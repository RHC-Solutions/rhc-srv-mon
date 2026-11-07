'use strict';
// Vault (left menu → Vault).
//
// 1. Entries: passwords, tokens, API keys, SSH keys, notes the admins keep here. The secret and the
//    notes are AES-256-GCM encrypted (secrets.js); lists never carry them — only a reveal does, and
//    every reveal is written to the event log by the API layer.
// 2. System secrets: every credential this server already holds, read from where it lives (token
//    files, the panel's encrypted settings, root-only files) instead of being copied in — a copy
//    would go stale the moment the real one is rotated. Read-only here; each links to where it is
//    managed. The panel's own master key (secret.key) is deliberately not listed.
const fs = require('fs');
const { open, settings } = require('./db');
const secrets = require('./secrets');

const KINDS = ['password', 'token', 'api-key', 'ssh-key', 'certificate', 'note', 'other'];
const q = (sql) => open().prepare(sql);
const now = () => new Date().toISOString();
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });

// ------------------------------------------------------------------ entries
function clean(b, partial) {
  const out = {};
  const str = (k, max, re) => {
    if (b[k] == null) return;
    const v = String(b[k]).trim();
    if (v.length > max) throw bad(k + ': at most ' + max + ' characters');
    if (re && v && !re.test(v)) throw bad('invalid ' + k);
    out[k] = v;
  };
  str('name', 120); str('username', 200); str('url', 500, /^(https?:\/\/|ssh:\/\/|[\w.-]+(:\d+)?(\/|$))/i); str('tags', 300);
  if (b.kind != null) { if (!KINDS.includes(b.kind)) throw bad('kind must be one of ' + KINDS.join(', ')); out.kind = b.kind; }
  if (b.secret != null) { const s = String(b.secret); if (s.length > 64 * 1024) throw bad('secret larger than 64 KB'); out.secret = s; }
  if (b.notes != null) { const n = String(b.notes); if (n.length > 64 * 1024) throw bad('notes larger than 64 KB'); out.notes = n; }
  if (!partial) {
    if (!out.name) throw bad('name is required');
    if (!out.secret) throw bad('secret is required');
  } else if (out.name === '') throw bad('name cannot be empty');
  if (out.tags != null) out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean).join(', ');
  return out;
}
const view = (r) => r && ({ id: r.id, name: r.name, kind: r.kind, username: r.username || '', url: r.url || '', tags: r.tags || '', hasNotes: !!r.notes_enc,
  created_at: r.created_at, created_by: r.created_by, updated_at: r.updated_at, updated_by: r.updated_by });

function list() { return q('SELECT * FROM vault ORDER BY lower(name)').all().map(view); }
function row(id) { const r = q('SELECT * FROM vault WHERE id = ?').get(Number(id)); if (!r) throw bad('no such vault entry', 404); return r; }
function create(b, user) {
  const c = clean(b, false), t = now();
  const r = q('INSERT INTO vault (name, kind, username, url, tags, secret_enc, notes_enc, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(c.name, c.kind || 'password', c.username || null, c.url || null, c.tags || null, secrets.encrypt(c.secret), c.notes ? secrets.encrypt(c.notes) : null, t, user || null, t, user || null);
  return view(row(r.lastInsertRowid));
}
function update(id, b, user) {
  const cur = row(id), c = clean(b, true);
  const next = {
    name: c.name != null ? c.name : cur.name, kind: c.kind || cur.kind,
    username: c.username != null ? c.username || null : cur.username, url: c.url != null ? c.url || null : cur.url, tags: c.tags != null ? c.tags || null : cur.tags,
    secret_enc: c.secret ? secrets.encrypt(c.secret) : cur.secret_enc,                  // empty secret in an edit = keep
    notes_enc: c.notes != null ? (c.notes ? secrets.encrypt(c.notes) : null) : cur.notes_enc,
  };
  q('UPDATE vault SET name=?, kind=?, username=?, url=?, tags=?, secret_enc=?, notes_enc=?, updated_at=?, updated_by=? WHERE id=?')
    .run(next.name, next.kind, next.username, next.url, next.tags, next.secret_enc, next.notes_enc, now(), user || null, cur.id);
  return view(row(cur.id));
}
function remove(id) { const r = row(id); q('DELETE FROM vault WHERE id = ?').run(r.id); return view(r); }
function reveal(id) {
  const r = row(id);
  return { id: r.id, name: r.name, secret: secrets.decrypt(r.secret_enc), notes: r.notes_enc ? secrets.decrypt(r.notes_enc) : '' };
}

// ------------------------------------------------------------------ system secrets
const dec = (v) => { if (!v) return ''; try { return secrets.isEncrypted(v) ? secrets.decrypt(v) : String(v); } catch (_) { return ''; } };
const readFile = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (_) { return ''; } };
const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
const setting = (key, field) => { const v = settings.get(key, null); return v ? dec(field ? v[field] : v) : ''; };

// Each: id, name, kind, where (how to find/rotate it), manage (panel page), username?, get() → secret
function systemSources() {
  const out = [];
  let tunnels = [];
  try { tunnels = require('./sites/tunnels').get().tunnels || []; } catch (_) {}
  for (const t of tunnels) {
    if (!t.token) continue;
    out.push({ id: 'tunnel:' + t.unit, name: 'Cloudflare Tunnel token · ' + (t.name || t.unit), kind: 'token', where: t.tokenSource || '/etc/cloudflared', manage: 'tunnels',
      get: () => { const r = require('./sites/tunnels').reveal(t.unit); return r ? r.token : ''; } });
  }
  const kuma = readJsonFile('/root/.kuma/admin.json');
  out.push({ id: 'kuma-admin', name: 'Uptime Kuma admin login', kind: 'password', where: '/root/.kuma/admin.json (used by kuma-sync)', url: settings.get('kuma.publicUrl', '') || '', username: kuma ? kuma.username : '', get: () => (readJsonFile('/root/.kuma/admin.json') || {}).password || '' });
  out.push({ id: 'kuma-api', name: 'Uptime Kuma API key (Monitor page)', kind: 'api-key', where: 'panel settings, encrypted (kv kuma.apiKey)', get: () => setting('kuma.apiKey') });
  out.push({ id: 'cloudflare-api', name: 'Cloudflare API token (panel)', kind: 'api-key', where: 'Settings → Cloudflare (encrypted)', manage: 'settings', get: () => setting('cloudflare.token') });
  const cfEnv = readFile('/root/.cf/env');
  const cfTok = (/^CF_API_TOKEN=(.*)$/m.exec(cfEnv) || [])[1] || '';
  out.push({ id: 'cloudflare-env', name: 'Cloudflare API token (kuma-sync)', kind: 'api-key', where: '/root/.cf/env', get: () => (/^CF_API_TOKEN=(.*)$/m.exec(readFile('/root/.cf/env')) || [])[1] || '', present: !!cfTok });
  out.push({ id: 'telegram', name: 'Telegram bot token', kind: 'token', where: 'Settings → Telegram (encrypted)', manage: 'settings', get: () => setting('notify.telegram', 'botToken') });
  out.push({ id: 'slack', name: 'Slack webhook URL', kind: 'token', where: 'Settings → Slack', manage: 'settings', get: () => setting('notify.slack', 'webhookUrl') });
  out.push({ id: 'brevo', name: 'Brevo API key', kind: 'api-key', where: 'Settings → Brevo (encrypted)', manage: 'settings', get: () => setting('notify.brevo', 'apiKey') });
  const was = settings.get('wasabi', null);
  out.push({ id: 'wasabi', name: 'Wasabi secret key (backups)', kind: 'api-key', where: 'Settings → Wasabi (encrypted)', manage: 'settings', username: was && was.accessKey ? was.accessKey : '',
    get: () => { try { const w = require('./wasabi').get(); return (w && w.secretKey) || ''; } catch (_) { return ''; } } });
  out.push({ id: 'turnstile', name: 'Turnstile secret key', kind: 'api-key', where: 'Settings → Turnstile (encrypted)', manage: 'settings', get: () => { try { return require('./turnstile').get().secretKey || ''; } catch (_) { return ''; } } });
  // SSH: every site's login (password + generated private key) and its extra SSH users — reachable
  // only from the admin IP whitelist — and the saved hosts of the SSH tab that carry a password.
  let sites = [], sshUsers = [];
  try { sites = open().prepare('SELECT id, domain, user, user_password_enc FROM sites ORDER BY domain').all(); } catch (_) {}
  try { sshUsers = open().prepare('SELECT u.id, u.username, u.password_enc, s.domain FROM ssh_users u JOIN sites s ON s.id = u.site_id ORDER BY s.domain, u.username').all(); } catch (_) {}
  const host = require('os').hostname();
  for (const s of sites) {
    out.push({ id: 'site-ssh:' + s.domain, name: 'SSH · ' + s.domain, kind: 'password', where: 'ssh ' + s.user + '@' + host + ' (port 22, admin IPs only) · site password', manage: 'sites?d=' + encodeURIComponent(s.domain) + '&t=ssh', username: s.user,
      get: () => { const r = open().prepare('SELECT user_password_enc FROM sites WHERE id = ?').get(s.id); return r && r.user_password_enc ? dec(r.user_password_enc) : ''; } });
    out.push({ id: 'site-sshkey:' + s.domain, name: 'SSH key · ' + s.domain, kind: 'ssh-key', where: 'private key for ' + s.user + '@' + host + ' (its public half is in authorized_keys)', manage: 'sites?d=' + encodeURIComponent(s.domain) + '&t=ssh', username: s.user,
      get: () => { const k = require('./whitelist').siteKey(s.domain); return k ? k.private : ''; } });
  }
  for (const s of sites) {
    const gh = settings.get('site.github:' + s.domain, null);
    if (gh) out.push({ id: 'github-key:' + s.domain, name: 'GitHub deploy key · ' + s.domain, kind: 'ssh-key', where: 'write access to github.com/' + gh.repo + ' only (~' + s.user + '/.ssh/github_deploy)', url: 'https://github.com/' + gh.repo, manage: 'sites?d=' + encodeURIComponent(s.domain) + '&t=github',
      get: () => require('./sites/github').deployKey(s.domain) });
  }
  for (const u of sshUsers) out.push({ id: 'ssh-user:' + u.id, name: 'SSH user ' + u.username + ' · ' + u.domain, kind: 'password', where: 'ssh ' + u.username + '@' + host + ' (port 22, admin IPs only)', manage: 'sites?d=' + encodeURIComponent(u.domain) + '&t=ssh', username: u.username,
    get: () => { const r = open().prepare('SELECT password_enc FROM ssh_users WHERE id = ?').get(u.id); return r && r.password_enc ? dec(r.password_enc) : ''; } });
  let hosts = [];
  try { hosts = (JSON.parse(fs.readFileSync(require('path').join(require('./config').APP_ROOT, 'ssh-hosts.json'), 'utf8')).hosts || []); } catch (_) {}
  for (const h of hosts) {
    const label = (h.user || 'root') + '@' + h.host + (h.port && Number(h.port) !== 22 ? ':' + h.port : '');
    if (h.password) out.push({ id: 'ssh-host:' + h.id, name: 'SSH host · ' + (h.name || h.host), kind: 'password', where: 'SSH tab · ' + label, manage: 'ssh', username: label, get: () => h.password });
    if (h.rdpPassword) out.push({ id: 'rdp-host:' + h.id, name: 'RDP · ' + (h.name || h.host), kind: 'password', where: 'SSH tab · RDP ' + (h.rdpUser || '') + '@' + (h.rdpHost || h.host), manage: 'ssh', username: h.rdpUser || '', get: () => h.rdpPassword });
    if (h.vncPassword) out.push({ id: 'vnc-host:' + h.id, name: 'VNC · ' + (h.name || h.host), kind: 'password', where: 'SSH tab · VNC ' + (h.vncHost || h.host), manage: 'ssh', get: () => h.vncPassword });
  }
  for (const s of out) if (s.present == null) { try { s.present = !!s.get(); } catch (_) { s.present = false; } }
  return out;
}
// The tunnel list is collected in the background; right after a restart it is still empty, so wait
// for one collection before listing (otherwise the tunnel tokens would be missing).
async function systemList() {
  try { const t = require('./sites/tunnels'); if (!t.get().generated_at) await t.refresh(); } catch (_) {}
  return systemSources().map((s) => ({ settable: !!SETTABLE[s.id], id: s.id, name: s.name, kind: s.kind, where: s.where, manage: s.manage || null, username: s.username || '', url: s.url || '', present: !!s.present }));
}
function systemReveal(id) {
  const s = systemSources().find((x) => x.id === id);
  if (!s) throw bad('no such system secret', 404);
  const v = s.get();
  if (!v) throw bad(s.name + ' is not set', 404);
  return { id: s.id, name: s.name, username: s.username || '', secret: v };
}

// ------------------------------------------------------------------ password changes
// Uptime Kuma admin: set a given password or generate one, store its bcrypt hash in Kuma's own DB
// (the same hashing Kuma uses), keep /root/.kuma/admin.json (kuma-sync's login) in step.
// Kuma runs as the panel site kuma.it-saas.com (user uptimekuma); /opt/uptime-kuma is only the
// pre-move copy. Resolved per call so a renamed or moved site is followed.
function kumaDir() {
  try {
    const s = require('./sites/store').get('kuma.it-saas.com');
    if (s) { const d = '/home/' + s.user + '/htdocs/' + s.domain; if (fs.existsSync(d + '/data/kuma.db')) return d; }
  } catch (_) {}
  return '/opt/uptime-kuma';
}
const KUMA_CRED = '/root/.kuma/admin.json';
function genPassword(len) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const crypto = require('crypto'); let out = '';
  while (out.length < len) for (const b of crypto.randomBytes(64)) if (b < A.length * 4 && out.length < len) out += A[b % A.length];
  return out;
}
async function setKumaPassword(pw) {
  const generated = !pw;
  pw = generated ? genPassword(32) : String(pw);
  if (pw.length < 12 || pw.length > 128) throw bad('password: 12 to 128 characters');
  if (/[\s]/.test(pw)) throw bad('password: no spaces or line breaks');
  const cred = readJsonFile(KUMA_CRED) || {};
  const { DatabaseSync } = require('node:sqlite');
  const KUMA_DIR = kumaDir();
  const db = new DatabaseSync(KUMA_DIR + '/data/kuma.db');
  try {
    const user = cred.username ? db.prepare('SELECT id, username FROM user WHERE username = ?').get(cred.username) : db.prepare('SELECT id, username FROM user ORDER BY id LIMIT 1').get();
    if (!user) throw bad('Kuma admin user not found', 404);
    const hash = await require(KUMA_DIR + '/server/password-hash').generate(pw);
    db.prepare('UPDATE user SET password = ? WHERE id = ?').run(hash, user.id);
    fs.writeFileSync(KUMA_CRED, JSON.stringify({ username: user.username, password: pw }, null, 2) + '\n', { mode: 0o600 });
    return { username: user.username, password: pw, generated };
  } finally { db.close(); }
}
const SETTABLE = { 'kuma-admin': setKumaPassword };
async function systemSetPassword(id, pw) {
  const fn = SETTABLE[id];
  if (!fn) throw bad('this secret cannot be changed from the Vault', 400);
  const s = systemSources().find((x) => x.id === id);
  return Object.assign({ id, name: s ? s.name : id, url: s ? s.url : '' }, await fn(pw));
}

module.exports = { systemSetPassword, genPassword, KINDS, list, create, update, remove, reveal, systemList, systemReveal };
