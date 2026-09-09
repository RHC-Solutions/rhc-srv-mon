'use strict';
// SQLite databases for a site: a file in the site's own home, and nothing else.
//
// The other two engines are servers — a daemon to reach, an admin credential to hold, accounts and
// grants to keep in step. SQLite has none of that, which is exactly why it is the right default for
// a small site: no MariaDB to start (this host deliberately leaves it off), no password to leak, no
// grant reachable from outside. The cost is that "who may read it" is answered by unix permissions,
// so the file is owned by the site user's group and kept group-writable: the app may well run as one
// of the site's SSH users rather than the site user itself, and a database it can read but not write
// is worse than none. Nothing outside the group can reach it.
//
// The panel's own tables want every database to belong to a server row, so each site gets one
// pseudo-server (engine 'sqlite', host = the domain, port 0). That keeps database names unique per
// site rather than globally, which is what an operator expects — two sites may both have "app".
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { DatabaseSync } = require('node:sqlite');
const store = require('./store');

const NAME_RE = /^[A-Za-z0-9_]{1,63}$/;
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });

const dirFor = (site) => path.join('/home', site.user, 'databases');
const fileFor = (site, name) => path.join(dirFor(site), name + '.sqlite');

function checkName(name) {
  const s = String(name == null ? '' : name);
  if (!NAME_RE.test(s)) throw bad('invalid database name "' + s.slice(0, 40) + '": letters, digits and underscore only, 1–63 characters');
  return s;
}
function ownerOf(site) {
  try { const st = fs.statSync('/home/' + site.user); return { uid: st.uid, gid: st.gid }; } catch (_) { return { uid: 0, gid: 0 }; }
}
// The row every SQLite database on this site hangs off. Created on demand — a site that never asks
// for one never gets a server row.
function serverFor(site) {
  const existing = store.dbServers.byEngineHost('sqlite', site.domain);
  if (existing) return existing;
  store.dbServers.upsert({ engine: 'sqlite', host: site.domain, port: 0, admin_user: site.user, admin_password_enc: null, is_default: 0 });
  const made = store.dbServers.byEngineHost('sqlite', site.domain);
  if (!made) throw bad('could not record a SQLite store for this site', 500);
  return made;
}
function ensureDir(site) {
  const dir = dirFor(site), o = ownerOf(site);
  // chmod after mkdir: the mode argument is masked by the process umask (0022 under pm2), chmod is not.
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  try { fs.chownSync(dir, o.uid, o.gid); fs.chmodSync(dir, 0o770); } catch (_) {}
  return dir;
}

// A real database file, not an empty one: an empty file is a valid but header-less SQLite database
// that some clients refuse, so the header is written by actually opening and closing it.
function create(site, name) {
  name = checkName(name);
  const server = serverFor(site);
  if (store.databases.byName(server.id, name)) throw bad('this site already has a SQLite database called ' + name, 409);
  ensureDir(site);
  const file = fileFor(site, name);
  if (fs.existsSync(file)) throw bad('a file already exists at ' + file, 409);
  const o = ownerOf(site);
  try {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.close();
  } catch (e) { throw bad('could not create the database file: ' + e.message, 500); }
  for (const f of [file, file + '-wal', file + '-shm']) {
    try { if (fs.existsSync(f)) { fs.chownSync(f, o.uid, o.gid); fs.chmodSync(f, 0o660); } } catch (_) {}
  }
  const id = store.databases.insert({ site_id: site.id, server_id: server.id, name });
  return { ok: true, id, engine: 'sqlite', name, file, user: site.user, permissions: 'rw' };
}

function drop(site, d, opts) {
  opts = opts || {};
  const file = fileFor(site, d.name);
  let removed = false;
  if (opts.keepData !== true) {
    for (const f of [file + '-wal', file + '-shm', file]) {
      try { if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; } } catch (e) { throw bad('could not remove ' + f + ': ' + e.message, 500); }
    }
  }
  store.databases.remove(d.id);
  return { ok: true, dropped: removed, name: d.name, engine: 'sqlite', file };
}

// Size and table count straight off the file — no server to ask.
function info(site, name) {
  const file = fileFor(site, name);
  let st = null; try { st = fs.statSync(file); } catch (_) { return undefined; }
  let tables = null;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;
    db.close();
  } catch (_) {}
  let bytes = st.size;
  for (const suffix of ['-wal', '-shm']) { try { bytes += fs.statSync(file + suffix).size; } catch (_) {} }
  return { bytes, tables, file, mode: (st.mode & 0o777).toString(8) };
}

function tables(site, name) {
  const file = fileFor(site, name);
  if (!fs.existsSync(file)) throw bad('the database file is gone: ' + file, 404);
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const out = rows.map((r) => {
      let n = null;
      try { n = db.prepare('SELECT COUNT(*) AS n FROM "' + String(r.name).replace(/"/g, '""') + '"').get().n; } catch (_) {}
      return { name: r.name, rows: n, bytes: null, engine: 'sqlite' };
    });
    db.close();
    return out;
  } catch (e) { throw bad('could not read the database: ' + e.message, 500); }
}

// `.dump` gives portable SQL, the same shape the other two engines export.
function dump(site, name) {
  const file = fileFor(site, name);
  if (!fs.existsSync(file)) throw bad('the database file is gone: ' + file, 404);
  return new Promise((resolve, reject) => {
    execFile('sqlite3', [file, '.dump'], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(bad('sqlite3 .dump failed: ' + (stderr || err.message), 500)) : resolve(stdout)));
  });
}
function vacuum(site, name) {
  const file = fileFor(site, name);
  if (!fs.existsSync(file)) throw bad('the database file is gone: ' + file, 404);
  try {
    const db = new DatabaseSync(file);
    db.exec('VACUUM');
    db.close();
    return { ok: true, output: 'VACUUM completed' };
  } catch (e) { throw bad('VACUUM failed: ' + e.message, 500); }
}

module.exports = { create, drop, info, tables, dump, vacuum, serverFor, fileFor, dirFor, checkName };
