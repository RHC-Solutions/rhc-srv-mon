'use strict';
/* --------------------------------------------------------------- updates */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { APP_ROOT } = require('./config');
const { querySitesDb } = require('./cloudpanel');
const notify = require('./notify');
const events = require('./events');

const UPDATES_FILE = path.join(APP_ROOT, 'updates.json');
const CHECK_INTERVAL_MS = 3600_000;          // check for latest versions hourly
const UPDATE_LOG_MAX = 50;

const COMPONENTS = [
  { key: 'node',     label: 'Node.js',     bin: 'node',     pkg: null,                         verFlag: '--version',
    // system package from the NodeSource apt repo (one major per repo, so this stays within 26.x)
    updateCmd: ['sh', '-c', 'apt-get update -qq >/dev/null 2>&1; apt-get install -y --only-upgrade nodejs 2>&1'] },
  { key: 'pi',       label: 'Pi',          bin: 'pi',       pkg: '@earendil-works/pi-coding-agent', verFlag: '--version' },
  { key: 'opencode', label: 'OpenCode',    bin: 'opencode', pkg: 'opencode-ai',                verFlag: '--version' },
  { key: 'codex',    label: 'Codex CLI',   bin: 'codex',    pkg: '@openai/codex',                   verFlag: '--version' },
  { key: 'gemini',   label: 'Gemini CLI',  bin: 'gemini',   pkg: '@google/gemini-cli',         verFlag: '--version' },
  { key: 'claude',   label: 'Claude Code', bin: 'claude',   pkg: '@anthropic-ai/claude-code',  verFlag: '--version', updateCmd: ['claude', 'update'] },
];

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
  notify.setConfig(updatesCache && updatesCache.telegram);
}
function saveUpdates() {
  try {
    if (updatesCache) {
      updatesCache.log = updateLog.slice(-UPDATE_LOG_MAX);
      fs.writeFileSync(UPDATES_FILE + '.tmp', JSON.stringify(updatesCache, null, 2));
      fs.renameSync(UPDATES_FILE + '.tmp', UPDATES_FILE);
    }
  } catch (_) {}
  notify.setConfig(updatesCache && updatesCache.telegram);
}

async function getCurrentVersion(comp) {
  return new Promise((resolve) => {
    execFile(comp.bin, [comp.verFlag], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      let v = stdout.trim().split('\n')[0].replace(/^v/, '');
      // Strip trailing annotations like "(Claude Code)" and leading labels like "codex-cli 0.150.1"
      v = v.replace(/\s*\(.*\)\s*$/, '').trim();
      const m = v.match(/\d+\.\d+[\w.\-]*/);
      if (m) v = m[0];
      resolve(v || null);
    });
  });
}

async function getLatestVersion(comp) {
  if (!comp.pkg) {
    // Node.js comes from the NodeSource apt repo, so "latest" is what apt can actually install.
    try {
      const pol = execFileSync('apt-cache', ['policy', 'nodejs'], { timeout: 15000, encoding: 'utf8' });
      const m = pol.match(/Candidate:\s*(\d+\.\d+\.\d+)/);
      if (m) return m[1];
    } catch (_) { /* fall back to nodejs.org */ }
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
    // Search the common per-user install locations: npm global prefix, the
    // native-installer dir (~/.local/bin, used by Claude Code etc.) and bun.
    // Capture stderr too — some CLIs (e.g. pi) print --version to stderr.
    execFile('sudo', ['-n', '-u', user, 'sh', '-c',
      `P="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; PATH="$P" command -v ${comp.bin} >/dev/null 2>&1 && PATH="$P" ${comp.bin} ${comp.verFlag} 2>&1 || echo '__NOT_FOUND__'`
    ], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      const out = (stdout || '').trim();
      if (!out || out.includes('__NOT_FOUND__')) return resolve(null);
      // Pull the first version-like token (e.g. "2.1.179 (Claude Code)" -> 2.1.179).
      for (const line of out.split('\n')) {
        const m = line.replace(/^v/, '').match(/\d+\.\d+[\w.\-]*/);
        if (m) return resolve(m[0]);
      }
      return resolve(null);
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

  // Get per-user versions for CloudPanel site users + every /home user + root.
  // The dev/SSH accounts (e.g. *_ssh, *_com) that actually run the agent CLIs
  // aren't CloudPanel site owners, so scan /home too — otherwise their
  // Claude Code / Pi installs never show up.
  const userCompKeys = COMPONENTS.map(c => c.key);
  const siteUsers = querySitesDb().map(s => s.user);
  let homeUsers = [];
  try { homeUsers = fs.readdirSync('/home'); } catch (_) {}
  const uniqueUsers = [...new Set([...siteUsers, ...homeUsers, 'root'])].filter(u => u && u !== 'clp');
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

async function runUserUpdate(user, compKey, actor) {
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
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: user + '/' + compKey, level: success ? 'info' : 'error',
    message: (success ? 'Updated ' : 'Update failed: ') + comp.label + ' for ' + user, data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));
  return entry;
}

async function runUpdate(compKey, actor) {
  if (updatesRunning.has(compKey)) return { error: 'Update already in progress' };
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (!comp.pkg && !comp.updateCmd) return { error: 'Update command not defined for ' + comp.label + '.' };

  updatesRunning.set(compKey, true);
  const start = Date.now();
  let success = false, output = '';

  try {
    const cmd = comp.updateCmd || ['npm', 'update', '-g', comp.pkg];
    const result = await new Promise((resolve) => {
      execFile(cmd[0], cmd.slice(1), { timeout: 600000, maxBuffer: 4 * 1024 * 1024, env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' }) }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      });
    });
    output = (result.stdout + '\n' + result.stderr).trim();
    success = !result.err;
  } catch (e) {
    output = e.message;
    success = false;
  } finally {
    updatesRunning.delete(compKey);
    // Always refresh cached version + clear the updating flag — even on failure or if the
    // post-update version read momentarily races — so the tile never gets stuck on "updating…".
    try {
      const newVersion = await getCurrentVersion(comp);
      if (updatesCache) {
        const c = updatesCache.components.find(x => x.key === compKey);
        if (c) {
          if (newVersion) {
            c.currentVersion = newVersion;
            const latest = await getLatestVersion(comp);
            if (latest) c.latestVersion = latest;
            c.updateAvailable = !!(newVersion && c.latestVersion && newVersion !== c.latestVersion);
          }
          c.updating = false;
        }
      }
    } catch (_) { /* ignore refresh errors */ }
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
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: compKey, level: success ? 'info' : 'error',
    message: (success ? 'Updated ' : 'Update failed: ') + comp.label, data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));

  // Telegram notification
  if (updatesCache && updatesCache.telegram && updatesCache.telegram.enabled) {
    const icon = success ? '✅' : '❌';
    const msg = `${icon} *Update ${comp.label}*: ${success ? 'succeeded' : 'failed'}\n\`${output.slice(0, 500)}\``;
    notify.sendTelegram(msg);
  }

  return entry;
}

/* ------------------------------------------------------- update scheduler */

let schedulerTimer = null;
let lastSchedKey = null;
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
    // Fire at most once per scheduled time per day — independent of manual runs, so a manual
    // update earlier in the day no longer suppresses the scheduled batch.
    const key = `${now.toISOString().slice(0, 10)}-${cfg.schedule.hour}-${cfg.schedule.minute}`;
    if (lastSchedKey === key) return;
    lastSchedKey = key;
    for (const compKey of cfg.schedule.components || []) {
      runUpdate(compKey);
    }
  }, 60000); // check every minute
}


// Accessors for the dispatcher / other modules.
function getCache() { return updatesCache; }
function getLog() { return updateLog; }
// Merge a { schedule?, telegram? } patch into the cache (POST /api/updates/config).
function setConfig(cfg) {
  if (!updatesCache) return false;
  if (cfg.schedule) updatesCache.schedule = { ...updatesCache.schedule, ...cfg.schedule };
  if (cfg.telegram) updatesCache.telegram = { ...updatesCache.telegram, ...cfg.telegram };
  updatesCacheAt = Date.now();
  saveUpdates();
  return true;
}
function clearLog() { updateLog = []; if (updatesCache) updatesCache.log = []; saveUpdates(); }
function exportSettings() { return updatesCache ? { schedule: updatesCache.schedule, telegram: updatesCache.telegram } : null; }

module.exports = { COMPONENTS, CHECK_INTERVAL_MS, loadUpdates, saveUpdates, collectUpdates, runUpdate, runUserUpdate, startScheduler, getCache, getLog, setConfig, clearLog, exportSettings };
