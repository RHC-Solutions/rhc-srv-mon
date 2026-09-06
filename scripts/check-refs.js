#!/usr/bin/env node
// After the split: flag uses of any former top-level name of the monolithic server.js that a
// file neither declares nor imports (a destructured require or a `module.` member access is fine).
//   node scripts/check-refs.js [reference-server.js]   (default: git show main:server.js)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');

function strip(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``').replace(/'(?:\\.|[^'\\\n])*'/g, "''").replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}
const declRe = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:let|const|var)\s+([A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?)*)/gm;
function topLevel(src) {
  const out = new Set(); let m;
  while ((m = declRe.exec(src))) { if (m[1]) out.add(m[1]); else m[2].split(',').forEach(x => out.add(x.trim().split(/[\s=]/)[0])); }
  return out;
}
const ref = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8')
  : execFileSync('git', ['show', 'main:server.js'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const oldNames = topLevel(strip(ref));
for (const n of ['http', 'fs', 'path', 'os', 'execFile', 'execFileSync', 'spawn', 'net', 'crypto', 'PAGE', 'LOGIN_PAGE', 'server']) oldNames.delete(n);
// the old PAGE literal held column-0 client code too — drop anything the ui/ files declare, and tiny names
const uiDir = path.join(root, 'ui');
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
for (const f of walk(uiDir)) for (const n of topLevel(fs.readFileSync(f, 'utf8'))) oldNames.delete(n);
for (const n of [...oldNames]) if (n.length < 3 || ['err', 'done', 'state', 'sessions'].includes(n)) oldNames.delete(n);

const files = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];
let bad = 0;
for (const f of files) {
  const raw = fs.readFileSync(path.join(root, f), 'utf8');
  const s = strip(raw);
  const declared = topLevel(s);
  for (const m of s.matchAll(/^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) declared.add(m[1]);   // block-scoped locals
  // destructured imports: const { a, b: c } = require(...)
  for (const m of s.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\(/g)) m[1].split(',').forEach(x => { const n = x.split(':').pop().trim(); if (n) declared.add(n); });
  const lines = s.split('\n');
  lines.forEach((line, i) => {
    // drop member accesses (foo.bar → keep foo only) and property keys (bar: …)
    const cleaned = line.replace(/\.\s*[A-Za-z_$][\w$]*/g, '').replace(/[A-Za-z_$][\w$]*\s*:/g, '');
    for (const id of cleaned.match(/[A-Za-z_$][\w$]*/g) || []) {
      if (oldNames.has(id) && !declared.has(id)) { console.log(`${f}:${i + 1}: ${id}`); bad++; }
    }
  });
}
console.log(bad ? `${bad} suspicious reference(s)` : 'no unresolved references to former globals');
process.exit(bad ? 1 : 0);
