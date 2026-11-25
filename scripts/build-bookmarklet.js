// Builds the javascript: URL from src/bookmarklet.js and injects it into docs/index.html.
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const src = fs.readFileSync(new URL('src/bookmarklet.js', root), 'utf8');
const body = src
  .split('\n')
  .filter((l) => !/^\s*\/\//.test(l))
  .map((l) => l.trim())
  .filter(Boolean)
  .join('\n');
const href = 'javascript:' + encodeURIComponent(body);
fs.writeFileSync(new URL('docs/bookmarklet.txt', root), href + '\n');
const tpl = fs.readFileSync(new URL('docs/index.template.html', root), 'utf8');
fs.writeFileSync(new URL('docs/index.html', root), tpl.replaceAll('__BOOKMARKLET__', href.replace(/"/g, '%22')));
console.log(`bookmarklet: ${href.length} chars`);
