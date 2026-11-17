'use strict';
/* ---------------------------------------------------------------- backups */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { APP_ROOT } = require('./config');
const { execP, fmtBytes, homeUsers, PG_SOCKET: PG_HOST } = require('./util');
const { querySitesDb, CLP_DB } = require('./cloudpanel');
const notify = require('./notify');
const events = require('./events');
// Backs up Postgres DBs, CloudPanel site files, SQLite databases and key configs to Wasabi
// (S3-compatible) via rclone; the target comes from Settings → Wasabi (lib/wasabi.js), or the
// hand-written rclone.conf on hosts that predate it. Dependency-free:
// shells out to pg_dump / tar+zstd / rclone. Stages on /var/tmp (NOT /tmp,
// which is tmpfs/RAM on this box), uploads, prunes, then deletes the stage.

const BACKUP_FILE   = path.join(APP_ROOT, 'backups.json');
const RCLONE_CONF   = '/root/.config/rclone/rclone.conf';
// Per host: this same app runs on several servers feeding one bucket, so each gets its own
// folder (default <hostname>-backups, see lib/wasabi.js). A shared one would also make prune
// (delete --min-age over the base) eat the other hosts' backups.
const wasabi = require('./wasabi');
const NOT_CONFIGURED = 'Wasabi is not configured — Settings → Wasabi';
const BACKUP_STAGE  = '/var/tmp/rhc-backups';   // local staging (root fs, NOT tmpfs)
// tar --listed-incremental snapshots, one per site: the state of the last FULL backup, which a
// differential run diffs against. Written only by full runs that cover the whole server (never by
// an ad-hoc per-site run), so every diff is relative to a full that lives under <prefix>/<stamp>.
const BACKUP_SNAR_DIR = path.join(APP_ROOT, 'backup-state');
const SITE_SIZE_TTL = 30 * 60_000;       // how long a du of every site's htdocs is trusted
const ALL_SITES_LABEL = 'all-sites';   // opts.site for the "back up every site" run
const BACKUP_LOG_MAX = 100;
// regenerable / heavy dirs excluded from site tarballs
const SITE_TAR_EXCLUDES = ['node_modules', '.next', '.turbo', '.cache', 'cache', 'vendor', '.git', 'logs', 'tmp'];

// What a backup run includes. pgDatabases / siteDomains: null = all, array = only those.
const DEFAULT_BACKUP_SCOPE = {
  postgres: true, pgDatabases: null,
  sites: true, siteDomains: null,
  sqlite: true,
  configs: true, cloudpanelDb: true, crontabs: true, pm2: true, fail2ban: true,
  extraPaths: [],
};
// schedule.mode: 'full' = every scheduled run is a full backup; 'diff' = daily runs only carry the
// site files changed since the last full, with a full one every week (fullDay, 0 = Sunday) or month
// (fullDate). Databases and configs are always complete — only the site tarballs are differential.
let backupsCache = {
  schedule: { enabled: true, hour: 3, minute: 30, mode: 'full', fullEvery: 'weekly', fullDay: 0, fullDate: 1 },
  retentionDays: 14,
  keepFulls: 4,      // never prune below this many full backups, whatever their age
  scope: Object.assign({}, DEFAULT_BACKUP_SCOPE),
  running: false,
  lastRun: null,     // { startedAt, finishedAt, success, bytes, itemCount, items, errors, duration_ms, stamp }
  log: [],           // recent runs (newest last)
};
let backupRunning = false;

function loadBackups() {
  try {
    const data = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
    backupsCache = Object.assign(backupsCache, data);
    backupsCache.scope = Object.assign({}, DEFAULT_BACKUP_SCOPE, backupsCache.scope || {});
    backupsCache.schedule = Object.assign({ mode: 'full', fullEvery: 'weekly', fullDay: 0, fullDate: 1 }, backupsCache.schedule || {});
    if (!backupsCache.keepFulls) backupsCache.keepFulls = 4;
    backupsCache.running = false;        // never resurrect a stuck "running" flag
    backupsCache.progress = null;
  } catch (_) { /* keep defaults */ }
}
function saveBackups() {
  try {
    fs.writeFileSync(BACKUP_FILE + '.tmp', JSON.stringify(backupsCache, null, 2));
    fs.renameSync(BACKUP_FILE + '.tmp', BACKUP_FILE);
  } catch (e) { console.error('saveBackups failed:', e.message); }
}

function rcloneArgs(t, extra) { return [...t.args, ...extra]; }
// Live progress for the Backups tab (GET /api/backup → progress): which step, n of N, the item being
// worked on, and for the upload rclone's own bytes / percent / speed / ETA.
function setProgress(step, done, total, item, extra) {
  backupsCache.phase = step + (total ? ' (' + Math.min(done + 1, total) + '/' + total + ')' : '') + (item ? ': ' + item : '');
  backupsCache.progress = Object.assign({ step, done, total, item: item || null, at: new Date().toISOString() }, extra || {});
}
// rclone copy that reports its stats every 2 s into backupsCache.progress.upload. Resolves like
// execP ({ err, stdout, stderr }) so errText() works on it unchanged.
function rcloneCopyLive(t, args, timeout) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn('rclone', rcloneArgs(t, [...args, '--stats', '2s', '--stats-one-line', '--stats-log-level', 'NOTICE']), { env: t.env });
    let stderr = '', buf = '', done = false;
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, timeout);
    const UNIT = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };
    const num = (v, u) => Math.round(parseFloat(v) * (UNIT[u] || 1));
    child.stderr.on('data', (d) => {
      buf += d; const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) {
        // "... NOTICE: 1.234 GiB / 2.800 GiB, 44%, 25.300 MiB/s, ETA 1m3s"
        const m = l.match(/([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\s*\/\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB),\s*(\d+|-)%,\s*([\d.]+)\s*(B|KiB|MiB|GiB|TiB)\/s,\s*ETA\s*(\S+)/);
        if (m) {
          if (backupsCache.progress) backupsCache.progress.upload = { bytes: num(m[1], m[2]), total: num(m[3], m[4]), pct: m[5] === '-' ? null : Number(m[5]), speed: num(m[6], m[7]), eta: m[8] === '-' ? null : m[8] };
        } else if (l.trim() && !/\/s, ETA/.test(l)) stderr += l + '\n';
      }
    });
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); resolve({ err, stdout: '', stderr: stderr + buf }); };
    child.on('error', (e) => finish(e));
    child.on('close', (code, sig) => finish(code === 0 ? null : Object.assign(new Error('rclone exited ' + (code != null ? code : sig)), { code, signal: sig, killed: !!sig })));
  });
}
// Why a command failed, on one line: its stderr (first line, or the last `tail` lines for rclone,
// which puts the cause at the end), else the spawn error — a missing binary writes no stderr at all.
function errText(r, tail) {
  const e = r.err || {};
  if (e.code === 'ENOENT' && e.syscall && e.syscall.startsWith('spawn')) return (e.path || 'command') + ' is not installed (not found on PATH)';
  if (e.killed) return 'timed out' + (e.signal ? ' (' + e.signal + ')' : '');
  const l = String(r.stderr || '').trim().split('\n').filter(Boolean);
  if (l.length) return (tail ? l.slice(-tail) : l.slice(0, 1)).join(' ').trim();
  return e.message || 'failed';
}
function backupStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2026-06-16T22-34-10
}
function listPgDatabases() {
  try {
    const out = execFileSync('psql', ['-U', 'postgres', '-h', PG_HOST, '-d', 'postgres', '-tAc',
      "SELECT datname FROM pg_database WHERE datistemplate=false AND datallowconn ORDER BY 1"],
      { timeout: 15000, encoding: 'utf8' });
    return out.trim().split('\n').map(s => s.trim()).filter(Boolean);
  } catch (_) { return []; }
}

async function dumpPostgres(stageDir, result, scope) {
  const dir = path.join(stageDir, 'postgres');
  fs.mkdirSync(dir, { recursive: true });
  const sel = Array.isArray(scope.pgDatabases) ? scope.pgDatabases : null;
  for (const db of listPgDatabases().filter((name) => !sel || sel.includes(name))) {
    const file = path.join(dir, db + '.dump');
    // -Fc = custom format: compressed and restorable with `pg_restore`
    const r = await execP('pg_dump', ['-U', 'postgres', '-h', PG_HOST, '-Fc', '-f', file, db], { timeout: 30 * 60_000 });
    if (r.err) result.errors.push('pg_dump ' + db + ': ' + errText(r));
    else result.items.push('postgres/' + db + '.dump');
  }
}
// Sites from our own table (domain, user, docroot); CloudPanel's DB as a fallback before the first import.
function listSites() {
  try {
    const rows = require('./sites/store').list();
    if (rows.length) return rows.map((r) => ({ domain: r.domain, user: r.user, root: '/home/' + r.user + '/htdocs/' + r.root_dir, type: r.type }));
  } catch (_) {}
  return querySitesDb().map((s) => ({ domain: s.domain, user: s.user, root: s.root ? '/home/' + s.user + '/htdocs/' + s.root : null, type: s.type }));
}
function siteSrc(s) {
  return (s.root && fs.existsSync(s.root)) ? s.root : ('/home/' + s.user + '/htdocs/' + s.domain);
}
function snarPath(domain) {
  return path.join(BACKUP_SNAR_DIR, String(domain).replace(/[^A-Za-z0-9.-]/g, '_') + '.snar');
}
// Which sites have a base snapshot (= were part of a full backup) and when it was taken.
function listBases() {
  const out = {};
  try {
    for (const f of fs.readdirSync(BACKUP_SNAR_DIR)) {
      if (!f.endsWith('.snar')) continue;
      try { out[f.slice(0, -5)] = fs.statSync(path.join(BACKUP_SNAR_DIR, f)).mtime.toISOString(); } catch (_) {}
    }
  } catch (_) {}
  return out;
}
// opts.mode 'full' | 'diff'; opts.writeBase: a full run may (re)write the per-site base snapshots.
// A differential tarball holds what changed since the base: restore = extract the full, then the
// diff on top (tar --listed-incremental=/dev/null -x also removes files deleted since the full).
async function tarSites(stageDir, result, scope, opts) {
  opts = opts || {};
  const diff = opts.mode === 'diff';
  const dir = path.join(stageDir, 'sites');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(BACKUP_SNAR_DIR, { recursive: true, mode: 0o700 });
  const excl = SITE_TAR_EXCLUDES.map(d => "--exclude='" + d + "'").join(' ');
  const sel = Array.isArray(scope.siteDomains) ? scope.siteDomains : null;
  const todo = listSites().filter((s) => s.user && s.domain && (!sel || sel.includes(s.domain)));
  let n = 0;
  for (const s of todo) {
    setProgress('packing site files', n++, todo.length, s.domain);
    const src = siteSrc(s);
    if (!fs.existsSync(src)) continue;
    const file = path.join(dir, s.domain + '.tar.zst');
    const parent = path.dirname(src), base = path.basename(src);
    const snar = snarPath(s.domain);
    let inc = null, tmp = null, how = 'full';
    if (diff && fs.existsSync(snar)) {
      // tar rewrites the snapshot it is given, so it works on a copy and the base stays put
      tmp = snar + '.' + process.pid + '.tmp';
      fs.copyFileSync(snar, tmp);
      inc = tmp; how = 'diff';
    } else if (opts.writeBase) {
      // full run: a fresh level-0 snapshot becomes the base for the diffs that follow
      try { fs.rmSync(snar, { force: true }); } catch (_) {}
      inc = snar;
      if (diff) result.notes.push(s.domain + ': no base snapshot yet, backed up in full');
    } else if (diff) {
      result.notes.push(s.domain + ': no base snapshot yet, backed up in full');
    }
    // every path is quoted for real ('…' with ' escaped): root_dir is site data, and this runs as root
    const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
    const r = await execP('bash', ['-c',
      "tar " + excl + (inc ? " --listed-incremental=" + sq(inc) : '') + " --warning=no-file-changed --ignore-failed-read -C " + sq(parent) + " -cf - " + sq(base)
      + " | zstd -q -T2 -o " + sq(file) + " -f"], { timeout: 60 * 60_000 });
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
    if (r.err && !fs.existsSync(file)) result.errors.push('tar ' + s.domain + ': ' + errText(r));
    else { result.items.push('sites/' + s.domain + '.tar.zst'); if (how === 'diff') result.diffItems.push('sites/' + s.domain + '.tar.zst'); }
  }
}
// One site's databases (MariaDB / PostgreSQL / SQLite, from the site's Databases tab), dumped into the
// stage as sites/<domain>-db/<name>-<time>.sql.gz — per-site runs (Backups tab on the site). The dump
// is made where the Databases tab exports to, then moved into the stage.
async function dumpSiteDbs(stageDir, result, domain) {
  let site = null, list = [];
  try { const store = require('./sites/store'); site = store.get(domain); list = site ? store.databases.list(site.id) : []; } catch (_) {}
  if (!site || !list.length) return;
  const dir = path.join(stageDir, 'sites', domain + '-db');
  fs.mkdirSync(dir, { recursive: true });
  for (const d of list) {
    backupsCache.phase = 'dumping database ' + d.name;
    try {
      const r = await require('./sites/dbs').exportDb(site, d.id);
      const name = path.basename(r.file);
      fs.copyFileSync(r.file, path.join(dir, name));
      try { fs.unlinkSync(r.file); } catch (_) {}
      result.items.push('sites/' + domain + '-db/' + name);
    } catch (e) { result.errors.push('database ' + d.name + ' (' + d.engine + '): ' + e.message); }
  }
}
// Size of every file staged for upload, per item and in total.
function stageSizes(stageDir) {
  const sizes = {}; let bytes = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(fp, r);
      else { try { const n = fs.statSync(fp).size; sizes[r] = n; bytes += n; } catch (_) {} }
    }
  };
  try { walk(stageDir, ''); } catch (_) {}
  return { bytes, sizes };
}
// On-disk size of each site's files as a backup would see them (the regenerable dirs excluded).
// du over every htdocs takes a while on a big box, so it runs in the background and is cached.
let siteSizesCache = { at: 0, map: {}, refreshing: false };
async function refreshSiteSizes() {
  if (siteSizesCache.refreshing) return;
  siteSizesCache.refreshing = true;
  const map = {};
  try {
    const excl = SITE_TAR_EXCLUDES.map(d => '--exclude=' + d);
    for (const s of listSites()) {
      if (!s.user || !s.domain) continue;
      const src = siteSrc(s);
      if (!fs.existsSync(src)) continue;
      const r = await execP('du', ['-sb', ...excl, src], { timeout: 5 * 60_000 });
      const n = parseInt(r.stdout, 10);
      if (!isNaN(n)) map[s.domain] = n;
    }
  } catch (_) {}
  siteSizesCache = { at: Date.now(), map, refreshing: false };
}
async function tarConfigs(stageDir, result, scope) {
  const dir = path.join(stageDir, 'configs');
  fs.mkdirSync(dir, { recursive: true });
  const sc = scope || {};
  const list = ['/etc/nginx', '/etc/systemd/system', RCLONE_CONF, APP_ROOT, '/etc/cloudflared', '/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d', '/etc/ufw', '/usr/local/bin', '/etc/network/interfaces'];
  if (sc.crontabs !== false) list.push('/var/spool/cron/crontabs', '/etc/cron.d', '/etc/crontab');
  if (sc.fail2ban !== false) list.push('/etc/fail2ban');
  if (sc.pm2 !== false) {
    for (const h of ['/root'].concat(homeUsers().map((u) => '/home/' + u))) {
      const f = path.join(h, '.pm2', 'dump.pm2');
      if (fs.existsSync(f)) list.push(f);
    }
  }
  const targets = list.filter(p => fs.existsSync(p)).map(t => "'" + t + "'").join(' ');
  const file = path.join(dir, 'configs.tar.zst');
  // secret.key never leaves the box; the live SQLite (WAL) is replaced by a consistent snapshot below
  const excludes = ['secret.key', 'rhc.sqlite', 'rhc.sqlite-wal', 'rhc.sqlite-shm', '.sessions', 'node_modules'].map((x) => "--exclude='" + x + "'").join(' ');
  const r = await execP('bash', ['-c',
    "tar --warning=no-file-changed --ignore-failed-read " + excludes + " -cf - " + targets + " | zstd -q -o '" + file + "' -f"],
    { timeout: 10 * 60_000 });
  if (r.err && !fs.existsSync(file)) result.errors.push('tar configs: ' + errText(r));
  else result.items.push('configs/configs.tar.zst');
  try {
    require('./db').snapshotTo(path.join(dir, 'rhc.sqlite'));
    result.items.push('configs/rhc.sqlite');
  } catch (e) { result.errors.push('rhc db snapshot: ' + e.message); }
  if (sc.cloudpanelDb !== false && fs.existsSync(CLP_DB)) {
    // consistent snapshot of CloudPanel's sqlite DB (sites, users, vhosts) via the online-backup API
    const out = path.join(dir, 'cloudpanel-db.sq3');
    const r2 = await execP('sqlite3', [CLP_DB, ".backup '" + out + "'"], { timeout: 5 * 60_000 });
    if (r2.err) result.errors.push('cloudpanel db: ' + errText(r2));
    else result.items.push('configs/cloudpanel-db.sq3');
  }
}
// Every SQLite database on the host (lib/sqlite-scan.js) → sqlite/<path>.db.zst. Plain ones are
// snapshotted with VACUUM INTO (consistent even while the app writes, WAL folded in); encrypted
// ones (SQLCipher) cannot be opened here and are copied as files — their apps' own backups are the
// consistent copy. The panel's own rhc.sqlite is covered by configs.
async function snapshotSqlite(stageDir, result) {
  const dir = path.join(stageDir, 'sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const own = require('./db').DB_FILE;
  const dbs = require('./sqlite-scan').scan().filter((s) => s.path !== own);
  let n = 0;
  for (const s of dbs) {
    setProgress('snapshotting SQLite databases', n++, dbs.length, s.path);
    const name = s.path.replace(/^\//, '').replace(/[^A-Za-z0-9._-]/g, '_');
    const tmp = path.join(dir, name);
    try {
      if (s.encrypted) { fs.copyFileSync(s.path, tmp); result.notes.push('sqlite ' + s.path + ': encrypted, copied as a file'); }
      else { const db = new DatabaseSync(s.path, { readOnly: true }); try { db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'"); } finally { db.close(); } }
      const z = await execP('zstd', ['-q', '--rm', '-f', tmp, '-o', tmp + '.zst'], { timeout: 30 * 60_000 });
      if (z.err) throw new Error(errText(z));
      result.items.push('sqlite/' + name + '.zst');
    } catch (e) { try { fs.unlinkSync(tmp); } catch (_) {} result.errors.push('sqlite ' + s.path + ': ' + e.message); }
  }
}
// User-chosen extra paths -> extra/extra.tar.zst. Only absolute, existing paths outside of the
// pseudo filesystems and our own staging dir are accepted.
function validExtraPath(p) {
  if (typeof p !== 'string') return false;
  const t = p.trim();
  if (!t || !path.isAbsolute(t) || t === '/' || t.split('/').includes('..')) return false;
  if (/^\/(proc|sys|dev|run|tmp)(\/|$)/.test(t) || t.startsWith(BACKUP_STAGE)) return false;
  return fs.existsSync(t);
}
async function tarExtras(stageDir, result, paths) {
  const valid = [], bad = [];
  for (const p of paths) (validExtraPath(p) ? valid : bad).push(String(p).trim());
  for (const b of bad) result.errors.push('extra path skipped (missing or not allowed): ' + b);
  if (!valid.length) return;
  const dir = path.join(stageDir, 'extra');
  fs.mkdirSync(dir, { recursive: true });
  const excl = SITE_TAR_EXCLUDES.filter(d => d !== '.git').map(d => "--exclude='" + d + "'").join(' ');
  const targets = valid.map(t => "'" + t.replace(/'/g, "'\\''") + "'").join(' ');
  const file = path.join(dir, 'extra.tar.zst');
  const r = await execP('bash', ['-c',
    "tar " + excl + " --warning=no-file-changed --ignore-failed-read -cf - " + targets + " | zstd -q -T2 -o '" + file + "' -f"],
    { timeout: 60 * 60_000 });
  if (r.err && !fs.existsSync(file)) result.errors.push('tar extra: ' + errText(r));
  else result.items.push('extra/extra.tar.zst');
}
let backupAvailableCache = null;   // { at, databases, sites }
function backupAvailable() {
  if (backupAvailableCache && Date.now() - backupAvailableCache.at < 60_000) return backupAvailableCache;
  backupAvailableCache = {
    at: Date.now(),
    databases: listPgDatabases(),
    sites: listSites().filter(s => s.domain).map(s => ({ domain: s.domain, user: s.user, type: s.type })),
  };
  return backupAvailableCache;
}
// What GET /api/backup hands the UI: the pickers above plus each site's on-disk size and base snapshot.
function backupAvailableFull() {
  const av = backupAvailable();
  if (Date.now() - siteSizesCache.at > SITE_SIZE_TTL) refreshSiteSizes();   // background; served stale meanwhile
  const bases = listBases();
  return {
    databases: av.databases,
    sites: av.sites.map((s) => Object.assign({}, s, { bytes: s.domain in siteSizesCache.map ? siteSizesCache.map[s.domain] : null, base: bases[s.domain] || null })),
    sizesAt: siteSizesCache.at ? new Date(siteSizesCache.at).toISOString() : null,
  };
}

// Remote folder names: <stamp> = full, <stamp>-diff = differential, anything else with a stamp is an
// ad-hoc per-site / all-sites run. Folders without a stamp are not ours and are left alone.
const STAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/;
function parseStamp(name) {
  const m = STAMP_RE.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}
function classifyFolder(name) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(name)) return 'full';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-diff$/.test(name)) return 'diff';
  return parseStamp(name) != null ? 'adhoc' : 'other';
}
// Retention is per folder: diffs and ad-hoc runs go after retentionDays; a full goes only when it is
// older than that AND not among the newest keepFulls AND no diff still kept depends on it (a diff's
// base is the newest full taken before it).
async function pruneBackups(result, t) {
  const days = backupsCache.retentionDays || 14;
  const keepFulls = Math.max(1, backupsCache.keepFulls || 4);
  const base = wasabi.base(t);
  const ls = await execP('rclone', rcloneArgs(t, ['lsjson', base, '--dirs-only']), { timeout: 5 * 60_000, env: t.env });
  if (ls.err) { result.errors.push('prune: ' + errText(ls, 2)); return; }
  let dirs;
  try { dirs = JSON.parse(ls.stdout).map(d => d.Name); } catch (_) { result.errors.push('prune: unreadable remote listing'); return; }
  const cutoff = Date.now() - days * 86400e3;
  const fulls = dirs.filter(n => classifyFolder(n) === 'full').sort();
  const protectedFulls = new Set(fulls.slice(-keepFulls));
  for (const n of dirs) {
    if (classifyFolder(n) !== 'diff' || parseStamp(n) < cutoff) continue;
    const b = fulls.filter(f => f < n).pop();
    if (b) protectedFulls.add(b);
  }
  for (const n of dirs) {
    // `at`, not `t`: shadowing the Wasabi target `t` here made every purge throw "t.args is not
    // iterable" (every nightly run marked FAILED from 2026-11-07, old backups never pruned).
    const kind = classifyFolder(n), at = parseStamp(n);
    if (kind === 'other' || at >= cutoff) continue;
    if (kind === 'full' && protectedFulls.has(n)) continue;
    const r = await execP('rclone', rcloneArgs(t, ['purge', base + '/' + n]), { timeout: 30 * 60_000, env: t.env });
    if (r.err) result.errors.push('prune ' + n + ': ' + errText(r, 2));
    else result.pruned.push(n);
  }
}

// opts.scope overrides the configured scope (per-site runs); opts.site labels the run and its remote folder
// (<prefix>/<stamp>-<domain>) so it sits next to the full backups and ages out with the same retention.
// opts.mode 'diff' makes the site tarballs differential (folder <prefix>/<stamp>-diff); the base
// snapshots are only rewritten by a full run without opts.site.
async function runBackup(trigger, actor, opts) {
  opts = opts || {};
  if (backupRunning) return { error: 'A backup is already running' };
  // A site with its own Wasabi bucket (Overrides tab) backs up there instead of to the shared one.
  const own = opts.site ? siteOwnTarget(opts.site) : null;
  const t = own || wasabi.target();
  if (!t) return { error: NOT_CONFIGURED };
  backupRunning = true; backupsCache.running = true; backupsCache.runningSite = opts.site || null; backupsCache.runningSince = new Date().toISOString(); backupsCache.phase = 'starting';
  const mode = opts.mode === 'diff' ? 'diff' : 'full';
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const stamp = backupStamp() + (mode === 'diff' ? '-diff' : '') + (opts.site ? '-' + String(opts.site).replace(/[^A-Za-z0-9.-]/g, '_') : '');
  const stageDir = path.join(BACKUP_STAGE, stamp);
  const result = { items: [], errors: [], notes: [], diffItems: [], pruned: [] };
  let bytes = 0, sizes = {}, uploaded = false;
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    const scope = opts.scope || backupsCache.scope || {};
    backupsCache.progress = null;
    if (scope.postgres) { setProgress('dumping PostgreSQL', 0, 0); await dumpPostgres(stageDir, result, scope); }
    if (scope.sites)    await tarSites(stageDir, result, scope, { mode, writeBase: !opts.site });
    if (scope.siteDbs && opts.site) await dumpSiteDbs(stageDir, result, opts.site);
    if (scope.sqlite !== false) await snapshotSqlite(stageDir, result);
    if (scope.configs)  { setProgress('packing server configs', 0, 0); await tarConfigs(stageDir, result, scope); }
    if (Array.isArray(scope.extraPaths) && scope.extraPaths.length) { setProgress('packing extra paths', 0, 0); await tarExtras(stageDir, result, scope.extraPaths); }
    ({ bytes, sizes } = stageSizes(stageDir));
    if (result.items.length) {
      const dest = wasabi.base(t) + '/' + stamp;
      setProgress('uploading to ' + (own ? 'the site\'s own bucket' : 'Wasabi'), 0, 0, null, { upload: { bytes: 0, total: bytes, pct: 0, speed: 0, eta: null } });
      const up = await rcloneCopyLive(t, ['copy', stageDir, dest, '--transfers', '4'], 6 * 60 * 60_000);
      if (up.err) result.errors.push('rclone upload: ' + errText(up, 2));
      else uploaded = true;
    } else {
      result.errors.push('nothing was produced to upload');
    }
    if (!opts.site) { setProgress('pruning old backups', 0, 0); await pruneBackups(result, t); }   // the nightly run prunes; ad-hoc site runs just upload
  } catch (e) {
    result.errors.push('runBackup: ' + e.message);
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    backupRunning = false; backupsCache.running = false; backupsCache.runningSite = null; backupsCache.phase = null; backupsCache.progress = null;
  }
  const success = result.errors.length === 0 && result.items.length > 0;
  const entry = {
    startedAt, finishedAt: new Date().toISOString(), trigger, success, bytes, mode,
    itemCount: result.items.length, items: result.items, sizes, diffItems: result.diffItems, errors: result.errors, notes: result.notes,
    pruned: result.pruned, duration_ms: Date.now() - start, stamp, site: opts.site || null,
  };
  if (!opts.site) backupsCache.lastRun = entry;
  backupsCache.log.push(entry);
  if (backupsCache.log.length > BACKUP_LOG_MAX) backupsCache.log = backupsCache.log.slice(-BACKUP_LOG_MAX);
  saveBackups();
  events.emit('backups.run', { user: trigger === 'manual' ? (actor && actor.user) || 'system' : 'system', ip: actor && actor.ip, target: stamp, site: opts.site || undefined,
    level: success ? 'info' : 'error', message: (opts.site ? 'Site backup of ' + opts.site : (mode === 'diff' ? 'Differential backup (' : 'Full backup (') + trigger + ')') + ' ' + (success ? 'completed: ' : 'FAILED: ') + result.items.length + ' items, ' + fmtBytes(bytes),
    data: { items: result.items, sizes, errors: result.errors, notes: result.notes, pruned: result.pruned, duration_ms: entry.duration_ms, bytes, mode } });
  try { await notify.send(backupMessage(entry, uploaded, t), success ? 'complete' : undefined, opts.site ? { site: opts.site } : undefined); } catch (_) {}
  return entry;
}

// The chat notification for a finished run: what kind of run, what it produced per category (the
// items themselves when there are few, the largest ones otherwise), where it went, what retention
// removed, then every error and note — enough to tell what broke without opening the panel.
const ITEM_GROUPS = { postgres: 'Databases', sites: 'Sites', sqlite: 'SQLite', configs: 'Configs', extra: 'Extra paths' };
function backupMessage(entry, uploaded, t) {
  const esc = (s) => String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
  const secs = Math.round(entry.duration_ms / 1000);
  const took = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  const what = entry.site === ALL_SITES_LABEL ? 'All-sites backup' : entry.site ? 'Site backup of ' + entry.site
    : entry.mode === 'diff' ? 'Differential backup' : 'Full backup';
  const lines = [(entry.success ? '✅ *' : '⚠️ *') + esc(what) + (entry.success ? '' : ' FAILED') + '* (' + esc(entry.trigger) + ')',
    entry.items.length + ' items, ' + fmtBytes(entry.bytes) + ', ' + took + ' — '
      + (uploaded ? 'uploaded to ' + esc(t.bucket + '/' + t.prefix + '/' + entry.stamp) : '*not uploaded*')];
  const groups = {};
  for (const it of entry.items) { const k = it.split('/')[0]; (groups[k] = groups[k] || []).push(it); }
  const diff = new Set(entry.diffItems || []);
  for (const k of Object.keys(groups)) {
    const its = groups[k].map((it) => ({ name: it.slice(k.length + 1).replace(/\.(tar\.zst|dump)$/, ''), bytes: entry.sizes[it] || 0, diff: diff.has(it) }));
    const total = its.reduce((a, x) => a + x.bytes, 0), nDiff = its.filter((x) => x.diff).length;
    const show = its.length <= 5 ? its : its.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 3);
    lines.push('• ' + (ITEM_GROUPS[k] || esc(k)) + ': ' + its.length + ', ' + fmtBytes(total) + (nDiff ? ' (' + nDiff + ' differential)' : '')
      + (its.length === 1 && its[0].name === k ? '' : ' — ' + (show.length < its.length ? 'largest ' : '') + show.map((x) => esc(x.name) + ' ' + fmtBytes(x.bytes)).join(', ')));
  }
  if (entry.pruned && entry.pruned.length) lines.push('🧹 Pruned ' + entry.pruned.length + ' old: ' + esc(entry.pruned.join(', ')));
  if (entry.errors.length) lines.push('*Errors:*', ...entry.errors.map((e) => '• ' + esc(e)));
  if (entry.notes && entry.notes.length) lines.push('_Notes:_', ...entry.notes.map((n) => '• ' + esc(n)));
  return lines.join('\n');
}

async function listRemoteBackups() {
  const t = wasabi.target();
  if (!t) return [];
  const r = await execP('rclone', rcloneArgs(t, ['lsjson', wasabi.base(t), '--dirs-only']), { timeout: 60_000, env: t.env });
  if (r.err) return [];
  try { return JSON.parse(r.stdout).map(d => d.Name).sort().reverse(); } catch (_) { return []; }
}

function siteOwnTarget(domain) {
  try {
    const o = require('./sites/overrides').get(domain).backups;
    if (o.mode !== 'own') return null;
    return wasabi.target(o.wasabi);
  } catch (_) { return null; }
}
// After the nightly host backup: every site with its own Wasabi bucket is backed up there too.
async function runOwnSiteBackups(mode) {
  for (const s of listSites()) {
    if (!siteOwnTarget(s.domain)) continue;
    for (let i = 0; i < 360 && backupRunning; i++) await new Promise((r) => setTimeout(r, 10_000));   // one run at a time
    try { await runBackup('scheduled', null, { site: s.domain, mode, scope: { postgres: false, sites: true, siteDomains: [s.domain], sqlite: false, configs: false, extraPaths: [] } }); } catch (_) {}
  }
}

let lastBackupSchedKey = null;
function backupTick() {
  const cfg = backupsCache.schedule;
  if (!cfg || !cfg.enabled || backupRunning || !wasabi.target()) return;   // nothing to upload to yet: skip quietly
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const tgt = (cfg.hour || 3) * 60 + (cfg.minute || 0);
  if (Math.abs(cur - tgt) > 2) return;
  const key = now.toISOString().slice(0, 10) + '-' + cfg.hour + '-' + cfg.minute;
  if (lastBackupSchedKey === key) return;
  lastBackupSchedKey = key;
  const mode = scheduledMode(now);
  runBackup('scheduled', null, { mode }).finally(() => runOwnSiteBackups(mode).catch(() => {}));
}
// In 'diff' mode the weekly/monthly full day gets a full run, every other day a differential one.
function scheduledMode(now) {
  const s = backupsCache.schedule || {};
  if (s.mode !== 'diff') return 'full';
  if (s.fullEvery === 'monthly') return now.getDate() === (s.fullDate || 1) ? 'full' : 'diff';
  return now.getDay() === (s.fullDay == null ? 0 : s.fullDay) ? 'full' : 'diff';
}


// Ad-hoc backup of one site's files (and, when known, nothing else). Returns the log entry when done.
// opts.dbs (default true): also the site's databases.
function runSiteBackup(domain, actor, mode, opts) {
  const site = listSites().find((s) => s.domain === domain);
  if (!site) return Promise.resolve({ error: 'unknown site ' + domain });
  return runBackup('manual', actor, { site: domain, mode, scope: { postgres: false, sites: true, siteDomains: [domain], siteDbs: !(opts && opts.dbs === false), sqlite: false, configs: false, extraPaths: [] } });
}

// ---- one site's view (site → Backups tab)
// Archives of a site in the bucket(s): its files (sites/<domain>.tar.zst) and databases
// (sites/<domain>-db/…) in every run folder — nightly, per-site, all-sites — of the shared target and,
// when the site has one, its own. Cached 2 min (listing a bucket is slow).
const siteArchCache = new Map();
async function listSiteArchives(domain, fresh) {
  const hit = siteArchCache.get(domain);
  if (hit && !fresh && Date.now() - hit.at < 120_000) return hit.v;
  const out = [];
  const targets = [['shared', wasabi.target()], ['own', siteOwnTarget(domain)]].filter(([, t]) => t);
  for (const [kind, t] of targets) {
    const r = await execP('rclone', rcloneArgs(t, ['lsjson', wasabi.base(t), '--recursive', '--files-only', '--max-depth', '4',
      '--include', '/*/sites/' + domain + '.tar.zst', '--include', '/*/sites/' + domain + '-db/**']), { timeout: 180_000, env: t.env });
    if (r.err) { out.push({ target: kind, error: errText(r, 2) }); continue; }
    let list = []; try { list = JSON.parse(r.stdout); } catch (_) {}
    const byStamp = new Map();
    for (const f of list) {
      const stamp = String(f.Path).split('/')[0];
      if (!byStamp.has(stamp)) byStamp.set(stamp, { target: kind, stamp, kind: classifyFolder(stamp), files: [], bytes: 0, at: f.ModTime });
      const g = byStamp.get(stamp);
      g.files.push({ file: String(f.Path).slice(stamp.length + 1), size: f.Size });
      g.bytes += f.Size || 0;
      if (f.ModTime > g.at) g.at = f.ModTime;
    }
    out.push(...byStamp.values());
  }
  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  siteArchCache.set(domain, { at: Date.now(), v: out });
  return out;
}
// Stream one archive file to the browser (rclone cat). Only files the listing shows can be fetched.
async function downloadSiteArchive(domain, target, stamp, file, res) {
  const list = await listSiteArchives(domain);
  const g = list.find((x) => x.target === target && x.stamp === stamp);
  if (!g || !g.files.some((f) => f.file === file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no such backup file' })); return; }
  const t = target === 'own' ? siteOwnTarget(domain) : wasabi.target();
  const { spawn } = require('child_process');
  const child = spawn('rclone', rcloneArgs(t, ['cat', wasabi.base(t) + '/' + stamp + '/' + file]), { env: Object.assign({}, process.env, t.env || {}) });
  const name = domain + '-' + stamp + '-' + path.basename(file);
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="' + name.replace(/[^\x20-\x7e]|"/g, '_') + '"', 'Cache-Control': 'no-store' });
    res.write(d);
  });
  await new Promise((resolve) => {
    child.on('close', (code) => {
      if (!res.headersSent) { res.writeHead(code ? 502 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(code ? { error: 'download failed: ' + err.trim().split('\n').pop() } : {})); }
      else res.end();
      resolve();
    });
    res.on('close', () => { try { child.kill('SIGKILL'); } catch (_) {} });
  });
}
// Is the site in the nightly backup, and where do its backups go?
function siteBackupInfo(domain) {
  const sc = backupsCache.scope || {};
  const nightly = !!sc.sites && (!Array.isArray(sc.siteDomains) || sc.siteDomains.includes(domain));
  const own = siteOwnTarget(domain);
  let ownBucket = null; try { ownBucket = own ? require('./sites/overrides').get(domain).backups.wasabi.bucket : null; } catch (_) {}
  return { nightly, siteDomainsLimited: Array.isArray(sc.siteDomains), schedule: backupsCache.schedule, sharedConfigured: !!wasabi.target(), own: !!own, ownBucket,
    running: backupsCache.running, runningSite: backupsCache.runningSite || null, runningSince: backupsCache.runningSince || null, phase: backupsCache.phase || null, progress: backupsCache.progress || null };
}
// Include / leave out one site in the nightly run (scope.siteDomains; null = every site).
function setSiteNightly(domain, on) {
  const sc = Object.assign({}, DEFAULT_BACKUP_SCOPE, backupsCache.scope);
  const all = listSites().map((s) => s.domain);
  let sel = Array.isArray(sc.siteDomains) ? sc.siteDomains.slice() : all.slice();
  sel = sel.filter((d) => d !== domain);
  if (on) sel.push(domain);
  sc.sites = sc.sites || on;
  sc.siteDomains = all.every((d) => sel.includes(d)) ? null : sel;   // everyone in again → back to "all"
  backupsCache.scope = sc;
  saveBackups();
  return siteBackupInfo(domain);
}
// Ad-hoc backup of every site's files in ONE run (one remote folder, one log entry).
// Labelled like a per-site run so it neither overwrites lastRun nor prunes — the
// nightly full backup stays the thing retention is measured against.
function runAllSitesBackup(actor, mode) {
  if (!listSites().length) return Promise.resolve({ error: 'no sites to back up' });
  return runBackup('manual', actor, { site: ALL_SITES_LABEL, mode, scope: { postgres: false, sites: true, siteDomains: null, sqlite: false, configs: false, extraPaths: [] } });
}
// Accessors for the dispatcher (module state is never exported directly).
function getState() { return backupsCache; }
function isRunning() { return backupRunning; }
function clearLog() { backupsCache.log = []; saveBackups(); }
// POST /api/backup/config: merge + validate { schedule?, scope?, retentionDays? }.
function setConfig(cfg) {
  if (cfg.schedule && typeof cfg.schedule === 'object') {
    const sIn = cfg.schedule, next = Object.assign({}, backupsCache.schedule);
    if (typeof sIn.enabled === 'boolean') next.enabled = sIn.enabled;
    if (sIn.hour != null) next.hour = Math.max(0, Math.min(23, parseInt(sIn.hour) || 0));
    if (sIn.minute != null) next.minute = Math.max(0, Math.min(59, parseInt(sIn.minute) || 0));
    if (sIn.mode === 'full' || sIn.mode === 'diff') next.mode = sIn.mode;
    if (sIn.fullEvery === 'weekly' || sIn.fullEvery === 'monthly') next.fullEvery = sIn.fullEvery;
    if (sIn.fullDay != null) next.fullDay = Math.max(0, Math.min(6, parseInt(sIn.fullDay) || 0));
    if (sIn.fullDate != null) next.fullDate = Math.max(1, Math.min(28, parseInt(sIn.fullDate) || 1));
    backupsCache.schedule = next;
  }
  if (cfg.keepFulls != null) backupsCache.keepFulls = Math.max(1, Math.min(52, parseInt(cfg.keepFulls) || 4));
  if (cfg.scope && typeof cfg.scope === 'object') {
    const sIn = cfg.scope, next = Object.assign({}, DEFAULT_BACKUP_SCOPE, backupsCache.scope);
    for (const k of ['postgres', 'sites', 'sqlite', 'configs', 'cloudpanelDb', 'crontabs', 'pm2', 'fail2ban']) if (typeof sIn[k] === 'boolean') next[k] = sIn[k];
    for (const k of ['pgDatabases', 'siteDomains']) if (k in sIn) next[k] = Array.isArray(sIn[k]) ? sIn[k].filter((x) => typeof x === 'string').slice(0, 200) : null;
    if ('extraPaths' in sIn) next.extraPaths = Array.isArray(sIn.extraPaths) ? sIn.extraPaths.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 50) : [];
    backupsCache.scope = next;
  }
  if (cfg.retentionDays != null) backupsCache.retentionDays = Math.max(1, Math.min(365, parseInt(cfg.retentionDays) || 14));
  saveBackups();
}
function exportSettings() { return { schedule: backupsCache.schedule, retentionDays: backupsCache.retentionDays, keepFulls: backupsCache.keepFulls, scope: backupsCache.scope }; }

module.exports = { listSiteArchives, downloadSiteArchive, siteBackupInfo, setSiteNightly, DEFAULT_BACKUP_SCOPE, loadBackups, saveBackups, runBackup, runSiteBackup, runAllSitesBackup, ALL_SITES_LABEL, listSites, backupAvailable, backupAvailableFull, listRemoteBackups, classifyFolder, scheduledMode, backupTick, getState, isRunning, clearLog, setConfig, exportSettings };
