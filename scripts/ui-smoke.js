#!/usr/bin/env node
/**
 * Headless smoke test for the browser code: loads ui/*.js (same order as lib/page.js) into a vm
 * context with a minimal DOM stub, points fetch() at a running dev instance, and drives the tabs
 * and every Sites sub-tab. Catches ReferenceErrors / TypeErrors in render paths — not layout.
 *
 *   node scripts/ui-smoke.js [http://127.0.0.1:8898] [domain]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const pageLib = require('../lib/page');

const BASE = (process.argv[2] || 'http://127.0.0.1:8898').replace(/\/$/, '');
const DOMAIN = process.argv[3] || null;
const errors = [];
const log = (...a) => console.log(...a);

/* ---- tiny DOM ---- */
function makeEl(tag, id) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: id || '', _html: '', children: [], style: {}, dataset: {}, value: '', checked: false, textContent: '',
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    addEventListener() {}, removeEventListener() {}, appendChild(c) { this.children.push(c); return c; }, remove() {}, focus() {}, select() {}, click() {},
    setAttribute() {}, getAttribute() { return null; }, contains() { return false; }, scrollTop: 0, scrollHeight: 0,
    querySelector(sel) { return findIn(this, sel)[0] || null; }, querySelectorAll(sel) { return findIn(this, sel); },
    get innerHTML() { return this._html; },
    set innerHTML(h) { this._html = String(h); this.children = []; registerIds(this, this._html); },
  };
  return el;
}
const byId = new Map();
function registerIds(parent, html) {
  for (const m of html.matchAll(/<(\w+)[^>]*\sid="([^"]+)"[^>]*>/g)) {
    const el = makeEl(m[1], m[2]);
    const v = /\svalue="([^"]*)"/.exec(m[0]); if (v) el.value = v[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    if (/\schecked\b/.test(m[0])) el.checked = true;
    if (m[1] === 'textarea') { const t = new RegExp('<textarea[^>]*\\sid="' + m[2] + '"[^>]*>([\\s\\S]*?)</textarea>').exec(html); if (t) el.value = t[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'); }
    byId.set(m[2], el); parent.children.push(el);
  }
}
function findIn(root, sel) {
  const out = [];
  const idm = /^#([\w-]+)$/.exec(sel); if (idm) { const e = byId.get(idm[1]); return e ? [e] : []; }
  const tagm = /^(input|select|textarea)(,.*)?$/i.exec(sel); if (tagm) { for (const e of byId.values()) if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName)) out.push(e); return out; }
  return out;   // class selectors etc. → nothing (only used for wiring listeners)
}
const document = {
  body: makeEl('body'), head: makeEl('head'), activeElement: null, visibilityState: 'visible',
  getElementById(id) { return byId.get(id) || null; },
  createElement(tag) { return makeEl(tag); },
  querySelector(sel) { return findIn(document.body, sel)[0] || null; },
  querySelectorAll(sel) { return findIn(document.body, sel); },
  addEventListener() {},
};
document.body.appendChild = (c) => { document.body.children.push(c); if (c._html) registerIds(c, c._html); return c; };
for (const id of ['host', 'updated', 'banner', 'userbar', 'q', 'sort', 'sharedToggle', 'main', 'toast-host', 'ivl', 'ssh-hostlist', 'ssh-tabbar', 'ssh-terms', 'ssh-empty', 'ssh-side-ft',
  'pm2view', 'dbview', 'updatesview', 'sitesview', 'modulesview', 'backupview', 'sshview', 'eventsview']) byId.set(id, makeEl(id.endsWith('view') ? 'div' : id === 'q' ? 'input' : 'div', id));

const storage = new Map();
const sandbox = {
  console, document, setTimeout: (f) => 0, setInterval: () => 0, clearInterval() {}, clearTimeout() {}, requestAnimationFrame: () => 0,
  localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
  location: { pathname: '/sites', search: '', href: BASE + '/sites', replace() {} },
  history: { pushState(s, t, url) { const q = url.indexOf('?'); sandbox.location.search = q >= 0 ? url.slice(q) : ''; sandbox.location.pathname = '/' + (q >= 0 ? url.slice(0, q) : url); }, replaceState(s, t, url) { this.pushState(s, t, url); } },
  navigator: { clipboard: { writeText: async () => {} } },
  TextEncoder, URLSearchParams, URL, Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set, WeakMap, Symbol, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
  fetch: (url, opts) => { const u = /^https?:/.test(url) ? url : BASE + '/' + String(url).replace(/^\.?\//, ''); return fetch(u, opts); },
  ResizeObserver: class { observe() {} disconnect() {} },
  alert: (m) => log('  [alert]', m), confirm: () => true,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {}; sandbox.innerWidth = 1400;
vm.createContext(sandbox);
process.on('unhandledRejection', (e) => { errors.push('unhandled rejection: ' + (e && e.stack || e)); });

const js = pageLib.jsFiles().map((f) => fs.readFileSync(path.join(pageLib.UI_DIR, f), 'utf8')).join('\n');
try { vm.runInContext(js, sandbox, { filename: 'ui.js' }); } catch (e) { console.error('ui script threw at load:', e.stack); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// top-level const/let of the ui script live in the script scope, not on the sandbox object → evaluate
const G = (expr) => vm.runInContext(expr, sandbox);
const call = (label, fn) => { try { const r = fn(); log('  ok  ' + label); return r; } catch (e) { errors.push(label + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); log('  ERR ' + label + ': ' + e.message); } };

(async () => {
  log('loaded ' + pageLib.jsFiles().length + ' files, base ' + BASE);
  await sleep(1500);                                   // boot's refresh() fetches
  call('refresh()', () => sandbox.refresh()); await sleep(1500);
  for (const tab of ['pm2', 'db', 'updates', 'sites', 'modules', 'backup', 'events']) {
    call('setTab(' + tab + ')', () => sandbox.setTab(tab)); await sleep(800);
    const v = byId.get(G('TABS')[tab].view); log('       ' + tab + ' view: ' + (v._html || '').length + ' chars');
  }
  // Sites detail
  const sites = (G('lastSites') || {}).sites || [];
  const domain = DOMAIN || (sites.find((s) => s.type === 'php') || sites[0] || {}).domain;
  if (!domain) { errors.push('no sites available'); }
  else {
    log('site detail: ' + domain);
    call('siteGo(' + domain + ')', () => sandbox.siteGo(domain, 'settings'));
    for (let i = 0; i < 20 && !G('siteView').data; i++) await sleep(200);
    if (!G('siteView').data) errors.push('site detail never loaded: ' + G('siteView').error);
    for (const [t] of G('SITE_TABS')) {
      call('siteGo(' + domain + ', ' + t + ')', () => sandbox.siteGo(domain, t));
      for (let i = 0; i < 25; i++) { await sleep(200); const subs = Object.values(G('siteView').sub).filter((x) => x && x.loading); if (!subs.length) break; }
      call('renderSiteDetail() [' + t + ']', () => sandbox.renderSiteDetail());
      const html = byId.get('sitesview')._html;
      const errs = Object.entries(G('siteView').sub).filter(([, x]) => x && x.error).map(([k, x]) => k + ': ' + x.error);
      log('       ' + t + ': ' + html.length + ' chars' + (errs.length ? ' · sub errors: ' + errs.join('; ') : '') + (/Loading…/.test(html) ? ' · STILL LOADING' : ''));
      if (/Loading…/.test(html) && !errs.length) errors.push(t + ': still loading after wait');
    }
    // dialogs (render only)
    for (const [label, fn] of [['sitePwGenerate', () => sandbox.sitePwGenerate()], ['siteSshAdd', () => sandbox.siteSshAdd()], ['siteCertUpload', () => sandbox.siteCertUpload()], ['siteCronEdit(null)', () => sandbox.siteCronEdit(null)], ['siteFmMkdir', () => sandbox.siteFmMkdir()]]) { call(label, fn); sandbox.sshModalClose(); }
    call('siteGo(null)', () => sandbox.siteGo(null));
  }
  log(errors.length ? '\n' + errors.length + ' error(s):\n - ' + errors.join('\n - ') : '\nno errors');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error('harness failed:', e.stack); process.exit(2); });
