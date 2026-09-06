'use strict';
// Assembles the single-page dashboard from ui/ at boot: index.html shell + one <style> of
// app.css + ONE <script> holding every ui/*.js in a fixed order (all tabs share one scope, so
// function hoisting across files behaves exactly as it did when this was one literal).
// The concatenated script is syntax-checked with vm.Script so a typo in one tab file fails
// the boot loudly instead of taking every tab down in the browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { APP_ROOT, DEV } = require('./config');

const UI_DIR = path.join(APP_ROOT, 'ui');
// Load order: core helpers/state first, tabs (each self-contained), boot last (runs setTab/refresh).
const JS_ORDER = [
  'core.js',
  'tabs/pm2.js', 'tabs/db.js', 'tabs/updates.js', 'tabs/sites.js', 'tabs/modules.js',
  'tabs/backups.js', 'tabs/ssh.js', 'tabs/auth.js', 'tabs/events.js', 'tabs/settings.js',
  'boot.js',
];

function read(rel) { return fs.readFileSync(path.join(UI_DIR, rel), 'utf8'); }

function jsFiles() {
  // Transitional: a monolithic ui/app.js (straight out of scripts/extract-ui.js) wins if present.
  if (fs.existsSync(path.join(UI_DIR, 'app.js'))) return ['app.js'];
  return JS_ORDER.filter(f => fs.existsSync(path.join(UI_DIR, f)));
}

function build() {
  const shell = read('index.html');
  const css = read('app.css');
  const files = jsFiles();
  const js = files.map(f => read(f)).join('');
  try { new vm.Script(js, { filename: 'ui/<' + files.join('+') + '>' }); }
  catch (e) { throw new Error('ui script does not parse: ' + e.message); }
  // Function replacers: the JS contains "$&"-style sequences that String.replace would expand.
  return shell.replace('{{css}}', () => css).replace('{{js}}', () => js);
}

let cached = null, cachedLogin = null;
function page() {
  if (DEV || !cached) cached = build();
  return cached;
}
function loginPage() {
  if (DEV || !cachedLogin) cachedLogin = read('login.html');
  return cachedLogin;
}

// Top-level identifiers per file — used by scripts/check-page.js to catch a name declared twice
// across tab files (would be a SyntaxError for let/const, or a silent override for functions).
function topLevelIdents(src) {
  const ids = [];
  const re = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:let|const|var)\s+([A-Za-z_$][\w$]*))/gm;
  let m; while ((m = re.exec(src))) ids.push(m[1] || m[2]);
  return ids;
}

module.exports = { page, loginPage, build, jsFiles, topLevelIdents, UI_DIR, JS_ORDER };
