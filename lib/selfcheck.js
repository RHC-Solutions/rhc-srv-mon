'use strict';
// Compile every server and UI script without running it, and build-check the UI page — the checks
// that catch the typo which would otherwise take the panel down on restart. Used by `sbctl restart`
// and by the panel's own Restart (left menu → Panel).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { APP_ROOT } = require('./config');

function check() {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (e.name.endsWith('.js')) files.push(f); } };
  for (const d of ['lib', 'ui', 'bin']) if (fs.existsSync(path.join(APP_ROOT, d))) walk(path.join(APP_ROOT, d));
  files.push(path.join(APP_ROOT, 'server.js'));
  const bad = [];
  for (const f of files) {
    let src = fs.readFileSync(f, 'utf8');
    if (src.startsWith('#!')) src = '//' + src;
    try { new vm.Script(f.includes('/ui/') ? src : '(function (exports, require, module, __filename, __dirname) {' + src + '\n})', { filename: f }); }
    catch (e) { bad.push(path.relative(APP_ROOT, f) + ': ' + e.message + (e.stack && /:\d+/.test(e.stack.split('\n')[0]) ? ' (' + e.stack.split('\n')[0] + ')' : '')); }
  }
  const page = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts/check-page.js'), '--idents-only'], { cwd: APP_ROOT, encoding: 'utf8', timeout: 60_000 });
  if (page.status !== 0) bad.push('UI page: ' + ((page.stdout || '') + (page.stderr || '')).trim().split('\n').slice(-6).join('\n    '));
  return { files: files.length, bad };
}

module.exports = { check };
