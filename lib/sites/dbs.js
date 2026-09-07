'use strict';
// Databases for a site, on MariaDB and PostgreSQL.
//
// DDL cannot be parameterised, so every identifier is validated against a strict pattern and every
// literal is checked for quote/backslash/NUL before it goes near a statement. Passwords the panel
// generates come from an alphanumeric alphabet for the same reason; one supplied by hand is rejected
// if it contains a character that could end the literal.
//
// MariaDB is reached over TCP with the admin password in MYSQL_PWD (never argv, which is world
// readable in /proc). PostgreSQL is reached over its unix socket as root, which pg_hba maps to the
// postgres role (`map=localroot`) — so it needs no stored password at all.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const secrets = require('../secrets');
const { PG_SOCKET } = require('../util');
const store = require('./store');
const { getent } = require('./users');

const IDENT = /^[A-Za-z0-9_]{1,63}$/;
const ENGINES = ['mariadb', 'postgres'];
// This host's MariaDB listens on all interfaces, so a '%' grant would be reachable from outside.
const MY_HOSTS = ['localhost', '127.0.0.1'];
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });

function ident(v, what) {
  const s = String(v == null ? '' : v);
  if (!IDENT.test(s)) throw bad('invalid ' + (what || 'name') + ' "' + s.slice(0, 40) + '": letters, digits and underscore only, 1–63 characters');
  return s;
}
function lit(v) {
  const s = String(v == null ? '' : v);
  if (/['"\\\x00\r\n]/.test(s)) throw bad('that password contains a character this panel will not put in a SQL statement (quote, backslash or newline) — let it generate one instead');
  return "'" + s + "'";
}
const engineOf = (e) => { const s = String(e || '').toLowerCase(); if (!ENGINES.includes(s)) throw bad('unknown engine "' + s + '" (mariadb | postgres)'); return s; };

function run(cmd, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const child = execFile(cmd, args, {
      timeout: opts.timeout || 120_000, maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/root' }, opts.env || {}),
    }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    if (opts.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(opts.stdin); }
    else if (opts.stdinStream) { child.stdin.on('error', () => {}); opts.stdinStream.pipe(child.stdin); }
  });
}

/* ------------------------------------------------------------ servers + admin credentials */
function serverFor(engine) {
  const s = store.dbServers.byEngine(engineOf(engine));
  if (!s) throw bad('no ' + engine + ' server is configured in this panel', 409);
  return s;
}
function adminPassword(server) {
  if (!server.admin_password_enc) return null;
  try { return secrets.decrypt(server.admin_password_enc); } catch (_) { return null; }
}
function failed(r, engine) {
  const msg = (r.stderr || r.stdout || (r.err && r.err.message) || 'command failed').trim().split('\n').filter(Boolean).slice(-3).join('; ');
  if (/access denied/i.test(msg)) {
    return bad('MariaDB refused the panel\'s admin credentials', 409,
      'Open “Root password manager” on this tab: import the password from CloudPanel, or paste the MariaDB root password. '
      + 'It is stored encrypted and used only from this server.');
  }
  if (/peer authentication|role .* does not exist/i.test(msg)) {
    return bad('PostgreSQL refused the connection', 409,
      'The panel connects over the unix socket as root, which pg_hba.conf must map to a superuser role (this host uses `local all postgres peer map=localroot`). ' + msg);
  }
  return bad((engine === 'postgres' ? 'PostgreSQL: ' : 'MariaDB: ') + msg, 400);
}

// Run SQL on MariaDB. Which connection works is not knowable up front: a Debian default gives unix
// root socket access with no password at all, while CloudPanel switches root to a password over TCP —
// and the two are granted to different accounts ('root'@'localhost' vs 'root'@'127.0.0.1'). So the
// candidates are tried in order of least privilege needed and the winner is cached.
const MY_SOCKETS = ['/run/mysqld/mysqld.sock', '/var/run/mysqld/mysqld.sock', '/tmp/mysql.sock'];
let myConn = null;                       // { kind: 'socket'|'tcp', socket?, withPassword }
function myCandidates(server) {
  const pw = adminPassword(server);
  const out = [];
  for (const sock of MY_SOCKETS) { if (!fs.existsSync(sock)) continue; out.push({ kind: 'socket', socket: sock, withPassword: false }); if (pw) out.push({ kind: 'socket', socket: sock, withPassword: true }); }
  out.push({ kind: 'tcp', withPassword: !!pw });
  return out;
}
function myArgs(server, c, opts) {
  const args = c.kind === 'socket'
    ? ['--protocol=SOCKET', '-S', c.socket, '-u', server.admin_user]
    : ['--protocol=TCP', '-h', server.host, '-P', String(server.port), '-u', server.admin_user];
  args.push('--batch', '--skip-column-names');
  if (opts && opts.db) args.push(ident(opts.db, 'database'));
  return args;
}
async function my(server, sql, opts) {
  opts = opts || {};
  const pw = adminPassword(server);
  const tries = myConn ? [myConn].concat(myCandidates(server).filter((c) => c.kind !== myConn.kind || c.withPassword !== myConn.withPassword)) : myCandidates(server);
  let last = null;
  for (const c of tries) {
    const r = await run('mariadb', myArgs(server, c, opts), { stdin: sql, env: c.withPassword && pw ? { MYSQL_PWD: pw } : {}, timeout: opts.timeout });
    if (!r.err) { myConn = c; return r.stdout; }
    last = r;
    // Only an authentication refusal is worth trying another connection for; a SQL error is final.
    if (!/access denied|can't connect|cannot connect|connection refused|no such file/i.test((r.stderr || r.stdout || ''))) break;
  }
  myConn = null;
  throw failed(last || { err: new Error('no MariaDB connection could be attempted') }, 'mariadb');
}
// Which connection the panel ended up using, for the Root password manager to report.
const myConnection = () => (myConn ? { kind: myConn.kind, socket: myConn.socket || null, uses_password: myConn.withPassword } : null);
// Run SQL on PostgreSQL. ON_ERROR_STOP makes a mid-script failure an error instead of a partial run.
async function pg(server, sql, opts) {
  opts = opts || {};
  const args = ['-U', server.admin_user, '-h', server.host || PG_SOCKET, '-p', String(server.port || 5432),
    '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-A', '-t', '-d', opts.db ? ident(opts.db, 'database') : 'postgres', '-f', '-'];
  const r = await run('psql', args, { stdin: sql, timeout: opts.timeout });
  if (r.err) throw failed(r, 'postgres');
  return r.stdout;
}
const sql = (server, text, opts) => (server.engine === 'postgres' ? pg(server, text, opts) : my(server, text, opts));

// Does the stored admin credential actually work? Returns the engine version when it does.
async function testAdmin(engine) {
  const server = serverFor(engine);
  const base = { engine, host: server.host, port: server.port, admin_user: server.admin_user, has_password: !!server.admin_password_enc };
  const svc = await serviceState(engine).catch(() => null);
  base.service = svc;
  try {
    const out = await sql(server, engine === 'postgres' ? 'SELECT version();' : 'SELECT VERSION();', { timeout: 20_000 });
    return Object.assign({ ok: true, version: out.trim().split('\n')[0] || null }, base);
  } catch (e) {
    // A stopped service is not a credential problem, and saying so avoids sending someone hunting
    // for a password when the answer is `systemctl start`.
    if (svc && svc.active !== 'active') {
      return Object.assign({ ok: false, stopped: true, error: (engine === 'postgres' ? 'PostgreSQL' : 'MariaDB') + ' is not running (' + svc.unit + ' is ' + svc.active + (svc.enabled ? ', ' + svc.enabled : '') + ')',
        detail: 'Nothing on this host uses it right now. Start it when a site needs it: systemctl enable --now ' + svc.unit }, base);
    }
    return Object.assign({ ok: false, error: e.message, detail: e.detail || null }, base);
  }
}
// Store an admin credential, but only after proving it works.
async function setAdmin(engine, password, adminUser) {
  const server = serverFor(engine);
  const probe = Object.assign({}, server, { admin_user: adminUser ? String(adminUser).trim() : server.admin_user, admin_password_enc: password ? secrets.encrypt(String(password)) : null });
  const out = await sql(probe, engine === 'postgres' ? 'SELECT version();' : 'SELECT VERSION();', { timeout: 20_000 });
  store.dbServers.upsert({ engine: server.engine, host: server.host, port: server.port, admin_user: probe.admin_user, admin_password_enc: probe.admin_password_enc, is_default: server.is_default });
  return { ok: true, engine, version: out.trim().split('\n')[0] || null, admin_user: probe.admin_user };
}
// CloudPanel keeps the MariaDB root password encrypted in its own database; clpctl prints it. Take
// it once, verify it, store it encrypted here — the panel never shows it unless asked.
async function importAdminFromCloudPanel() {
  const r = await run('clpctl', ['db:show:master-credentials'], { timeout: 60_000 });
  if (r.err) throw bad('clpctl could not show the master credentials', 409, (r.stderr || r.stdout || '').trim().slice(0, 500));
  const m = /-p'([^']+)'/.exec(r.stdout) || /^\|\s*Password\s*\|\s*(\S+)\s*\|/m.exec(r.stdout);
  if (!m) throw bad('could not find a password in clpctl\'s output', 500);
  const res = await setAdmin('mariadb', m[1]);
  return Object.assign({ source: 'cloudpanel' }, res);
}
// Is the engine's service even running? A stopped MariaDB and a wrong password both surface as a
// failed connection, and they need completely different responses.
async function serviceState(engine) {
  const unit = engine === 'postgres' ? 'postgresql' : 'mariadb';
  const r = await run('systemctl', ['is-active', unit], { timeout: 10_000 });
  const active = (r.stdout || '').trim();
  const e = await run('systemctl', ['is-enabled', unit], { timeout: 10_000 });
  return { unit, active, enabled: (e.stdout || '').trim() };
}

// Reset MariaDB's root authentication when nobody holds the password any more.
//
// Deliberately NOT --skip-grant-tables: that removes authentication from the whole server for the
// length of the window. --init-file runs one script as root at startup while normal authentication
// stays enforced, and the unit already supports it through $MYSQLD_OPTS. root is left with BOTH
// unix_socket (so this panel, running as root, needs no stored password at all — the same deal
// PostgreSQL gives) and a generated password for TCP clients. Each statement is on its own line:
// --init-file does not accept multi-line statements.
const MY_DROPIN = '/etc/systemd/system/mariadb.service.d/zz-rhc-root-reset.conf';
const MY_INIT_SQL = '/var/lib/rhc-srv-mon/mariadb-root-reset.sql';
async function resetMariadbRoot() {
  const server = serverFor('mariadb');
  const pw = secrets.generatePassword(32);
  lit(pw);
  const steps = [];
  const say = (name, detail) => { steps.push({ name, detail: detail || null }); };
  const sysd = async (args, what) => { const r = await run('systemctl', args, { timeout: 120_000 }); if (r.err) throw bad('systemctl ' + args.join(' ') + ' failed: ' + ((r.stderr || r.stdout || '').trim().slice(0, 300) || what), 500); };
  try {
    fs.mkdirSync(path.dirname(MY_INIT_SQL), { recursive: true });
    fs.writeFileSync(MY_INIT_SQL, [
      "CREATE USER IF NOT EXISTS 'root'@'localhost';",
      "ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket OR mysql_native_password USING PASSWORD(" + lit(pw) + ");",
      "GRANT ALL PRIVILEGES ON *.* TO 'root'@'localhost' WITH GRANT OPTION;",
      'FLUSH PRIVILEGES;',
      '',
    ].join('\n'), { mode: 0o640 });
    try { fs.chownSync(MY_INIT_SQL, 0, (getent('mysql') || {}).gid || 0); } catch (_) {}
    say('wrote the init script', MY_INIT_SQL);

    fs.mkdirSync(path.dirname(MY_DROPIN), { recursive: true });
    fs.writeFileSync(MY_DROPIN, '# temporary: rhc-srv-mon root auth reset. Removed automatically.\n[Service]\nEnvironment="MYSQLD_OPTS=--init-file=' + MY_INIT_SQL + '"\n', { mode: 0o644 });
    await sysd(['daemon-reload']);
    say('installed a temporary systemd drop-in', MY_DROPIN);

    await sysd(['restart', 'mariadb']);
    say('restarted MariaDB with the init script');
    // give it a moment to finish the init script and open the socket
    for (let i = 0; i < 20; i++) {
      try { await my(Object.assign({}, server, { admin_password_enc: null }), 'SELECT 1;', { timeout: 10_000 }); break; }
      catch (e) { if (i === 19) throw e; await new Promise((r) => setTimeout(r, 1000)); }
    }
    say('root now authenticates over the unix socket with no password');
  } finally {
    // Always take the drop-in away again, even if something above failed: leaving it behind would
    // re-run the reset on every boot.
    try { fs.unlinkSync(MY_DROPIN); } catch (_) {}
    try { fs.unlinkSync(MY_INIT_SQL); } catch (_) {}
    try { await run('systemctl', ['daemon-reload'], { timeout: 60_000 }); } catch (_) {}
  }
  await run('systemctl', ['restart', 'mariadb'], { timeout: 120_000 });
  say('removed the drop-in and restarted MariaDB normally');
  const res = await setAdmin('mariadb', pw);        // verifies over TCP, then stores it encrypted
  say('verified the generated password over TCP and stored it encrypted');
  return { ok: true, engine: 'mariadb', version: res.version, steps, password: pw };
}

function revealAdmin(engine) {
  const server = serverFor(engine);
  const pw = adminPassword(server);
  if (!pw) throw bad('no password is stored for this server', 404);
  return { engine, admin_user: server.admin_user, password: pw };
}

/* ------------------------------------------------------------ listing */
async function sizes(server, names) {
  const out = new Map();
  if (!names.length) return out;
  try {
    if (server.engine === 'postgres') {
      const rows = await pg(server, 'SELECT datname, pg_database_size(datname) FROM pg_database WHERE datname IN (' + names.map(lit).join(',') + ');');
      for (const l of rows.trim().split('\n').filter(Boolean)) { const [n, b] = l.split('|'); out.set(n, Number(b) || 0); }
    } else {
      const rows = await my(server, 'SELECT table_schema, COALESCE(SUM(data_length+index_length),0), COUNT(*) FROM information_schema.tables WHERE table_schema IN ('
        + names.map(lit).join(',') + ') GROUP BY table_schema;');
      for (const l of rows.trim().split('\n').filter(Boolean)) { const [n, b, t] = l.split('\t'); out.set(n, { bytes: Number(b) || 0, tables: Number(t) || 0 }); }
    }
  } catch (_) { /* sizes are a nicety; never fail the listing over them */ }
  return out;
}
// Databases this panel knows for the site, annotated with what the server actually reports, plus
// the databases that exist on the server and are NOT recorded here (imported sites, CLI-created).
async function list(site) {
  const rows = store.databases.list(site.id);
  const out = { databases: [], servers: [], unmanaged: [] };
  for (const engine of ENGINES) {
    const t = await testAdmin(engine).catch((e) => ({ ok: false, engine, error: e.message }));
    out.servers.push(t);
  }
  const byEngine = new Map();
  for (const r of rows) { if (!byEngine.has(r.engine)) byEngine.set(r.engine, []); byEngine.get(r.engine).push(r); }
  for (const [engine, list_] of byEngine) {
    let server = null; try { server = serverFor(engine); } catch (_) {}
    const s = server ? await sizes(server, list_.map((d) => d.name)) : new Map();
    for (const d of list_) {
      const info = s.get(d.name);
      out.databases.push(Object.assign({}, d, {
        users: store.databases.users(d.id).map((u) => ({ id: u.id, username: u.username, permissions: u.permissions, has_password: !!u.password_enc })),
        bytes: typeof info === 'number' ? info : (info && info.bytes) || null,
        tables: info && info.tables != null ? info.tables : null,
        exists: info !== undefined,
      }));
    }
  }
  // Anything on the servers that we do not have a row for, so nothing is invisible.
  const known = new Set(rows.map((r) => r.engine + ':' + r.name));
  for (const engine of ENGINES) {
    const t = out.servers.find((x) => x.engine === engine);
    if (!t || !t.ok) continue;
    let server; try { server = serverFor(engine); } catch (_) { continue; }
    try {
      const q = engine === 'postgres'
        ? "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY 1;"
        : "SHOW DATABASES;";
      const skip = engine === 'postgres' ? new Set() : new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
      for (const n of (await sql(server, q)).trim().split('\n').map((x) => x.trim()).filter(Boolean)) {
        if (skip.has(n) || known.has(engine + ':' + n)) continue;
        out.unmanaged.push({ engine, name: n });
      }
    } catch (_) { /* listing extras is best-effort */ }
  }
  return out;
}

/* ------------------------------------------------------------ create / drop */
const GRANT_RW = { mariadb: 'ALL PRIVILEGES', postgres: 'ALL PRIVILEGES' };
// Start (and enable) an engine that is switched off. MariaDB is left disabled on a host where no
// site uses it; the moment one asks for a MySQL database, that has to stop being an obstacle.
async function ensureRunning(engine) {
  const svc = await serviceState(engine).catch(() => null);
  if (!svc || svc.active === 'active') return null;
  const r = await run('systemctl', ['enable', '--now', svc.unit], { timeout: 120_000 });
  if (r.err) throw bad('could not start ' + svc.unit + ': ' + ((r.stderr || r.stdout || '').trim().slice(0, 200)), 500);
  for (let i = 0; i < 20; i++) {
    const t = await testAdmin(engine);
    if (t.ok) return { started: svc.unit, was: svc.active };
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw bad(svc.unit + ' was started but is still not answering', 500);
}

async function create(site, opts) {
  opts = opts || {};
  const engine = engineOf(opts.engine);
  const started = await ensureRunning(engine);
  const server = serverFor(engine);
  const name = ident(opts.name, 'database name');
  const username = ident(opts.user || opts.username || name, 'user name');
  const perms = opts.permissions === 'ro' ? 'ro' : 'rw';
  const password = opts.password ? String(opts.password) : secrets.generatePassword(24);
  if (String(password).length < 12) throw bad('database password must be at least 12 characters');
  lit(password);                                   // reject anything unquotable before we start
  if (store.databases.byName(server.id, name)) throw bad('this panel already manages a database called ' + name, 409);

  if (engine === 'mariadb') {
    await my(server, 'CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;');
    try {
      for (const h of MY_HOSTS) {
        await my(server, 'CREATE USER ' + lit(username) + '@' + lit(h) + ' IDENTIFIED BY ' + lit(password) + ';');
        await my(server, 'GRANT ' + (perms === 'ro' ? 'SELECT, SHOW VIEW' : GRANT_RW.mariadb) + ' ON `' + name + '`.* TO ' + lit(username) + '@' + lit(h) + ';');
      }
      await my(server, 'FLUSH PRIVILEGES;');
    } catch (e) { await my(server, 'DROP DATABASE IF EXISTS `' + name + '`;').catch(() => {}); throw e; }
  } else {
    // CREATE DATABASE cannot run inside a transaction, so these are separate statements.
    await pg(server, 'CREATE ROLE "' + username + '" LOGIN PASSWORD ' + lit(password) + ';');
    try {
      await pg(server, 'CREATE DATABASE "' + name + '" OWNER "' + username + '" ENCODING \'UTF8\';');
      if (perms === 'ro') {
        await pg(server, 'REVOKE ALL ON DATABASE "' + name + '" FROM "' + username + '"; GRANT CONNECT ON DATABASE "' + name + '" TO "' + username + '";');
        await pg(server, 'GRANT USAGE ON SCHEMA public TO "' + username + '"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "' + username + '"; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO "' + username + '";', { db: name });
      }
    } catch (e) { await pg(server, 'DROP ROLE IF EXISTS "' + username + '";').catch(() => {}); throw e; }
  }
  const dbId = store.databases.insert({ site_id: site.id, server_id: server.id, name });
  store.databases.insertUser({ database_id: dbId, username, password_enc: secrets.encrypt(password), permissions: perms });
  return { ok: true, id: dbId, engine, name, user: username, password, permissions: perms, grant_hosts: engine === 'mariadb' ? MY_HOSTS : null, started };
}

async function drop(site, id, opts) {
  opts = opts || {};
  const d = store.databases.get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const server = serverFor(d.engine);
  const users = store.databases.users(d.id);
  if (opts.keepData !== true) {
    if (d.engine === 'mariadb') await my(server, 'DROP DATABASE IF EXISTS `' + ident(d.name) + '`;');
    else await pg(server, 'DROP DATABASE IF EXISTS "' + ident(d.name) + '" WITH (FORCE);');
  }
  if (opts.dropUsers !== false) {
    for (const u of users) {
      try {
        if (d.engine === 'mariadb') for (const h of MY_HOSTS) await my(server, 'DROP USER IF EXISTS ' + lit(u.username) + '@' + lit(h) + ';');
        else await pg(server, 'DROP ROLE IF EXISTS "' + ident(u.username) + '";');
      } catch (_) { /* a role still owning objects elsewhere is not fatal here */ }
    }
  }
  store.databases.remove(d.id);
  return { ok: true, dropped: opts.keepData !== true, name: d.name, engine: d.engine };
}

/* ------------------------------------------------------------ users + permissions */
async function setUserPermissions(site, dbId, userId, perms) {
  const d = store.databases.get(dbId);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const u = store.databases.user(Number(userId));
  if (!u || u.database_id !== d.id) throw bad('unknown database user', 404);
  const p = perms === 'ro' ? 'ro' : 'rw';
  const server = serverFor(d.engine);
  const name = ident(d.name), un = ident(u.username);
  if (d.engine === 'mariadb') {
    for (const h of MY_HOSTS) {
      await my(server, 'REVOKE ALL PRIVILEGES ON `' + name + '`.* FROM ' + lit(un) + '@' + lit(h) + ';').catch(() => {});
      await my(server, 'GRANT ' + (p === 'ro' ? 'SELECT, SHOW VIEW' : GRANT_RW.mariadb) + ' ON `' + name + '`.* TO ' + lit(un) + '@' + lit(h) + ';');
    }
    await my(server, 'FLUSH PRIVILEGES;');
  } else {
    if (p === 'ro') {
      await pg(server, 'REVOKE ALL ON DATABASE "' + name + '" FROM "' + un + '"; GRANT CONNECT ON DATABASE "' + name + '" TO "' + un + '";');
      await pg(server, 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM "' + un + '"; GRANT USAGE ON SCHEMA public TO "' + un + '"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "' + un + '";', { db: name });
    } else {
      await pg(server, 'GRANT ALL PRIVILEGES ON DATABASE "' + name + '" TO "' + un + '";');
      await pg(server, 'GRANT ALL ON SCHEMA public TO "' + un + '"; GRANT ALL ON ALL TABLES IN SCHEMA public TO "' + un + '";', { db: name });
    }
  }
  store.databases.updateUser(u.id, { permissions: p });
  return { ok: true, id: u.id, permissions: p };
}
async function setUserPassword(site, dbId, userId, password) {
  const d = store.databases.get(dbId);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const u = store.databases.user(Number(userId));
  if (!u || u.database_id !== d.id) throw bad('unknown database user', 404);
  const pw = password ? String(password) : secrets.generatePassword(24);
  if (pw.length < 12) throw bad('password must be at least 12 characters');
  lit(pw);
  const server = serverFor(d.engine);
  if (d.engine === 'mariadb') { for (const h of MY_HOSTS) await my(server, 'ALTER USER ' + lit(u.username) + '@' + lit(h) + ' IDENTIFIED BY ' + lit(pw) + ';'); await my(server, 'FLUSH PRIVILEGES;'); }
  else await pg(server, 'ALTER ROLE "' + ident(u.username) + '" PASSWORD ' + lit(pw) + ';');
  store.databases.updateUser(u.id, { password_enc: secrets.encrypt(pw) });
  return { ok: true, id: u.id, password: pw };
}
function revealUserPassword(site, dbId, userId) {
  const d = store.databases.get(dbId);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const u = store.databases.user(Number(userId));
  if (!u || u.database_id !== d.id) throw bad('unknown database user', 404);
  if (!u.password_enc) throw bad('no password stored for that user', 404);
  return { id: u.id, username: u.username, password: secrets.decrypt(u.password_enc) };
}

/* ------------------------------------------------------------ export / import / tools */
function backupDir(site) {
  const dir = path.join('/home', site.user, 'backups', 'databases');
  const ent = getent(site.user);
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  if (ent) { try { fs.chownSync(dir, ent.uid, ent.gid); fs.chownSync(path.dirname(dir), ent.uid, ent.gid); } catch (_) {} }
  return dir;
}
// Dump into the site's own backups/databases/, owned by the site user like CloudPanel does.
async function exportDb(site, id) {
  const d = store.databases.get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const server = serverFor(d.engine);
  const dir = path.join(backupDir(site), d.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o770 });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, d.name + '-' + stamp + '.sql.gz');
  const pw = adminPassword(server);
  const cmd = d.engine === 'mariadb'
    ? 'mariadb-dump --protocol=TCP -h ' + JSON.stringify(server.host) + ' -P ' + server.port + ' -u ' + JSON.stringify(server.admin_user)
      + ' --single-transaction --quick --routines --triggers --events ' + JSON.stringify(d.name) + ' | gzip -6 > ' + JSON.stringify(file)
    : 'pg_dump -U ' + JSON.stringify(server.admin_user) + ' -h ' + JSON.stringify(server.host || PG_SOCKET) + ' -p ' + (server.port || 5432)
      + ' --no-owner --no-privileges ' + JSON.stringify(d.name) + ' | gzip -6 > ' + JSON.stringify(file);
  const r = await run('bash', ['-o', 'pipefail', '-c', cmd], { env: pw ? { MYSQL_PWD: pw } : {}, timeout: 30 * 60_000 });
  if (r.err) { try { fs.unlinkSync(file); } catch (_) {} throw failed(r, d.engine); }
  const ent = getent(site.user);
  try { fs.chmodSync(file, 0o660); if (ent) fs.chownSync(file, ent.uid, ent.gid); } catch (_) {}
  let size = 0; try { size = fs.statSync(file).size; } catch (_) {}
  return { ok: true, file, size, engine: d.engine, name: d.name };
}
// Load a .sql or .sql.gz stream into an existing database.
function importDb(site, id, req, maxBytes) {
  const d = store.databases.get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const server = serverFor(d.engine);
  const gz = /\.gz$/i.test(String((req.headers && req.headers['x-filename']) || ''));
  const pw = adminPassword(server);
  const load = d.engine === 'mariadb'
    ? 'mariadb --protocol=TCP -h ' + JSON.stringify(server.host) + ' -P ' + server.port + ' -u ' + JSON.stringify(server.admin_user) + ' ' + JSON.stringify(d.name)
    : 'psql -U ' + JSON.stringify(server.admin_user) + ' -h ' + JSON.stringify(server.host || PG_SOCKET) + ' -p ' + (server.port || 5432) + ' -v ON_ERROR_STOP=1 -X -q -d ' + JSON.stringify(d.name);
  const cmd = (gz ? 'gzip -dc | ' : '') + load;
  return new Promise((resolve, reject) => {
    let got = 0, failedEarly = false;
    const child = execFile('bash', ['-o', 'pipefail', '-c', cmd], {
      timeout: 60 * 60_000, maxBuffer: 8 * 1024 * 1024,
      env: Object.assign({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/root' }, pw ? { MYSQL_PWD: pw } : {}),
    }, (err, stdout, stderr) => {
      if (failedEarly) return;
      if (err) return reject(failed({ err, stdout, stderr }, d.engine));
      resolve({ ok: true, engine: d.engine, name: d.name, bytes: got, output: String(stderr || '').trim().slice(0, 2000) });
    });
    child.stdin.on('error', () => {});
    req.on('data', (c) => { got += c.length; if (maxBytes && got > maxBytes && !failedEarly) { failedEarly = true; try { child.kill('SIGKILL'); } catch (_) {} req.destroy(); reject(bad('dump is larger than the ' + Math.round(maxBytes / 1048576) + ' MB limit', 413)); } });
    req.on('error', () => { if (!failedEarly) { failedEarly = true; try { child.kill('SIGKILL'); } catch (_) {} reject(bad('upload aborted', 400)); } });
    req.pipe(child.stdin);
  });
}
// Tables with sizes, and the maintenance actions each engine offers.
async function tables(site, id) {
  const d = store.databases.get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const server = serverFor(d.engine);
  const name = ident(d.name);
  const out = [];
  if (d.engine === 'mariadb') {
    const rows = await my(server, 'SELECT table_name, engine, table_rows, data_length, index_length FROM information_schema.tables WHERE table_schema = ' + lit(name) + ' ORDER BY table_name;');
    for (const l of rows.trim().split('\n').filter(Boolean)) { const f = l.split('\t'); out.push({ name: f[0], engine: f[1], rows: Number(f[2]) || 0, bytes: (Number(f[3]) || 0) + (Number(f[4]) || 0) }); }
  } else {
    const rows = await pg(server, "SELECT relname, n_live_tup, pg_total_relation_size(relid) FROM pg_stat_user_tables ORDER BY relname;", { db: name });
    for (const l of rows.trim().split('\n').filter(Boolean)) { const f = l.split('|'); out.push({ name: f[0], engine: null, rows: Number(f[1]) || 0, bytes: Number(f[2]) || 0 }); }
  }
  return { engine: d.engine, name: d.name, tables: out, actions: d.engine === 'mariadb' ? ['optimize', 'analyze', 'check', 'repair'] : ['vacuum', 'analyze', 'reindex'] };
}
const MY_ACTIONS = { optimize: 'OPTIMIZE', analyze: 'ANALYZE', check: 'CHECK', repair: 'REPAIR' };
const PG_ACTIONS = { vacuum: 'VACUUM (ANALYZE)', analyze: 'ANALYZE', reindex: 'REINDEX DATABASE' };
async function maintain(site, id, action) {
  const d = store.databases.get(id);
  if (!d || d.site_id !== site.id) throw bad('unknown database for this site', 404);
  const server = serverFor(d.engine);
  const name = ident(d.name);
  const a = String(action || '').toLowerCase();
  if (d.engine === 'mariadb') {
    const verb = MY_ACTIONS[a];
    if (!verb) throw bad('unknown action "' + a + '" (' + Object.keys(MY_ACTIONS).join(', ') + ')');
    const names = (await my(server, 'SELECT table_name FROM information_schema.tables WHERE table_schema = ' + lit(name) + " AND table_type = 'BASE TABLE';")).trim().split('\n').filter(Boolean);
    if (!names.length) return { ok: true, action: a, tables: 0, output: 'no base tables' };
    const list_ = names.map((t) => '`' + ident(t, 'table name') + '`').join(', ');
    const out = await my(server, verb + ' TABLE ' + list_ + ';', { db: name, timeout: 30 * 60_000 });
    return { ok: true, action: a, tables: names.length, output: out.trim().slice(0, 4000) };
  }
  const verb = PG_ACTIONS[a];
  if (!verb) throw bad('unknown action "' + a + '" (' + Object.keys(PG_ACTIONS).join(', ') + ')');
  const stmt = a === 'reindex' ? 'REINDEX DATABASE "' + name + '";' : verb + ';';
  const out = await pg(server, stmt, { db: name, timeout: 30 * 60_000 });
  return { ok: true, action: a, output: (out.trim() || verb + ' completed').slice(0, 4000) };
}
// Take an existing server-side database under management (imported sites, CLI-created ones).
function adopt(site, engine, name) {
  const server = serverFor(engine);
  const n = ident(name, 'database name');
  if (store.databases.byName(server.id, n)) throw bad('already managed', 409);
  const id = store.databases.insert({ site_id: site.id, server_id: server.id, name: n });
  return { ok: true, id, engine: server.engine, name: n };
}

module.exports = { myConnection, serviceState, ensureRunning, resetMariadbRoot, list, create, drop, exportDb, importDb, tables, maintain, adopt,
  setUserPermissions, setUserPassword, revealUserPassword,
  testAdmin, setAdmin, importAdminFromCloudPanel, revealAdmin, ENGINES };
