#!/usr/bin/env node
// claude-ferry: move conversations between Claude Chat (claude.ai) and Claude Code.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { normaliseChat, isExportArray } from '../src/chat.js';
import { writeSession, listSessions, findSession, sessionToMarkdown } from '../src/code.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const BOOKMARKLET_PAGE = 'https://github.com/patrickballard/claude-ferry#bookmarklet';

const c = process.stdout.isTTY && !process.env.NO_COLOR
  ? { b: (s) => `\x1b[1m${s}\x1b[22m`, d: (s) => `\x1b[2m${s}\x1b[22m`, g: (s) => `\x1b[32m${s}\x1b[39m`, y: (s) => `\x1b[33m${s}\x1b[39m`, r: (s) => `\x1b[31m${s}\x1b[39m` }
  : { b: String, d: String, g: String, y: String, r: String };

const HELP = `${c.b('claude-ferry')} ${VERSION} — move conversations between Claude Chat and Claude Code

${c.b('Chat → Code')}
  1. On a claude.ai chat, click the ⛴ Ferry bookmarklet (${BOOKMARKLET_PAGE})
  2. In your project folder:   ${c.g('npx github:patrickballard/claude-ferry in')}
     → opens Claude Code with the chat as real session history

  ferry in [file]          read from clipboard, a file, or newest ~/Downloads/claude-ferry-*.json
                           also accepts conversations.json from claude.ai's data export
    --last <n>             only bring the last n exchanges
    --no-launch            write the session but don't start claude

${c.b('Code → Chat')}
  ferry out [session]      pick a session from this folder (or pass an id/path),
                           copy it as markdown to paste into claude.ai
    --tools                include one-line summaries of tool calls
    --last <n>             only the last n exchanges
    --save <file>          also write the markdown to a file

  ferry --help | --version
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--last' || a === '--save') args[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else if (a === '-h') args.help = true;
    else if (a === '-v') args.version = true;
    else args._.push(a);
  }
  return args;
}

// ---------- clipboard ----------
function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
function readClipboard() {
  if (process.platform === 'darwin') return run('pbpaste', []);
  if (process.platform === 'win32') return run('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw']);
  return run('wl-paste', ['--no-newline']) ?? run('xclip', ['-o', '-selection', 'clipboard']) ?? run('xsel', ['-ob']);
}
function writeClipboard(text) {
  if (process.platform === 'darwin') return run('pbcopy', [], text) !== null;
  if (process.platform === 'win32') return run('clip', [], text) !== null;
  return (run('wl-copy', [], text) ?? run('xclip', ['-selection', 'clipboard'], text) ?? run('xsel', ['-ib'], text)) !== null;
}

// ---------- input discovery ----------
function tryJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function findInput(fileArg) {
  if (fileArg) {
    const data = tryJSON(fs.readFileSync(fileArg, 'utf8'));
    if (!data) throw new Error(`${fileArg} isn't valid JSON.`);
    return { data, from: fileArg };
  }
  const clip = tryJSON(readClipboard()?.trim());
  if (clip && (clip.ferry || clip.chat_messages || isExportArray(clip))) return { data: clip, from: 'clipboard' };

  const dl = path.join(os.homedir(), 'Downloads');
  const files = fs.existsSync(dl)
    ? fs.readdirSync(dl).filter((f) => /^claude-ferry-.*\.json$/.test(f)).map((f) => path.join(dl, f))
    : [];
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (files[0] && Date.now() - fs.statSync(files[0]).mtimeMs < 60 * 60 * 1000) {
    return { data: JSON.parse(fs.readFileSync(files[0], 'utf8')), from: files[0] };
  }
  throw new Error(
    `Nothing to ferry. Click the ⛴ Ferry bookmarklet on a claude.ai chat first\n  (${BOOKMARKLET_PAGE}), or pass a file: ferry in conversations.json`,
  );
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}

async function pick(items, label, render) {
  const shown = items.slice(0, 20);
  shown.forEach((it, i) => console.log(`${c.d(String(i + 1).padStart(3))}  ${render(it)}`));
  if (items.length > shown.length) console.log(c.d(`     …and ${items.length - shown.length} more (type to search)`));
  for (;;) {
    const a = await ask(`\n${label} [1]: `);
    if (!a) return shown[0];
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1];
    const hits = items.filter((it) => render(it).toLowerCase().includes(a.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length) return pick(hits, label, render);
    console.log(c.y('No match.'));
  }
}

function lastN(turns, n) {
  if (!n) return turns;
  let seen = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user' && ++seen === n) return turns.slice(i);
  }
  return turns;
}

function claudeVersion() {
  const out = run('claude', ['--version']);
  return out ? out.trim().split(/\s+/)[0] : null;
}

// ---------- commands ----------
async function cmdIn(args) {
  let { data, from } = findInput(args._[1]);
  if (isExportArray(data)) {
    const convs = data.filter((cv) => cv.chat_messages.length).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    console.log(c.b(`${convs.length} chats in ${path.basename(from)}:\n`));
    data = await pick(convs, 'Which chat? (number or search)', (cv) => `${cv.name || 'Untitled'} ${c.d(`· ${cv.chat_messages.length} msgs · ${String(cv.updated_at).slice(0, 10)}`)}`);
  }
  const chat = normaliseChat(data);
  if (args.last) chat.turns = lastN(chat.turns, Number(args.last));
  if (chat.turns[0]?.role !== 'user') chat.turns.unshift({ role: 'user', text: '(conversation continues from earlier)', at: null });
  if (!chat.turns.length) throw new Error('That chat has no messages to port.');

  const version = claudeVersion();
  const { sessionId, file } = writeSession(chat, { cwd: process.cwd(), version: version || '2.0.0' });
  const exchanges = chat.turns.filter((t) => t.role === 'user').length;
  console.log(`${c.g('⛴')}  Ferried ${c.b(`"${chat.title}"`)} ${c.d(`(${exchanges} exchanges, from ${from === 'clipboard' ? 'clipboard' : path.basename(from)})`)}`);
  console.log(c.d(`   ${file}`));

  if (args['no-launch'] || !version) {
    if (!version) console.log(c.y('\n   `claude` not found on PATH.'));
    console.log(`\n   Resume it with: ${c.g(`claude --resume ${sessionId}`)}`);
    return;
  }
  console.log(c.d(`   claude --resume ${sessionId}\n`));
  const r = spawnSync('claude', ['--resume', sessionId], { stdio: 'inherit' });
  process.exitCode = r.status ?? 0;
}

async function cmdOut(args) {
  let file;
  if (args._[1]) {
    file = findSession(args._[1]);
    if (!file) throw new Error(`No session "${args._[1]}" found.`);
  } else {
    const sessions = listSessions();
    if (!sessions.length) throw new Error(`No Claude Code sessions found for ${process.cwd()}.\n  Run this from the folder you used Claude Code in, or pass a session id.`);
    if (sessions.length === 1 || !process.stdin.isTTY) file = sessions[0].file;
    else {
      console.log(c.b(`Claude Code sessions in ${process.cwd()}:\n`));
      file = (await pick(sessions, 'Which session? (number or search)', (s) => `${s.title} ${c.d(`· ${s.turns} prompts · ${ago(s.mtime)}`)}`)).file;
    }
  }
  const { markdown, title, turns } = sessionToMarkdown(file, { tools: !!args.tools, lastTurns: Number(args.last) || 0 });
  if (args.save) fs.writeFileSync(args.save, markdown);
  const copied = !args.stdout && writeClipboard(markdown);
  if (args.stdout || !copied) process.stdout.write(markdown);
  if (copied) {
    const kb = (Buffer.byteLength(markdown) / 1024).toFixed(1);
    console.log(`${c.g('⛴')}  Copied ${c.b(`"${title.replace(/^⛴\s*/, '')}"`)} ${c.d(`(${turns} prompts, ${kb} KB)`)} — paste it into a new chat at ${c.b('claude.ai/new')}`);
    if (Buffer.byteLength(markdown) > 60 * 1024) console.log(c.y('   Big one: claude.ai turns long pastes into an attachment, which works fine. Use --last <n> to trim.'));
  }
  if (args.save) console.log(c.d(`   saved ${args.save}`));
}

function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(VERSION);
  const cmd = args._[0];
  if (args.help || !cmd) return console.log(HELP);
  if (cmd === 'in') return cmdIn(args);
  if (cmd === 'out') return cmdOut(args);
  console.log(HELP);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(`${c.r('✗')} ${e.message}`);
  process.exitCode = 1;
});
