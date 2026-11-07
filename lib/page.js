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
const brand = require('./brand');

const UI_DIR = path.join(APP_ROOT, 'ui');
// Load order: core helpers/state first, tabs (each self-contained), boot last (runs setTab/refresh).
const JS_ORDER = [
  'core.js', 'clp.js',
  'tabs/pm2.js', 'tabs/db.js', 'tabs/updates.js', 'tabs/sites.js', 'tabs/modules.js',
  'tabs/backups.js', 'tabs/ssh.js', 'tabs/auth.js', 'tabs/events.js', 'tabs/settings.js', 'tabs/vault.js',
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
  return shell.replace('{{css}}', () => css).replace('{{js}}', () => js).replace('{{tz}}', () => serverTz());
}
// The server's zone for the top-bar clock (the browser's own zone may differ from the box's).
function serverTz() {
  let tz = ''; try { tz = fs.readFileSync('/etc/timezone', 'utf8').trim(); } catch (_) {}
  if (!/^[A-Za-z0-9_+\-\/]{1,64}$/.test(tz)) tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return tz;
}

// The product name in the UI is per-host (Settings → General → Panel name, kv `panel.name`):
// pages are built with the default and the name is swapped in on the way out, memoised per name.
const DEFAULT_NAME = 'RHC SRV Manager';
function panelName() {
  try { const n = String(require('./db').settings.get('panel.name', '') || '').trim(); return n || DEFAULT_NAME; } catch (_) { return DEFAULT_NAME; }
}
const htmlName = (n) => n.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The header/sign-in brand is written "<b>RHC</b> SRV Manager": the first word of a custom name
// is bolded the same way.
function brandHtml(n) { const i = n.indexOf(' '); return i > 0 ? '<b>' + htmlName(n.slice(0, i)) + '</b>' + htmlName(n.slice(i)) : '<b>' + htmlName(n) + '</b>'; }
function named(src, memo, px) {
  const n = panelName(), l = brand.logo(), key = n + '|' + (l ? l.v : '');
  if (memo.src !== src || memo.key !== key) {
    let out = src;
    if (n !== DEFAULT_NAME) out = out.split('<b>RHC</b> SRV Manager').join(brandHtml(n)).split(DEFAULT_NAME).join(htmlName(n));
    memo.src = src; memo.key = key; memo.out = brand.apply(out, px);
  }
  return memo.out;
}

let cached = null, cachedLogin = null;
const memoPage = {}, memoLogin = {};
function page() {
  if (DEV || !cached) cached = build();
  return named(cached, memoPage, 32);
}
function loginPage() {
  if (DEV || !cachedLogin) cachedLogin = read('login.html');
  return named(cachedLogin, memoLogin, 38);
}

// Top-level identifiers per file — used by scripts/check-page.js to catch a name declared twice
// across tab files (would be a SyntaxError for let/const, or a silent override for functions).
function topLevelIdents(src) {
  const ids = [];
  const re = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:let|const|var)\s+([A-Za-z_$][\w$]*))/gm;
  let m; while ((m = re.exec(src))) ids.push(m[1] || m[2]);
  return ids;
}

module.exports = { page, loginPage, panelName, DEFAULT_NAME, build, jsFiles, topLevelIdents, UI_DIR, JS_ORDER };
