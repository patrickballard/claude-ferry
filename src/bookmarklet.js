// ⛴ Ferry bookmarklet: run on a claude.ai chat. Fetches the conversation from
// claude.ai's own API (same origin, your session) and copies it to the
// clipboard for `npx claude-ferry in`. Nothing is sent anywhere else.
(async () => {
  const toast = (msg, ok = true) => {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);max-width:90vw;' +
      'padding:12px 16px;border-radius:10px;font:14px/1.4 ui-sans-serif,system-ui,sans-serif;white-space:pre-line;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.25);color:#fff;background:' + (ok ? '#1f6f43' : '#9b2c2c');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ok ? 6000 : 9000);
  };
  try {
    if (!/(^|\.)claude\.ai$/.test(location.hostname)) return toast('⛴ Ferry: open a chat on claude.ai first.', false);
    const id = (location.pathname.match(/\/chat\/([0-9a-f-]{36})/) || [])[1];
    if (!id) return toast('⛴ Ferry: open a chat on claude.ai first.', false);

    const q = '?tree=True&rendering_mode=messages&render_all_tools=true';
    const cookieOrg = decodeURIComponent((document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/) || [])[1] || '');
    let orgs = cookieOrg ? [cookieOrg] : [];
    if (!orgs.length) {
      const r = await fetch('/api/organizations', { credentials: 'include' });
      orgs = r.ok ? (await r.json()).map((o) => o.uuid) : [];
    }
    let conv = null;
    for (const org of orgs) {
      const r = await fetch(`/api/organizations/${org}/chat_conversations/${id}${q}`, { credentials: 'include' });
      if (r.ok) { conv = await r.json(); break; }
    }
    if (!conv) return toast("⛴ Ferry: couldn't load this chat from claude.ai.", false);

    const payload = JSON.stringify({ ferry: 1, source: 'claude.ai', url: location.origin + location.pathname, conversation: conv });
    let copied = false;
    try { await navigator.clipboard.writeText(payload); copied = true; } catch (e) {}
    if (!copied) {
      // Clipboard needs focus/permission in some browsers: fall back to a download.
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
      a.download = `claude-ferry-${id.slice(0, 8)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    const n = (conv.chat_messages || []).length;
    toast(`⛴ "${conv.name || 'Chat'}" (${n} messages) ${copied ? 'copied' : 'downloaded'}.\nNow run in your project:  npx claude-ferry in`);
  } catch (e) {
    toast('⛴ Ferry failed: ' + e.message, false);
  }
})();
