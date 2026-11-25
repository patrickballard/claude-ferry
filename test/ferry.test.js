import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normaliseChat, isExportArray } from '../src/chat.js';
import { writeSession, sessionToMarkdown, listSessions } from '../src/code.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixture-api.json', import.meta.url)));

test('follows the current branch and drops abandoned edits', () => {
  const chat = normaliseChat(fixture);
  assert.equal(chat.title, 'Pricing page for Lantern');
  assert.deepEqual(chat.turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(!JSON.stringify(chat).includes('ABANDONED'));
});

test('keeps artifacts and attachments, drops thinking', () => {
  const [u1, a1, , a2] = normaliseChat(fixture).turns;
  assert.match(u1.text, /<attached file="notes.txt">\nFree tier must allow 3 projects/);
  assert.match(a1.text, /```html\n<h1>Lantern<\/h1>/);
  assert.ok(!a1.text.includes('secret'));
  assert.match(a2.text, /Used tool `web_search`: saas pricing/);
  assert.match(a2.text, /SaaS pricing report <https:\/\/example.com\/report>/);
});

test('accepts the official export shape (flat, no tree)', () => {
  const exp = [{ uuid: 'x', name: 'Export chat', chat_messages: [
    { sender: 'human', text: 'hi', content: [], created_at: '2026-01-01T00:00:00Z' },
    { sender: 'assistant', text: 'hello', created_at: '2026-01-01T00:00:01Z' },
  ] }];
  assert.ok(isExportArray(exp));
  const chat = normaliseChat(exp[0]);
  assert.deepEqual(chat.turns.map((t) => t.text), ['hi', 'hello']);
});

test('writes a linked session that round-trips back to markdown', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ferry-'));
  process.env.CLAUDE_CONFIG_DIR = home;
  const cwd = '/tmp/some project';
  const { sessionId, file } = writeSession(normaliseChat(fixture), { cwd, version: '2.1.0' });
  assert.ok(file.startsWith(path.join(home, 'projects', '-tmp-some-project')));

  const recs = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const msgs = recs.filter((r) => r.type === 'user' || r.type === 'assistant');
  assert.equal(msgs[0].parentUuid, null);
  for (let i = 1; i < msgs.length; i++) assert.equal(msgs[i].parentUuid, msgs[i - 1].uuid);
  assert.ok(msgs.every((m) => m.sessionId === sessionId && m.cwd === cwd));
  assert.match(msgs[0].message.content, /^\[Ported from Claude Chat/);

  const [s] = listSessions(cwd);
  assert.equal(s.title, '⛴ Pricing page for Lantern');
  const { markdown } = sessionToMarkdown(file);
  assert.match(markdown, /^# Pricing page for Lantern/);
  assert.match(markdown, /## Me\n\nMake Pro \$12 instead\./);
  assert.match(markdown, /Pro is now \$12\/month/);
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('bookmarklet fetches the chat and copies a ferry payload', async () => {
  const href = fs.readFileSync(new URL('../docs/bookmarklet.txt', import.meta.url), 'utf8').trim();
  const code = decodeURIComponent(href.slice('javascript:'.length));
  const calls = [];
  let copied = null;
  const el = () => ({ style: {}, remove() {}, click() {} });
  const ctx = {
    location: { hostname: 'claude.ai', origin: 'https://claude.ai', pathname: '/chat/11111111-2222-3333-4444-555555555555' },
    document: { cookie: 'foo=1; lastActiveOrg=org-123', createElement: el, body: { appendChild() {} } },
    navigator: { clipboard: { writeText: async (t) => { copied = t; } } },
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => fixture.conversation }; },
    setTimeout: () => {},
  };
  vm.runInNewContext(code, ctx);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls[0], '/api/organizations/org-123/chat_conversations/11111111-2222-3333-4444-555555555555?tree=True&rendering_mode=messages&render_all_tools=true');
  const payload = JSON.parse(copied);
  assert.equal(payload.ferry, 1);
  assert.equal(normaliseChat(payload).turns.length, 4);
});
