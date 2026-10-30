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
// Backs up Postgres DBs, CloudPanel site files, and key configs to Wasabi
// (S3-compatible) via the already-configured rclone remote. Dependency-free:
// shells out to pg_dump / tar+zstd / rclone. Stages on /var/tmp (NOT /tmp,
// which is tmpfs/RAM on this box), uploads, prunes, then deletes the stage.

const BACKUP_FILE   = path.join(APP_ROOT, 'backups.json');
const RCLONE_CONF   = '/root/.config/rclone/rclone.conf';
const RCLONE_REMOTE = 'remote:';
const BACKUP_BUCKET = 'rhcsolutions';
// Per host: this same app runs on several servers feeding one bucket, so each gets its own
// prefix. A shared one would also make prune (delete --min-age over the base) eat the other
// hosts' backups. web01 keeps 'web01-backups', the name its history is already under.
const BACKUP_PREFIX = (String(os.hostname() || 'unknown').split('.')[0].replace(/[^A-Za-z0-9_-]/g, '') || 'unknown') + '-backups';
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
  } catch (_) { /* keep defaults */ }
}
function saveBackups() {
  try {
    fs.writeFileSync(BACKUP_FILE + '.tmp', JSON.stringify(backupsCache, null, 2));
    fs.renameSync(BACKUP_FILE + '.tmp', BACKUP_FILE);
  } catch (e) { console.error('saveBackups failed:', e.message); }
}

function rcloneArgs(extra) {
  return ['--config', RCLONE_CONF, '--s3-no-check-bucket', ...extra];
}
const RCLONE_ENV = () => Object.assign({}, process.env, { HOME: '/root' });
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
  for (const s of listSites()) {
    if (!s.user || !s.domain) continue;
    if (sel && !sel.includes(s.domain)) continue;
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
    const r = await execP('bash', ['-c',
      "tar " + excl + (inc ? " --listed-incremental='" + inc + "'" : '') + " --warning=no-file-changed --ignore-failed-read -C '" + parent + "' -cf - '" + base
      + "' | zstd -q -T2 -o '" + file + "' -f"], { timeout: 60 * 60_000 });
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} }
    if (r.err && !fs.existsSync(file)) result.errors.push('tar ' + s.domain + ': ' + errText(r));
    else { result.items.push('sites/' + s.domain + '.tar.zst'); if (how === 'diff') result.diffItems.push('sites/' + s.domain + '.tar.zst'); }
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
  const list = ['/etc/nginx', '/etc/systemd/system', '/root/.config/rclone/rclone.conf', APP_ROOT];
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
async function pruneBackups(result) {
  const days = backupsCache.retentionDays || 14;
  const keepFulls = Math.max(1, backupsCache.keepFulls || 4);
  const base = RCLONE_REMOTE + BACKUP_BUCKET + '/' + BACKUP_PREFIX;
  const ls = await execP('rclone', rcloneArgs(['lsjson', base, '--dirs-only']), { timeout: 5 * 60_000, env: RCLONE_ENV() });
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
    const kind = classifyFolder(n), t = parseStamp(n);
    if (kind === 'other' || t >= cutoff) continue;
    if (kind === 'full' && protectedFulls.has(n)) continue;
    const r = await execP('rclone', rcloneArgs(['purge', base + '/' + n]), { timeout: 30 * 60_000, env: RCLONE_ENV() });
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
  backupRunning = true; backupsCache.running = true;
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
    if (scope.postgres) await dumpPostgres(stageDir, result, scope);
    if (scope.sites)    await tarSites(stageDir, result, scope, { mode, writeBase: !opts.site });
    if (scope.configs)  await tarConfigs(stageDir, result, scope);
    if (Array.isArray(scope.extraPaths) && scope.extraPaths.length) await tarExtras(stageDir, result, scope.extraPaths);
    ({ bytes, sizes } = stageSizes(stageDir));
    if (result.items.length) {
      const dest = RCLONE_REMOTE + BACKUP_BUCKET + '/' + BACKUP_PREFIX + '/' + stamp;
      const up = await execP('rclone', rcloneArgs(['copy', stageDir, dest, '--transfers', '4']),
        { timeout: 6 * 60 * 60_000, env: RCLONE_ENV() });
      if (up.err) result.errors.push('rclone upload: ' + errText(up, 2));
      else uploaded = true;
    } else {
      result.errors.push('nothing was produced to upload');
    }
    if (!opts.site) await pruneBackups(result);   // the nightly run prunes; ad-hoc site runs just upload
  } catch (e) {
    result.errors.push('runBackup: ' + e.message);
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    backupRunning = false; backupsCache.running = false;
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
  try { await notify.send(backupMessage(entry, uploaded), success ? 'complete' : undefined); } catch (_) {}
  return entry;
}

// The chat notification for a finished run: what kind of run, what it produced per category (the
// items themselves when there are few, the largest ones otherwise), where it went, what retention
// removed, then every error and note — enough to tell what broke without opening the panel.
const ITEM_GROUPS = { postgres: 'Databases', sites: 'Sites', configs: 'Configs', extra: 'Extra paths' };
function backupMessage(entry, uploaded) {
  const esc = (s) => String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
  const secs = Math.round(entry.duration_ms / 1000);
  const took = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
  const what = entry.site === ALL_SITES_LABEL ? 'All-sites backup' : entry.site ? 'Site backup of ' + entry.site
    : entry.mode === 'diff' ? 'Differential backup' : 'Full backup';
  const lines = [(entry.success ? '✅ *' : '⚠️ *') + esc(what) + (entry.success ? '' : ' FAILED') + '* (' + esc(entry.trigger) + ')',
    entry.items.length + ' items, ' + fmtBytes(entry.bytes) + ', ' + took + ' — '
      + (uploaded ? 'uploaded to ' + esc(BACKUP_BUCKET + '/' + BACKUP_PREFIX + '/' + entry.stamp) : '*not uploaded*')];
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
  const base = RCLONE_REMOTE + BACKUP_BUCKET + '/' + BACKUP_PREFIX;
  const r = await execP('rclone', rcloneArgs(['lsjson', base, '--dirs-only']), { timeout: 60_000, env: RCLONE_ENV() });
  if (r.err) return [];
  try { return JSON.parse(r.stdout).map(d => d.Name).sort().reverse(); } catch (_) { return []; }
}

let lastBackupSchedKey = null;
function backupTick() {
  const cfg = backupsCache.schedule;
  if (!cfg || !cfg.enabled || backupRunning) return;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const tgt = (cfg.hour || 3) * 60 + (cfg.minute || 0);
  if (Math.abs(cur - tgt) > 2) return;
  const key = now.toISOString().slice(0, 10) + '-' + cfg.hour + '-' + cfg.minute;
  if (lastBackupSchedKey === key) return;
  lastBackupSchedKey = key;
  runBackup('scheduled', null, { mode: scheduledMode(now) });
}
// In 'diff' mode the weekly/monthly full day gets a full run, every other day a differential one.
function scheduledMode(now) {
  const s = backupsCache.schedule || {};
  if (s.mode !== 'diff') return 'full';
  if (s.fullEvery === 'monthly') return now.getDate() === (s.fullDate || 1) ? 'full' : 'diff';
  return now.getDay() === (s.fullDay == null ? 0 : s.fullDay) ? 'full' : 'diff';
}


// Ad-hoc backup of one site's files (and, when known, nothing else). Returns the log entry when done.
function runSiteBackup(domain, actor, mode) {
  const site = listSites().find((s) => s.domain === domain);
  if (!site) return Promise.resolve({ error: 'unknown site ' + domain });
  return runBackup('manual', actor, { site: domain, mode, scope: { postgres: false, sites: true, siteDomains: [domain], configs: false, extraPaths: [] } });
}
// Ad-hoc backup of every site's files in ONE run (one remote folder, one log entry).
// Labelled like a per-site run so it neither overwrites lastRun nor prunes — the
// nightly full backup stays the thing retention is measured against.
function runAllSitesBackup(actor, mode) {
  if (!listSites().length) return Promise.resolve({ error: 'no sites to back up' });
  return runBackup('manual', actor, { site: ALL_SITES_LABEL, mode, scope: { postgres: false, sites: true, siteDomains: null, configs: false, extraPaths: [] } });
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
    for (const k of ['postgres', 'sites', 'configs', 'cloudpanelDb', 'crontabs', 'pm2', 'fail2ban']) if (typeof sIn[k] === 'boolean') next[k] = sIn[k];
    for (const k of ['pgDatabases', 'siteDomains']) if (k in sIn) next[k] = Array.isArray(sIn[k]) ? sIn[k].filter((x) => typeof x === 'string').slice(0, 200) : null;
    if ('extraPaths' in sIn) next.extraPaths = Array.isArray(sIn.extraPaths) ? sIn.extraPaths.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, 50) : [];
    backupsCache.scope = next;
  }
  if (cfg.retentionDays != null) backupsCache.retentionDays = Math.max(1, Math.min(365, parseInt(cfg.retentionDays) || 14));
  saveBackups();
}
function exportSettings() { return { schedule: backupsCache.schedule, retentionDays: backupsCache.retentionDays, keepFulls: backupsCache.keepFulls, scope: backupsCache.scope }; }

module.exports = { DEFAULT_BACKUP_SCOPE, loadBackups, saveBackups, runBackup, runSiteBackup, runAllSitesBackup, ALL_SITES_LABEL, listSites, backupAvailable, backupAvailableFull, listRemoteBackups, classifyFolder, scheduledMode, backupTick, getState, isRunning, clearLog, setConfig, exportSettings };
