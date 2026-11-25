// Turn a claude.ai conversation (internal API shape or official data export
// shape) into a flat list of { role: 'user' | 'assistant', text, at } turns.

const SKIP_TOOL_RESULTS = new Set(['artifacts']);

export function normaliseChat(raw) {
  // Bookmarklet payload: { ferry: 1, conversation: {...} }
  const conv = raw && raw.ferry ? raw.conversation : raw;
  if (!conv || !Array.isArray(conv.chat_messages)) {
    throw new Error("That doesn't look like a claude.ai conversation (no chat_messages).");
  }
  const messages = currentBranch(conv);
  const turns = [];
  for (const m of messages) {
    const role = m.sender === 'human' ? 'user' : 'assistant';
    const text = role === 'user' ? renderHuman(m) : renderAssistant(m);
    if (!text.trim()) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += '\n\n' + text; // keep strict alternation
    else turns.push({ role, text, at: m.created_at || m.updated_at || null });
  }
  return {
    title: conv.name || 'Untitled chat',
    uuid: conv.uuid || null,
    url: raw && raw.url ? raw.url : conv.uuid ? `https://claude.ai/chat/${conv.uuid}` : null,
    model: conv.model || null,
    turns,
  };
}

// With ?tree=True the API returns every edit/retry branch. Walk back from the
// current leaf so we port the conversation the user actually sees.
function currentBranch(conv) {
  const msgs = conv.chat_messages;
  const hasTree = msgs.some((m) => m.parent_message_uuid);
  if (!hasTree) return [...msgs].sort(byIndex);
  const byId = new Map(msgs.map((m) => [m.uuid, m]));
  let leaf = conv.current_leaf_message_uuid && byId.get(conv.current_leaf_message_uuid);
  if (!leaf) leaf = [...msgs].sort(byIndex).at(-1);
  const chain = [];
  const seen = new Set();
  while (leaf && !seen.has(leaf.uuid)) {
    seen.add(leaf.uuid);
    chain.push(leaf);
    leaf = byId.get(leaf.parent_message_uuid);
  }
  return chain.reverse();
}

function byIndex(a, b) {
  if (a.index != null && b.index != null) return a.index - b.index;
  return String(a.created_at).localeCompare(String(b.created_at));
}

function blocks(m) {
  if (Array.isArray(m.content) && m.content.length) return m.content;
  return [{ type: 'text', text: m.text || '' }];
}

function renderHuman(m) {
  const parts = [];
  for (const b of blocks(m)) if (b.type === 'text' && b.text) parts.push(b.text);
  for (const a of m.attachments || []) {
    const body = a.extracted_content || '';
    parts.push(`<attached file="${a.file_name || 'attachment'}">\n${body}\n</attached>`);
  }
  for (const f of m.files || m.files_v2 || []) {
    parts.push(`[Attached ${f.file_kind || 'file'} "${f.file_name || f.file_uuid || ''}" was not ported]`);
  }
  return parts.join('\n\n');
}

function renderAssistant(m) {
  const parts = [];
  for (const b of blocks(m)) {
    if (b.type === 'text' && b.text) parts.push(b.text);
    else if (b.type === 'tool_use') parts.push(renderToolUse(b));
    else if (b.type === 'tool_result' && !SKIP_TOOL_RESULTS.has(b.name)) {
      const summary = toolResultSummary(b);
      if (summary) parts.push(summary);
    }
    // thinking / redacted_thinking blocks are dropped: their signatures don't transfer.
  }
  return parts.filter(Boolean).join('\n\n');
}

function renderToolUse(b) {
  const input = b.input || {};
  if (b.name === 'artifacts') {
    // The most valuable thing to carry into Code: the artifact's full source.
    if (input.content) {
      const lang = langFor(input.type, input.language);
      return `**Artifact: ${input.title || input.id || 'untitled'}** (${input.command || 'create'})\n\n\`\`\`${lang}\n${input.content}\n\`\`\``;
    }
    if (input.command === 'update' && input.old_str != null) {
      return `**Artifact edit: ${input.id || ''}**\n\nReplaced:\n\`\`\`\n${input.old_str}\n\`\`\`\nWith:\n\`\`\`\n${input.new_str || ''}\n\`\`\``;
    }
  }
  if (b.name === 'repl' && input.code) return `**Ran analysis code:**\n\n\`\`\`javascript\n${input.code}\n\`\`\``;
  if (b.name === 'create_file' && input.file_text != null) {
    return `**Created file \`${input.path || ''}\`:**\n\n\`\`\`\n${input.file_text}\n\`\`\``;
  }
  const arg = input.query || input.url || input.command || input.path || '';
  return `[Used tool \`${b.name}\`${arg ? `: ${truncate(String(arg), 200)}` : ''}]`;
}

function toolResultSummary(b) {
  const content = Array.isArray(b.content) ? b.content : [];
  const links = content
    .filter((c) => c.type === 'knowledge' || c.url)
    .slice(0, 5)
    .map((c) => `- ${c.title || c.url}${c.url ? ` <${c.url}>` : ''}`);
  if (links.length) return `Sources:\n${links.join('\n')}`;
  return '';
}

function langFor(type, language) {
  if (language) return language;
  const map = {
    'application/vnd.ant.react': 'jsx',
    'text/html': 'html',
    'image/svg+xml': 'svg',
    'application/vnd.ant.mermaid': 'mermaid',
    'text/markdown': 'markdown',
    'application/vnd.ant.code': '',
  };
  return map[type] ?? '';
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Official export: an array of conversations.
export function isExportArray(raw) {
  return Array.isArray(raw) && raw.length > 0 && raw.every((c) => c && Array.isArray(c.chat_messages));
}
