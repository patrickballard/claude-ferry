// Read and write Claude Code session transcripts (~/.claude/projects/<dir>/<id>.jsonl).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const projectsDir = () => path.join(claudeHome(), 'projects');

// Claude Code names each project folder after its cwd with every
// non-alphanumeric character replaced by "-".
export function projectDirFor(cwd) {
  return path.join(projectsDir(), cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// ---------- writing (Chat -> Code) ----------

export function writeSession(chat, { cwd = process.cwd(), version = '0.0.0' } = {}) {
  const sessionId = randomUUID();
  const dir = projectDirFor(cwd);
  fs.mkdirSync(dir, { recursive: true });

  const banner =
    `[Ported from Claude Chat with claude-ferry: "${chat.title}"${chat.url ? ` (${chat.url})` : ''}. ` +
    `The turns below happened in claude.ai, not in this terminal. Tool calls and artifacts are shown as text; ` +
    `nothing in this directory has been touched yet.]`;

  const lines = [];
  let parentUuid = null;
  const base = Date.now() - chat.turns.length * 1000;
  chat.turns.forEach((t, i) => {
    const uuid = randomUUID();
    const timestamp = t.at || new Date(base + i * 1000).toISOString();
    const common = { parentUuid, isSidechain: false, userType: 'external', cwd, sessionId, version, gitBranch: '', uuid, timestamp };
    if (t.role === 'user') {
      const text = i === 0 ? `${banner}\n\n${t.text}` : t.text;
      lines.push({ ...common, type: 'user', message: { role: 'user', content: text } });
    } else {
      lines.push({
        ...common,
        type: 'assistant',
        message: {
          id: `msg_ferry_${uuid.replace(/-/g, '').slice(0, 24)}`,
          type: 'message',
          role: 'assistant',
          model: chat.model || 'claude-ferry-import',
          content: [{ type: 'text', text: t.text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    parentUuid = uuid;
  });
  lines.push({ type: 'custom-title', customTitle: `⛴ ${chat.title}`, sessionId });

  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sessionId, file };
}

// ---------- reading (Code -> Chat) ----------

export function listSessions(cwd = process.cwd()) {
  let dir = projectDirFor(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const file = path.join(dir, f);
      return { id: f.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((s) => ({ ...s, ...peek(s.file) }))
    .filter((s) => s.turns > 0);
}

export function findSession(idOrPath, cwd = process.cwd()) {
  if (fs.existsSync(idOrPath)) return path.resolve(idOrPath);
  const local = path.join(projectDirFor(cwd), `${idOrPath}.jsonl`);
  if (fs.existsSync(local)) return local;
  for (const d of fs.existsSync(projectsDir()) ? fs.readdirSync(projectsDir()) : []) {
    const p = path.join(projectsDir(), d, `${idOrPath}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readRecords(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial line */ }
  }
  return out;
}

function peek(file) {
  const recs = readRecords(file);
  let title = null;
  let first = null;
  let turns = 0;
  for (const r of recs) {
    if (r.type === 'custom-title' && r.customTitle) title = r.customTitle;
    if (r.type === 'user' && !r.isSidechain && !r.isMeta && typeof humanText(r) === 'string') {
      turns++;
      if (!first) first = humanText(r);
    }
  }
  return { title: title || (first ? oneLine(first, 70) : '(no prompt)'), turns };
}

// A user record that a human typed (not a tool result or injected reminder).
function humanText(r) {
  const c = r.message && r.message.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && c.every((b) => b.type === 'text' || b.type === 'image')) {
    text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (text == null) return null;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || /^<(command-|local-command|bash-)/.test(text) || text.startsWith('Caveat:')) return null;
  return text;
}

// Follow parentUuid links back from the newest message so rewinds/branches
// don't leak abandoned turns into the export.
// Compaction boundaries have parentUuid null and point back via logicalParentUuid,
// so the walk crosses them and recovers the full pre-compaction history.
function mainThread(recs) {
  const linked = recs.filter((r) => r.uuid && !r.isSidechain);
  const byId = new Map(linked.map((r) => [r.uuid, r]));
  const isMsg = (r) => r.type === 'user' || r.type === 'assistant';
  const chain = [];
  let cur = linked.filter(isMsg).at(-1);
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    if (isMsg(cur) && !cur.isCompactSummary) chain.push(cur);
    cur = byId.get(cur.parentUuid || cur.logicalParentUuid);
  }
  return chain.reverse();
}

export function sessionToMarkdown(file, { tools = false, lastTurns = 0 } = {}) {
  const recs = readRecords(file);
  const meta = peek(file);
  const cwd = (recs.find((r) => r.cwd) || {}).cwd || '';
  const thread = mainThread(recs);

  const turns = []; // { role, parts[] }
  const push = (role, part) => {
    const last = turns.at(-1);
    if (last && last.role === role) last.parts.push(part);
    else turns.push({ role, parts: [part] });
  };

  for (const r of thread) {
    if (r.type === 'user') {
      const t = humanText(r);
      if (t && !r.isMeta) push('user', t);
      continue;
    }
    const content = (r.message && r.message.content) || [];
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && b.text && b.text.trim()) push('assistant', b.text.trim());
      else if (b.type === 'tool_use' && tools) push('assistant', `> 🔧 ${describeTool(b)}`);
    }
  }

  // Collapse runs of tool lines and keep the last N user turns if asked.
  let selected = turns;
  if (lastTurns > 0) {
    let seen = 0;
    let start = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user' && ++seen === lastTurns) { start = i; break; }
    }
    selected = turns.slice(start);
  }

  const out = [
    `# ${meta.title.replace(/^⛴\s*/, '')}`,
    '',
    `*Claude Code session ported with [claude-ferry](https://github.com/patrickballard/claude-ferry) — working directory \`${cwd}\`. ` +
      `This is a transcript for context; files it mentions live on my machine, not here.*`,
    '',
  ];
  for (const t of selected) {
    out.push(t.role === 'user' ? '## Me' : '## Claude Code', '', t.parts.join('\n\n'), '');
  }
  return { markdown: out.join('\n'), title: meta.title, turns: selected.filter((t) => t.role === 'user').length };
}

function describeTool(b) {
  const i = b.input || {};
  const arg = i.description || i.command || i.file_path || i.path || i.pattern || i.url || i.query || i.prompt || '';
  return `${b.name}${arg ? ` — ${oneLine(String(arg), 120)}` : ''}`;
}

function oneLine(s, n) {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
