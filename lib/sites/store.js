'use strict';
// SQLite access for sites and their attachments. Rows are plain objects; the per-type settings
// (php / nodejs / python) are attached to a site as `site.php`, `site.nodejs`, `site.python`.
const { open, transaction } = require('../db');
const secrets = require('../secrets');

const now = () => new Date().toISOString();

function attach(row) {
  if (!row) return null;
  const db = open();
  row.varnish_cache = !!row.varnish_cache; row.cf_only = !!row.cf_only; row.pagespeed_enabled = !!row.pagespeed_enabled;
  row.php = db.prepare('SELECT * FROM site_php WHERE site_id = ?').get(row.id) || null;
  row.nodejs = db.prepare('SELECT * FROM site_nodejs WHERE site_id = ?').get(row.id) || null;
  row.python = db.prepare('SELECT * FROM site_python WHERE site_id = ?').get(row.id) || null;
  return row;
}

function list() {
  return open().prepare('SELECT * FROM sites ORDER BY domain').all().map(attach);
}
function get(domain) {
  return attach(open().prepare('SELECT * FROM sites WHERE domain = ?').get(String(domain)));
}
function getById(id) { return attach(open().prepare('SELECT * FROM sites WHERE id = ?').get(id)); }
function byUser(user) { return attach(open().prepare('SELECT * FROM sites WHERE user = ?').get(String(user))); }

// Public view: never leaks the encrypted password blob; `hasPassword` tells the UI it can reveal it.
function publicView(site) {
  if (!site) return null;
  const { user_password_enc, ...rest } = site;
  return Object.assign(rest, { hasPassword: !!user_password_enc });
}
function password(site) { try { return site.user_password_enc ? secrets.decrypt(site.user_password_enc) : null; } catch (_) { return null; } }

const SITE_COLS = ['domain', 'type', 'user', 'root_dir', 'application', 'vhost_template', 'varnish_cache', 'cf_only', 'pagespeed_enabled', 'pagespeed_settings', 'reverse_proxy_url', 'user_password_enc', 'ssh_keys', 'managed_by', 'vhost_source', 'clp_id'];
const bool = (v) => (v ? 1 : 0);

function insert(s) {
  const db = open();
  const t = now();
  const r = db.prepare(`INSERT INTO sites (${SITE_COLS.join(', ')}, created_at, updated_at) VALUES (${SITE_COLS.map(() => '?').join(', ')}, ?, ?)`)
    .run(s.domain, s.type, s.user, s.root_dir, s.application || null, s.vhost_template, bool(s.varnish_cache), bool(s.cf_only), bool(s.pagespeed_enabled), s.pagespeed_settings || null,
      s.reverse_proxy_url || null, s.user_password_enc || null, s.ssh_keys || null, s.managed_by || 'rhc', s.vhost_source || 'template', s.clp_id || null, s.created_at || t, t);
  const id = Number(r.lastInsertRowid);
  if (s.php) setPhp(id, s.php);
  if (s.nodejs) setNodejs(id, s.nodejs);
  if (s.python) setPython(id, s.python);
  return getById(id);
}
// Partial update of the site row; `patch` keys must be SITE_COLS members.
function update(id, patch) {
  const cols = Object.keys(patch).filter((k) => SITE_COLS.includes(k) && k !== 'domain');
  if (!cols.length) return getById(id);
  const vals = cols.map((k) => (['varnish_cache', 'cf_only', 'pagespeed_enabled'].includes(k) ? bool(patch[k]) : patch[k]));
  open().prepare(`UPDATE sites SET ${cols.map((c) => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
  return getById(id);
}
// Any edit from our UI makes the row ours (CLP must no longer touch it).
function claim(id) { open().prepare("UPDATE sites SET managed_by = 'rhc', updated_at = ? WHERE id = ? AND managed_by <> 'rhc'").run(now(), id); }
function remove(id) { open().prepare('DELETE FROM sites WHERE id = ?').run(id); }

function setPhp(siteId, p) {
  open().prepare(`INSERT INTO site_php (site_id, php_version, pool_port, memory_limit, max_execution_time, max_input_time, max_input_vars, post_max_size, upload_max_filesize, additional_configuration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET php_version = excluded.php_version, pool_port = excluded.pool_port, memory_limit = excluded.memory_limit,
    max_execution_time = excluded.max_execution_time, max_input_time = excluded.max_input_time, max_input_vars = excluded.max_input_vars, post_max_size = excluded.post_max_size,
    upload_max_filesize = excluded.upload_max_filesize, additional_configuration = excluded.additional_configuration`)
    .run(siteId, String(p.php_version), Number(p.pool_port), String(p.memory_limit || '256M'), String(p.max_execution_time || '60'), String(p.max_input_time || '60'),
      String(p.max_input_vars || '1000'), String(p.post_max_size || '32M'), String(p.upload_max_filesize || '32M'), p.additional_configuration == null ? null : String(p.additional_configuration));
}
function setNodejs(siteId, n) {
  open().prepare(`INSERT INTO site_nodejs (site_id, node_version, port, runtime) VALUES (?, ?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET node_version = excluded.node_version, port = excluded.port, runtime = excluded.runtime`)
    .run(siteId, String(n.node_version), Number(n.port), n.runtime || 'nvm');
}
function setPython(siteId, p) {
  open().prepare(`INSERT INTO site_python (site_id, python_version, port) VALUES (?, ?, ?)
    ON CONFLICT(site_id) DO UPDATE SET python_version = excluded.python_version, port = excluded.port`).run(siteId, String(p.python_version), Number(p.port));
}

/* ---- attachments ---- */
const q = (sql) => open().prepare(sql);
const certs = {
  list: (siteId) => q('SELECT id, site_id, type, subject, sans, issuer, expires_at, fingerprint, is_active, created_at, (private_key_enc IS NOT NULL) AS has_key FROM certificates WHERE site_id = ? ORDER BY is_active DESC, id DESC').all(siteId)
    .map((c) => Object.assign(c, { sans: c.sans ? JSON.parse(c.sans) : [], is_active: !!c.is_active, has_key: !!c.has_key })),
  get: (id) => q('SELECT * FROM certificates WHERE id = ?').get(id),
  active: (siteId) => q('SELECT * FROM certificates WHERE site_id = ? AND is_active = 1').get(siteId) || null,
  insert: (c) => Number(q('INSERT INTO certificates (site_id, type, subject, sans, issuer, expires_at, private_key_enc, certificate, chain, fingerprint, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(c.site_id, c.type, c.subject || null, JSON.stringify(c.sans || []), c.issuer || null, c.expires_at || null, c.private_key_enc || null, c.certificate, c.chain || null, c.fingerprint || null, c.is_active ? 1 : 0, c.created_at || now()).lastInsertRowid),
  setActive: (siteId, id) => transaction((db) => { db.prepare('UPDATE certificates SET is_active = 0 WHERE site_id = ?').run(siteId); db.prepare('UPDATE certificates SET is_active = 1 WHERE id = ? AND site_id = ?').run(id, siteId); }),
  remove: (id) => q('DELETE FROM certificates WHERE id = ? AND is_active = 0').run(id).changes,
  byFingerprint: (siteId, fp) => q('SELECT * FROM certificates WHERE site_id = ? AND fingerprint = ?').get(siteId, fp) || null,
  setKey: (id, enc) => q('UPDATE certificates SET private_key_enc = ? WHERE id = ?').run(enc, id),
};
const basicAuth = {
  get: (siteId) => { const r = q('SELECT * FROM basic_auth WHERE site_id = ?').get(siteId); if (r) { r.is_active = !!r.is_active; r.allowed_ips = r.allowed_ips ? JSON.parse(r.allowed_ips) : []; } return r || null; },
  set: (siteId, b) => q('INSERT INTO basic_auth (site_id, is_active, username, password_enc, allowed_ips) VALUES (?, ?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET is_active = excluded.is_active, username = excluded.username, password_enc = excluded.password_enc, allowed_ips = excluded.allowed_ips')
    .run(siteId, b.is_active ? 1 : 0, b.username || null, b.password_enc || null, JSON.stringify(b.allowed_ips || [])),
  remove: (siteId) => q('DELETE FROM basic_auth WHERE site_id = ?').run(siteId),
};
const blockedIps = {
  list: (siteId) => q('SELECT ip FROM blocked_ips WHERE site_id = ? ORDER BY id').all(siteId).map((r) => r.ip),
  set: (siteId, ips) => transaction((db) => { db.prepare('DELETE FROM blocked_ips WHERE site_id = ?').run(siteId); const ins = db.prepare('INSERT OR IGNORE INTO blocked_ips (site_id, ip) VALUES (?, ?)'); for (const ip of ips) ins.run(siteId, ip); }),
};
const blockedBots = {
  list: (siteId) => q('SELECT ua FROM blocked_bots WHERE site_id = ? ORDER BY id').all(siteId).map((r) => r.ua),
  set: (siteId, uas) => transaction((db) => { db.prepare('DELETE FROM blocked_bots WHERE site_id = ?').run(siteId); const ins = db.prepare('INSERT OR IGNORE INTO blocked_bots (site_id, ua) VALUES (?, ?)'); for (const ua of uas) ins.run(siteId, ua); }),
};
const sshUsers = {
  list: (siteId) => q('SELECT id, site_id, username, ssh_keys, (password_enc IS NOT NULL) AS has_password, created_at FROM ssh_users WHERE site_id = ? ORDER BY username').all(siteId).map((r) => Object.assign(r, { has_password: !!r.has_password })),
  get: (username) => q('SELECT * FROM ssh_users WHERE username = ?').get(String(username)) || null,
  all: () => q('SELECT * FROM ssh_users').all(),
  insert: (u) => Number(q('INSERT INTO ssh_users (site_id, username, ssh_keys, password_enc, created_at) VALUES (?, ?, ?, ?, ?)').run(u.site_id, u.username, u.ssh_keys || null, u.password_enc || null, u.created_at || now()).lastInsertRowid),
  update: (id, patch) => { const cols = Object.keys(patch).filter((k) => ['ssh_keys', 'password_enc'].includes(k)); if (cols.length) q(`UPDATE ssh_users SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c]), id); },
  remove: (id) => q('DELETE FROM ssh_users WHERE id = ?').run(id),
};
const ftpUsers = {
  list: (siteId) => q('SELECT id, site_id, username, home, (password_enc IS NOT NULL) AS has_password, created_at FROM ftp_users WHERE site_id = ? ORDER BY username').all(siteId).map((r) => Object.assign(r, { has_password: !!r.has_password })),
  get: (username) => q('SELECT * FROM ftp_users WHERE username = ?').get(String(username)) || null,
  all: () => q('SELECT * FROM ftp_users').all(),
  insert: (u) => Number(q('INSERT INTO ftp_users (site_id, username, home, password_enc, created_at) VALUES (?, ?, ?, ?, ?)').run(u.site_id, u.username, u.home, u.password_enc || null, u.created_at || now()).lastInsertRowid),
  remove: (id) => q('DELETE FROM ftp_users WHERE id = ?').run(id),
};
const cronJobs = {
  list: (siteId) => q('SELECT * FROM cron_jobs WHERE site_id = ? ORDER BY id').all(siteId),
  get: (id) => q('SELECT * FROM cron_jobs WHERE id = ?').get(id) || null,
  insert: (j) => Number(q('INSERT INTO cron_jobs (site_id, minute, hour, day, month, weekday, command, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(j.site_id, j.minute, j.hour, j.day, j.month, j.weekday, j.command, j.created_at || now()).lastInsertRowid),
  update: (id, j) => q('UPDATE cron_jobs SET minute = ?, hour = ?, day = ?, month = ?, weekday = ?, command = ? WHERE id = ?').run(j.minute, j.hour, j.day, j.month, j.weekday, j.command, id),
  remove: (id) => q('DELETE FROM cron_jobs WHERE id = ?').run(id),
  clear: (siteId) => q('DELETE FROM cron_jobs WHERE site_id = ?').run(siteId),
};
const dbServers = {
  list: () => q('SELECT id, engine, host, port, admin_user, is_default, (admin_password_enc IS NOT NULL) AS has_password FROM database_servers ORDER BY engine').all().map((r) => Object.assign(r, { is_default: !!r.is_default, has_password: !!r.has_password })),
  get: (id) => q('SELECT * FROM database_servers WHERE id = ?').get(id) || null,
  byEngine: (engine) => q('SELECT * FROM database_servers WHERE engine = ? ORDER BY is_default DESC, id').get(engine) || null,
  upsert: (s) => q('INSERT INTO database_servers (engine, host, port, admin_user, admin_password_enc, is_default) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(engine, host, port) DO UPDATE SET admin_user = excluded.admin_user, admin_password_enc = COALESCE(excluded.admin_password_enc, database_servers.admin_password_enc), is_default = excluded.is_default')
    .run(s.engine, s.host, Number(s.port), s.admin_user, s.admin_password_enc || null, s.is_default ? 1 : 0),
};
const databases = {
  list: (siteId) => q('SELECT d.*, s.engine, s.host, s.port AS server_port FROM databases d JOIN database_servers s ON s.id = d.server_id WHERE d.site_id = ? ORDER BY d.name').all(siteId),
  get: (id) => q('SELECT d.*, s.engine, s.host, s.port AS server_port FROM databases d JOIN database_servers s ON s.id = d.server_id WHERE d.id = ?').get(id) || null,
  byName: (serverId, name) => q('SELECT * FROM databases WHERE server_id = ? AND name = ?').get(serverId, name) || null,
  insert: (d) => Number(q('INSERT INTO databases (site_id, server_id, name, created_at) VALUES (?, ?, ?, ?)').run(d.site_id, d.server_id, d.name, d.created_at || now()).lastInsertRowid),
  remove: (id) => q('DELETE FROM databases WHERE id = ?').run(id),
  users: (databaseId) => q('SELECT id, database_id, username, permissions, (password_enc IS NOT NULL) AS has_password, created_at FROM database_users WHERE database_id = ? ORDER BY username').all(databaseId).map((r) => Object.assign(r, { has_password: !!r.has_password })),
  user: (id) => q('SELECT * FROM database_users WHERE id = ?').get(id) || null,
  insertUser: (u) => Number(q('INSERT INTO database_users (database_id, username, password_enc, permissions, created_at) VALUES (?, ?, ?, ?, ?)').run(u.database_id, u.username, u.password_enc || null, u.permissions || 'rw', u.created_at || now()).lastInsertRowid),
  removeUser: (id) => q('DELETE FROM database_users WHERE id = ?').run(id),
};
const templates = {
  list: () => q('SELECT id, name, type, php_version, root_dir, source, updated_at, (varnish_settings IS NOT NULL) AS has_varnish FROM vhost_templates ORDER BY type, name').all().map((r) => Object.assign(r, { has_varnish: !!r.has_varnish })),
  get: (name) => q('SELECT * FROM vhost_templates WHERE name = ?').get(String(name)) || null,
  upsert: (t) => q('INSERT INTO vhost_templates (name, type, php_version, root_dir, template, varnish_settings, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET type = excluded.type, php_version = excluded.php_version, root_dir = excluded.root_dir, template = excluded.template, varnish_settings = excluded.varnish_settings, source = excluded.source, updated_at = excluded.updated_at')
    .run(t.name, t.type, t.php_version || null, t.root_dir || null, t.template, t.varnish_settings || null, t.source || 'clp', now()),
};

// Every unix user name this panel is allowed to touch (site users, SSH users, FTP users).
function knownUnixUsers() {
  const db = open();
  return new Set([
    ...db.prepare('SELECT user AS u FROM sites').all().map((r) => r.u),
    ...db.prepare('SELECT username AS u FROM ssh_users').all().map((r) => r.u),
    ...db.prepare('SELECT username AS u FROM ftp_users').all().map((r) => r.u),
  ]);
}
function usedPorts() {
  const db = open();
  return new Set([
    ...db.prepare('SELECT port FROM site_nodejs').all().map((r) => r.port),
    ...db.prepare('SELECT port FROM site_python').all().map((r) => r.port),
    ...db.prepare('SELECT pool_port AS port FROM site_php').all().map((r) => r.port),
  ]);
}

// Per-site Cloudflare binding. token_enc is NULL when the site rides on the account-wide token.
const cloudflare = {
  get: (siteId) => q('SELECT * FROM site_cloudflare WHERE site_id = ?').get(siteId) || null,
  token: (siteId) => { const r = q('SELECT token_enc FROM site_cloudflare WHERE site_id = ?').get(siteId); if (!r || !r.token_enc) return null; try { return secrets.decrypt(r.token_enc); } catch (_) { return null; } },
  set: (siteId, patch) => {
    const cur = cloudflare.get(siteId) || {};
    const row = Object.assign({ token_enc: null, zone_id: null, zone_name: null, account_id: null, account_name: null, checked_at: now(), last_error: null }, cur, patch);
    if (patch.token !== undefined) row.token_enc = patch.token ? secrets.encrypt(String(patch.token).trim()) : null;
    q(`INSERT INTO site_cloudflare (site_id, token_enc, zone_id, zone_name, account_id, account_name, checked_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id) DO UPDATE SET token_enc = excluded.token_enc, zone_id = excluded.zone_id, zone_name = excluded.zone_name,
         account_id = excluded.account_id, account_name = excluded.account_name, checked_at = excluded.checked_at, last_error = excluded.last_error`)
      .run(siteId, row.token_enc, row.zone_id, row.zone_name, row.account_id, row.account_name, row.checked_at, row.last_error);
    return cloudflare.get(siteId);
  },
  remove: (siteId) => q('DELETE FROM site_cloudflare WHERE site_id = ?').run(siteId),
};

module.exports = { list, get, getById, byUser, publicView, password, insert, update, claim, remove, setPhp, setNodejs, setPython,
  certs, basicAuth, blockedIps, blockedBots, sshUsers, ftpUsers, cronJobs, dbServers, databases, templates, knownUnixUsers, usedPorts, cloudflare };
