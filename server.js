#!/usr/bin/env node
/**
 * pm2-status — consolidated, Uptime-Kuma-style status page for all per-user
 * PM2 daemons on this host. Zero dependencies.
 *
 *   GET /            -> HTML dashboard (auto-refreshes)
 *   GET /api/status  -> JSON (current state + heartbeat history)
 *
 * Binds to 127.0.0.1 only; exposed via nginx at /pm2status/ with basic auth.
 * History is sampled every SAMPLE_MS and persisted to history.json so
 * heartbeat bars survive restarts of this service.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

const PORT = process.env.PORT || 8899;
const HOST = '127.0.0.1';
const EXEC_TIMEOUT = 10000;
const SAMPLE_MS = 60_000;            // heartbeat sampling interval
const HISTORY_MAX = 1440;            // keep 24h of samples per app
const BEATS_SHOWN = 50;              // beats rendered per bar
const HISTORY_FILE = path.join(__dirname, 'history.json');
const DB_CREDS_FILE = path.join(__dirname, 'db-credentials.json');

/* --------------------------------------------------------------- updates */

const UPDATES_FILE = path.join(__dirname, 'updates.json');
const CHECK_INTERVAL_MS = 3600_000;          // check for latest versions hourly
const UPDATE_LOG_MAX = 50;

const COMPONENTS = [
  { key: 'node',     label: 'Node.js',     bin: 'node',     pkg: null,                         verFlag: '--version' },
  { key: 'pi',       label: 'Pi',          bin: 'pi',       pkg: '@earendil-works/pi-coding-agent', verFlag: '--version' },
  { key: 'opencode', label: 'OpenCode',    bin: 'opencode', pkg: 'opencode-ai',                verFlag: '--version' },
  { key: 'codex',    label: 'Codex CLI',   bin: 'codex',    pkg: 'codex',                      verFlag: '--version' },
  { key: 'gemini',   label: 'Gemini CLI',  bin: 'gemini',   pkg: '@google/gemini-cli',         verFlag: '--version' },
  { key: 'claude',   label: 'Claude Code', bin: 'claude',   pkg: '@anthropic-ai/claude-code',  verFlag: '--version' },
];

/* -------------------------------------------------------------- postgres */
// Connect as root → postgres role over the unix socket (peer auth, no password).
const PG_SOCKET = '/var/run/postgresql';
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
        if (err && !stdout) return resolve({ error: String((err.message || '').split('\n')[0] || err.code) });
        try { resolve({ data: JSON.parse(stdout.trim()) }); }
        catch (e) { resolve({ error: 'parse failed: ' + stdout.slice(0, 120) }); }
      });
  });
}

function loadDbCreds() {
  try { return JSON.parse(fs.readFileSync(DB_CREDS_FILE, 'utf8')).credentials || []; }
  catch (_) { return []; }
}

let latestDb = null, latestDbAt = 0;
async function dbSample() {
  const res = await pgQuery();
  latestDb = res; latestDbAt = Date.now();
  const t = Math.floor(Date.now() / 1000);
  if (res.error) return;                         // cluster down: don't fabricate per-db states
  for (const db of res.data.dbs || []) {
    const key = `db::${db.name}`;
    const arr = history[key] || (history[key] = []);
    arr.push([t, 1]);
    if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  }
}

function buildDbPayload() {
  const r = latestDb || {};
  const dbs = (r.data && r.data.dbs ? r.data.dbs : []).map((db) => {
    const arr = history[`db::${db.name}`] || [];
    const total = db.blks_hit + db.blks_read;
    return {
      ...db,
      cache_hit: total > 0 ? (db.blks_hit / total) * 100 : null,
      beats: arr.slice(-BEATS_SHOWN),
      uptime24h: uptimePct(arr),
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
  } catch { sqlite = { error: 'unreachable' }; }

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
  } catch { mariadb = { error: 'unreachable' }; }

  return {
    generated_at: new Date(latestDbAt || Date.now()).toISOString(),
    error: r.error || null,
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
    credentials: loadDbCreds(),
    sqlite,
    mariadb,
  };
}

/* ----------------------------------------------------------- updates api */

let updatesCache = null;             // { components: [...], lastChecked, schedule, telegram, log: [...] }
let updatesCacheAt = 0;
let updatesRunning = new Map();      // component key -> promise
let updateLog = [];

function loadUpdates() {
  try {
    const data = JSON.parse(fs.readFileSync(UPDATES_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      updatesCache = data;
      if (data.log) updateLog = data.log;
    }
  } catch (_) {}
}
function saveUpdates() {
  try {
    if (updatesCache) {
      updatesCache.log = updateLog.slice(-UPDATE_LOG_MAX);
      fs.writeFileSync(UPDATES_FILE + '.tmp', JSON.stringify(updatesCache, null, 2));
      fs.renameSync(UPDATES_FILE + '.tmp', UPDATES_FILE);
    }
  } catch (_) {}
}

async function getCurrentVersion(comp) {
  return new Promise((resolve) => {
    execFile(comp.bin, [comp.verFlag], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      let v = stdout.trim().split('\n')[0].replace(/^v/, '');
      // Strip trailing annotations like "(Claude Code)"
      v = v.replace(/\s*\(.*\)\s*$/, '').trim();
      resolve(v || null);
    });
  });
}

async function getLatestVersion(comp) {
  if (!comp.pkg) {
    // Node.js: fetch latest release (not just LTS) from nodejs.org
    try {
      const res = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(8000) });
      const list = await res.json();
      return list[0] ? list[0].version.replace(/^v/, '') : null;
    } catch { return null; }
  }
  // npm package: use npm view
  return new Promise((resolve) => {
    execFile('npm', ['view', comp.pkg, 'version'], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

async function getUserVersion(user, comp) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', '-u', user, 'sh', '-c',
      `PATH="$HOME/.npm-global/bin:$PATH" command -v ${comp.bin} 2>/dev/null && PATH="$HOME/.npm-global/bin:$PATH" ${comp.bin} ${comp.verFlag} 2>/dev/null || echo '__NOT_FOUND__'`
    ], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const v = stdout.trim().split('\n').pop().replace(/^v/, '').replace(/\s*\(.*\)\s*$/, '').trim();
      return resolve(v === '__NOT_FOUND__' ? null : v || null);
    });
  });
}

async function collectUpdates() {
  const now = Date.now();
  const results = [];

  for (const comp of COMPONENTS) {
    const current = await getCurrentVersion(comp);
    const latest = await getLatestVersion(comp);
    results.push({
      key: comp.key,
      label: comp.label,
      bin: comp.bin,
      pkg: comp.pkg,
      currentVersion: current,
      latestVersion: latest,
      updateAvailable: !!(current && latest && current !== latest),
      updating: updatesRunning.has(comp.key),
    });
  }

  // Get per-user versions for CloudPanel site users + root
  const userCompKeys = COMPONENTS.map(c => c.key);
  const siteUsers = querySitesDb().map(s => s.user);
  const uniqueUsers = [...new Set(siteUsers), 'root'].filter(u => u && u !== 'clp');
  const userVersions = {};
  for (const user of uniqueUsers) {
    userVersions[user] = {};
    for (const key of userCompKeys) {
      const comp = COMPONENTS.find(c => c.key === key);
      if (comp) {
        userVersions[user][key] = await getUserVersion(user, comp);
      }
    }
  }

  const upd = {
    components: results,
    users: userVersions,
    siteUsers: uniqueUsers,
    lastChecked: new Date(now).toISOString(),
    schedule: updatesCache ? updatesCache.schedule : { enabled: false, hour: 3, minute: 0, components: COMPONENTS.map(c => c.key) },
    telegram: updatesCache ? updatesCache.telegram : { enabled: false, botToken: '', chatId: '', notifyOnUpdate: true, notifyOnComplete: true },
    log: updateLog.slice(-UPDATE_LOG_MAX),
  };
  updatesCache = upd;
  updatesCacheAt = now;
  saveUpdates();
  return upd;
}

async function runUserUpdate(user, compKey) {
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (!comp.pkg) return { error: 'No npm package for ' + comp.label };
  const start = Date.now();
  let success = false, output = '';
  try {
    // Check if user has their own npm prefix or shares the system one
    let useRoot = false;
    try {
      const prefix = execFileSync('sudo', ['-n', '-u', user, 'npm', 'config', 'get', 'prefix'], { timeout: 5000, encoding: 'utf8' }).trim();
      if (prefix === '/usr' || prefix === '/usr/local') useRoot = true;
    } catch { useRoot = true; }
    const cmd = useRoot
      ? ['npm', 'update', '-g', comp.pkg]
      : ['sudo', '-n', '-u', user, 'sh', '-c', `npm update -g ${comp.pkg} 2>&1`];
    const opts = useRoot
      ? { timeout: 120000, maxBuffer: 1024 * 1024 }
      : { timeout: 120000, maxBuffer: 1024 * 1024 };
    const result = await new Promise((resolve) => {
      execFile(cmd[0], cmd.slice(1), opts, (err, stdout, stderr) => {
        resolve({ err, stdout: (stdout || '') + '\n' + (stderr || '') });
      });
    });
    output = result.stdout.trim();
    success = !result.err;
  } catch (e) {
    output = e.message;
    success = false;
  }
  // Refresh per-user versions after update
  if (success && updatesCache && updatesCache.users && updatesCache.users[user]) {
    for (const c of COMPONENTS) {
      if (c.key === compKey) {
        const v = await getUserVersion(user, c);
        if (v) updatesCache.users[user][c.key] = v;
      }
    }
  }
  const entry = {
    component: compKey, label: comp.label, user, success,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();
  return entry;
}

async function runUpdate(compKey) {
  if (updatesRunning.has(compKey)) return { error: 'Update already in progress' };
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (!comp.pkg) return { error: 'Update command not defined for ' + comp.label + '. Use nvm/fnm/n manually.' };

  updatesRunning.set(compKey, true);
  const start = Date.now();
  let success = false, output = '';

  try {
    const result = await new Promise((resolve) => {
      execFile('npm', ['update', '-g', comp.pkg], { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      });
    });
    output = (result.stdout + '\n' + result.stderr).trim();
    success = !result.err;

    // Update the cached latest version after update
    const newVersion = await getCurrentVersion(comp);
    if (newVersion && updatesCache) {
      const c = updatesCache.components.find(x => x.key === compKey);
      if (c) {
        c.currentVersion = newVersion;
        // Re-check latest
        const latest = await getLatestVersion(comp);
        c.latestVersion = latest;
        c.updateAvailable = !!(newVersion && latest && newVersion !== latest);
        c.updating = false;
      }
    }
  } catch (e) {
    output = e.message;
    success = false;
  } finally {
    updatesRunning.delete(compKey);
  }

  const entry = {
    component: compKey,
    label: comp.label,
    success,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();

  // Telegram notification
  if (updatesCache && updatesCache.telegram && updatesCache.telegram.enabled) {
    const icon = success ? '✅' : '❌';
    const msg = `${icon} *Update ${comp.label}*: ${success ? 'succeeded' : 'failed'}\n\`${output.slice(0, 500)}\``;
    sendTelegram(msg);
  }

  return entry;
}

/* ------------------------------------------------------------ telegram */

async function sendTelegram(text) {
  const cfg = updatesCache ? updatesCache.telegram : null;
  if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) return;
  try {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
}

/* ------------------------------------------------------- update scheduler */

let schedulerTimer = null;
function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(() => {
    const cfg = updatesCache;
    if (!cfg || !cfg.schedule || !cfg.schedule.enabled) return;
    const now = new Date();
    const schedMin = now.getHours() * 60 + now.getMinutes();
    const schedTarget = cfg.schedule.hour * 60 + cfg.schedule.minute;
    // Run within a 5-minute window
    if (Math.abs(schedMin - schedTarget) > 2) return;
    // Only run if we haven't already run in the last 24h for these components
    const lastRun = updateLog.filter(e => e.success).pop();
    if (lastRun && (Date.now() - new Date(lastRun.timestamp).getTime()) < 82800000) return; // 23h
    for (const key of cfg.schedule.components || []) {
      runUpdate(key);
    }
  }, 60000); // check every minute
}

/* -------------------------------------------------------------- sites */

const CLP_DB = '/home/clp/htdocs/app/data/db.sq3';

function querySitesDb() {
  try {
    const out = execFileSync('sqlite3', [CLP_DB,
      "SELECT s.id, s.domain_name, s.type, s.user, s.root_directory, s.reverse_proxy_url, s.varnish_cache, "
      + "n.port AS node_port, n.nodejs_version, "
      + "p.php_version, p.pool_port, p.memory_limit "
      + "FROM site s "
      + "LEFT JOIN nodejs_settings n ON n.site_id = s.id "
      + "LEFT JOIN php_settings p ON p.site_id = s.id "
      + "ORDER BY s.domain_name"
    ], { timeout: 5000, encoding: 'utf8' });
    return out.trim().split('\n').filter(l => l).map(line => {
      const [id, domain, type, user, root, revProxy, varnish, nodePort, nodeVer, phpVer, poolPort, phpMem] = line.split('|');
      return { id, domain, type, user, root, revProxy, varnish: varnish === '1', nodePort: nodePort || null, nodeVer: nodeVer || null, phpVer: phpVer || null, poolPort: poolPort || null, phpMem: phpMem || null };
    });
  } catch (_) { return []; }
}

let sitesCache = null, sitesCacheAt = 0;

function getSiteDisk(dir) {
  try {
    const out = execFileSync('du', ['-sh', dir], { timeout: 3000, encoding: 'utf8' });
    return out.trim().split('\t')[0];
  } catch { return '?'; }
}

function isPortListening(port) {
  try {
    const out = execFileSync('ss', ['-tlnpH'], { timeout: 3000, encoding: 'utf8' });
    return out.includes(`:${port} `);
  } catch { return false; }
}

async function checkSiteHealth(site) {
  const result = {
    id: site.id, domain: site.domain, type: site.type, user: site.user,
    root: site.root, revProxy: site.revProxy,
    nodeVersion: site.nodeVer, phpVersion: site.phpVer,
    portUp: false, httpUp: false, disk: '?', pm2: null,
    status: 'unknown', statusLabel: 'Unknown',
  };

  // Check port
  if (site.nodePort) {
    result.portUp = isPortListening(site.nodePort);
  } else if (site.poolPort) {
    result.portUp = isPortListening(site.poolPort);
  } else if (site.type === 'static') {
    result.portUp = true; // served by nginx, no app port
  }

  // HTTP health check
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://${site.domain}/`, { signal: ctrl.signal, redirect: 'follow' });
    result.httpUp = res.ok || res.status < 500;
  } catch {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`http://${site.domain}/`, { signal: ctrl.signal, redirect: 'follow' });
      result.httpUp = res.ok || res.status < 500;
    } catch { result.httpUp = false; }
  }

  // Disk
  if (site.user) {
    const homeDir = `/home/${site.user}`;
    result.disk = getSiteDisk(homeDir);
  }

  // PM2 process data (match against existing PM2 data)
  if (latest) {
    const userDirs = [];
    const siteHome = (() => { try { return fs.realpathSync(`/home/${site.user}`); } catch { return ''; } })();
    for (const g of latest) {
      if (g.user === site.user) { userDirs.push(g); continue; }
      if (g.pm2_home.includes(`/home/${site.user}/`) || g.pm2_home.includes(`/home/${site.user}.`)) { userDirs.push(g); continue; }
      if (g.user.includes(site.user) || site.user.includes(g.user)) { userDirs.push(g); continue; }
      // Check if home directories resolve to same path (symlinked SSH users)
      if (siteHome) {
        try {
          const pm2HomeDir = path.dirname(g.pm2_home);
          if (fs.realpathSync(pm2HomeDir) === siteHome) { userDirs.push(g); continue; }
        } catch {}
        // Check if PM2 user's htdocs symlink points to site user's htdocs
        try {
          const pm2Htdocs = fs.realpathSync(path.join(path.dirname(g.pm2_home), 'htdocs'));
          const siteHtdocs = path.join(siteHome, 'htdocs');
          if (pm2Htdocs === siteHtdocs) { userDirs.push(g); continue; }
        } catch {}
      }
      // Check PM2 process names for site domain name
      if (g.processes.some(p => p.name.includes(site.domain.split('.')[0]))) { userDirs.push(g); continue; }
    }
    // Deduplicate
    const seen = new Set();
    const deduped = [];
    for (const g of userDirs) {
      if (!seen.has(g.user)) { seen.add(g.user); deduped.push(g); }
    }
    if (deduped.length) {
      result.pm2 = deduped.flatMap(g => g.processes);
    }
  }

  const colors = { 'online': 'up' };
  // Determine overall status
  const pm2Online = result.pm2 ? result.pm2.some(p => p.status === 'online') : false;
  if (site.type === 'static') {
    result.status = result.httpUp ? 'online' : 'down';
  } else if (site.nodePort) {
    if (pm2Online && result.httpUp) { result.status = 'online'; }
    else if (!result.portUp && !result.httpUp) { result.status = 'down'; }
    else { result.status = 'degraded'; }
  } else if (site.poolPort) {
    if (result.portUp && result.httpUp) { result.status = 'online'; }
    else { result.status = 'down'; }
  }
  result.statusLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);
  return result;
}

async function collectSites() {
  const sites = querySitesDb();
  const results = await Promise.all(sites.map(s => checkSiteHealth(s)));
  sitesCache = { sites: results, generated_at: new Date().toISOString() };
  sitesCacheAt = Date.now();
  return sitesCache;
}

/* ---------------------------------------------------------------- modules */
const MODULES_FILE = path.join(__dirname, 'modules.json');
const MODULES_TIMEOUT = 90_000;          // per-project npm outdated timeout
const MODULES_CONCURRENCY = 3;           // parallel scans (registry-bound)
const MODULES_INTERVAL_MS = 6 * 3600_000; // refresh every 6h
const MOD_UPDATE_TIMEOUT = 5 * 60_000;   // per-update timeout
const MOD_UPDATE_LOG_MAX = 50;
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const MOD_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', 'cache',
  'coverage', '.git', 'tmp', '.turbo', '.vite', '.parcel-cache', '.svelte-kit',
]);

let modulesCache = null;
let modulesScanInProgress = false;
let modulesScanProgress = { total: 0, done: 0, current: null, startedAt: null };
const moduleUpdatesActive = {};   // key: realpath dir -> { user, packages, startedAt }
let moduleUpdateLog = [];          // recent results, newest last

function loadModulesCache() {
  try {
    const data = JSON.parse(fs.readFileSync(MODULES_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      modulesCache = data;
      moduleUpdateLog = Array.isArray(data.updateLog) ? data.updateLog : [];
    }
  } catch (_) { /* first run */ }
}

function saveModulesCache() {
  try {
    if (modulesCache) modulesCache.updateLog = moduleUpdateLog;
    fs.writeFileSync(MODULES_FILE + '.tmp', JSON.stringify(modulesCache));
    fs.renameSync(MODULES_FILE + '.tmp', MODULES_FILE);
  } catch (e) { console.error('modules save failed:', e.message); }
}

function detectPM(dir) {
  try { if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'; } catch {}
  try { if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'; } catch {}
  return 'npm';
}

// Walk a tree looking for installed projects (dirs with both package.json AND node_modules).
// Stops descending into a project once found (its own node_modules is uninteresting).
function findInstalledProjects(root, maxDepth = 5) {
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let hasPkg = false, hasNm = false;
    for (const e of entries) {
      if (e.name === 'package.json' && e.isFile()) hasPkg = true;
      else if (e.name === 'node_modules' && e.isDirectory()) hasNm = true;
    }
    if (hasPkg && hasNm) { results.push(dir); continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (MOD_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return results;
}

function dirOwner(dir) {
  try { return uidToName(fs.statSync(dir).uid); } catch { return 'root'; }
}

function discoverModuleProjects() {
  const found = [];
  // /home/<user>/htdocs/...
  let users;
  try { users = fs.readdirSync('/home'); } catch { users = []; }
  for (const user of users) {
    const htdocs = path.join('/home', user, 'htdocs');
    let st;
    try { st = fs.statSync(htdocs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const dir of findInstalledProjects(htdocs)) {
      found.push({ dir, user: dirOwner(dir), scope: user });
    }
  }
  // /opt/<dir>
  try {
    for (const e of fs.readdirSync('/opt', { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const root = path.join('/opt', e.name);
      for (const dir of findInstalledProjects(root, 4)) {
        found.push({ dir, user: dirOwner(dir), scope: 'opt:' + e.name });
      }
    }
  } catch (_) { /* no /opt */ }
  // Dedup by realpath
  const seen = new Set();
  const out = [];
  for (const p of found) {
    let real;
    try { real = fs.realpathSync(p.dir); } catch { real = p.dir; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ ...p, dir: real });
  }
  return out;
}

function readPkgJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return null; }
}

function npmOutdated(project) {
  return new Promise((resolve) => {
    const cwdEsc = project.dir.replace(/'/g, `'\\''`);
    const shCmd = `cd '${cwdEsc}' && npm outdated --json --depth=0 2>/dev/null || true`;
    const isRoot = !project.user || project.user === 'root';
    const bin = isRoot ? 'sh' : 'sudo';
    const args = isRoot ? ['-c', shCmd] : ['-n', '-H', '-u', project.user, 'sh', '-c', shCmd];
    execFile(bin, args, { timeout: MODULES_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: String(err.code || err.signal || err.message) });
        const trimmed = (stdout || '').trim();
        if (!trimmed) return resolve({ outdated: {} });
        try { return resolve({ outdated: JSON.parse(trimmed) }); }
        catch (_) { return resolve({ error: 'npm outdated parse failed' }); }
      });
  });
}

function semverParts(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function severityOf(current, latest) {
  const a = semverParts(current);
  const b = semverParts(latest);
  if (!a || !b) return null;
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return null;
}

function relPath(dir) {
  const m = dir.match(/^\/home\/([^/]+)\/(.*)$/);
  if (m) return '~' + m[1] + '/' + m[2];
  return dir;
}

async function collectModules() {
  if (modulesScanInProgress) return modulesCache;
  modulesScanInProgress = true;
  modulesScanProgress = { total: 0, done: 0, current: null, startedAt: new Date().toISOString() };
  try {
    const projects = discoverModuleProjects();
    modulesScanProgress.total = projects.length;

    // Pre-fill metadata from package.json
    const enriched = projects.map((p) => {
      const pkg = readPkgJson(p.dir) || {};
      const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      return {
        dir: p.dir,
        relDir: relPath(p.dir),
        user: p.user,
        scope: p.scope,
        pm: detectPM(p.dir),
        pkgName: pkg.name || path.basename(p.dir),
        pkgVersion: pkg.version || null,
        depCount: Object.keys(direct).length,
        outdated: null,
        error: null,
        scannedAt: null,
      };
    });

    let idx = 0;
    async function worker() {
      while (idx < enriched.length) {
        const i = idx++;
        const p = enriched[i];
        modulesScanProgress.current = p.dir;
        const r = await npmOutdated({ dir: p.dir, user: p.user });
        p.error = r.error || null;
        p.outdated = r.outdated || {};
        p.scannedAt = new Date().toISOString();
        modulesScanProgress.done++;
      }
    }
    await Promise.all(Array.from({ length: MODULES_CONCURRENCY }, () => worker()));

    // Flatten outdated rows + classify severity
    const rows = [];
    let major = 0, minor = 0, patch = 0;
    for (const p of enriched) {
      if (!p.outdated) continue;
      for (const [name, info] of Object.entries(p.outdated)) {
        const sev = severityOf(info.current, info.latest);
        rows.push({
          user: p.user,
          dir: p.dir,
          relDir: p.relDir,
          pkgName: p.pkgName,
          pm: p.pm,
          package: name,
          current: info.current || null,
          wanted: info.wanted || null,
          latest: info.latest || null,
          type: info.type || 'dependencies',
          severity: sev,
        });
        if (sev === 'major') major++;
        else if (sev === 'minor') minor++;
        else if (sev === 'patch') patch++;
      }
    }

    modulesCache = {
      generated_at: new Date().toISOString(),
      summary: {
        projects: enriched.length,
        projectsOutdated: enriched.filter((p) => p.outdated && Object.keys(p.outdated).length).length,
        outdatedTotal: rows.length,
        major, minor, patch,
        errors: enriched.filter((p) => p.error).length,
      },
      projects: enriched,
      outdated: rows,
      updateLog: moduleUpdateLog,
    };
    saveModulesCache();
  } catch (e) {
    console.error('collectModules failed:', e.message);
  } finally {
    modulesScanInProgress = false;
    modulesScanProgress = { total: 0, done: 0, current: null, startedAt: null };
  }
  return modulesCache;
}

function recomputeModulesSummary() {
  if (!modulesCache) return;
  const rows = [];
  let major = 0, minor = 0, patch = 0;
  for (const p of modulesCache.projects) {
    if (!p.outdated) continue;
    for (const [name, info] of Object.entries(p.outdated)) {
      const sev = severityOf(info.current, info.latest);
      rows.push({
        user: p.user, dir: p.dir, relDir: p.relDir, pkgName: p.pkgName, pm: p.pm,
        package: name,
        current: info.current || null,
        wanted: info.wanted || null,
        latest: info.latest || null,
        type: info.type || 'dependencies',
        severity: sev,
      });
      if (sev === 'major') major++;
      else if (sev === 'minor') minor++;
      else if (sev === 'patch') patch++;
    }
  }
  modulesCache.outdated = rows;
  modulesCache.summary = {
    projects: modulesCache.projects.length,
    projectsOutdated: modulesCache.projects.filter((p) => p.outdated && Object.keys(p.outdated).length).length,
    outdatedTotal: rows.length,
    major, minor, patch,
    errors: modulesCache.projects.filter((p) => p.error).length,
  };
}

async function rescanProject(dir, user) {
  if (!modulesCache) return;
  const idx = modulesCache.projects.findIndex((p) => p.dir === dir);
  if (idx < 0) return;
  const r = await npmOutdated({ dir, user });
  const pkg = readPkgJson(dir) || {};
  const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const proj = modulesCache.projects[idx];
  proj.outdated = r.outdated || {};
  proj.error = r.error || null;
  proj.scannedAt = new Date().toISOString();
  proj.pkgName = pkg.name || path.basename(dir);
  proj.pkgVersion = pkg.version || null;
  proj.depCount = Object.keys(direct).length;
  proj.pm = detectPM(dir);
  recomputeModulesSummary();
  modulesCache.generated_at = new Date().toISOString();
  saveModulesCache();
}

function appendUpdateLog(entry) {
  moduleUpdateLog.push(entry);
  if (moduleUpdateLog.length > MOD_UPDATE_LOG_MAX) {
    moduleUpdateLog.splice(0, moduleUpdateLog.length - MOD_UPDATE_LOG_MAX);
  }
  if (modulesCache) modulesCache.updateLog = moduleUpdateLog;
  saveModulesCache();
}

// Validate inputs and run an update for one project. packages is array of npm names; if empty, update all outdated in the project.
async function runModuleUpdate(dir, user, packagesIn) {
  if (!modulesCache) return { success: false, error: 'no scan cache; rescan first' };
  const project = modulesCache.projects.find((p) => p.dir === dir);
  if (!project) return { success: false, error: 'project not in scan cache' };

  // Verify dir is owned by claimed user (defense in depth — UI sends both)
  let actualUser;
  try { actualUser = uidToName(fs.statSync(dir).uid); }
  catch (e) { return { success: false, error: 'cannot stat dir: ' + e.message }; }
  if (actualUser !== user) return { success: false, error: `user mismatch (dir owned by '${actualUser}', not '${user}')` };

  // Compose the package list
  let packages;
  if (Array.isArray(packagesIn) && packagesIn.length) {
    packages = packagesIn;
  } else {
    packages = Object.keys(project.outdated || {});
  }
  if (!packages.length) return { success: false, error: 'no packages to update' };
  for (const pkg of packages) {
    if (!PKG_NAME_RE.test(pkg)) return { success: false, error: 'invalid package name: ' + pkg };
    if (!project.outdated || !project.outdated[pkg]) {
      return { success: false, error: `package '${pkg}' not in outdated list for this project (rescan?)` };
    }
  }

  const pm = project.pm || 'npm';
  const dirEsc = dir.replace(/'/g, `'\\''`);
  const pkgsAtLatest = packages.map((p) => `'${p}@latest'`).join(' ');
  let shCmd;
  if (pm === 'npm') {
    // --legacy-peer-deps: matches how most non-trivial Next/React/eslint-heavy projects
    // are installed; without it, modern npm refuses to install on any peer-dep mismatch.
    shCmd = `cd '${dirEsc}' && npm install --legacy-peer-deps --no-fund --no-audit --no-progress ${pkgsAtLatest} 2>&1`;
  } else if (pm === 'pnpm') {
    shCmd = `cd '${dirEsc}' && pnpm add ${pkgsAtLatest} 2>&1`;
  } else if (pm === 'yarn') {
    shCmd = `cd '${dirEsc}' && yarn add ${pkgsAtLatest} 2>&1`;
  } else {
    return { success: false, error: 'unsupported package manager: ' + pm };
  }

  if (moduleUpdatesActive[dir]) {
    return { success: false, error: 'an update is already running for this project' };
  }
  moduleUpdatesActive[dir] = { user, packages, startedAt: new Date().toISOString() };
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const isRoot = user === 'root';
    const bin = isRoot ? 'sh' : 'sudo';
    const args = isRoot ? ['-c', shCmd] : ['-n', '-H', '-u', user, 'sh', '-c', shCmd];
    execFile(bin, args, { timeout: MOD_UPDATE_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      async (err, stdout) => {
        const output = (stdout || '').toString();
        const success = !err;
        const result = {
          timestamp: new Date().toISOString(),
          dir, relDir: project.relDir, user,
          packages, pm,
          success,
          error: err ? String(err.code || err.signal || err.message) : null,
          output: output.slice(-4000),
          duration_ms: Date.now() - startedAt,
        };
        appendUpdateLog(result);
        delete moduleUpdatesActive[dir];
        // Rescan the project so the UI immediately reflects the new state
        try { await rescanProject(dir, user); } catch (e) { console.error('post-update rescan failed:', e.message); }
        resolve(result);
      });
  });
}

/* ---------------------------------------------------------------- collect */

function discoverDaemons() {
  const daemons = [];
  const candidates = [];
  try {
    for (const entry of fs.readdirSync('/home')) {
      candidates.push(path.join('/home', entry, '.pm2'));
    }
  } catch (_) { /* no /home */ }
  candidates.push('/root/.pm2');

  for (const dir of candidates) {
    let st;
    try { st = fs.statSync(dir); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let pid;
    try { pid = parseInt(fs.readFileSync(path.join(dir, 'pm2.pid'), 'utf8').trim(), 10); } catch (_) { continue; }
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (_) { continue; }
    daemons.push({ dir, uid: st.uid });
  }
  return daemons;
}

function uidToName(uid) {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of passwd.split('\n')) {
      const f = line.split(':');
      if (parseInt(f[2], 10) === uid) return f[0];
    }
  } catch (_) {}
  return String(uid);
}

function pm2Jlist(user, pm2Home) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', '-H', '-u', user, 'sh', '-c',
      `PM2_HOME='${pm2Home}' pm2 jlist --no-color 2>/dev/null | grep -E '^\\[' | head -1`],
      { timeout: EXEC_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: String(err.code || err.signal || err.message) });
        try {
          const procs = JSON.parse(stdout.trim());
          resolve({ procs });
        } catch (e) { resolve({ error: 'JSON parse failed' }); }
      });
  });
}

async function collect() {
  const daemons = discoverDaemons();
  const groups = await Promise.all(daemons.map(async (d) => {
    const user = uidToName(d.uid);
    const res = await pm2Jlist(user, d.dir);
    const procs = (res.procs || [])
      .filter((p) => !(p.pm2_env && p.pm2_env.axm_options && p.pm2_env.axm_options.isModule === true))
      .map((p) => {
        const env = p.pm2_env || {};
        const monit = p.monit || {};
        return {
          name: p.name,
          status: env.status || 'unknown',
          restarts: env.restart_time ?? 0,
          cpu: monit.cpu ?? 0,
          memory: monit.memory ?? 0,
          uptime_ms: env.status === 'online' && env.pm_uptime ? Date.now() - env.pm_uptime : null,
        };
      });
    return { user, pm2_home: d.dir, error: res.error || null, processes: procs };
  }));
  return groups.sort((a, b) => a.user.localeCompare(b.user));
}

/* ---------------------------------------------------------------- history */
// history: { "<user>/<app>": [[epochSec, state], ...] }  state: 1 up, 0 down, 2 restarted
let history = {};
let prevRestarts = {};

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (data && typeof data === 'object') { history = data.history || {}; prevRestarts = data.prevRestarts || {}; }
  } catch (_) { /* first run */ }
}

let lastSaved = 0;
function saveHistory(force) {
  const now = Date.now();
  if (!force && now - lastSaved < 5 * 60_000) return;
  lastSaved = now;
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify({ history, prevRestarts }));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) { console.error('history save failed:', e.message); }
}

let latest = null;           // last collected groups
let latestAt = 0;

async function sample() {
  let groups;
  try { groups = await collect(); } catch (e) { console.error('collect failed:', e.message); return; }
  latest = groups; latestAt = Date.now();
  const t = Math.floor(Date.now() / 1000);
  for (const g of groups) {
    if (g.error) continue;                      // daemon unreachable: skip, don't fake "down" for all apps
    for (const p of g.processes) {
      const key = `${g.user}/${p.name}`;
      let state = p.status === 'online' ? 1 : 0;
      if (state === 1 && prevRestarts[key] != null && p.restarts > prevRestarts[key]) state = 2;
      prevRestarts[key] = p.restarts;
      const arr = history[key] || (history[key] = []);
      arr.push([t, state]);
      if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    }
  }
  try { await dbSample(); } catch (e) { console.error('db sample failed:', e.message); }
  saveHistory(false);
}

function uptimePct(arr) {
  if (!arr || !arr.length) return null;
  const up = arr.filter((b) => b[1] !== 0).length;
  return (up / arr.length) * 100;
}

function buildPayload() {
  const groups = (latest || []).map((g) => ({
    user: g.user,
    pm2_home: g.pm2_home,
    error: g.error,
    processes: g.processes.map((p) => {
      const key = `${g.user}/${p.name}`;
      const arr = history[key] || [];
      return { ...p, beats: arr.slice(-BEATS_SHOWN), uptime24h: uptimePct(arr) };
    }),
  }));
  const all = groups.flatMap((g) => g.processes);
  return {
    generated_at: new Date(latestAt || Date.now()).toISOString(),
    hostname: os.hostname(),
    sample_interval_s: SAMPLE_MS / 1000,
    summary: {
      daemons: groups.length,
      total: all.length,
      online: all.filter((p) => p.status === 'online').length,
      down: all.filter((p) => p.status !== 'online').length,
      memory: all.reduce((s, p) => s + (p.memory || 0), 0),
    },
    groups,
  };
}

/* ------------------------------------------------------------------- html */

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PM2 Status</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#161823; color:#e9e9e9;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 1160px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; display:flex; align-items:center; gap:10px; }
  .sub { color:#9ca3af; font-size:13px; margin-bottom:20px; }
  .banner { border-radius: 14px; padding: 18px 22px; margin-bottom: 26px;
            font-size: 18px; font-weight: 600; display:flex; align-items:center; gap:12px; }
  .banner.ok   { background:#1f4e34; color:#5cdd8b; }
  .banner.bad  { background:#5a1f25; color:#ff8088; }
  .banner .ico { font-size: 22px; }
  .group { background:#1e2230; border-radius:14px; padding:6px 20px 10px; margin-bottom:22px;
           box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .group h2 { font-size:15px; font-weight:700; color:#e9e9e9; margin:14px 0 6px; }
  .group h2 .dim { color:#6b7280; font-weight:400; font-size:12px; margin-left:8px; }
  .row { display:flex; align-items:center; gap:14px; padding:10px 0; border-top:1px solid #2a2f40; }
  .row:first-of-type { border-top:none; }
  .stat { flex:0 0 64px; }
  .pill { display:inline-block; min-width:52px; text-align:center; padding:3px 10px; border-radius:999px;
          font-size:12px; font-weight:700; }
  .pill.up   { background:#5cdd8b; color:#0b2818; }
  .pill.down { background:#dc3545; color:#fff; }
  .meta { flex:1 1 180px; min-width:140px; }
  .name { font-weight:600; font-size:14.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .info { color:#9ca3af; font-size:12px; margin-top:1px; }
  .beats { display:flex; align-items:center; gap:3px; flex:0 0 auto; }
  .beat { width:7px; height:26px; border-radius:4px; background:#3a4054; transition: transform .12s; position:relative; }
  .beat.up { background:#5cdd8b; }
  .beat.down { background:#dc3545; }
  .beat.restart { background:#f8a306; }
  .beat:hover { transform: scale(1.35); }
  .beat:hover::after { content: attr(data-tip); position:absolute; bottom:34px; left:50%; transform:translateX(-50%);
        background:#0c0e16; color:#e9e9e9; font-size:11px; padding:4px 8px; border-radius:6px; white-space:nowrap;
        z-index:10; box-shadow:0 2px 8px rgba(0,0,0,.5); }
  .col { flex:0 0 58px; text-align:right; font-size:13px; font-variant-numeric: tabular-nums; color:#cbd5e1; }
  .col.warm { color:#f8a306; } .col.hot { color:#dc3545; font-weight:700; }
  .pct { flex:0 0 60px; text-align:right; font-size:13.5px; font-weight:600; }
  .pct.good { color:#5cdd8b; } .pct.mid { color:#f8a306; } .pct.poor { color:#dc3545; }
  .hdr { display:flex; align-items:center; gap:14px; padding:8px 0 2px; color:#6b7280; font-size:11px;
         text-transform:uppercase; letter-spacing:.5px; }
  .hdr .stat { flex:0 0 64px; } .hdr .meta { flex:1 1 180px; min-width:140px; } .hdr .beats-h { flex:0 0 auto; width:497px; }
  .hdr .col, .hdr .pct { font-weight:600; }
  .err { color:#ff8088; font-size:13px; padding:10px 0; }
  .toolbar { display:flex; align-items:center; gap:10px; margin-bottom:20px; flex-wrap:wrap; }
  .toolbar input { flex:1 1 220px; min-width:160px; background:#1e2230; border:1px solid #2a2f40; color:#e9e9e9;
        border-radius:10px; padding:9px 14px; font-size:14px; outline:none; }
  .toolbar input:focus { border-color:#5cdd8b66; }
  .chip { background:#1e2230; border:1px solid #2a2f40; color:#9ca3af; border-radius:999px; padding:7px 14px;
        font-size:13px; font-weight:600; cursor:pointer; }
  .chip:hover { color:#e9e9e9; }
  .chip.active { background:#5cdd8b; border-color:#5cdd8b; color:#0b2818; }
  .chip.active.down-chip { background:#dc3545; border-color:#dc3545; color:#fff; }
  .toolbar select { background:#1e2230; border:1px solid #2a2f40; color:#e9e9e9; border-radius:10px;
        padding:9px 12px; font-size:13px; cursor:pointer; outline:none; }
  .tabs { display:flex; gap:6px; margin:0 0 20px; border-bottom:1px solid #2a2f40; }
  .tab { background:none; border:none; color:#9ca3af; font-size:14px; font-weight:600; cursor:pointer;
         padding:10px 16px; border-bottom:2px solid transparent; margin-bottom:-1px; }
  .tab:hover { color:#e9e9e9; }
  .tab.active { color:#5cdd8b; border-bottom-color:#5cdd8b; }
  .creds { margin-top:8px; }
  .creds summary { cursor:pointer; color:#9ca3af; font-size:13px; font-weight:600; padding:8px 0; }
  .creds table { border-collapse:collapse; width:100%; margin-top:8px; font-size:13px; }
  .creds th { text-align:left; color:#6b7280; font-weight:600; padding:6px 12px 6px 0; border-bottom:1px solid #2a2f40; font-size:11px; text-transform:uppercase; }
  .creds td { padding:7px 12px 7px 0; border-bottom:1px solid #20242f; vertical-align:top; }
  .creds code { background:#12141d; padding:2px 7px; border-radius:6px; color:#e9e9e9; font-size:12.5px; word-break:break-all; }
  .creds .pwwrap { display:flex; align-items:center; gap:8px; }
  .creds .reveal { cursor:pointer; color:#6b7280; font-size:14px; user-select:none; flex:0 0 auto; }
  .creds .reveal:hover { color:#5cdd8b; }
  .creds .src { color:#6b7280; font-size:11.5px; }
  .warnbox { background:#3a2d10; color:#d8b257; border-radius:10px; padding:10px 14px; font-size:12.5px; margin-top:14px; }
  .upd-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .upd-card { background:#1e2230; border-radius:14px; padding:18px 20px; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
  .upd-card h3 { font-size:14px; font-weight:700; margin:0 0 12px; color:#e9e9e9; }
  .upd-table { width:100%; border-collapse:collapse; font-size:13.5px; }
  .upd-table th { text-align:left; color:#6b7280; font-weight:600; padding:8px 10px 8px 0; border-bottom:1px solid #2a2f40; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
  .upd-table td { padding:10px 10px 10px 0; border-bottom:1px solid #20242f; vertical-align:middle; }
  .upd-table tr:last-child td { border-bottom:none; }
  .upd-table .btn { background:#2a2f40; border:none; color:#e9e9e9; border-radius:8px; padding:6px 14px; font-size:12.5px; font-weight:600; cursor:pointer; white-space:nowrap; }
  .upd-table .btn:hover { background:#3a4054; }
  .upd-table .btn.update { background:#5cdd8b; color:#0b2818; }
  .upd-table .btn.update:hover { background:#6fee9c; }
  .upd-table .btn:disabled { opacity:.4; cursor:not-allowed; }
  .upd-table .btn.running { background:#f8a306; color:#0b2818; }
  .upd-table .btn.small { padding:3px 8px; font-size:11px; border-radius:5px; }
  .upd-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11.5px; font-weight:700; }
  .upd-badge.ok { background:#1f4e34; color:#5cdd8b; }
  .upd-badge.new { background:#5a4e1f; color:#f8a306; }
  .upd-badge.err { background:#5a1f25; color:#ff8088; }
  .upd-badge.na  { background:#2a2f40; color:#6b7280; }
  .upd-field { display:flex; flex-direction:column; gap:6px; margin-bottom:12px; }
  .upd-field label { font-size:12px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.5px; }
  .upd-field input, .upd-field select { background:#12141d; border:1px solid #2a2f40; color:#e9e9e9; border-radius:8px; padding:8px 12px; font-size:13px; outline:none; }
  .upd-field input:focus { border-color:#5cdd8b66; }
  .upd-field .hint { font-size:11px; color:#6b7280; }
  .upd-toggle { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
  .upd-toggle label { font-size:13px; font-weight:600; cursor:pointer; }
  .switch { position:relative; display:inline-block; width:42px; height:24px; flex-shrink:0; }
  .switch input { opacity:0; width:0; height:0; }
  .switch .slider { position:absolute; cursor:pointer; inset:0; background:#2a2f40; border-radius:24px; transition:.2s; }
  .switch .slider::before { content:''; position:absolute; width:18px; height:18px; left:3px; bottom:3px; background:#6b7280; border-radius:50%; transition:.2s; }
  .switch input:checked + .slider { background:#5cdd8b; }
  .switch input:checked + .slider::before { background:#0b2818; transform:translateX(18px); }
  .upd-chk-grid { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  .upd-chk-grid label { font-size:13px; display:flex; align-items:center; gap:6px; cursor:pointer; }
  .upd-chk-grid input { accent-color:#5cdd8b; }
  .upd-log { max-height:240px; overflow-y:auto; font-size:12px; }
  .upd-log-entry { padding:6px 0; border-bottom:1px solid #20242f; display:flex; gap:10px; align-items:flex-start; }
  .upd-log-entry:last-child { border-bottom:none; }
  .upd-log-entry .time { color:#6b7280; flex-shrink:0; font-family:monospace; font-size:11px; }
  .upd-log-entry .comp { font-weight:600; flex-shrink:0; min-width:60px; }
  .upd-log-entry .result { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .upd-test-btn { background:#2a2f40; border:none; color:#e9e9e9; border-radius:8px; padding:6px 14px; font-size:12px; cursor:pointer; }
  .upd-test-btn:hover { background:#3a4054; }
  .site-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:14px; }
  .site-card { background:#1e2230; border-radius:14px; padding:16px 18px; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  .site-card .top { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; }
  .site-card .domain { font-size:14px; font-weight:700; color:#e9e9e9; word-break:break-all; }
  .site-card .domain .hint { font-weight:400; font-size:11px; color:#6b7280; margin-left:6px; }
  .site-card .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:700; white-space:nowrap; }
  .site-card .badge.online { background:#1f4e34; color:#5cdd8b; }
  .site-card .badge.degraded { background:#5a4e1f; color:#f8a306; }
  .site-card .badge.down { background:#5a1f25; color:#ff8088; }
  .site-card .badge.type { background:#2a2f40; color:#9ca3af; }
  .site-card .meta { display:flex; flex-wrap:wrap; gap:6px 14px; font-size:12px; color:#9ca3af; margin-bottom:10px; }
  .site-card .meta span { display:flex; align-items:center; gap:4px; }
  .site-card .meta .val { color:#e9e9e9; font-weight:600; }
  .site-card .procs { margin-top:8px; border-top:1px solid #2a2f40; padding-top:8px; }
  .site-card .procs .prow { display:flex; justify-content:space-between; align-items:center; font-size:12px; padding:4px 0; }
  .site-card .procs .prow .pname { color:#e9e9e9; font-weight:600; }
  .site-card .procs .prow .pstat { font-size:11px; }
  .site-card .procs .prow .pstat.up { color:#5cdd8b; }
  .site-card .procs .prow .pstat.down { color:#dc3545; }
  .site-card .procs .prow .pstat .dim { color:#6b7280; }
  .btn { background:#2a2f40; border:none; color:#e9e9e9; border-radius:8px; padding:4px 10px; font-size:11px; font-weight:600; cursor:pointer; }
  .btn:hover { background:#3a4054; }
  /* Modules tab */
  .mod-summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:18px; }
  .mod-stat { background:#1e2230; border-radius:14px; padding:14px 18px; box-shadow:0 2px 8px rgba(0,0,0,.25); }
  .mod-stat .v { font-size:24px; font-weight:700; line-height:1.15; font-variant-numeric:tabular-nums; }
  .mod-stat .l { color:#9ca3af; font-size:11.5px; text-transform:uppercase; letter-spacing:.5px; margin-top:4px; font-weight:600; }
  .mod-stat.major .v { color:#ff8088; }
  .mod-stat.minor .v { color:#f8a306; }
  .mod-stat.patch .v { color:#5cdd8b; }
  .mod-stat.ok .v    { color:#5cdd8b; }
  .mod-stat.err .v   { color:#ff8088; }
  .mod-card { background:#1e2230; border-radius:14px; padding:14px 20px; box-shadow:0 2px 8px rgba(0,0,0,.25); margin-bottom:16px; }
  .mod-card h3 { font-size:14px; font-weight:700; margin:0 0 10px; color:#e9e9e9; }
  .mod-card .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; gap:10px; flex-wrap:wrap; }
  .mod-table { width:100%; border-collapse:collapse; font-size:13px; }
  .mod-table th { text-align:left; color:#6b7280; font-weight:600; padding:8px 10px 8px 0; border-bottom:1px solid #2a2f40; font-size:11px; text-transform:uppercase; letter-spacing:.5px; cursor:pointer; user-select:none; white-space:nowrap; }
  .mod-table th:hover { color:#e9e9e9; }
  .mod-table th.active { color:#5cdd8b; }
  .mod-table td { padding:9px 10px 9px 0; border-bottom:1px solid #20242f; vertical-align:middle; }
  .mod-table tr:hover td { background:#20242f; }
  .mod-table tr.toolrow:hover td { background:transparent; }
  .sev { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.3px; }
  .sev.major { background:#5a1f25; color:#ff8088; }
  .sev.minor { background:#5a4e1f; color:#f8a306; }
  .sev.patch { background:#1f4e34; color:#5cdd8b; }
  .sev.none  { background:#2a2f40; color:#6b7280; }
  .mod-pkg  { font-weight:600; color:#e9e9e9; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; }
  .mod-pkg.dev { color:#9ca3af; }
  .mod-ver { font-variant-numeric:tabular-nums; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
  .mod-ver .arrow { color:#6b7280; margin:0 4px; }
  .mod-ver .new   { color:#5cdd8b; }
  .mod-path { color:#6b7280; font-size:11.5px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; max-width:340px; display:inline-block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; vertical-align:middle; }
  .mod-cmd { background:#12141d; color:#cbd5e1; padding:3px 8px; border-radius:5px; font-size:11.5px; font-family:ui-monospace,Menlo,Consolas,monospace; cursor:pointer; border:1px solid #2a2f40; }
  .mod-cmd:hover { background:#1a1d28; color:#5cdd8b; border-color:#5cdd8b66; }
  .mod-empty { color:#6b7280; padding:14px 0; font-size:13px; text-align:center; }
  .mod-progress { color:#f8a306; font-size:12px; padding:8px 0; }
  /* Shared-only chip + per-user counts */
  .chip.toggle { background:#1e2230; border:1px solid #2a2f40; color:#9ca3af; }
  .chip.toggle.active { background:#3a4054; border-color:#5cdd8b; color:#5cdd8b; }
  .group h2 .pcounts { font-weight:400; font-size:12px; color:#9ca3af; margin-left:8px; }
  .group h2 .pcounts .up { color:#5cdd8b; }
  .group h2 .pcounts .down { color:#ff8088; }
  /* Toasts (replaces alert()) */
  #toast-host { position:fixed; bottom:18px; right:18px; display:flex; flex-direction:column; gap:8px; z-index:9999; max-width:min(420px, calc(100vw - 36px)); pointer-events:none; }
  .toast { background:#1e2230; border:1px solid #2a2f40; border-left:3px solid #6b7280; color:#e9e9e9; border-radius:10px; padding:10px 14px; font-size:13px; box-shadow:0 6px 20px rgba(0,0,0,.4); animation:toast-in .18s ease-out; pointer-events:auto; display:flex; align-items:flex-start; gap:10px; }
  .toast.fade { animation:toast-out .25s ease-in forwards; }
  .toast.success { border-left-color:#5cdd8b; }
  .toast.error   { border-left-color:#dc3545; }
  .toast.warn    { border-left-color:#f8a306; }
  .toast .ico { flex:0 0 auto; font-size:14px; line-height:1.4; }
  .toast .body { flex:1; min-width:0; }
  .toast .body pre { margin:6px 0 0; padding:6px 8px; background:#12141d; border-radius:6px; max-height:120px; overflow:auto; color:#cbd5e1; font-size:11.5px; white-space:pre-wrap; word-break:break-word; }
  .toast .x { flex:0 0 auto; cursor:pointer; color:#6b7280; font-size:14px; user-select:none; line-height:1.2; padding:0 2px; }
  .toast .x:hover { color:#e9e9e9; }
  @keyframes toast-in  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  @keyframes toast-out { to { opacity:0; transform:translateY(8px); } }
  /* Inline two-step confirm button state */
  .arm-confirm { background:#5a1f25 !important; color:#ff8088 !important; border-color:#7a2d35 !important; animation:arm-pulse 1.2s ease-in-out infinite; }
  @keyframes arm-pulse { 0%,100%{ box-shadow:0 0 0 0 rgba(220,53,69,.4); } 50%{ box-shadow:0 0 0 4px rgba(220,53,69,0); } }
  footer { color:#6b7280; font-size:12px; text-align:center; margin-top:8px; }
  @media (max-width:1180px){ .beats .beat:nth-child(-n+25){ display:none; } .hdr .beats-h{ width:247px; } }
  @media (max-width:860px){ .beats, .hdr .beats-h { display:none; } }
  @media (max-width:560px){ .col { flex:0 0 48px; } .info{ display:none; } .stat { flex:0 0 54px; } }
</style></head>
<body>
<div class="wrap">
  <h1>📊 PM2 Status <span id="host" class="sub" style="margin:0"></span></h1>
  <div class="sub" id="updated">loading…</div>
  <div class="tabs">
    <button class="tab active" data-tab="pm2">⚙️ PM2 Services</button>
    <button class="tab" data-tab="db">🐘 PostgreSQL</button>
    <button class="tab" data-tab="updates">🔄 Updates</button>
    <button class="tab" data-tab="sites">🌐 Sites</button>
    <button class="tab" data-tab="modules">📦 Modules</button>
  </div>
  <div id="banner" class="banner ok" style="display:none"></div>
  <div id="pm2view">
  <div class="toolbar">
    <input id="q" type="search" placeholder="Filter services or users…" autocomplete="off">
    <button class="chip" data-f="all">All</button>
    <button class="chip" data-f="up">Up</button>
    <button class="chip down-chip" data-f="down">Down</button>
    <button class="chip toggle" id="sharedToggle" title="Show only apps that run on multiple users">🔗 Shared</button>
    <select id="sort" title="Sort">
      <option value="group">Group by user</option>
      <option value="name">Name A→Z</option>
      <option value="cpu">CPU high→low</option>
      <option value="mem">Memory high→low</option>
      <option value="restarts">Restarts high→low</option>
      <option value="uptime">Uptime % worst first</option>
    </select>
  </div>
  <div id="main"></div>
  </div>
  <div id="dbview" style="display:none"></div>
  <div id="updatesview" style="display:none"></div>
  <div id="sitesview" style="display:none"></div>
  <div id="modulesview" style="display:none"></div>
  <footer>auto-refresh 10s · heartbeat = <span id="ivl">60</span>s samples · 🟩 up · 🟥 down · 🟧 restarted</footer>
</div>
<div id="toast-host"></div>
<script>
function esc(t){ return String(t).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtMem(b){ if(!b) return '0 MB'; const mb=b/1048576; return mb>=1024 ? (mb/1024).toFixed(1)+' GB' : mb.toFixed(0)+' MB'; }
function fmtUp(ms){ if(ms==null) return '–'; const s=Math.floor(ms/1000);
  if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h';
  return Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h'; }
function pctCls(p){ return p==null?'':(p>=99?'good':(p>=90?'mid':'poor')); }

// In-page toast (replaces alert/window.alert/Notification — never opens a browser dialog)
function toast(msg, type, opts){
  const host = document.getElementById('toast-host'); if (!host) return;
  type = type || 'info';
  const o = opts || {};
  const ms = o.duration != null ? o.duration : (type==='error' ? 8000 : 4000);
  const ico = type==='success'?'✅':type==='error'?'❌':type==='warn'?'⚠️':'ℹ️';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  let inner = '<span class="ico">'+ico+'</span><div class="body">'+esc(msg||'');
  if (o.detail) inner += '<pre>'+esc(o.detail)+'</pre>';
  inner += '</div><span class="x" title="dismiss">×</span>';
  el.innerHTML = inner;
  const close = () => { el.classList.add('fade'); setTimeout(() => el.remove(), 250); };
  el.querySelector('.x').addEventListener('click', close);
  host.appendChild(el);
  if (ms > 0) setTimeout(close, ms);
  return el;
}

// Two-step inline confirm (replaces window.confirm — never opens a browser dialog)
const _armed = new WeakMap();
function armConfirm(btn, armedLabel, onConfirm){
  if (!btn) return;
  if (_armed.has(btn)) {            // Second click → execute
    const t = _armed.get(btn);
    clearTimeout(t.timer);
    btn.textContent = t.original;
    btn.classList.remove('arm-confirm');
    _armed.delete(btn);
    try { onConfirm(); } catch(e) { toast('Error: '+e.message, 'error'); }
    return;
  }
  const original = btn.textContent;
  btn.textContent = armedLabel;
  btn.classList.add('arm-confirm');
  const timer = setTimeout(() => {
    btn.textContent = original;
    btn.classList.remove('arm-confirm');
    _armed.delete(btn);
  }, 5000);
  _armed.set(btn, { original, timer });
}

let lastData = null, lastDb = null;
const state = Object.assign({
  q:'', f:'all', sort:'group', tab:'pm2',
  sharedOnly:false,
  modSort:'severity', modFilter:'all', modQ:''
}, JSON.parse(localStorage.getItem('pm2ui') || '{}'));
function saveState(){ localStorage.setItem('pm2ui', JSON.stringify(state)); }

function matches(p, user){
  if (state.f === 'up' && p.status !== 'online') return false;
  if (state.f === 'down' && p.status === 'online') return false;
  if (state.q){
    const q = state.q.toLowerCase();
    if (!p.name.toLowerCase().includes(q) && !user.toLowerCase().includes(q)) return false;
  }
  return true;
}

const HDR = '<div class="hdr"><div class="stat">Status</div><div class="meta">Service</div>'
  + '<div class="beats-h"></div><div class="col">CPU</div><div class="col">Mem</div><div class="col">↺</div><div class="pct" style="color:#6b7280">24h</div></div>';

function rowHtml(p, userLabel){
  const up = p.status === 'online';
  let beats = '';
  const pad = Math.max(0, 50 - p.beats.length);
  for (let i=0;i<pad;i++) beats += '<div class="beat"></div>';
  for (const b of p.beats) {
    const cls = b[1]===1?'up':(b[1]===2?'restart':'down');
    const lbl = b[1]===1?'up':(b[1]===2?'restarted':'down');
    beats += '<div class="beat '+cls+'" data-tip="'+new Date(b[0]*1000).toLocaleTimeString()+' — '+lbl+'"></div>';
  }
  const pct = p.uptime24h==null ? '–' : (p.uptime24h>=99.95?'100%':p.uptime24h.toFixed(1)+'%');
  const cpuCls = p.cpu>=80?'hot':(p.cpu>=40?'warm':'');
  const memCls = p.memory>=1073741824?'warm':'';
  const rstCls = p.restarts>=1000?'hot':(p.restarts>=50?'warm':'');
  const actions = up
    ? '<button class="btn small" onclick="pm2Action(\\'stop\\', \\''+userLabel+'\\', \\''+esc(p.name)+'\\')">⏹</button>'
    : '<button class="btn small" onclick="pm2Action(\\'start\\', \\''+userLabel+'\\', \\''+esc(p.name)+'\\')">▶</button>';
  return '<div class="row">'
    + '<div class="stat"><span class="pill '+(up?'up':'down')+'">'+(up?'Up':'Down')+'</span></div>'
    + '<div class="meta"><div class="name">'+esc(p.name)+'</div>'
    + '<div class="info">up '+fmtUp(p.uptime_ms)+(userLabel?' · '+esc(userLabel):'')+'</div></div>'
    + '<div class="beats">'+beats+'</div>'
    + '<div class="col '+cpuCls+'">'+p.cpu+'%</div>'
    + '<div class="col '+memCls+'">'+fmtMem(p.memory)+'</div>'
    + '<div class="col '+rstCls+'">'+p.restarts+'</div>'
    + '<div class="pct '+pctCls(p.uptime24h)+'">'+pct+'</div>'
    + '<div class="col">'+actions+' <button class="btn small" onclick="pm2Action(\\'restart\\', \\''+userLabel+'\\', \\''+esc(p.name)+'\\')">⟳</button></div>'
    + '</div>';
}

function render(){
  if (!lastData) return;
  const d = lastData;
  document.getElementById('host').textContent = d.hostname;
  document.getElementById('ivl').textContent = d.sample_interval_s;
  document.title = (d.summary.down ? '🔴 ' : '🟢 ') + d.summary.online + '/' + d.summary.total + ' · PM2 Status · ' + d.hostname;
  document.getElementById('updated').textContent = 'Last updated: ' + new Date(d.generated_at).toLocaleString();
  if (state.tab !== 'pm2') return;
  const banner = document.getElementById('banner');
  banner.style.display='flex';
  if (d.summary.down === 0) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> All Systems Operational <span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'+d.summary.total+' services · '+fmtMem(d.summary.memory)+'</span>';
  } else {
    banner.className='banner bad';
    banner.innerHTML = '<span class="ico">🔴</span> ' + d.summary.down + ' service' + (d.summary.down>1?'s':'') + ' down <span style="margin-left:auto;font-size:13px;font-weight:400">'+d.summary.online+'/'+d.summary.total+' up</span>';
  }
  // chip labels with live counts
  document.querySelectorAll('.chip[data-f]').forEach(c => {
    const f = c.dataset.f;
    const n = f==='all' ? d.summary.total : (f==='up' ? d.summary.online : d.summary.down);
    c.textContent = (f==='all'?'All':(f==='up'?'Up':'Down')) + ' ' + n;
    c.classList.toggle('active', state.f === f);
  });
  document.getElementById('sort').value = state.sort;
  const stog = document.getElementById('sharedToggle');
  if (stog) stog.classList.toggle('active', !!state.sharedOnly);

  // Build set of app-names that run on multiple users (for "shared" toggle)
  const appUsers = {};
  for (const g of d.groups) for (const p of g.processes) {
    (appUsers[p.name] = appUsers[p.name] || new Set()).add(g.user);
  }
  const isShared = (name) => (appUsers[name] && appUsers[name].size >= 2);

  let html = '';
  if (state.sort === 'group') {
    for (const g of d.groups) {
      const procs = g.processes.filter(p => matches(p, g.user))
        .filter(p => !state.sharedOnly || isShared(p.name))
        .sort((a,b) => (a.status==='online') - (b.status==='online'));   // down first
      if (!procs.length && !g.error) continue;
      const up = g.processes.filter(p => p.status==='online').length;
      const down = g.processes.length - up;
      const counts = '<span class="pcounts">'
        + '<span class="up">'+up+' up</span>'
        + (down ? ' · <span class="down">'+down+' down</span>' : '')
        + ' · '+g.processes.length+' service'+(g.processes.length===1?'':'s')
        + '</span>';
      html += '<div class="group"><h2>'+esc(g.user)+counts+'<span class="dim">'+esc(g.pm2_home)+'</span></h2>';
      if (g.error) html += '<div class="err">⚠ daemon unreachable: '+esc(g.error)+'</div>';
      if (procs.length) html += HDR;
      for (const p of procs) html += rowHtml(p, null);
      html += '</div>';
    }
  } else {
    const all = [];
    for (const g of d.groups) for (const p of g.processes) {
      if (!matches(p, g.user)) continue;
      if (state.sharedOnly && !isShared(p.name)) continue;
      all.push({ p, u: g.user });
    }
    const cmp = {
      name:     (a,b) => a.p.name.localeCompare(b.p.name),
      cpu:      (a,b) => b.p.cpu - a.p.cpu,
      mem:      (a,b) => b.p.memory - a.p.memory,
      restarts: (a,b) => b.p.restarts - a.p.restarts,
      uptime:   (a,b) => (a.p.uptime24h ?? 101) - (b.p.uptime24h ?? 101),
    }[state.sort] || ((a,b)=>0);
    all.sort(cmp);
    if (all.length) {
      html += '<div class="group"><h2>All services<span class="dim">'+all.length+' shown</span></h2>' + HDR;
      for (const it of all) html += rowHtml(it.p, it.u);
      html += '</div>';
    }
  }
  if (!html) html = '<div class="group"><div class="err">No services match the current filter.</div></div>';
  document.getElementById('main').innerHTML = html;
}

function dbRow(db){
  const cache = db.cache_hit==null ? '–' : db.cache_hit.toFixed(1)+'%';
  const cacheCls = db.cache_hit==null ? '' : (db.cache_hit>=99?'good':(db.cache_hit>=90?'mid':'poor'));
  let beats = '';
  const pad = Math.max(0, 50 - db.beats.length);
  for (let i=0;i<pad;i++) beats += '<div class="beat"></div>';
  for (const b of db.beats) beats += '<div class="beat up" data-tip="'+new Date(b[0]*1000).toLocaleTimeString()+' — reachable"></div>';
  const pct = db.uptime24h==null ? '–' : (db.uptime24h>=99.95?'100%':db.uptime24h.toFixed(1)+'%');
  return '<div class="row">'
    + '<div class="stat"><span class="pill up">Up</span></div>'
    + '<div class="meta"><div class="name">'+esc(db.name)+'</div>'
    + '<div class="info">owner '+esc(db.owner)+' · ↻ '+Number(db.commits).toLocaleString()+' commits · ⚠ '+db.rollbacks+' rb</div></div>'
    + '<div class="beats">'+beats+'</div>'
    + '<div class="col">'+fmtMem(Number(db.size))+'</div>'
    + '<div class="col">'+db.conns+'</div>'
    + '<div class="col '+cacheCls+'" style="'+(cacheCls?'':'')+'">'+cache+'</div>'
    + '<div class="pct '+pctCls(db.uptime24h)+'">'+pct+'</div>'
    + '</div>';
}

function renderDb(){
  if (!lastDb) return;
  const d = lastDb;
  const banner = document.getElementById('banner');
  banner.style.display='flex';
  if (d.error) {
    banner.className='banner bad';
    banner.innerHTML = '<span class="ico">🔴</span> PostgreSQL unreachable <span style="margin-left:auto;font-size:13px;font-weight:400">'+esc(d.error)+'</span>';
  } else {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> PostgreSQL '+esc(d.version||'')+' Online '
      + '<span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'
      + d.summary.databases+' databases · '+fmtMem(d.summary.total_size)+' · '
      + d.total_conns+'/'+d.max_connections+' conns</span>';
  }
  let html = '<div class="group"><h2>🐘 PostgreSQL <span class="dim">/var/run/postgresql/.s.PGSQL.5432</span></h2>';
  if (d.error) {
    html += '<div class="err">⚠ '+esc(d.error)+'</div>';
  } else {
    html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">Unix socket · cluster 17/main</div></div><div class="col" style="flex:0 0 auto">' + esc(d.version || '') + '</div></div>';
    html += '<div class="hdr"><div class="stat">Status</div><div class="meta">Database</div>'
      + '<div class="beats-h"></div><div class="col">Size</div><div class="col">Conns</div><div class="col">Cache</div><div class="pct" style="color:#6b7280">24h</div></div>';
    for (const db of d.databases) html += dbRow(db);
  }
  html += '</div>';
  // credentials
  if (d.credentials && d.credentials.length) {
    html += '<details class="creds"><summary>🔑 Connection credentials ('+d.credentials.length+' roles) — click to reveal</summary>'
      + '<div class="warnbox">⚠ Plaintext app passwords, recovered from each app\\'s live config. PostgreSQL itself stores only irreversible SCRAM-SHA-256 hashes. This page is behind basic-auth + Cloudflare Access.</div>'
      + '<table><tr><th>Role</th><th>Database</th><th>Password</th><th>Source</th></tr>';
    for (const c of d.credentials) {
      const pid = 'pw'+Math.abs(hashStr(c.role));
      html += '<tr><td><code>'+esc(c.role)+'</code></td><td>'+esc(c.database)+'</td>'
        + '<td><div class="pwwrap"><span class="reveal" data-pw="'+pid+'">👁</span>'
        + '<code id="'+pid+'" data-real="'+esc(c.password)+'">'+'•'.repeat(Math.min(16,c.password.length))+'</code></div></td>'
        + '<td class="src">'+esc(c.source)+'</td></tr>';
    }
    html += '</table></details>';
  }

  // SQLite section
  if (d.sqlite) {
    html += '<div class="group" style="margin-top:18px"><h2>🗄️ SQLite <span class="dim">CloudPanel config</span></h2>';
    if (d.sqlite.error) {
      html += '<div class="err">⚠ ' + esc(d.sqlite.error) + '</div>';
    } else {
      html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">file</div></div><div class="col" style="flex:0 0 auto;word-break:break-all;font-size:11px;max-width:400px">' + esc(d.sqlite.path || '') + '</div></div>';
      html += '<div class="hdr"><div class="meta">Name</div><div class="col" style="flex:0 0 auto">Size</div></div>';
      html += '<div class="row"><div class="meta"><div class="name">CloudPanel DB</div><div class="info">' + d.sqlite.tables + ' tables · ' + d.sqlite.pageCount.toLocaleString() + ' pages</div></div><div class="col" style="flex:0 0 auto">' + fmtMem(d.sqlite.size) + '</div></div>';
    }
    html += '</div>';
  }

  // MariaDB section
  if (d.mariadb) {
    html += '<div class="group" style="margin-top:18px"><h2>🐬 MariaDB</h2>';
    if (d.mariadb.error) {
      html += '<div class="err">⚠ ' + esc(d.mariadb.error) + '</div>';
    } else {
      const upStr = d.mariadb.uptime ? fmtUp(d.mariadb.uptime * 1000) : '?';
      html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">TCP · up ' + upStr + '</div></div><div class="col" style="flex:0 0 auto">localhost:3306 · ' + esc(d.mariadb.version) + '</div></div>';
      if (d.mariadb.dbSizes && d.mariadb.dbSizes.length) {
        html += '<div class="hdr"><div class="meta">Database</div><div class="col" style="flex:0 0 auto">Size</div></div>';
        for (const db of d.mariadb.dbSizes) {
          html += '<div class="row"><div class="meta"><div class="name">' + esc(db.name) + '</div></div><div class="col" style="flex:0 0 auto">' + fmtMem((db.sizeMb || 0) * 1048576) + '</div></div>';
        }
      } else {
        html += '<div class="row"><div class="meta"><div class="name">(no user databases)</div><div class="info">only system schemas exist</div></div><div class="col" style="flex:0 0 auto">—</div></div>';
      }
    }
    html += '</div>';
  }

  document.getElementById('dbview').innerHTML = html;
  document.querySelectorAll('.reveal').forEach(el => el.addEventListener('click', () => {
    const code = document.getElementById(el.dataset.pw);
    const real = code.dataset.real;
    if (code.textContent.startsWith('•')) { code.textContent = real; el.textContent='🙈'; }
    else { code.textContent = '•'.repeat(Math.min(16,real.length)); el.textContent='👁'; }
  }));
}
function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return h; }

/* ---------------------------------------------------------------- updates */

let lastUpdates = null;

function renderUpdates(){
  if (!lastUpdates) return;
  const d = lastUpdates;
  document.getElementById('host').textContent = 'updates';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.lastChecked ? new Date(d.lastChecked).toLocaleString() : 'never') + ' · hourly auto-check';
  const banner = document.getElementById('banner');
  banner.style.display='flex';
  const avail = (d.components||[]).filter(c => c.updateAvailable).length;
  if (avail === 0) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> All components up to date <span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">' + d.components.length + ' components tracked</span>';
  } else {
    banner.className='banner bad';
    banner.innerHTML = '<span class="ico">🔄</span> ' + avail + ' update' + (avail>1?'s':'') + ' available <span style="margin-left:auto;font-size:13px;font-weight:400">' + d.components.filter(c => !c.updateAvailable).length + '/' + d.components.length + ' up to date</span>';
  }

  let html = '<div class="upd-grid">';

  // Left column: components table
  html += '<div class="upd-card" style="grid-column:1/-1">';
  const updCount = d.components.filter(c => c.updateAvailable && c.key !== 'node').length;
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Components</h3>';
  if (updCount) {
    html += '<button class="btn update" onclick="triggerUpdateAll()" style="font-size:12px;padding:4px 14px">⬆ Update All (' + updCount + ')</button>';
  }
  html += '</div>';
  html += '<table class="upd-table"><tr><th>Component</th><th>Current</th><th>Latest</th><th>Status</th><th></th></tr>';
  for (const c of d.components) {
    const hasUpdate = c.updateAvailable;
    const isRunning = c.updating;
    const statusBadge = !c.currentVersion ? '<span class="upd-badge na">not installed</span>'
      : isRunning ? '<span class="upd-badge" style="background:#5a4e1f;color:#f8a306">updating…</span>'
      : hasUpdate ? '<span class="upd-badge new">update available</span>'
      : '<span class="upd-badge ok">up to date</span>';
    const btnHtml = !c.currentVersion ? ''
      : isRunning ? '<button class="btn running" disabled>⏳ updating</button>'
      : c.key === 'node' ? '<button class="btn" disabled>via nvm/fnm/n</button>'
      : hasUpdate ? '<button class="btn update" onclick="triggerUpdate(\\'' + c.key + '\\')">⬆ Update</button>'
      : '<button class="btn" disabled>✓ latest</button>';
    html += '<tr>'
      + '<td><strong>' + esc(c.label) + '</strong></td>'
      + '<td>' + esc(c.currentVersion || '—') + '</td>'
      + '<td>' + esc(c.latestVersion || '—') + '</td>'
      + '<td>' + statusBadge + '</td>'
      + '<td style="text-align:right">' + btnHtml + '</td>'
      + '</tr>';
  }
  html += '</table></div>';

  // Per-user versions table
  const userKeys = Object.keys(d.users || {});
  if (userKeys.length) {
    const allCompKeys = d.components.map(c => c.key);
    html += '<div class="upd-card" style="grid-column:1/-1">';
    html += '<h3>By User <span style="font-weight:400;font-size:12px;color:#6b7280">' + userKeys.length + ' users</span></h3>';
    html += '<div style="overflow-x:auto"><table class="upd-table">';
    html += '<tr><th>User</th>';
    for (const c of d.components) {
      if (c.key === 'node') { html += '<th>' + esc(c.label) + '</th>'; continue; }
      html += '<th>' + esc(c.label) + '</th>';
    }
    html += '<th style="width:100px">Update</th></tr>';
    const sortedUsers = [...userKeys].sort();
    for (const u of sortedUsers) {
      const uv = d.users[u] || {};
      let hasOutdated = false;
      let innerCols = '';
      html += '<tr><td><strong>' + esc(u) + '</strong></td>';
      for (const c of d.components) {
        if (c.key === 'node') {
          const userV = uv[c.key] || null;
          html += '<td>' + esc(userV || '—') + '</td>';
          continue;
        }
        const userV = uv[c.key] || null;
        const latestC = d.components.find(x => x.key === c.key);
        const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
        if (isUpd) hasOutdated = true;
        if (userV) {
          html += '<td>' + esc(userV) + (isUpd ? ' <span class="upd-badge new">⬆ ' + esc(latestC.latestVersion) + '</span>' : ' <span class="upd-badge ok">✓</span>') + '</td>';
        } else {
          html += '<td><span class="upd-badge na">—</span></td>';
        }
      }
      html += '<td>';
      if (hasOutdated) {
        for (const c of d.components) {
          if (c.key === 'node') continue;
          const userV = uv[c.key] || null;
          const latestC = d.components.find(x => x.key === c.key);
          const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
          if (isUpd) {
            html += '<button class="btn update small" style="margin:1px;font-size:11px" onclick="triggerUserUpdate(\\'' + esc(u) + '\\',\\'' + c.key + '\\')">⬆ ' + c.key + '</button> ';
          }
        }
      } else {
        html += '<span class="upd-badge ok" style="font-size:11px">✓ up to date</span>';
      }
      html += '</td>';
      html += '</tr>';
    }
    html += '</table></div></div>';
  }

  // Schedule card
  html += '<div class="upd-card">';
  html += '<h3>Schedule</h3>';
  const sched = d.schedule || {};
  html += '<div class="upd-toggle">'
    + '<label class="switch"><input type="checkbox" id="schedEnable" ' + (sched.enabled?'checked':'') + ' onchange="saveUpdatesConfig()"><span class="slider"></span></label>'
    + '<label>Auto-update</label></div>';
  html += '<div class="upd-field"><label>Time (24h)</label>'
    + '<div style="display:flex;gap:8px">'
    + '<input type="number" id="schedHour" min="0" max="23" value="' + (sched.hour||3) + '" style="width:70px" onchange="saveUpdatesConfig()">:<input type="number" id="schedMin" min="0" max="59" value="' + (sched.min||0) + '" style="width:70px" onchange="saveUpdatesConfig()">'
    + '</div><span class="hint">Server time — updates run within 2 min of this time</span></div>';
  html += '<div class="upd-field"><label>Components to auto-update</label><div class="upd-chk-grid">';
  for (const c of d.components) {
    const checked = !sched.components || sched.components.includes(c.key);
    html += '<label><input type="checkbox" class="sched-comp" data-key="' + c.key + '" ' + (checked?'checked':'') + ' onchange="saveUpdatesConfig()"> ' + c.label + (c.key === 'node' ? ' <span class="hint">(manual via nvm/fnm)</span>' : '') + '</label>';
  }
  html += '</div></div></div>';

  // Telegram card
  html += '<div class="upd-card">';
  html += '<h3>Telegram Notifications</h3>';
  const tel = d.telegram || {};
  html += '<div class="upd-toggle">'
    + '<label class="switch"><input type="checkbox" id="telEnable" ' + (tel.enabled?'checked':'') + ' onchange="saveUpdatesConfig()"><span class="slider"></span></label>'
    + '<label>Enabled</label></div>';
  html += '<div class="upd-field"><label>Bot Token</label><input type="password" id="telToken" value="' + esc(tel.botToken||'') + '" placeholder="123456:ABC-DEF1234ghIkl" onchange="saveUpdatesConfig()"></div>';
  html += '<div class="upd-field"><label>Chat ID</label><input type="text" id="telChatId" value="' + esc(tel.chatId||'') + '" placeholder="-123456789" onchange="saveUpdatesConfig()"></div>';
  html += '<div class="upd-chk-grid">'
    + '<label><input type="checkbox" id="telNotifyUpd" ' + (tel.notifyOnUpdate!==false?'checked':'') + ' onchange="saveUpdatesConfig()"> Notify when updates available</label>'
    + '<label><input type="checkbox" id="telNotifyDone" ' + (tel.notifyOnComplete!==false?'checked':'') + ' onchange="saveUpdatesConfig()"> Notify on update completion</label>'
    + '</div>';
  html += '<button class="upd-test-btn" onclick="testTelegram()">📨 Test Telegram</button>';
  html += '</div>';

  // Update log
  html += '<div class="upd-card" style="grid-column:1/-1">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Update Log <span style="font-weight:400;font-size:12px;color:#6b7280">last ' + d.log.length + ' entries</span></h3>';
  html += '<button class="btn" onclick="clearUpdateLog()" style="font-size:11px;padding:3px 10px;background:#3a2020;color:#ff8088;border:none;border-radius:5px;cursor:pointer">🗑 Clear log</button>';
  html += '</div>';
  html += '<div class="upd-log">';
  if (!d.log.length) {
    html += '<div style="color:#6b7280;padding:10px 0;font-size:13px">No updates have been run yet.</div>';
  } else {
    for (const entry of d.log.slice().reverse()) {
      const icon = entry.success ? '✅' : '❌';
      const cls = entry.success ? '' : ' style="color:#ff8088"';
      html += '<div class="upd-log-entry">'
        + '<span class="time">' + new Date(entry.timestamp).toLocaleString() + '</span>'
        + '<span class="comp"' + cls + '>' + icon + ' ' + esc(entry.label) + '</span>'
        + '<span class="result">' + esc((entry.output||'').split('\\n')[0].slice(0, 80)) + '</span>'
        + '</div>';
    }
  }
  html += '</div></div>';

  html += '</div>';
  document.getElementById('updatesview').innerHTML = html;
}

/* ---------------------------------------------------------------- sites */

let lastSites = null;

function renderSites(){
  if (!lastSites) return;
  const d = lastSites;
  document.getElementById('host').textContent = 'sites';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.generated_at ? new Date(d.generated_at).toLocaleString() : 'never') + ' · auto-refresh 5 min';

  const banner = document.getElementById('banner');
  banner.style.display='flex';
  const down = d.sites.filter(s => s.status === 'down').length;
  const degraded = d.sites.filter(s => s.status === 'degraded').length;
  const total = d.sites.length;
  if (down === 0 && degraded === 0) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> All sites operational <span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'+total+' sites</span>';
  } else {
    banner.className='banner bad';
    const parts = [];
    if (down) parts.push(down + ' down');
    if (degraded) parts.push(degraded + ' degraded');
    banner.innerHTML = '<span class="ico">🔴</span> ' + parts.join(', ') + ' <span style="margin-left:auto;font-size:13px;font-weight:400">'+(total-down-degraded)+'/'+total+' ok</span>';
  }

  let html = '<div class="site-grid">';
  const sortOrder = { 'down': 0, 'degraded': 1, 'online': 2 };
  const sorted = [...d.sites].sort((a, b) => (sortOrder[a.status]||9) - (sortOrder[b.status]||9) || a.domain.localeCompare(b.domain));

  for (const s of sorted) {
    const typeLabel = s.type === 'nodejs' ? 'Node.js' : s.type === 'php' ? 'PHP' : s.type === 'static' ? 'Static' : s.type;
    const appVer = s.nodeVersion ? 'Node ' + s.nodeVersion : s.phpVersion ? 'PHP ' + s.phpVersion : '';
    const portInfo = s.nodePort ? ':' + s.nodePort : s.poolPort ? ':' + s.poolPort : '';
    const healthIcon = s.httpUp ? '✅' : (s.httpUp === false ? '❌' : '—');

    html += '<div class="site-card">';
    html += '<div class="top">';
    html += '<div class="domain">' + esc(s.domain) + '<span class="hint">' + esc(typeLabel) + '</span></div>';
    html += '<span class="badge ' + s.status + '">' + s.statusLabel + '</span>';
    html += '</div>';
    html += '<div class="meta">';
    html += '<span>Port: <span class="val">' + (portInfo || 'n/a') + '</span></span>';
    html += '<span>HTTP: <span class="val">' + healthIcon + '</span></span>';
    html += '<span>' + esc(appVer) + '</span>';
    html += '<span>Disk: <span class="val">' + esc(s.disk || '?') + '</span></span>';
    html += '</div>';

    if (s.pm2 && s.pm2.length) {
      html += '<div class="procs">';
      for (const p of s.pm2) {
        const pUp = p.status === 'online';
        const cpuMem = 'CPU ' + p.cpu + '% · ' + fmtMem(p.memory);
        html += '<div class="prow"><span class="pname">' + esc(p.name) + '</span>'
          + '<span class="pstat ' + (pUp?'up':'down') + '">' + (pUp?'🟢':'🔴') + ' ' + esc(p.status) + ' <span class="dim">' + cpuMem + '</span></span>'
          + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
  }
  html += '</div>';
  document.getElementById('sitesview').innerHTML = html;
}

/* ----------------------------------------------------------------- modules */

let lastModules = null;

function modSeverityRank(s){ return s==='major'?3:s==='minor'?2:s==='patch'?1:0; }

function renderModules(){
  const view = document.getElementById('modulesview');
  if (!lastModules) { view.innerHTML = '<div class="mod-empty">Loading…</div>'; return; }
  const d = lastModules;
  const active = d.activeUpdates || {};
  const isUpdating = (dir) => !!active[dir];

  document.getElementById('host').textContent = 'modules';
  const ts = d.generated_at ? new Date(d.generated_at).toLocaleString() : 'never';
  let stamp = 'Last scan: ' + ts + ' · refresh every 6h';
  if (d.scanInProgress) {
    const sp = d.scanProgress || {};
    stamp = 'Scanning… ' + (sp.done||0) + '/' + (sp.total||'?') + (sp.current ? ' · ' + sp.current : '');
  }
  const activeCount = Object.keys(active).length;
  if (activeCount) stamp += ' · ' + activeCount + ' update' + (activeCount>1?'s':'') + ' running…';
  document.getElementById('updated').textContent = stamp;

  const banner = document.getElementById('banner');
  banner.style.display='flex';
  const s = d.summary || {};
  const totalOutdated = s.outdatedTotal || 0;
  if (!d.generated_at) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">⏳</span> First module scan running in the background — versions hit the npm registry, this can take a few minutes.';
  } else if (totalOutdated === 0) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> All modules up to date <span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'+(s.projects||0)+' projects scanned</span>';
  } else {
    banner.className='banner bad';
    const parts = [];
    if (s.major) parts.push(s.major + ' major');
    if (s.minor) parts.push(s.minor + ' minor');
    if (s.patch) parts.push(s.patch + ' patch');
    banner.innerHTML = '<span class="ico">📦</span> ' + totalOutdated + ' outdated dependencies <span style="margin-left:auto;font-size:13px;font-weight:400">'+parts.join(' · ')+'</span>';
  }

  // Summary stats grid (Observe)
  let html = '<div class="mod-summary">';
  html += '<div class="mod-stat"><div class="v">'+(s.projects||0)+'</div><div class="l">Projects</div></div>';
  html += '<div class="mod-stat ok"><div class="v">'+((s.projects||0)-(s.projectsOutdated||0))+'</div><div class="l">Up to date</div></div>';
  html += '<div class="mod-stat major"><div class="v">'+(s.major||0)+'</div><div class="l">Major bumps</div></div>';
  html += '<div class="mod-stat minor"><div class="v">'+(s.minor||0)+'</div><div class="l">Minor</div></div>';
  html += '<div class="mod-stat patch"><div class="v">'+(s.patch||0)+'</div><div class="l">Patch</div></div>';
  if (s.errors) html += '<div class="mod-stat err"><div class="v">'+s.errors+'</div><div class="l">Scan errors</div></div>';
  html += '</div>';

  // Toolbar (Orient): filter chips + search + refresh
  html += '<div class="mod-card"><div class="head">';
  html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1">';
  html += '<input id="modQ" type="search" placeholder="Filter package, project, user…" value="'+esc(state.modQ||'')+'" style="background:#12141d;border:1px solid #2a2f40;color:#e9e9e9;border-radius:10px;padding:8px 12px;font-size:13px;outline:none;flex:1 1 220px;min-width:160px">';
  for (const f of [['all','All'],['major','Major'],['minor','Minor'],['patch','Patch']]) {
    const cls = (state.modFilter===f[0])?'chip active'+(f[0]==='major'?' down-chip':''):'chip';
    html += '<button class="'+cls+'" data-modf="'+f[0]+'">'+f[1]+'</button>';
  }
  html += '</div>';
  html += '<button class="btn" id="modRefresh" '+(d.scanInProgress?'disabled':'')+' style="padding:7px 14px;font-size:12px">'+(d.scanInProgress?'⏳ Scanning…':'🔄 Rescan')+'</button>';
  html += '</div>';

  // Outdated table (Decide)
  const rows = (d.outdated||[]).slice();
  const q = (state.modQ||'').toLowerCase();
  let filtered = rows.filter(r => {
    if (state.modFilter !== 'all' && r.severity !== state.modFilter) return false;
    if (q) {
      const hay = (r.package+' '+r.user+' '+r.relDir+' '+(r.pkgName||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmps = {
    severity: (a,b) => modSeverityRank(b.severity)-modSeverityRank(a.severity)
                     || a.user.localeCompare(b.user)
                     || a.package.localeCompare(b.package),
    user:     (a,b) => a.user.localeCompare(b.user) || a.package.localeCompare(b.package),
    package:  (a,b) => a.package.localeCompare(b.package),
    project:  (a,b) => a.relDir.localeCompare(b.relDir) || a.package.localeCompare(b.package),
  };
  filtered.sort(cmps[state.modSort] || cmps.severity);

  if (!filtered.length) {
    html += '<div class="mod-empty">'+(rows.length?'No matches.':'No outdated dependencies in scanned projects.')+'</div>';
  } else {
    html += '<div style="overflow-x:auto"><table class="mod-table">';
    const hdr = (k,l) => '<th data-modsort="'+k+'" class="'+(state.modSort===k?'active':'')+'">'+l+(state.modSort===k?' ▾':'')+'</th>';
    html += '<tr>'+hdr('severity','Sev')+hdr('package','Package')+'<th>Installed</th><th>Wanted</th><th>Latest</th>'+hdr('user','User')+hdr('project','Project')+'<th>PM</th><th style="width:130px;text-align:right"></th></tr>';
    for (const r of filtered) {
      const sev = r.severity || 'none';
      const isDev = (r.type||'').includes('dev');
      const pm = r.pm || 'npm';
      const cmd = pm === 'npm'
        ? "sudo -u " + r.user + " sh -c 'cd " + r.dir + " && npm install " + r.package + "@latest'"
        : "sudo -u " + r.user + " sh -c 'cd " + r.dir + " && " + pm + " add " + r.package + "@latest'";
      const updating = isUpdating(r.dir);
      const upBtn = updating
        ? '<button class="mod-cmd" disabled style="opacity:.6">⏳ updating…</button>'
        : '<button class="mod-cmd" data-update-pkg="'+esc(r.package)+'" data-update-dir="'+esc(r.dir)+'" data-update-user="'+esc(r.user)+'" title="Run: '+esc(pm)+' install '+esc(r.package)+'@latest" style="background:#1f4e34;color:#5cdd8b;border-color:#2e6e4a">⬆ Update</button>';
      const cpyBtn = '<button class="mod-cmd" data-cmd="'+esc(cmd)+'" title="Copy command">📋</button>';
      html += '<tr>'
        + '<td><span class="sev '+sev+'">'+(r.severity||'—')+'</span></td>'
        + '<td><span class="mod-pkg'+(isDev?' dev':'')+'">'+esc(r.package)+'</span>'+(isDev?' <span style="color:#6b7280;font-size:10.5px;text-transform:uppercase">dev</span>':'')+'</td>'
        + '<td class="mod-ver">'+esc(r.current||'—')+'</td>'
        + '<td class="mod-ver">'+esc(r.wanted||'—')+'</td>'
        + '<td class="mod-ver new">'+esc(r.latest||'—')+'</td>'
        + '<td>'+esc(r.user)+'</td>'
        + '<td><span class="mod-path" title="'+esc(r.dir)+'">'+esc(r.relDir)+'</span></td>'
        + '<td style="color:#6b7280;font-size:11px;text-transform:uppercase">'+esc(pm)+'</td>'
        + '<td style="text-align:right;white-space:nowrap">'+upBtn+' '+cpyBtn+'</td>'
        + '</tr>';
    }
    html += '</table></div>';
  }
  html += '</div>';

  // Per-project breakdown (Act): list every scanned project so you know what was looked at
  const projects = (d.projects||[]).slice().sort((a,b) => {
    const ao = a.outdated ? Object.keys(a.outdated).length : 0;
    const bo = b.outdated ? Object.keys(b.outdated).length : 0;
    return bo - ao || a.user.localeCompare(b.user) || a.relDir.localeCompare(b.relDir);
  });
  if (projects.length) {
    html += '<div class="mod-card"><h3>Scanned Projects <span style="font-weight:400;font-size:12px;color:#6b7280">'+projects.length+' total</span></h3>';
    html += '<div style="overflow-x:auto"><table class="mod-table">';
    html += '<tr><th>User</th><th>Project</th><th>Path</th><th>PM</th><th>Deps</th><th>Outdated</th><th>Last scan</th><th style="text-align:right"></th></tr>';
    for (const p of projects) {
      const od = p.outdated ? Object.keys(p.outdated).length : 0;
      const odLabel = p.error
        ? '<span class="sev major" title="'+esc(p.error)+'">err</span>'
        : (od ? '<span class="sev minor">'+od+'</span>' : '<span class="sev patch">0</span>');
      const updating = isUpdating(p.dir);
      const allBtn = updating
        ? '<button class="mod-cmd" disabled style="opacity:.6">⏳ updating…</button>'
        : (od ? '<button class="mod-cmd" data-update-all="'+esc(p.dir)+'" data-update-user="'+esc(p.user)+'" data-update-count="'+od+'" title="Update all '+od+' outdated packages to @latest" style="background:#3a2d10;color:#f8a306;border-color:#5a4e1f">⬆ Update all ('+od+')</button>'
              : '');
      html += '<tr>'
        + '<td>'+esc(p.user)+'</td>'
        + '<td><span class="mod-pkg">'+esc(p.pkgName||'—')+'</span>'+(p.pkgVersion?' <span style="color:#6b7280;font-size:11px">'+esc(p.pkgVersion)+'</span>':'')+'</td>'
        + '<td><span class="mod-path" title="'+esc(p.dir)+'">'+esc(p.relDir)+'</span></td>'
        + '<td style="color:#6b7280;font-size:11px;text-transform:uppercase">'+esc(p.pm||'npm')+'</td>'
        + '<td>'+(p.depCount||0)+'</td>'
        + '<td>'+odLabel+'</td>'
        + '<td><span style="color:#6b7280;font-size:11.5px">'+(p.scannedAt? new Date(p.scannedAt).toLocaleString() : '—')+'</span></td>'
        + '<td style="text-align:right">'+allBtn+'</td>'
        + '</tr>';
    }
    html += '</table></div></div>';
  }

  // Recent updates log
  const log = (d.updateLog || []).slice().reverse();
  html += '<div class="mod-card"><div class="head"><h3 style="margin:0">Recent Updates <span style="font-weight:400;font-size:12px;color:#6b7280">'+log.length+' entries</span></h3>';
  if (log.length) html += '<button class="btn" id="modClearLog" style="font-size:11px;padding:4px 10px;background:#3a2020;color:#ff8088">🗑 Clear</button>';
  html += '</div>';
  if (!log.length) {
    html += '<div class="mod-empty">No updates have been run yet.</div>';
  } else {
    html += '<div class="upd-log">';
    for (const e of log) {
      const icon = e.success ? '✅' : '❌';
      const colorStyle = e.success ? '' : ' style="color:#ff8088"';
      const dur = e.duration_ms ? Math.round(e.duration_ms/1000)+'s' : '';
      const pkgs = (e.packages||[]).slice(0,4).join(', ') + ((e.packages||[]).length>4 ? ' +'+((e.packages||[]).length-4)+' more' : '');
      html += '<div class="upd-log-entry">'
        + '<span class="time">' + new Date(e.timestamp).toLocaleString() + '</span>'
        + '<span class="comp"' + colorStyle + '>' + icon + ' ' + esc(e.user) + ' · ' + esc(e.relDir) + '</span>'
        + '<span class="result" title="'+esc((e.output||e.error||'').slice(0,2000))+'">'+esc(pkgs)+(dur?' · '+dur:'')+(e.error?' · '+esc(e.error):'')+'</span>'
        + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  view.innerHTML = html;

  // Wire interactive elements
  const mq = document.getElementById('modQ');
  if (mq) mq.addEventListener('input', e => { state.modQ = e.target.value; saveState(); renderModules(); });
  view.querySelectorAll('[data-modf]').forEach(b => b.addEventListener('click', () => { state.modFilter = b.dataset.modf; saveState(); renderModules(); }));
  view.querySelectorAll('[data-modsort]').forEach(t => t.addEventListener('click', () => { state.modSort = t.dataset.modsort; saveState(); renderModules(); }));
  view.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => {
    const txt = b.dataset.cmd;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => {
      const old = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = old, 1200);
    });
  }));
  view.querySelectorAll('[data-update-pkg]').forEach(b => b.addEventListener('click', () => {
    triggerModuleUpdate(b.dataset.updateDir, b.dataset.updateUser, [b.dataset.updatePkg]);
  }));
  view.querySelectorAll('[data-update-all]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.updateCount;
    armConfirm(b, '⚠ Click again to confirm · ' + n + ' pkg' + (n==='1'?'':'s'),
      () => triggerModuleUpdate(b.dataset.updateAll, b.dataset.updateUser, []));
  }));
  const mr = document.getElementById('modRefresh');
  if (mr) mr.addEventListener('click', () => triggerModulesRescan());
  const cl = document.getElementById('modClearLog');
  if (cl) cl.addEventListener('click', () => armConfirm(cl, '⚠ Click again to clear', async () => {
    await fetch('api/modules/log', { method: 'DELETE' });
    if (lastModules) lastModules.updateLog = [];
    renderModules();
    toast('Update log cleared', 'info');
  }));
}

let modulesPollTimer = null;
function ensureModulesPoll(active) {
  if (active && !modulesPollTimer) {
    modulesPollTimer = setInterval(async () => {
      try {
        const m = await fetch('api/modules').then(r => r.json());
        lastModules = m;
        if (state.tab === 'modules') renderModules();
        const stillActive = m.scanInProgress || (m.activeUpdates && Object.keys(m.activeUpdates).length);
        if (!stillActive) { clearInterval(modulesPollTimer); modulesPollTimer = null; }
      } catch(_) {}
    }, 3000);
  }
}

async function triggerModulesRescan(){
  try {
    const r = await fetch('api/modules/check', { method:'POST' });
    if (!r.ok && r.status !== 202) {
      const e = await r.json().catch(()=>({}));
      toast(e.error || 'Rescan failed', 'error');
      return;
    }
    if (lastModules) lastModules.scanInProgress = true;
    if (state.tab === 'modules') renderModules();
    ensureModulesPoll(true);
    toast('Rescan started', 'info');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function triggerModuleUpdate(dir, user, packages){
  // Optimistically mark this dir as updating
  if (lastModules) {
    lastModules.activeUpdates = lastModules.activeUpdates || {};
    lastModules.activeUpdates[dir] = { user, packages, startedAt: new Date().toISOString() };
  }
  if (state.tab === 'modules') renderModules();
  ensureModulesPoll(true);
  try {
    const res = await fetch('api/modules/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, user, packages: packages || [] }),
    });
    const result = await res.json();
    // Refresh state immediately
    try {
      const m = await fetch('api/modules').then(r => r.json());
      lastModules = m;
    } catch(_) {}
    if (state.tab === 'modules') renderModules();
    if (result.success) {
      const pkgs = (result.packages||[]).join(', ');
      toast('Update succeeded' + (pkgs ? ' · ' + pkgs : ''), 'success');
    } else {
      const out = (result.output || '').split('\\n').slice(-6).join('\\n');
      toast('Update failed: ' + (result.error || 'unknown'), 'error', { detail: out, duration: 12000 });
    }
  } catch(e) {
    toast('Error: '+e.message, 'error');
    // Clear the optimistic state
    if (lastModules && lastModules.activeUpdates) delete lastModules.activeUpdates[dir];
    if (state.tab === 'modules') renderModules();
  }
}

async function checkUpdates(){
  try {
    const res = await fetch('api/updates/check', { method: 'POST' });
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdate(key){
  // Optimistically show running state
  if (lastUpdates) {
    const c = lastUpdates.components.find(x => x.key === key);
    if (c) c.updating = true;
    renderUpdates();
  }
  try {
    const res = await fetch('api/updates/run/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUserUpdate(user, key){
  try {
    const res = await fetch('api/updates/run/' + user + '/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdateAll(){
  try {
    await fetch('api/updates/run-all', { method: 'POST' });
    const res = await fetch('api/updates');
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

function saveUpdatesConfig(){
  if (!lastUpdates) return;
  const sched = {
    enabled: document.getElementById('schedEnable').checked,
    hour: parseInt(document.getElementById('schedHour').value) || 3,
    minute: parseInt(document.getElementById('schedMin').value) || 0,
    components: Array.from(document.querySelectorAll('.sched-comp:checked')).map(el => el.dataset.key),
  };
  const tel = {
    enabled: document.getElementById('telEnable').checked,
    botToken: document.getElementById('telToken').value,
    chatId: document.getElementById('telChatId').value,
    notifyOnUpdate: document.getElementById('telNotifyUpd').checked,
    notifyOnComplete: document.getElementById('telNotifyDone').checked,
  };
  fetch('api/updates/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: sched, telegram: tel }),
  });
  if (lastUpdates) {
    lastUpdates.schedule = sched;
    lastUpdates.telegram = tel;
  }
}

async function clearUpdateLog(){
  try {
    await fetch('api/updates/log', { method: 'DELETE' });
    if (lastUpdates) { lastUpdates.log = []; renderUpdates(); }
  } catch(_){}
}

async function testTelegram(){
  if (!lastUpdates || !lastUpdates.telegram) return;
  const tel = lastUpdates.telegram;
  if (!tel.botToken || !tel.chatId) { toast('Save bot token and chat ID first', 'warn'); return; }
  try {
    const res = await fetch('https://api.telegram.org/bot' + tel.botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tel.chatId, text: '🔔 *PM2 Status* — Telegram notification is working!', parse_mode: 'Markdown' }),
    });
    if (res.ok) toast('Test message sent — check your Telegram.', 'success');
    else { const j = await res.json(); toast('Telegram error: ' + (j.description || res.status), 'error'); }
  } catch(e){ toast('Telegram failed: ' + e.message, 'error'); }
}

function setTab(tab){
  state.tab = tab; saveState();
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  document.getElementById('pm2view').style.display = tab==='pm2' ? '' : 'none';
  document.getElementById('dbview').style.display  = tab==='db'  ? '' : 'none';
  document.getElementById('updatesview').style.display = tab==='updates' ? '' : 'none';
  document.getElementById('sitesview').style.display = tab==='sites' ? '' : 'none';
  document.getElementById('modulesview').style.display = tab==='modules' ? '' : 'none';
  if (tab==='pm2') render();
  else if (tab==='db') renderDb();
  else if (tab==='updates') renderUpdates();
  else if (tab==='sites') renderSites();
  else if (tab==='modules') renderModules();
}

document.getElementById('q').value = state.q;
document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; saveState(); render(); });
document.querySelectorAll('.chip[data-f]').forEach(c =>
  c.addEventListener('click', () => { state.f = c.dataset.f; saveState(); render(); }));
document.getElementById('sort').addEventListener('change', e => { state.sort = e.target.value; saveState(); render(); });
document.getElementById('sharedToggle').addEventListener('click', () => {
  state.sharedOnly = !state.sharedOnly; saveState(); render();
});
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));

async function refresh(){
  try { [lastData, lastDb, lastUpdates, lastSites, lastModules] = await Promise.all([
    fetch('api/status').then(r=>r.json()),
    fetch('api/db').then(r=>r.json()),
    fetch('api/updates').then(r=>r.json()),
    fetch('api/sites').then(r=>r.json()),
    fetch('api/modules').then(r=>r.json()),
  ]); } catch(e){ return; }
  if (state.tab==='pm2') render();
  else if (state.tab==='db') renderDb();
  else if (state.tab==='updates') renderUpdates();
  else if (state.tab==='sites') renderSites();
  else if (state.tab==='modules') renderModules();
}
async function pm2Action(action, user, app) {
  try {
    const r = await fetch('api/pm2/' + action + '/' + user + '/' + app, { method: 'POST' });
    const data = await r.json();
    if (data.success) toast(action + ' sent · ' + app, 'success');
    else toast('Error', 'error', { detail: data.output || 'unknown', duration: 10000 });
    refresh();
  } catch(e) { toast('Error: ' + e, 'error'); }
}
setTab(state.tab);
refresh(); setInterval(refresh, 10000);
</script>
</body></html>`;

/* ----------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (url === '/api/status' || url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(buildPayload()));
  }
  if (url === '/api/db') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(buildDbPayload()));
  }
  if (url === '/api/updates') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(updatesCache || { components: [], lastChecked: null, schedule: { enabled: false }, telegram: { enabled: false }, log: [] }));
  }
  if (url === '/api/updates/check' && req.method === 'POST') {
    collectUpdates().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/updates/run-all' && req.method === 'POST') {
    const outdated = (updatesCache ? updatesCache.components : []).filter(c => c.updateAvailable && c.key !== 'node');
    Promise.all(outdated.map(c => runUpdate(c.key))).then((results) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    });
    return;
  }
  if (url.startsWith('/api/updates/run/') && req.method === 'POST') {
    const parts = url.slice('/api/updates/run/'.length).split('/');
    const promise = parts.length >= 2 && parts[1]
      ? runUserUpdate(parts[0], parts[1])
      : runUpdate(parts[0]);
    promise.then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (url === '/api/updates/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        if (updatesCache) {
          if (cfg.schedule) updatesCache.schedule = { ...updatesCache.schedule, ...cfg.schedule };
          if (cfg.telegram) updatesCache.telegram = { ...updatesCache.telegram, ...cfg.telegram };
          updatesCacheAt = Date.now();
          saveUpdates();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  if (url === '/api/updates/log' && req.method === 'DELETE') {
    updateLog = [];
    if (updatesCache) updatesCache.log = [];
    saveUpdates();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url === '/api/sites') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sitesCache || { sites: [], generated_at: null }));
  }
  if (url.startsWith('/api/pm2/') && req.method === 'POST') {
    const parts = url.slice('/api/pm2/'.length).split('/');
    const action = parts[0];
    const targetUser = parts[1];
    const appName = parts[2];
    const pm2Home = `/home/${targetUser}/.pm2`;
    const cmd = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
    execFile('sudo', ['-n', '-u', targetUser, 'sh', '-c',
      `PM2_HOME=${pm2Home} pm2 ${cmd} ${appName} 2>&1`],
      { timeout: 30000 },
      (err, stdout) => {
        const result = { action, user: targetUser, app: appName, success: !err, output: stdout.trim() };
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    return;
  }
  if (url === '/api/sites/check' && req.method === 'POST') {
    collectSites().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/modules') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modulesCache
      ? { ...modulesCache, scanInProgress: modulesScanInProgress, scanProgress: modulesScanProgress, activeUpdates: moduleUpdatesActive, updateLog: moduleUpdateLog }
      : { generated_at: null, summary: {}, projects: [], outdated: [], scanInProgress: modulesScanInProgress, scanProgress: modulesScanProgress, activeUpdates: moduleUpdatesActive, updateLog: moduleUpdateLog }));
  }
  if (url === '/api/modules/check' && req.method === 'POST') {
    if (modulesScanInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'scan already in progress', progress: modulesScanProgress }));
    }
    collectModules().catch((e) => console.error('modules scan failed:', e.message));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, started: true }));
  }
  if (url === '/api/modules/update' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid JSON' })); }
      const { dir, user, packages } = payload || {};
      if (!dir || !user) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'dir and user required' }));
      }
      runModuleUpdate(dir, user, packages || []).then((result) => {
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      });
    });
    return;
  }
  if (url === '/api/modules/log' && req.method === 'DELETE') {
    moduleUpdateLog = [];
    if (modulesCache) modulesCache.updateLog = [];
    saveModulesCache();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

loadHistory();
loadUpdates();
loadModulesCache();
sample();                                  // first sample immediately
setInterval(sample, SAMPLE_MS);
collectUpdates().then(() => startScheduler());  // initial updates check + scheduler
setInterval(() => collectUpdates(), CHECK_INTERVAL_MS); // hourly re-check
collectSites();                            // initial sites data
setInterval(() => collectSites(), 300_000); // re-check sites every 5 min
// modules: kick off first scan in background (slow — registry-bound), then refresh every 6h
setTimeout(() => { collectModules().catch((e) => console.error('initial modules scan failed:', e.message)); }, 8_000);
setInterval(() => collectModules().catch(() => {}), MODULES_INTERVAL_MS);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveHistory(true); process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`pm2-status listening on http://${HOST}:${PORT}`);
});
