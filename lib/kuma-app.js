'use strict';
// Uptime Kuma from the App Store: a local Kuma (/opt/uptime-kuma from the GitHub release, systemd
// uptime-kuma.service as user uptimekuma, 127.0.0.1 on a free port from 3901) that watches every site.
//
// Install = download + start + admin account (/root/.kuma/admin.json, shown in Vault) + an API key
// for the Monitor page (kv kuma.apiKey) + the first site sync. The panel then reads this Kuma instead
// of whatever kuma.url pointed at before (kept in kv kuma.prev and put back on remove).
//
// Site sync (after install, every 10 min, and right after a site is created or moved): per site
//   "public · <domain>"  https://<domain>/ the way visitors reach it — through Cloudflare when the
//                        site is proxied there, straight to the server when it is not
//   "origin · <domain>"  the same site without Cloudflare: the app's own port for Node.js/Python
//                        sites, otherwise nginx on 127.0.0.1 with the site's Host header (a CF-only
//                        site's nginx answers 403 to anyone but Cloudflare — that counts as up there)
// Monitors the sync made carry "rhc-srv-mon:<kind>:<domain>" as description; only those are changed,
// paused (site held stopped or moved away) or deleted (site deleted). Anything added by hand in Kuma
// is left alone.
const fs = require('fs');
const path = require('path');
const { settings } = require('./db');
const secrets = require('./secrets');
const { execP } = require('./util');

const DIR = '/opt/uptime-kuma';
const DATA = DIR + '/data';
const UNIT = 'uptime-kuma';
const UNIT_FILE = '/etc/systemd/system/' + UNIT + '.service';
const CRED = '/root/.kuma/admin.json';
const REPO = 'louislam/uptime-kuma';
const TAG = 'rhc-srv-mon:';
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const ENV = Object.assign({}, process.env, { HOME: '/root', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' });
const sh = (script, t) => execP('bash', ['-c', 'set -o pipefail; ' + script], { timeout: t || 20 * 60_000, env: ENV });
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// kv kuma.local = { port, dir, version } while the App Store Kuma is installed here.
const local = () => settings.get('kuma.local', null);
const installed = () => !!local() && fs.existsSync(UNIT_FILE);

function version() { try { return JSON.parse(fs.readFileSync(DIR + '/package.json', 'utf8')).version || null; } catch (_) { return null; } }
async function detect() { return { latest: installed() ? version() : null }; }

async function latestTag() {
  const r = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', { headers: { 'User-Agent': 'rhc-srv-mon', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw bad('GitHub releases: HTTP ' + r.status);
  const j = await r.json();
  if (!/^[\w.-]+$/.test(j.tag_name || '')) throw bad('GitHub returned no usable release tag');
  return j.tag_name;
}

async function step(log, what, script, t) {
  log('» ' + what);
  const r = await sh(script, t);
  log((r.stdout || '') + (r.stderr || ''));
  if (r.err) throw bad(what + ' failed (exit ' + (r.err.code || '?') + ')');
  return r;
}

// Code at a release tag + production modules + the prebuilt frontend (dist.tar.gz of that release).
// The code stays root's; only data/ belongs to uptimekuma.
async function fetchRelease(tag, log) {
  if (!fs.existsSync(DIR + '/.git')) {
    if (fs.existsSync(DIR) && fs.readdirSync(DIR).length) throw bad(DIR + ' exists and is not an Uptime Kuma checkout — move it away first');
    await step(log, 'download Uptime Kuma ' + tag, 'git clone -q --depth 1 --branch ' + q(tag) + ' https://github.com/' + REPO + '.git ' + DIR + ' 2>&1');
  } else {
    await step(log, 'fetch Uptime Kuma ' + tag, 'cd ' + DIR + ' && git -c safe.directory=* fetch -q --depth 1 origin tag ' + q(tag) + ' 2>&1 && git -c safe.directory=* checkout -q -f ' + q(tag) + ' 2>&1');
  }
  await step(log, 'install its Node.js modules (a few minutes)', 'cd ' + DIR + ' && npm ci --omit=dev --no-audit --no-fund --loglevel=error 2>&1 | tail -20');
  await step(log, 'download the web interface', 'cd ' + DIR + ' && rm -rf dist && curl -fsSL https://github.com/' + REPO + '/releases/download/' + q(tag) + '/dist.tar.gz | tar -xz 2>&1 && test -f dist/index.html');
}

function writeUnit(port) {
  fs.writeFileSync(UNIT_FILE, [
    '[Unit]', 'Description=Uptime Kuma — installed from the App Store (RHC SRV MAN)', 'After=network-online.target', 'Wants=network-online.target', '',
    '[Service]', 'User=uptimekuma', 'Group=uptimekuma', 'WorkingDirectory=' + DIR,
    'Environment=NODE_ENV=production UPTIME_KUMA_HOST=127.0.0.1 UPTIME_KUMA_PORT=' + port + ' DATA_DIR=' + DATA + '/',
    'ExecStart=/usr/bin/node server/server.js', 'Restart=always', 'RestartSec=5', '',
    '[Install]', 'WantedBy=multi-user.target', '',
  ].join('\n'));
}

async function waitUp(port, log) {
  for (let i = 0; i < 90; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/api/entry-page', { signal: AbortSignal.timeout(3000) }); if (r.ok) return; } catch (_) {}
    await new Promise((res) => setTimeout(res, 2000));
  }
  const j = await sh('journalctl -u ' + UNIT + ' -n 30 --no-pager 2>&1', 15_000);
  log(j.stdout);
  throw bad('Uptime Kuma did not start within 3 minutes');
}

// ---- Kuma's socket.io API (the client library comes with Kuma itself — the panel has no dependencies)
async function connect(url, dir) {
  const { io } = require(path.join(dir || DIR, 'node_modules/socket.io-client'));
  const socket = io(url, { transports: ['websocket'], reconnection: false, timeout: 15_000 });
  const lists = [];
  socket.on('monitorList', (l) => { lists.push(l); });
  // Kuma registers its event handlers only after it has sent "info" to the new connection (server.js:
  // `await sendInfo(socket)` first) — anything emitted before that is dropped and its ack times out.
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(bad('Uptime Kuma at ' + url + ' accepted the connection but never sent its info')), 20_000);
    socket.once('info', () => { clearTimeout(t); res(); });
    socket.once('connect_error', (e) => { clearTimeout(t); rej(bad('cannot reach Uptime Kuma at ' + url + ': ' + e.message)); });
  });
  const call = async (ev, ...args) => {
    const r = await socket.timeout(30_000).emitWithAck(ev, ...args).catch((e) => { throw bad('Kuma ' + ev + ': ' + e.message); });
    if (r && typeof r === 'object' && r.ok === false) throw bad('Kuma ' + ev + ': ' + (r.msg || 'refused'));
    return r;
  };
  // A fresh list (Kuma pushes it after login and after every change; getMonitorList asks for it).
  const monitors = async () => {
    const n = lists.length;
    await call('getMonitorList');
    for (let i = 0; i < 50 && lists.length === n; i++) await new Promise((res) => setTimeout(res, 100));
    return Object.values(lists[lists.length - 1] || {});
  };
  return { socket, call, monitors, close: () => socket.close() };
}

// Log in without knowing a password: a JWT made exactly like Kuma's own (server/model/user.js
// createJWT: username + shake256(password hash, 16), signed with the jwtSecret in its database), for the
// first active user — the one who owns the monitors. Survives password changes and a database copied
// from another Kuma (whose user's password the panel never knew).
function tokenLogin(dir) {
  const d = dir || DIR;
  const { DatabaseSync } = require('node:sqlite');
  let db;
  try { db = new DatabaseSync(path.join(d, 'data', 'kuma.db'), { readOnly: true }); } catch (_) { return null; }
  try {
    const u = db.prepare('SELECT username, password FROM user WHERE active = 1 ORDER BY id LIMIT 1').get();
    const s = db.prepare("SELECT value FROM setting WHERE key = 'jwtSecret'").get();
    if (!u || !s || !s.value) return null;
    const jwt = require(path.join(d, 'node_modules/jsonwebtoken'));
    const h = require('crypto').createHash('shake256', { outputLength: 16 }).update(String(u.password)).digest('hex');
    return { username: u.username, token: jwt.sign({ username: u.username, h }, s.value) };
  } catch (_) { return null; } finally { try { db.close(); } catch (_) {} }
}
async function login(k, opts) {
  const t = opts.cred ? null : tokenLogin(opts.dir);
  if (t) { await k.call('loginByToken', t.token); return t.username; }
  const cred = opts.cred || readCred();
  if (!cred) throw bad('cannot log in to Kuma: no user in its database and no login in ' + CRED);
  await k.call('login', { username: cred.username, password: cred.password, token: '' });
  return cred.username;
}
function readCred() { try { const c = JSON.parse(fs.readFileSync(CRED, 'utf8')); return c.username && c.password ? c : null; } catch (_) { return null; } }

// ---- what every site should have
function wanted() {
  const store = require('./sites/store');
  const held = (() => { try { return settings.get('sites.heldStopped', {}) || {}; } catch (_) { return {}; } })();
  const out = [];
  for (const s of store.list()) {
    if (settings.get('site.movedTo:' + s.domain, null)) continue;     // served by another server now
    const active = !held[s.domain];
    const port = (s.nodejs && s.nodejs.port) || (s.python && s.python.port) || null;
    out.push({ key: 'public:' + s.domain, active, name: 'public · ' + s.domain, url: 'https://' + s.domain + '/', maxredirects: 10, accepted: ['200-299', '300-399'], headers: null, ignoreTls: false });
    if (port) out.push({ key: 'origin:' + s.domain, active, name: 'origin · ' + s.domain, url: 'http://127.0.0.1:' + port + '/', maxredirects: 0, accepted: ['200-299', '300-399', '400-499'], headers: null, ignoreTls: false });
    else out.push({ key: 'origin:' + s.domain, active, name: 'origin · ' + s.domain, url: 'https://127.0.0.1/', maxredirects: 0, accepted: ['200-299', '300-399'].concat(s.cf_only ? ['403'] : []), headers: JSON.stringify({ Host: s.domain }), ignoreTls: true });
  }
  return out;
}

const monitorFor = (w) => ({
  type: 'http', name: w.name, description: TAG + w.key, parent: null, url: w.url, method: 'GET', interval: 60, retryInterval: 60, resendInterval: 0, maxretries: 2, timeout: 48,
  notificationIDList: {}, ignoreTls: w.ignoreTls, upsideDown: false, expiryNotification: false, maxredirects: w.maxredirects, accepted_statuscodes: w.accepted,
  headers: w.headers, body: null, httpBodyEncoding: 'json', authMethod: null, proxyId: null, active: w.active,
  kafkaProducerBrokers: [], kafkaProducerSaslOptions: { mechanism: 'None' }, conditions: [], rabbitmqNodes: [],
});
const differs = (m, w) => m.url !== w.url || m.name !== w.name || Number(m.maxredirects) !== w.maxredirects || !!m.ignoreTls !== w.ignoreTls
  || (m.headers || null) !== w.headers || JSON.stringify(m.accepted_statuscodes || []) !== JSON.stringify(w.accepted);

let running = null;
async function sync(opts) {
  if (running) return running;
  running = doSync(opts || {}).finally(() => { running = null; });
  return running;
}
async function doSync(opts) {
  const log = opts.log || (() => {});
  const lc = local();
  const url = opts.url || (lc ? 'http://127.0.0.1:' + lc.port : null);
  if (!url) throw bad('Uptime Kuma is not installed from the App Store here');
  const k = await connect(url, opts.dir);
  const done = { added: 0, changed: 0, paused: 0, resumed: 0, deleted: 0, kept: 0 };
  try {
    await login(k, opts);
    const list = await k.monitors();
    const mine = new Map(), names = new Set(list.map((m) => m.name));
    for (const m of list) if (String(m.description || '').startsWith(TAG)) mine.set(m.description.slice(TAG.length), m);
    const want = wanted();
    for (const w of want) {
      const m = mine.get(w.key);
      if (!m) {
        if (names.has(w.name)) { done.kept++; continue; }               // made by hand under that name: leave it
        await k.call('add', monitorFor(w)); done.added++; log('+ ' + w.name + '  ' + w.url); continue;
      }
      if (differs(m, w)) {
        await k.call('editMonitor', Object.assign({}, m, monitorFor(w), { id: m.id, active: m.active, tags: undefined }));
        done.changed++; log('~ ' + w.name + '  ' + w.url);
      }
      if (!!m.active !== w.active) {
        await k.call(w.active ? 'resumeMonitor' : 'pauseMonitor', m.id);
        done[w.active ? 'resumed' : 'paused']++; log((w.active ? '▶ ' : '⏸ ') + w.name);
      }
    }
    const keys = new Set(want.map((w) => w.key));
    for (const [key, m] of mine) if (!keys.has(key)) { await k.call('deleteMonitor', m.id, false); done.deleted++; log('- ' + m.name + ' (site gone)'); }
  } finally { k.close(); }
  settings.set('kuma.lastSync', Object.assign({ at: new Date().toISOString() }, done));
  try { require('./kuma').refreshSoon(); } catch (_) {}
  return done;
}

// ---- App Store actions (each returns an execP-like result; the job log gets the details via log)
async function install(_v, log, opts) {
  opts = opts || {};
  if (installed()) throw bad('Uptime Kuma is already installed here — use Update');
  // A retry after a failed install keeps the port of the unit already written (that Kuma may still be
  // running on it, so freePort would skip it and the restart below would never move it).
  const prevPort = (() => { try { const m = /UPTIME_KUMA_PORT=(\d+)/.exec(fs.readFileSync(UNIT_FILE, 'utf8')); return m ? Number(m[1]) : null; } catch (_) { return null; } })();
  const port = prevPort || require('./sites/create').freePort(3901);
  const tag = await latestTag();
  await step(log, 'system user uptimekuma', 'id uptimekuma >/dev/null 2>&1 || useradd --system --home-dir ' + DIR + ' --shell /usr/sbin/nologin uptimekuma 2>&1');
  await fetchRelease(tag, log);
  fs.mkdirSync(DATA, { recursive: true });
  if (!fs.existsSync(DATA + '/db-config.json')) fs.writeFileSync(DATA + '/db-config.json', JSON.stringify({ type: 'sqlite' }) + '\n');   // skip Kuma's database setup page
  await step(log, 'data directory', 'chown -R uptimekuma:uptimekuma ' + DATA + ' && chmod 750 ' + DATA);
  writeUnit(port);
  await step(log, 'start uptime-kuma.service on 127.0.0.1:' + port, 'systemctl daemon-reload && systemctl enable ' + UNIT + ' 2>&1 && systemctl restart ' + UNIT + ' 2>&1');
  await waitUp(port, log);
  const url = 'http://127.0.0.1:' + port;

  // Admin account (a Kuma that already has one — reinstall over an old data dir — keeps it)
  const k = await connect(url);
  let cred;
  try {
    if (await k.socket.timeout(15_000).emitWithAck('needSetup')) {
      cred = { username: 'admin', password: secrets.generatePassword(24) };
      await k.call('setup', cred.username, cred.password);
      fs.mkdirSync(path.dirname(CRED), { recursive: true, mode: 0o700 });
      fs.writeFileSync(CRED, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
      log('» admin account "admin" created — the password is in Vault (Uptime Kuma admin login)');
    } else {
      cred = readCred();
      if (!cred) throw bad('this Kuma already has an admin account but ' + CRED + ' has no login for it — set it in Vault, then Update');
    }
    await k.call('login', { username: cred.username, password: cred.password, token: '' });
    const key = await k.call('addAPIKey', { name: 'RHC SRV MAN Monitor page', expires: null, active: true });
    // The panel reads this Kuma from now on; the previous source comes back on remove.
    if (!settings.get('kuma.prev', null)) settings.set('kuma.prev', { url: settings.get('kuma.url', null), publicUrl: settings.get('kuma.publicUrl', null), apiKey: settings.get('kuma.apiKey', null) });
    settings.set('kuma.apiKey', secrets.encrypt(key.key));
    settings.set('kuma.url', url);
    settings.set('kuma.publicUrl', null);
    settings.set('kuma.local', { port, dir: DIR, version: tag, installed: new Date().toISOString() });
    log('» API key stored for the Monitor page');
  } finally { k.close(); }

  log('» adding every site (public through Cloudflare + origin without it)');
  const r = await sync({ log });
  log('sync: ' + JSON.stringify(r));
  if (opts.host) await publish(opts, log);
  else log('Kuma listens on 127.0.0.1:' + port + ' only — use 🌐 Publish in the App Store to give it a hostname.');
  return { stdout: '', stderr: '' };
}

async function update(_v, log) {
  const lc = local(); if (!lc) throw bad('Uptime Kuma is not installed from the App Store here');
  const tag = await latestTag();
  if (tag === version()) log('already on ' + tag + ' — rebuilding anyway');
  await fetchRelease(tag, log);
  await step(log, 'restart uptime-kuma.service', 'systemctl restart ' + UNIT + ' 2>&1');
  await waitUp(lc.port, log);
  settings.set('kuma.local', Object.assign({}, lc, { version: tag }));
  const r = await sync({ log });
  log('sync: ' + JSON.stringify(r));
  return { stdout: '', stderr: '' };
}

// Stops and removes Kuma; its data (monitors, history) is kept as a tarball in /var/backups.
async function remove(_v, log) {
  if (!local() && !fs.existsSync(UNIT_FILE)) throw bad('Uptime Kuma is not installed from the App Store here');
  const bk = '/var/backups/uptime-kuma-data-' + new Date().toISOString().slice(0, 10) + '.tgz';
  await step(log, 'stop uptime-kuma.service', 'systemctl disable --now ' + UNIT + ' 2>&1; rm -f ' + UNIT_FILE + ' && systemctl daemon-reload');
  if (fs.existsSync(DATA)) await step(log, 'keep its data as ' + bk, 'mkdir -p /var/backups && tar -czf ' + bk + ' -C ' + DIR + ' data 2>&1');
  await step(log, 'remove ' + DIR, 'rm -rf ' + DIR + ' && (userdel uptimekuma 2>/dev/null; true)');
  const prev = settings.get('kuma.prev', null) || {};
  for (const k of ['url', 'publicUrl', 'apiKey']) { if (prev[k] != null) settings.set('kuma.' + k, prev[k]); else settings.del('kuma.' + k); }
  for (const k of ['kuma.prev', 'kuma.local', 'kuma.lastSync']) settings.del(k);
  log('the Monitor page reads ' + (prev.url ? prev.url : 'no Kuma') + ' again');
  return { stdout: '', stderr: '' };
}

// Its own site (reverse proxy → the local Kuma), so the dashboard has a URL; the Monitor page links to it.
async function publish(opts, log) {
  const lc = local(); if (!lc) throw bad('Uptime Kuma is not installed from the App Store here');
  const r = await require('./app-publish').publish(Object.assign({}, opts, { url: 'http://127.0.0.1:' + lc.port, app: 'Uptime Kuma' }), log);
  settings.set('kuma.publicUrl', r.url);
  settings.set('kuma.local', Object.assign({}, local(), { host: r.host }));
  try { require('./kuma').refreshSoon(); } catch (_) {}
  log('the Monitor page links to ' + r.url + ' — log in as "admin" (password in Vault)');
  return r;
}
const publicUrl = () => { const lc = local(); return lc && lc.host ? 'https://' + lc.host : null; };

// Every 10 minutes while the App Store Kuma is installed.
if (!process.env.RHC_NO_JOBS) setInterval(() => { if (installed()) sync().catch((e) => console.error('kuma sync:', e.message)); }, 10 * 60_000).unref();

module.exports = { install, update, remove, publish, publicUrl, detect, installed, sync, wanted, connect, login, tokenLogin, UNIT, DIR, DATA };
