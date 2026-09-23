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

// In cluster mode the pm2 God Daemon, not the app, owns the app's listening socket — so "what is on
// this port" answers with the daemon, and anything derived from it (its node binary above all) says
// nothing about the app. These two let callers tell the daemon apart from what it supervises.
const daemonPids = new Set();
function isDaemonPid(pid) { return !!pid && daemonPids.has(Number(pid)); }
// The daemon's own interpreter. A '(deleted)' exe means node was upgraded under a daemon that has
// been up ever since: its workers pick the new one up on restart, but the daemon itself only does on
// `pm2 update`, which is a different fix from restarting an app and worth naming separately.
function daemonInfo(pid) {
  if (!pid) return null;
  let exe = null;
  try { exe = fs.readlinkSync('/proc/' + pid + '/exe'); } catch (_) { return { pid, stale: false, path: null }; }
  return { pid, stale: / \(deleted\)$/.test(exe), path: exe.replace(/ \(deleted\)$/, '') };
}

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
    if (running && pid) daemonPids.add(pid);
    if (running || dump.length) out.push({ user, pm2_home: dir, running, dump, daemon: running ? daemonInfo(pid) : null });   // an empty, stopped ~/.pm2 is just leftovers
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

// One `pm2 jlist` as the owning user. This is the only reading that is true *now* — the collector's
// snapshot is up to a sample interval old, which is exactly long enough for a stop or a start made
// from the panel to appear not to have happened.
function jlist(user, pm2Home) {
  return new Promise((resolve) => {
    const cmd = 'cd ' + JSON.stringify('/home/' + user) + ' && PM2_HOME=' + JSON.stringify(pm2Home) + ' pm2 jlist 2>/dev/null';
    execFile('sudo', ['-n', '-H', '-u', user, 'sh', '-c', cmd], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(null);
      // pm2 sometimes prefixes the JSON with a banner line; take from the first '['.
      const i = String(stdout).indexOf('[');
      if (i < 0) return resolve(null);
      try {
        const j = JSON.parse(String(stdout).slice(i));
        resolve((Array.isArray(j) ? j : []).map((p) => ({
          name: p.name, pid: p.pid || null, status: (p.pm2_env && p.pm2_env.status) || 'unknown',
          restarts: (p.pm2_env && p.pm2_env.restart_time) || 0,
          cpu: (p.monit && p.monit.cpu) || 0, memory: (p.monit && p.monit.memory) || 0,
          uptime_ms: p.pm2_env && p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
          out_log: p.pm2_env && p.pm2_env.pm_out_log_path, err_log: p.pm2_env && p.pm2_env.pm_err_log_path,
        })));
      } catch (_) { resolve(null); }
    });
  });
}

// Processes of this site: what the collector last saw, plus the dump for daemons that are down.
//
// `opts.live` asks pm2 itself instead of trusting the snapshot — used by the per-site views and
// straight after a start/stop/restart, where being a sample interval behind is the whole complaint.
// Either way a process the snapshot calls 'online' whose pid is gone is reported as stopped: a dead
// pid is proof, and it costs nothing to check.
// Assemble the per-home rows into the shape callers expect. `rowsFor` yields one home's processes.
function assemble(homes, rowsFor) {
  const procs = [];
  for (const h of homes) {
    const seen = new Set();
    for (const p of rowsFor(h) || []) {
      seen.add(p.name);
      // The snapshot can name a pid that has since exited — that is not 'online' any more.
      if (p.status === 'online' && p.pid && !pidAlive(p.pid)) { p.status = 'stopped'; p.pid = null; p.cpu = 0; p.uptime_ms = null; }
      procs.push(Object.assign({}, p, { pm2User: h.user }));
    }
    // apps in the dump the daemon is not running (daemon dead, or the app was deleted from the list)
    for (const name of h.dump) if (!seen.has(name)) procs.push({ name, status: h.running ? 'not started' : 'daemon down', restarts: 0, cpu: 0, memory: 0, uptime_ms: null, pm2User: h.user, fromDump: true });
  }
  return { homes, processes: procs };
}

// The collector's last snapshot, no subprocesses. Callers on a synchronous path use this.
function listSnapshot(site) {
  const homes = pm2HomesFor(site);
  const latest = history.getLatest() || [];
  return assemble(homes, (h) => {
    const g = latest.find((x) => x.pm2_home === h.pm2_home || x.user === h.user);
    return ((g && g.processes) || []).map((p) => Object.assign({}, p));
  });
}

async function list(site, opts) {
  const homes = pm2HomesFor(site);
  if (!(opts && opts.live)) return listSnapshot(site);
  const live = new Map();
  for (const h of homes) if (h.running) live.set(h.user, await jlist(h.user, h.pm2_home));
  const latest = history.getLatest() || [];
  return assemble(homes, (h) => {
    const rows = live.get(h.user);
    if (rows) return rows;
    const g = latest.find((x) => x.pm2_home === h.pm2_home || x.user === h.user);
    return ((g && g.processes) || []).map((p) => Object.assign({}, p));
  });
}

// Cron jobs belonging to this site that will start the app again on their own.
//
// Several sites here carry their own watchdog (`healthcheck.sh`, `self-heal.mjs`, `ooda.sh health`),
// written after an outage that nothing was watching. They work — which means a `pm2 stop` from the
// panel is quietly undone a minute or two later, and the button looks broken when it was in fact
// overruled. The panel does not own these crontabs and must not edit them; what it owes the operator
// is to say that they are there.
const WATCHDOG_RE = /(health-?check|self-?heal|watchdog|monitor|ooda)|pm2\s+(restart|start|resurrect)/i;
function watchdogCrons(site) {
  const users = new Set([site.user]);
  try { for (const u of store.sshUsers.list(site.id)) users.add(u.username); } catch (_) {}
  const found = [];
  for (const user of users) {
    if (!user || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) continue;
    let out = '';
    try { out = require('child_process').execFileSync('crontab', ['-u', user, '-l'], { timeout: 10_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { continue; }
    for (const line of out.split('\n')) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      // Split the schedule off the command: either an @-shortcut or five fields.
      const m = /^(@\w+)\s+(.*)$/.exec(l) || /^((?:\S+\s+){5})(.*)$/.exec(l);
      if (!m) continue;
      const schedule = m[1].trim(), command = m[2].trim();
      // @reboot only fires on boot, so it is not something that will undo a stop made just now.
      if (schedule === '@reboot') continue;
      if (WATCHDOG_RE.test(command)) found.push({ user, schedule, command: command.slice(0, 300) });
    }
  }
  return found;
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

module.exports = { pm2HomesFor, list, listSnapshot, act, dumpApps, isDaemonPid, watchdogCrons };
