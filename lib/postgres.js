'use strict';
/* -------------------------------------------------------------- postgres */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { APP_ROOT, EXEC_TIMEOUT } = require('./config');
const { PG_SOCKET } = require('./util');
const { CLP_DB } = require('./cloudpanel');
const history = require('./history');
const { open: openDb, settings } = require('./db');
const secrets = require('./secrets');

const DB_CREDS_FILE = path.join(APP_ROOT, 'db-credentials.json');
const PG_HOST = PG_SOCKET;
// Connect as root → postgres role over the unix socket (peer auth, no password).
const DB_SQL = `SELECT json_build_object(
  'version', (SELECT setting FROM pg_settings WHERE name='server_version'),
  'max_connections', (SELECT setting::int FROM pg_settings WHERE name='max_connections'),
  'start_time', (SELECT EXTRACT(EPOCH FROM pg_postmaster_start_time())::bigint),
  'total_conns', (SELECT count(*) FROM pg_stat_activity),
  'dbs', (SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (
     SELECT d.datname AS name,
            pg_get_userbyid(d.datdba) AS owner,
            pg_database_size(d.datname) AS size,
            COALESCE(s.numbackends,0) AS conns,
            COALESCE(s.xact_commit,0) AS commits,
            COALESCE(s.xact_rollback,0) AS rollbacks,
            COALESCE(s.blks_hit,0) AS blks_hit,
            COALESCE(s.blks_read,0) AS blks_read,
            COALESCE(s.tup_inserted,0) AS tup_inserted,
            COALESCE(s.tup_updated,0) AS tup_updated,
            COALESCE(s.tup_deleted,0) AS tup_deleted,
            COALESCE(s.deadlocks,0) AS deadlocks
     FROM pg_database d
     LEFT JOIN pg_stat_database s ON s.datname = d.datname
     WHERE d.datistemplate = false
     ORDER BY pg_database_size(d.datname) DESC
  ) t)
)`;

function pgQuery() {
  return new Promise((resolve) => {
    execFile('psql', ['-U', 'postgres', '-h', PG_SOCKET, '-d', 'postgres', '-tAc', DB_SQL],
      { timeout: EXEC_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout && err.code === 'ENOENT') return resolve({ error: 'not installed', notInstalled: true });
        if (err && !stdout) return resolve({ error: String((err.message || '').split('\n')[0] || err.code) });
        try { resolve({ data: JSON.parse(stdout.trim()) }); }
        catch (e) { resolve({ error: 'parse failed: ' + stdout.slice(0, 120) }); }
      });
  });
}

// Legacy plaintext file (gitignored, but was once committed) — read only by the one-time import.
function loadDbCreds() {
  try { return JSON.parse(fs.readFileSync(DB_CREDS_FILE, 'utf8')).credentials || []; }
  catch (_) { return []; }
}

// Postgres app credentials for the "show password" reveal live ONLY in sqlite (db_credentials,
// password AES-GCM encrypted). The .env / systemd scrape below runs exactly once, as the initial
// import into sqlite (kv pg.credsImported); after that nothing reads .env files again.
const PG_DSN_RE = /postgres(?:ql)?:\/\/([^:/\s"']+):([^@/\s"']+)@([^:/\s"']+)(?::(\d+))?\/([A-Za-z0-9_.-]+)/g;
const ENV_SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'vendor', '.turbo', 'cache', '.cache', 'dist', 'tmp', 'logs']);
let _dbCredsCache = null, _dbCredsAt = 0;
const DB_CREDS_TTL = 5 * 60_000;

function collectEnvFiles(base, out, depth) {
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (depth <= 0 || ENV_SKIP_DIRS.has(e.name)) continue;
      collectEnvFiles(path.join(base, e.name), out, depth - 1);
    } else if (e.name.startsWith('.env') && !/\.(example|sample|template|dist|tmpl)$/i.test(e.name) && out.length < 2000) {
      out.push(path.join(base, e.name));  // skip .env.example / .env.*.sample templates (placeholder creds)
    }
  }
}
// Pull postgres creds from a blob (file contents or NUL-joined process env): both
// postgres:// DSNs and split KEY=VALUE groups. Mislabeled/garbage matches are dropped
// later by the live-PG-role filter in getDbCredentials().
function extractCreds(text, source, found, dec) {
  PG_DSN_RE.lastIndex = 0;
  let m;
  while ((m = PG_DSN_RE.exec(text))) {
    const role = dec(m[1]), password = dec(m[2]), host = m[3], port = m[4] || '5432', database = m[5];
    const key = role + '|' + database + '|' + password;
    if (!found.has(key)) found.set(key, { role, database, password, host, port, source });
  }
  const env = {};
  for (const line of text.split(/[\n\0]/)) {
    const mm = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (mm) env[mm[1].toUpperCase()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  const pick = (...ks) => { for (const k of ks) if (env[k]) return env[k]; return null; };
  const sPw = pick('PGPASSWORD', 'POSTGRES_PASSWORD', 'DB_PASSWORD', 'DATABASE_PASSWORD', 'DB_PASS');
  const sUser = pick('PGUSER', 'POSTGRES_USER', 'DB_USER', 'DB_USERNAME', 'DATABASE_USER');
  if (sPw && sUser) {
    const sDb = pick('PGDATABASE', 'POSTGRES_DB', 'DB_NAME', 'DB_DATABASE', 'DATABASE_NAME') || '(unknown)';
    const sHost = pick('PGHOST', 'POSTGRES_HOST', 'DB_HOST', 'DATABASE_HOST') || '?';
    const key = sUser + '|' + sDb + '|' + sPw;
    if (!found.has(key)) found.set(key, { role: sUser, database: sDb, password: sPw, host: sHost, port: pick('PGPORT', 'DB_PORT') || '5432', source });
  }
}
function recoverDbCredentials() {
  const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
  const found = new Map();
  // 1) systemd units + .env files on disk
  const files = [];
  try { for (const f of fs.readdirSync('/etc/systemd/system')) if (f.endsWith('.service')) files.push('/etc/systemd/system/' + f); } catch (_) {}
  let homes = [];
  try { homes = fs.readdirSync('/home'); } catch (_) {}
  for (const u of homes) {
    const ud = '/home/' + u + '/.config/systemd/user';
    try { for (const f of fs.readdirSync(ud)) if (f.endsWith('.service')) files.push(path.join(ud, f)); } catch (_) {}
    collectEnvFiles('/home/' + u + '/htdocs', files, 4);
  }
  for (const fp of files) { try { extractCreds(fs.readFileSync(fp, 'utf8'), fp, found, dec); } catch (_) {} }
  return [...found.values()].sort((a, b) => a.role.localeCompare(b.role) || a.database.localeCompare(b.database));
}
function listPgLoginRoles() {
  try {
    const out = execFileSync('psql', ['-U', 'postgres', '-h', PG_HOST, '-d', 'postgres', '-tAc',
      "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname NOT LIKE 'pg_%'"],
      { timeout: 10000, encoding: 'utf8' });
    return new Set(out.trim().split('\n').map(s => s.trim()).filter(Boolean));
  } catch (_) { return null; }
}
// Insert or replace one credential (password encrypted). Used by the import and by rotations.
function saveDbCredential(c) {
  if (!c || !c.role || !c.database || !c.password) throw new Error('role, database and password are required');
  openDb().prepare(`INSERT INTO db_credentials (role, database, host, port, password_enc, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(role, database) DO UPDATE SET host = excluded.host, port = excluded.port,
    password_enc = excluded.password_enc, source = excluded.source, updated_at = excluded.updated_at`)
    .run(c.role, c.database, c.host || '127.0.0.1', String(c.port || '5432'), secrets.encrypt(c.password), c.source || null, new Date().toISOString());
  _dbCredsCache = null;
}
function importDbCredentialsOnce() {
  if (settings.get('pg.credsImported', false)) return;
  const merged = new Map();
  for (const c of loadDbCreds()) if (c.password && !/^—/.test(c.password)) merged.set(c.role + '|' + c.database, c);
  for (const c of recoverDbCredentials()) if (!merged.has(c.role + '|' + c.database)) merged.set(c.role + '|' + c.database, c);
  let n = 0;
  for (const c of merged.values()) { try { saveDbCredential(c); n++; } catch (_) {} }
  settings.set('pg.credsImported', new Date().toISOString());
  console.log('db credentials: imported ' + n + ' into sqlite (one-time); .env files are no longer read');
}
function loadDbCredentialsFromSqlite() {
  const out = [];
  for (const r of openDb().prepare('SELECT role, database, host, port, password_enc, source FROM db_credentials ORDER BY role, database').all()) {
    let password = null;
    try { password = secrets.decrypt(r.password_enc); } catch (e) { console.error('db credential decrypt failed for ' + r.role + ':', e.message); continue; }
    out.push({ role: r.role, database: r.database, password, host: r.host, port: r.port, source: r.source || 'sqlite' });
  }
  return out;
}
function getDbCredentials() {
  const now = Date.now();
  if (_dbCredsCache && (now - _dbCredsAt) < DB_CREDS_TTL) return _dbCredsCache;
  try { importDbCredentialsOnce(); } catch (e) { console.error('db credentials import failed:', e.message); }
  let list = loadDbCredentialsFromSqlite();
  // keep only creds whose role is a real PG login role — drops placeholder/MySQL/garbage matches
  const roles = listPgLoginRoles();
  if (roles && roles.size) list = list.filter(c => roles.has(c.role));
  _dbCredsCache = list;
  _dbCredsAt = now;
  return _dbCredsCache;
}

let latestDb = null, latestDbAt = 0;
async function dbSample() {
  const res = await pgQuery();
  latestDb = res; latestDbAt = Date.now();
  const t = Math.floor(Date.now() / 1000);
  if (res.error) return;                         // cluster down: don't fabricate per-db states
  for (const db of res.data.dbs || []) {
    history.record(`db::${db.name}`, 1, t);
  }
}

function buildDbPayload() {
  const r = latestDb || {};
  const dbs = (r.data && r.data.dbs ? r.data.dbs : []).map((db) => {
    const arr = history.get(`db::${db.name}`);
    const total = db.blks_hit + db.blks_read;
    return {
      ...db,
      cache_hit: total > 0 ? (db.blks_hit / total) * 100 : null,
      beats: arr.slice(-history.BEATS_SHOWN),
      uptime24h: history.uptimePct(arr),
    };
  });

  // SQLite info
  let sqlite = null;
  try {
    const out = execFileSync('sqlite3', [CLP_DB,
      "SELECT page_count * page_size, page_size, page_count, (SELECT count(*) FROM sqlite_master WHERE type='table') FROM pragma_page_count, pragma_page_size"
    ], { timeout: 3000, encoding: 'utf8' });
    const [size, pageSize, pageCount, tblCount] = out.trim().split('|');
    const fsize = (() => { try { return fs.statSync(CLP_DB).size; } catch { return 0; } })();
    sqlite = { size: parseInt(size) || 0, fileSize: fsize, pageSize: parseInt(pageSize) || 0, pageCount: parseInt(pageCount) || 0, tables: parseInt(tblCount) || 0, path: CLP_DB };
  } catch { sqlite = fs.existsSync(CLP_DB) ? { error: 'unreachable' } : null; }   // no CloudPanel DB on this host: no section

  // MariaDB info
  let mariadb = null;
  try {
    const out = execFileSync('mariadb', ['-u', 'root', '-proot', '-N', '-e',
      "SELECT CONCAT(VERSION(),'|',COALESCE((SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys')),0),'|',COALESCE((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')),0),'|',COALESCE((SELECT VARIABLE_VALUE FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME='Threads_connected'),'0'),'|',COALESCE((SELECT ROUND(SUM(data_length+index_length)/1024/1024) FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')),0))"
    ], { timeout: 5000, encoding: 'utf8' });
    const [version, dbCount, tblCount, threads, dataMb] = out.trim().split('|');
    // Get per-database sizes
    const dbOut = execFileSync('mariadb', ['-u', 'root', '-proot', '-N', '-e',
      "SELECT TABLE_SCHEMA, COALESCE(ROUND(SUM(data_length+index_length)/1024/1024),0) FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys') GROUP BY TABLE_SCHEMA ORDER BY 2 DESC"
    ], { timeout: 5000, encoding: 'utf8' });
    const dbSizes = dbOut.trim().split('\n').filter(l => l).map(line => {
      const cols = line.split('\t');
      return { name: cols[0] || '?', sizeMb: cols[1] ? parseFloat(cols[1]) : 0 };
    });
    mariadb = {
      version: version || '?', databases: parseInt(dbCount) || 0, tables: parseInt(tblCount) || 0,
      threads: parseInt(threads) || 0, totalDataMb: parseFloat(dataMb) || 0, dbSizes,
      uptime: (() => { try {
        const out2 = execFileSync('mariadb', ['-u', 'root', '-proot', '-N', '-e', "SELECT COALESCE(VARIABLE_VALUE,0) FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME='Uptime'"], { timeout: 3000, encoding: 'utf8' });
        return parseInt(out2.trim()) || 0;
      } catch { return 0; } })(),
    };
  } catch (e) { mariadb = e && e.code === 'ENOENT' ? { error: 'not installed', notInstalled: true } : { error: 'unreachable' }; }

  return {
    generated_at: new Date(latestDbAt || Date.now()).toISOString(),
    error: r.error || null,
    notInstalled: !!r.notInstalled,
    version: r.data && r.data.version,
    max_connections: r.data && r.data.max_connections,
    total_conns: r.data && r.data.total_conns,
    start_time: r.data && r.data.start_time,
    summary: {
      databases: dbs.length,
      total_size: dbs.reduce((s, d) => s + Number(d.size || 0), 0),
      total_conns: r.data ? r.data.total_conns : 0,
    },
    databases: dbs,
    credentials: getDbCredentials(),
    sqlite,
    sqlites: require('./sqlite-scan').get(),
    mariadb,
  };
}


module.exports = { dbSample, buildDbPayload, getDbCredentials, saveDbCredential };
