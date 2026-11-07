'use strict';
/* --------------------------------------------------------------- updates */
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { APP_ROOT } = require('./config');
const { querySitesDb } = require('./cloudpanel');
const notify = require('./notify');
const { isSystemUser } = require('./util');
const events = require('./events');

const UPDATES_FILE = path.join(APP_ROOT, 'updates.json');
const CHECK_INTERVAL_MS = 3600_000;          // check for latest versions hourly
const UPDATE_LOG_MAX = 50;

// Sites recorded as following the system Node, restarted so they actually execute it. Required late
// so a site module pulling updates.js back in cannot deadlock the require graph at load.
async function restartLatestTracking(compKey, comp) {
  const out = [];
  try {
    const store = require('./sites/store');
    const procs = require('./sites/procs');
    const nodever = require('./sites/nodever');
    const runtime = require('./sites/runtime');
    for (const site of store.list()) {
      if (site.type !== 'nodejs' || !site.nodejs || !nodever.isLatest(site.nodejs.node_version)) continue;
      // A latest-tracking site's nvm, if it has one, is a spare — bring it along so it cannot drift
      // back to naming a version nothing runs. A pinned site is skipped by the guard above, because
      // holding its version is the whole point of the pin.
      try { await runtime.syncNvmToSystem(site.user); } catch (_) { /* a spare is not worth failing over */ }
      try {
        const before = (await procs.list(site, { live: true })).processes;
        const r = await procs.act(site, 'restart', { onlyRunning: true });   // a site someone stopped stays stopped
        if (r.results.length && r.results.every((x) => x.skipped)) { out.push({ domain: site.domain, ok: true, skipped: true, error: null }); continue; }
        if (!r.ok) { out.push({ domain: site.domain, ok: false, error: 'pm2 restart reported no success' }); continue; }
        // "restart ✓" only means pm2 took the order; the site is up when its process is still online
        // a few seconds later. A crash here is almost always a build that no longer matches what is
        // installed (a dependency updated without a rebuild), so say so where it will be read.
        const h = await procs.health(site, { before });
        const crash = h.ok ? null : procs.describeCrash(h);
        out.push({ domain: site.domain, ok: h.ok, error: h.ok ? null : 'crashed after restart: ' + crash });
        if (!h.ok) events.emit('site.crash', { user: 'system', site: site.domain, target: compKey, level: 'error',
          message: site.domain + ' crashed after the ' + comp.label + ' update restart: ' + crash, data: { crashed: h.crashed } });
      } catch (e) {
        // A site with nothing running has nothing to move onto the new version; that is not a failure.
        const nothingRunning = /no pm2 daemon/i.test(e.message || '');
        out.push({ domain: site.domain, ok: true, skipped: nothingRunning, error: nothingRunning ? null : e.message });
        if (!nothingRunning) out[out.length - 1].ok = false;
      }
    }
  } catch (e) { /* a store that will not load is not a reason to fail the update itself */ }
  return out;
}

const COMPONENTS = [
  { key: 'node',     label: 'Node.js',     bin: 'node',     pkg: null,                         verFlag: '--version',
    // system package from the NodeSource apt repo (one major per repo, so this stays within 26.x)
    updateCmd: ['sh', '-c', 'apt-get update -qq >/dev/null 2>&1; apt-get install -y --only-upgrade nodejs 2>&1'] },
  { key: 'claude',   label: 'Claude Code', bin: 'claude',   pkg: '@anthropic-ai/claude-code',  verFlag: '--version', updateCmd: ['claude', 'update'] },
  // The panel itself, from its GitHub repo: the version is the checked-out commit, latest is the
  // upstream branch's. Not a per-user tool, and updating it means restarting this very process.
  { key: 'panel',    label: 'RHC SRV Manager (panel)', bin: null, pkg: null, git: true },
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
  // legacy: the Telegram config (incl. bot token) used to live here; migrate it to sqlite and drop it
  if (updatesCache && updatesCache.telegram) {
    notify.setConfig(updatesCache.telegram);
    delete updatesCache.telegram;
    saveUpdates();
  }
  reportPanelRestart();
}
function saveUpdates() {
  try {
    if (updatesCache) {
      updatesCache.log = updateLog.slice(-UPDATE_LOG_MAX);
      fs.writeFileSync(UPDATES_FILE + '.tmp', JSON.stringify(updatesCache, null, 2), { mode: 0o600 });
      fs.renameSync(UPDATES_FILE + '.tmp', UPDATES_FILE);
    }
  } catch (_) {}
}

/* ------------------------------------------------------ panel self-update */

// Same lock as the auto-commit cron and scripts/land.sh, so a pull never meets a half-written index.
const GIT_LOCK = '/var/lock/rhc-autocommit';
const PANEL_RESULT_FILE = path.join(APP_ROOT, 'panel-update-result.json');

function gitOut(args, timeout) {
  return new Promise((resolve) => execFile('git', ['-C', APP_ROOT].concat(args), { timeout: timeout || 10000, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ err, out: (stdout || '').trim(), errOut: (stderr || '').trim() })));
}

// Where the checkout stands against its upstream (origin/main on the live box). `fetch` refreshes the
// remote-tracking ref first; without it the answer is only as fresh as the last fetch.
async function panelGitState({ fetch } = {}) {
  const head = await gitOut(['rev-parse', '--short', 'HEAD']);
  if (head.err) return { current: null, latest: null, behind: 0, ahead: 0 };
  const up = await gitOut(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (up.err) return { current: head.out, latest: null, behind: 0, ahead: 0, error: 'no upstream branch' };
  if (fetch) {
    const f = await gitOut(['fetch', '-q', up.out.split('/')[0]], 60000);
    if (f.err) return { current: head.out, latest: null, behind: 0, ahead: 0, error: 'git fetch failed: ' + (f.errOut || f.err.message) };
  }
  const latest = await gitOut(['rev-parse', '--short', '@{u}']);
  const counts = await gitOut(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  const [ahead, behind] = (counts.out || '0 0').split(/\s+/).map(Number);
  return { current: head.out, latest: latest.out || null, behind: behind || 0, ahead: ahead || 0 };
}

// Pull, check, then restart under pm2. The restart kills this process (and pm2 tree-kills its
// children), so it is handed to a transient systemd unit that also watches the new code come up and
// rolls back to the previous commit when it does not; the outcome is picked up by loadUpdates().
async function runPanelUpdate(compKey, comp, actor) {
  const pm2Name = process.env.pm_id !== undefined ? process.env.name : null;
  if (!pm2Name) return { error: 'The panel is not running under pm2 — pull and restart it by hand.' };
  updatesRunning.set(compKey, true);
  const start = Date.now();
  const before = (await panelGitState()).current;
  let success = false, output = '';
  try {
    const script = [
      'set -e',
      'cd "$1"',
      'if ! git diff --quiet || ! git diff --cached --quiet; then echo "the checkout has uncommitted changes (the auto-commit picks them up within 15 min, then try again):"; git status --short; exit 3; fi',
      'before=$(git rev-parse HEAD)',
      'git fetch -q "$(git rev-parse --abbrev-ref @{u} | cut -d/ -f1)"',
      'git merge --ff-only -q @{u} || { echo "cannot fast-forward: this checkout has commits that are not on GitHub"; exit 4; }',
      'for f in server.js $(git ls-files lib bin | grep "\\.js$"); do',
      '  node --check "$f" || { git reset -q --keep "$before"; echo "syntax check failed in $f; stayed on $before"; exit 5; }',
      'done',
      'git log --oneline "$before..HEAD"',
    ].join('\n');
    const r = await execOut('flock', ['-w', '120', GIT_LOCK, 'sh', '-c', script, 'sh', APP_ROOT], { timeout: 180000 });
    output = r.out;
    success = !r.err;
  } catch (e) {
    output = e.message; success = false;
  } finally {
    updatesRunning.delete(compKey);
  }
  const st = await panelGitState();
  const commits = success ? output.split('\n').filter(Boolean).length : 0;
  if (updatesCache) {
    const c = (updatesCache.components || []).find((x) => x.key === compKey);
    if (c) Object.assign(c, { currentVersion: st.current, latestVersion: st.latest, behind: st.behind, updateAvailable: st.behind > 0, updating: false });
  }
  if (success && !commits) output = 'already up to date (' + st.current + ')';
  else if (success) output = before + ' → ' + st.current + ' (' + commits + ' commit' + (commits > 1 ? 's' : '') + '), restarting the panel\n' + output;
  const entry = {
    component: compKey, label: comp.label, success,
    timestamp: new Date().toISOString(), duration_ms: Date.now() - start, output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: compKey, level: success ? 'info' : 'error',
    message: (success ? 'Updated ' : 'Update failed: ') + comp.label + (commits ? ' to ' + st.current : ''), data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));
  notify.send((success ? '✅' : '❌') + ' *Update ' + comp.label + '*: ' + (success ? 'succeeded' : 'failed') + '\n`' + output.slice(0, 500) + '`', 'complete');
  if (commits) restartPanel(pm2Name, before, st.current);
  return entry;
}

// The restart kills whatever this process is still running (an apt upgrade from "Update All", a
// user's npm install), so it waits for the other updates to finish first.
async function restartPanel(pm2Name, prev, head) {
  for (let i = 0; i < 450 && updatesRunning.size; i++) await new Promise((r) => setTimeout(r, 2000));
  const port = Number(process.env.PORT) || 8899;
  const watchdog = [
    'sleep 2',
    'cd "$1"',
    'pm2 restart "$2" --update-env >/dev/null 2>&1',
    'ok=0; for i in $(seq 1 20); do sleep 3; if curl -s -o /dev/null -m 3 "http://127.0.0.1:$3/"; then ok=1; break; fi; done',
    // The new code did not answer within a minute: go back to the commit it replaced. The note is
    // written first, so the old code finds it when it boots.
    'if [ $ok = 0 ]; then',
    '  printf \'{"ok":false,"head":"%s","rolledBackTo":"%s","at":"%s"}\' "$5" "$4" "$(date -u +%FT%TZ)" > "$6"',
    '  flock -w 120 /var/lock/rhc-autocommit git reset -q --keep "$4" && pm2 restart "$2" --update-env >/dev/null 2>&1',
    'fi',
  ].join('\n');
  // Read by the new code at boot, which is how the restart itself reaches the update log.
  try { fs.writeFileSync(PANEL_RESULT_FILE, JSON.stringify({ head, prev, at: new Date().toISOString() }), { mode: 0o600 }); } catch (_) {}
  execFile('systemd-run', ['--unit=rhc-panel-update-' + Date.now(), '--collect', '--quiet', '--setenv=HOME=/root', '--setenv=PATH=' + process.env.PATH,
    'sh', '-c', watchdog, 'sh', APP_ROOT, pm2Name, String(port), prev, head, PANEL_RESULT_FILE], { timeout: 10000 }, (err) => {
    if (err) console.error('panel restart: systemd-run failed:', err.message);
  });
}

// After the restart (into the new code, or back into the old one after a rollback): report it once.
function reportPanelRestart() {
  let r;
  try { r = JSON.parse(fs.readFileSync(PANEL_RESULT_FILE, 'utf8')); fs.unlinkSync(PANEL_RESULT_FILE); } catch (_) { return; }
  r.ok = r.ok !== false;
  const comp = COMPONENTS.find((c) => c.key === 'panel');
  const output = r.ok ? 'restarted on ' + r.head : 'the panel did not come up on ' + r.head + ' within a minute; rolled back to ' + r.rolledBackTo;
  updateLog.push({ component: 'panel', label: comp.label, success: r.ok, action: 'restart', timestamp: new Date().toISOString(), duration_ms: 0, output });
  saveUpdates();
  events.emit('updates.run', { user: 'system', target: 'panel', level: r.ok ? 'info' : 'error', message: comp.label + ': ' + output });
  if (!r.ok) notify.send('❌ *Update ' + comp.label + '*: ' + output, 'complete');
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
    if (comp.git) {
      const st = await panelGitState({ fetch: true });
      results.push({ key: comp.key, label: comp.label, bin: null, pkg: null, git: true,
        currentVersion: st.current, latestVersion: st.latest, behind: st.behind, ahead: st.ahead, error: st.error,
        updateAvailable: st.behind > 0, updating: updatesRunning.has(comp.key) });
      continue;
    }
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
  const userCompKeys = COMPONENTS.filter(c => !c.git).map(c => c.key);
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
    log: updateLog.slice(-UPDATE_LOG_MAX),
  };
  // "notify when updates become available": only for components that were current at the previous check
  const prevAvail = new Set(((updatesCache && updatesCache.components) || []).filter((c) => c.updateAvailable).map((c) => c.key));
  const fresh = results.filter((c) => c.updateAvailable && !prevAvail.has(c.key));
  if (fresh.length && updatesCache) notify.send('🔄 *Updates available*\n' + fresh.map((c) => '• ' + c.label + ': ' + c.currentVersion + ' → ' + c.latestVersion).join('\n'), 'update').catch(() => {});
  updatesCache = upd;
  updatesCacheAt = now;
  saveUpdates();
  return upd;
}

// The install a user actually runs — the same PATH getUserVersion searches — resolved through its
// symlinks. Updating by `npm config get prefix` was wrong for most users: their prefix is the
// shared /usr, but the binary they run is a private copy in ~/.local (npm --prefix) or a Claude
// Code native install, so the system copy was updated and the user's stayed where it was.
function userInstall(user, comp) {
  let out = '';
  try {
    out = execFileSync('sudo', ['-n', '-H', '-u', user, 'sh', '-c',
      `P="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:$PATH"; p=$(PATH="$P" command -v ${comp.bin}) && echo "$HOME" && echo "$p" && readlink -f "$p"`],
      { timeout: 8000, encoding: 'utf8' }).trim();
  } catch (_) { return null; }
  const [home, bin, real] = out.split('\n');
  if (!real) return null;
  if (/\/\.local\/share\/claude\/versions\//.test(real)) return { kind: 'claude-native', bin };
  if (real.startsWith(home + '/.bun/')) return { kind: 'bun', bin };
  const m = real.match(/^(.*)\/lib\/node_modules\//);
  if (m && (m[1] === '/usr' || m[1] === '/usr/local')) return { kind: 'system', prefix: m[1], bin };
  if (m && m[1].startsWith(home)) return { kind: 'npm-prefix', prefix: m[1], bin };
  return { kind: 'unknown', bin, real };
}

function execOut(cmd, args, opts) {
  return new Promise((resolve) => execFile(cmd, args, Object.assign({ timeout: 300000, maxBuffer: 4 * 1024 * 1024 }, opts),
    (err, stdout, stderr) => resolve({ err, out: ((stdout || '') + '\n' + (stderr || '')).trim() })));
}

async function runUserUpdate(user, compKey, actor) {
  if (!isSystemUser(user)) return { error: 'Invalid user' };
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (!comp.pkg) return { error: 'No npm package for ' + comp.label };
  const start = Date.now();
  let success = false, output = '';
  updatesRunning.set(user + '/' + compKey, true);   // keeps a panel restart from cutting the install short
  try {
    const before = await getUserVersion(user, comp);
    const inst = userInstall(user, comp);
    const asUser = (sh) => execOut('sudo', ['-n', '-H', '-u', user, 'sh', '-c', 'cd "$HOME" && ' + sh + ' 2>&1']);
    let r;
    if (!inst) r = { err: new Error('not installed'), out: comp.bin + ' is not installed for ' + user };
    else if (inst.kind === 'claude-native') r = await asUser(JSON.stringify(inst.bin) + ' update');
    else if (inst.kind === 'npm-prefix') r = await asUser('npm install -g --prefix ' + JSON.stringify(inst.prefix) + ' ' + comp.pkg + '@latest');
    else if (inst.kind === 'bun') r = await asUser('"$HOME/.bun/bin/bun" add -g ' + comp.pkg + '@latest');
    else if (inst.kind === 'system') r = await execOut('npm', ['install', '-g', '--prefix', inst.prefix, comp.pkg + '@latest']);
    else r = { err: new Error('unknown install'), out: 'do not know how to update ' + inst.real };
    const after = inst ? await getUserVersion(user, comp) : null;
    const latest = (updatesCache && (updatesCache.components || []).find((c) => c.key === compKey) || {}).latestVersion || null;
    // Success is the version the user now runs, not the installer's exit code — "up to date" from
    // an installer that looked at the wrong copy is exactly how this used to report success.
    success = !r.err && !!after && (after === latest || (!latest && after !== before));
    output = (inst ? '[' + inst.kind + (inst.prefix ? ' ' + inst.prefix : '') + '] ' : '') + (before || '?') + ' → ' + (after || '?')
      + (latest ? ' (latest ' + latest + ')' : '') + '\n' + r.out;
    if (!r.err && !success) output = 'installer finished but ' + user + ' still runs ' + (after || '?') + '\n' + output;
    if (after && updatesCache && updatesCache.users && updatesCache.users[user]) updatesCache.users[user][comp.key] = after;
  } catch (e) {
    output = e.message;
    success = false;
  } finally {
    updatesRunning.delete(user + '/' + compKey);
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

/* --------------------------------------------------------- removal (uninstall)
   The tracked components are global npm packages, so removing one is `npm rm -g <pkg>`
   — system-wide, or for a single user that has their own npm prefix. Node.js is a
   system apt package that everything else here runs on, so it is never removable. */
function removableComponent(compKey) {
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (!comp.pkg) return { error: comp.label + ' is a system package and cannot be removed here' };
  return { comp };
}

async function runRemove(compKey, actor) {
  if (updatesRunning.has(compKey)) return { error: 'Another operation is already in progress' };
  const { comp, error } = removableComponent(compKey);
  if (error) return { error };

  updatesRunning.set(compKey, true);
  const start = Date.now();
  let success = false, output = '';
  try {
    const result = await new Promise((resolve) => {
      execFile('npm', ['rm', '-g', comp.pkg], { timeout: 600000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, stdout: stdout || '', stderr: stderr || '' });
      });
    });
    output = (result.stdout + '\n' + result.stderr).trim();
    success = !result.err;
  } catch (e) {
    output = e.message; success = false;
  } finally {
    updatesRunning.delete(compKey);
    // Re-read the version so a removed component drops to "not installed" instead of
    // sitting on its old number until the next hourly collect.
    try {
      const v = await getCurrentVersion(comp);
      if (updatesCache) {
        const c = updatesCache.components.find(x => x.key === compKey);
        if (c) { c.currentVersion = v || null; c.updateAvailable = !!(v && c.latestVersion && v !== c.latestVersion); c.updating = false; }
      }
    } catch (_) { /* ignore refresh errors */ }
  }
  const entry = {
    component: compKey, label: comp.label, success, action: 'remove',
    timestamp: new Date().toISOString(), duration_ms: Date.now() - start, output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: compKey, level: success ? 'warn' : 'error',
    message: (success ? 'Removed ' : 'Removal failed: ') + comp.label, data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));
  return entry;
}

async function runUserRemove(user, compKey, actor) {
  if (!isSystemUser(user)) return { error: 'Invalid user' };
  const { comp, error } = removableComponent(compKey);
  if (error) return { error };
  const start = Date.now();
  let success = false, output = '';
  try {
    // Same prefix probe as runUserUpdate: a user on the shared system prefix would be
    // removing the package for everyone, so that case is refused rather than silently done.
    let useRoot = false;
    try {
      const prefix = execFileSync('sudo', ['-n', '-u', user, 'npm', 'config', 'get', 'prefix'], { timeout: 5000, encoding: 'utf8' }).trim();
      if (prefix === '/usr' || prefix === '/usr/local') useRoot = true;
    } catch { useRoot = true; }
    if (useRoot) return { error: user + ' shares the system npm prefix — remove ' + comp.label + ' system-wide instead' };
    const result = await new Promise((resolve) => {
      execFile('sudo', ['-n', '-u', user, 'sh', '-c', `npm rm -g ${comp.pkg} 2>&1`], { timeout: 120000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ err, stdout: (stdout || '') + '\n' + (stderr || '') });
      });
    });
    output = result.stdout.trim();
    success = !result.err;
  } catch (e) {
    output = e.message; success = false;
  }
  if (success && updatesCache && updatesCache.users && updatesCache.users[user]) {
    const v = await getUserVersion(user, comp);
    if (v) updatesCache.users[user][compKey] = v; else delete updatesCache.users[user][compKey];
  }
  const entry = {
    component: compKey, label: comp.label, user, success, action: 'remove',
    timestamp: new Date().toISOString(), duration_ms: Date.now() - start, output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: user + '/' + compKey, level: success ? 'warn' : 'error',
    message: (success ? 'Removed ' : 'Removal failed: ') + comp.label + ' for ' + user, data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));
  return entry;
}

async function runUpdate(compKey, actor) {
  if (updatesRunning.has(compKey)) return { error: 'Update already in progress' };
  const comp = COMPONENTS.find(c => c.key === compKey);
  if (!comp) return { error: 'Unknown component' };
  if (comp.git) return runPanelUpdate(compKey, comp, actor);
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

  // Upgrading the package swaps the binary on disk, but a running process keeps executing the inode
  // it already mapped — /proc shows it as "node (deleted)". A site that tracks the system Node is
  // only actually on the new version once it has been restarted, so that is done here rather than
  // left to whenever someone next happens to restart it.
  let restarted = null;
  if (compKey === 'node' && success) {
    restarted = await restartLatestTracking(compKey, comp);
    if (restarted.length) {
      output += '\n\nRestarted to pick up the new Node.js: '
        + restarted.map((r) => r.domain + (r.skipped ? ' (not running)' : r.ok ? '' : ' (FAILED: ' + r.error + ')')).join(', ');
    }
  }

  const entry = {
    component: compKey,
    label: comp.label,
    success,
    restarted: restarted || undefined,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - start,
    output: output.slice(0, 2000),
  };
  updateLog.push(entry);
  saveUpdates();
  events.emit('updates.run', Object.assign({ user: 'system' }, actor, { target: compKey, level: success ? 'info' : 'error',
    message: (success ? 'Updated ' : 'Update failed: ') + comp.label, data: { duration_ms: entry.duration_ms, output: entry.output.slice(0, 1000) } }));

  // Telegram notification
  {
    const icon = success ? '✅' : '❌';
    const crashed = (restarted || []).filter((r) => !r.ok);
    const restartLine = restarted && restarted.length
      ? '\nrestarted: ' + restarted.filter((r) => r.ok).length + '/' + restarted.length + ' site(s) onto the new version'
        + (crashed.length ? '\n⚠ *not up after the restart:*\n' + crashed.map((r) => '• ' + r.domain + ' — ' + String(r.error || '').slice(0, 300)).join('\n') : '')
      : '';
    const msg = `${crashed.length ? '⚠️' : icon} *Update ${comp.label}*: ${success ? 'succeeded' : 'failed'}${restartLine}\n\`${output.slice(0, 500)}\``;
    notify.send(msg, 'complete');
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
  if (cfg.telegram) notify.saveTelegram(cfg.telegram);   // legacy clients; Settings tab is the owner now
  updatesCacheAt = Date.now();
  saveUpdates();
  return true;
}
function clearLog() { updateLog = []; if (updatesCache) updatesCache.log = []; saveUpdates(); }
function exportSettings() { return updatesCache ? { schedule: updatesCache.schedule, telegram: notify.getConfig() } : null; }

module.exports = { COMPONENTS, CHECK_INTERVAL_MS, loadUpdates, saveUpdates, collectUpdates, runUpdate, runUserUpdate, runRemove, runUserRemove, startScheduler, getCache, getLog, setConfig, clearLog, exportSettings };
