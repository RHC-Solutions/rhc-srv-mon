'use strict';
// PM2 control for a site. Two things make this less obvious than "run pm2 as the site user":
//   * a site's apps often run under one of its SSH users (whose home symlinks htdocs into the site
//     home), not under the site user itself, so the daemon to talk to has to be discovered;
//   * when the daemon is dead there is nothing to list — but ~/.pm2/dump.pm2 still names the apps,
//     and `pm2 resurrect` is what brings them back. That is exactly the state a site is in when it
//     is down, so the panel has to see it.
// Every pm2 command runs as the owning user with HOME set and cwd inside that home: pm2 spawns the
// app from its own cwd, and a root-only cwd (the panel runs from /root) makes that spawn EACCES.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const history = require('../history');
const store = require('./store');

const ACTIONS = { start: 'start', stop: 'stop', restart: 'restart', reload: 'reload', resurrect: 'resurrect' };
const APP_RE = /^[A-Za-z0-9._@:/-]{1,64}$/;

const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');   // pm2 colours its output even without a tty
function realpath(p) { try { return fs.realpathSync(p); } catch (_) { return null; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (_) { return false; } }

// Apps recorded in dump.pm2 — the only listing available while the daemon is down.
function dumpApps(pm2Home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pm2Home, 'dump.pm2'), 'utf8'));
    return (Array.isArray(j) ? j : []).map((p) => p.name).filter(Boolean);
  } catch (_) { return []; }
}

// Every unix account whose ~/.pm2 could hold this site's apps, running or not.
function pm2HomesFor(site) {
  const home = '/home/' + site.user;
  const siteReal = realpath(home);
  const siteHtdocs = realpath(home + '/htdocs');
  const out = [], seen = new Set();
  const consider = (user) => {
    if (!user || seen.has(user)) return;
    seen.add(user);
    const dir = '/home/' + user + '/.pm2';
    if (!fs.existsSync(dir)) return;
    let pid = null;
    try { pid = parseInt(fs.readFileSync(path.join(dir, 'pm2.pid'), 'utf8').trim(), 10) || null; } catch (_) {}
    const running = pidAlive(pid), dump = dumpApps(dir);
    if (running || dump.length) out.push({ user, pm2_home: dir, running, dump });   // an empty, stopped ~/.pm2 is just leftovers
  };
  consider(site.user);
  try { for (const u of store.sshUsers.list(site.id)) consider(u.username); } catch (_) {}
  let entries = []; try { entries = fs.readdirSync('/home'); } catch (_) {}
  for (const e of entries) {
    if (seen.has(e)) continue;
    if ((siteReal && realpath('/home/' + e) === siteReal) || (siteHtdocs && realpath('/home/' + e + '/htdocs') === siteHtdocs)) consider(e);
  }
  return out;
}

// Processes of this site: what the collector last saw, plus the dump for daemons that are down.
function list(site) {
  const homes = pm2HomesFor(site);
  const latest = history.getLatest() || [];
  const procs = [];
  for (const h of homes) {
    const g = latest.find((x) => x.pm2_home === h.pm2_home || x.user === h.user);
    const seen = new Set();
    for (const p of (g && g.processes) || []) { seen.add(p.name); procs.push(Object.assign({}, p, { pm2User: h.user })); }
    // apps in the dump the daemon is not running (daemon dead, or the app was deleted from the list)
    for (const name of h.dump) if (!seen.has(name)) procs.push({ name, status: h.running ? 'not started' : 'daemon down', restarts: 0, cpu: 0, memory: 0, uptime_ms: null, pm2User: h.user, fromDump: true });
  }
  return { homes, processes: procs };
}

function run(user, pm2Home, argv) {
  return new Promise((resolve) => {
    const cmd = 'cd ' + JSON.stringify('/home/' + user) + ' && PM2_HOME=' + JSON.stringify(pm2Home) + ' pm2 ' + argv.join(' ') + ' 2>&1';
    execFile('sudo', ['-n', '-H', '-u', user, 'sh', '-c', cmd], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ user, ok: !err, output: strip(stdout).trim().slice(0, 4000), error: err ? String(err.code || err.signal || err.message) : null }));
  });
}

// action: start | stop | restart | reload | resurrect.
// opts.app + opts.user target one process; without them the action applies to the whole site, and
// start/restart fall back to `pm2 resurrect` for a daemon that is not running but has a dump.
async function act(site, action, opts) {
  opts = opts || {};
  const cmd = ACTIONS[action];
  if (!cmd) throw Object.assign(new Error('unknown action ' + action), { status: 400 });
  if (opts.app && !APP_RE.test(opts.app)) throw Object.assign(new Error('invalid process name'), { status: 400 });
  let homes = pm2HomesFor(site);
  if (opts.user) {
    homes = homes.filter((h) => h.user === opts.user);
    if (!homes.length) throw Object.assign(new Error('no pm2 home for user ' + opts.user + ' on this site'), { status: 404 });
  }
  if (!homes.length) throw Object.assign(new Error('this site has no pm2 daemon — nothing to ' + action), { status: 409 });
  const results = [];
  for (const h of homes) {
    let argv;
    if (cmd === 'resurrect') { if (!h.dump.length) { results.push({ user: h.user, ok: false, skipped: true, output: 'no dump.pm2 to resurrect' }); continue; } argv = ['resurrect']; }
    else if (opts.app) argv = [cmd, JSON.stringify(opts.app)];
    else if (!h.running && (cmd === 'start' || cmd === 'restart')) {
      if (!h.dump.length) { results.push({ user: h.user, ok: false, skipped: true, output: 'pm2 daemon is not running and there is no dump.pm2' }); continue; }
      argv = ['resurrect'];
    } else if (!h.running && cmd === 'stop') { results.push({ user: h.user, ok: true, skipped: true, output: 'pm2 daemon is not running' }); continue; }
    else argv = [cmd, 'all'];
    const r = await run(h.user, h.pm2_home, argv);
    results.push(Object.assign(r, { command: 'pm2 ' + argv.join(' ') }));
  }
  return { action, app: opts.app || null, results, ok: results.some((r) => r.ok && !r.skipped) && !results.some((r) => !r.ok) };
}

module.exports = { pm2HomesFor, list, act, dumpApps };
