'use strict';
/* ---------------------------------------------------------------- backups */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { APP_ROOT } = require('./config');
const { execP, fmtBytes, dirSize, homeUsers, PG_SOCKET: PG_HOST } = require('./util');
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
const BACKUP_PREFIX = 'web01-backups';          // remote:rhcsolutions/web01-backups/<stamp>/...
const BACKUP_STAGE  = '/var/tmp/rhc-backups';   // local staging (root fs, NOT tmpfs)
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
let backupsCache = {
  schedule: { enabled: true, hour: 3, minute: 30 },
  retentionDays: 14,
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
    if (r.err) result.errors.push('pg_dump ' + db + ': ' + (r.stderr || r.err.message || '').split('\n')[0]);
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
async function tarSites(stageDir, result, scope) {
  const dir = path.join(stageDir, 'sites');
  fs.mkdirSync(dir, { recursive: true });
  const excl = SITE_TAR_EXCLUDES.map(d => "--exclude='" + d + "'").join(' ');
  const sel = Array.isArray(scope.siteDomains) ? scope.siteDomains : null;
  for (const s of listSites()) {
    if (!s.user || !s.domain) continue;
    if (sel && !sel.includes(s.domain)) continue;
    const src = (s.root && fs.existsSync(s.root)) ? s.root : ('/home/' + s.user + '/htdocs/' + s.domain);
    if (!fs.existsSync(src)) continue;
    const file = path.join(dir, s.domain + '.tar.zst');
    const parent = path.dirname(src), base = path.basename(src);
    const r = await execP('bash', ['-c',
      "tar " + excl + " --warning=no-file-changed --ignore-failed-read -C '" + parent + "' -cf - '" + base
      + "' | zstd -q -T2 -o '" + file + "' -f"], { timeout: 60 * 60_000 });
    if (r.err && !fs.existsSync(file)) result.errors.push('tar ' + s.domain + ': ' + (r.stderr || '').split('\n')[0]);
    else result.items.push('sites/' + s.domain + '.tar.zst');
  }
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
  if (r.err && !fs.existsSync(file)) result.errors.push('tar configs: ' + (r.stderr || '').split('\n')[0]);
  else result.items.push('configs/configs.tar.zst');
  try {
    require('./db').snapshotTo(path.join(dir, 'rhc.sqlite'));
    result.items.push('configs/rhc.sqlite');
  } catch (e) { result.errors.push('rhc db snapshot: ' + e.message); }
  if (sc.cloudpanelDb !== false && fs.existsSync(CLP_DB)) {
    // consistent snapshot of CloudPanel's sqlite DB (sites, users, vhosts) via the online-backup API
    const out = path.join(dir, 'cloudpanel-db.sq3');
    const r2 = await execP('sqlite3', [CLP_DB, ".backup '" + out + "'"], { timeout: 5 * 60_000 });
    if (r2.err) result.errors.push('cloudpanel db: ' + (r2.stderr || r2.err.message || '').split('\n')[0]);
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
  if (r.err && !fs.existsSync(file)) result.errors.push('tar extra: ' + (r.stderr || '').split('\n')[0]);
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

async function pruneBackups(result) {
  const days = backupsCache.retentionDays || 14;
  const base = RCLONE_REMOTE + BACKUP_BUCKET + '/' + BACKUP_PREFIX;
  const del = await execP('rclone', rcloneArgs(['delete', base, '--min-age', days + 'd']),
    { timeout: 30 * 60_000, env: RCLONE_ENV() });
  if (del.err) { result.errors.push('prune: ' + (del.stderr || '').split('\n').slice(-2).join(' ').trim()); return; }
  await execP('rclone', rcloneArgs(['rmdirs', base, '--leave-root']), { timeout: 10 * 60_000, env: RCLONE_ENV() });
}

// opts.scope overrides the configured scope (per-site runs); opts.site labels the run and its remote folder
// (<prefix>/<stamp>-<domain>) so it sits next to the full backups and ages out with the same retention.
async function runBackup(trigger, actor, opts) {
  opts = opts || {};
  if (backupRunning) return { error: 'A backup is already running' };
  backupRunning = true; backupsCache.running = true;
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const stamp = backupStamp() + (opts.site ? '-' + String(opts.site).replace(/[^A-Za-z0-9.-]/g, '_') : '');
  const stageDir = path.join(BACKUP_STAGE, stamp);
  const result = { items: [], errors: [] };
  let bytes = 0;
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    const scope = opts.scope || backupsCache.scope || {};
    if (scope.postgres) await dumpPostgres(stageDir, result, scope);
    if (scope.sites)    await tarSites(stageDir, result, scope);
    if (scope.configs)  await tarConfigs(stageDir, result, scope);
    if (Array.isArray(scope.extraPaths) && scope.extraPaths.length) await tarExtras(stageDir, result, scope.extraPaths);
    bytes = dirSize(stageDir);
    if (result.items.length) {
      const dest = RCLONE_REMOTE + BACKUP_BUCKET + '/' + BACKUP_PREFIX + '/' + stamp;
      const up = await execP('rclone', rcloneArgs(['copy', stageDir, dest, '--transfers', '4']),
        { timeout: 6 * 60 * 60_000, env: RCLONE_ENV() });
      if (up.err) result.errors.push('rclone upload: ' + (up.stderr || up.err.message || '').split('\n').slice(-2).join(' ').trim());
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
    startedAt, finishedAt: new Date().toISOString(), trigger, success, bytes,
    itemCount: result.items.length, items: result.items, errors: result.errors,
    duration_ms: Date.now() - start, stamp, site: opts.site || null,
  };
  if (!opts.site) backupsCache.lastRun = entry;
  backupsCache.log.push(entry);
  if (backupsCache.log.length > BACKUP_LOG_MAX) backupsCache.log = backupsCache.log.slice(-BACKUP_LOG_MAX);
  saveBackups();
  events.emit('backups.run', { user: trigger === 'manual' ? (actor && actor.user) || 'system' : 'system', ip: actor && actor.ip, target: stamp, site: opts.site || undefined,
    level: success ? 'info' : 'error', message: (opts.site ? 'Site backup of ' + opts.site : 'Backup (' + trigger + ')') + ' ' + (success ? 'completed: ' : 'FAILED: ') + result.items.length + ' items, ' + fmtBytes(bytes),
    data: { items: result.items, errors: result.errors, duration_ms: entry.duration_ms, bytes } });
  // optional notify, reusing the Updates-tab Telegram config
  const tel = notify.getConfig();
  if (tel && tel.enabled && tel.botToken && tel.chatId && (!success || tel.notifyOnComplete)) {
    const msg = (success ? '✅' : '⚠️') + ' web01 backup (' + trigger + ') — '
      + result.items.length + ' items, ' + fmtBytes(bytes) + ', ' + Math.round(entry.duration_ms / 1000) + 's'
      + (result.errors.length ? '\nErrors:\n• ' + result.errors.join('\n• ') : '');
    try { await notify.sendTelegram(msg); } catch (_) {}
  }
  return entry;
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
  runBackup('scheduled');
}


// Ad-hoc backup of one site's files (and, when known, nothing else). Returns the log entry when done.
function runSiteBackup(domain, actor) {
  const site = listSites().find((s) => s.domain === domain);
  if (!site) return Promise.resolve({ error: 'unknown site ' + domain });
  return runBackup('manual', actor, { site: domain, scope: { postgres: false, sites: true, siteDomains: [domain], configs: false, extraPaths: [] } });
}
// Accessors for the dispatcher (module state is never exported directly).
function getState() { return backupsCache; }
function isRunning() { return backupRunning; }
function clearLog() { backupsCache.log = []; saveBackups(); }
// POST /api/backup/config: merge + validate { schedule?, scope?, retentionDays? }.
function setConfig(cfg) {
  if (cfg.schedule) backupsCache.schedule = Object.assign({}, backupsCache.schedule, cfg.schedule);
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
function exportSettings() { return { schedule: backupsCache.schedule, retentionDays: backupsCache.retentionDays, scope: backupsCache.scope }; }

module.exports = { DEFAULT_BACKUP_SCOPE, loadBackups, saveBackups, runBackup, runSiteBackup, listSites, backupAvailable, listRemoteBackups, backupTick, getState, isRunning, clearLog, setConfig, exportSettings };
