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
    const pid = require('../collect').daemonPid(dir);
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

// Is the site actually up after a start/restart, or crash-looping? Waits out pm2's first restart
// window, then asks pm2 itself. A process that is not online, or has restarted more than the one
// time the action itself causes (restart counts from `opts.before`, a listing taken beforehand),
// is reported with the tail of its error log — "pm2 restart ✓" alone proved nothing when four
// Next.js sites came back up and died within a second.
function tailFile(file, lines) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-lines).join('\n').slice(-1500); } catch (_) { return ''; }
}
async function health(site, opts) {
  opts = opts || {};
  await new Promise((r) => setTimeout(r, opts.delayMs || 6000));
  const live = await list(site, { live: true });
  const crashed = [];
  for (const p of live.processes) {
    if (opts.app && p.name !== opts.app) continue;
    const prev = (opts.before || []).find((b) => b.name === p.name && b.pm2User === p.pm2User);
    const looping = !!prev && typeof p.restarts === 'number' && p.restarts > (prev.restarts || 0) + 1;
    if (p.status === 'online' && !looping) continue;
    if (p.status === 'stopped' && prev && prev.status === 'stopped') continue;   // stopped on purpose, left alone
    crashed.push({ name: p.name, user: p.pm2User, status: p.status, restarts: p.restarts, log: tailFile(p.err_log, 12) });
  }
  return { ok: !crashed.length, crashed, processes: live.processes.length };
}
// One line per crashed process, for log entries and notifications.
function describeCrash(h) {
  // The tail of an error log usually ends in the closing braces of a dumped error object; the line
  // worth quoting is the last one that names the error.
  const gist = (log) => {
    const lines = String(log || '').split('\n').reverse();
    return lines.find((l) => /\b\w*(Error|Exception)\b\s*:/.test(l))
      || lines.find((l) => /error|exception|cannot|not found|ENOENT|EADDR|EACCES|fatal/i.test(l))
      || lines.find((l) => !/^[\s{}[\]()]*$/.test(l)) || '';
  };
  return (h.crashed || []).map((c) => { const g = gist(c.log).replace(/^\S+T\S+:\s*/, '').trim(); return c.name + ' ' + c.status + (g ? ' — ' + g.slice(0, 200) : ''); }).join('; ');
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

// Statuses of an app nobody has stopped. A restart issued by the panel itself (Node.js or module
// auto-update) only touches these: `pm2 restart` on a stopped app starts it, which undid every
// manual stop at the next nightly update.
const RUNNING_STATUS = new Set(['online', 'launching', 'waiting restart', 'errored']);

// action: start | stop | restart | reload | resurrect.
// opts.app + opts.user target one process; without them the action applies to the whole site, and
// start/restart fall back to `pm2 resurrect` for a daemon that is not running but has a dump.
// opts.onlyRunning (restart/reload, for automated callers): act only on apps that are running now —
// never start a stopped app, never resurrect a dead daemon.
// A whole-site start/stop/restart made by a person is followed by `pm2 save`, so a reboot brings
// the site back in the state it was left in (resurrect keeps apps saved as stopped stopped).
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
    if (opts.onlyRunning && (cmd === 'restart' || cmd === 'reload')) {
      if (!h.running) { results.push({ user: h.user, ok: true, skipped: true, output: 'pm2 daemon is not running — left down' }); continue; }
      const apps = await jlist(h.user, h.pm2_home);
      if (!apps) { results.push({ user: h.user, ok: false, output: 'pm2 jlist failed — not restarting blind' }); continue; }
      const live = apps.filter((p) => RUNNING_STATUS.has(p.status) && (!opts.app || p.name === opts.app)).map((p) => p.name);
      if (!live.length) { results.push({ user: h.user, ok: true, skipped: true, output: 'no running apps — stopped apps left stopped' }); continue; }
      argv = [cmd].concat([...new Set(live)].map((n) => JSON.stringify(n)));
    }
    else if (cmd === 'resurrect') { if (!h.dump.length) { results.push({ user: h.user, ok: false, skipped: true, output: 'no dump.pm2 to resurrect' }); continue; } argv = ['resurrect']; }
    else if (opts.app) argv = [cmd, JSON.stringify(opts.app)];
    else if (!h.running && (cmd === 'start' || cmd === 'restart')) {
      if (!h.dump.length) { results.push({ user: h.user, ok: false, skipped: true, output: 'pm2 daemon is not running and there is no dump.pm2' }); continue; }
      argv = ['resurrect'];
    } else if (!h.running && cmd === 'stop') { results.push({ user: h.user, ok: true, skipped: true, output: 'pm2 daemon is not running' }); continue; }
    else argv = [cmd, 'all'];
    const r = await run(h.user, h.pm2_home, argv);
    // A daemon with no apps answers a stop with "No process found" — that home simply has nothing
    // to stop, which is not a failed stop (it made every whole-site stop look failed).
    if (!r.ok && cmd === 'stop' && /No process found/i.test(r.output)) { r.ok = true; r.skipped = true; }
    if (r.ok && !r.skipped && !opts.onlyRunning && (cmd === 'start' || cmd === 'stop' || cmd === 'restart' || cmd === 'resurrect')) {
      const s = await run(h.user, h.pm2_home, ['save', '--force']);
      r.saved = s.ok;
      if (!s.ok) r.output += '\n(pm2 save failed: ' + s.output.slice(-300) + ')';
    }
    results.push(Object.assign(r, { command: 'pm2 ' + argv.join(' ') }));
  }
  return { action, app: opts.app || null, results, ok: results.some((r) => r.ok && !r.skipped) && !results.some((r) => !r.ok) };
}

// A pm2 app of this site that is down and whose error log says EADDRINUSE on the site's own port,
// while that port is up and another app of the site is online, is a stray duplicate (typically the
// same app started a second time under an SSH user). Restarting it can never work and it keeps the
// site "Degraded" forever, so it is removed from its pm2 (pm2 keeps the previous list as
// dump.pm2.bak). Returns what was removed.
async function dropPortDuplicates(site) {
  const port = Number((site.nodejs && site.nodejs.port) || (site.python && site.python.port) || 0);
  if (!port || !require('../util').listeningPorts().has(port)) return [];
  const lists = [];
  for (const h of pm2HomesFor(site).filter((x) => x.running)) { const apps = await jlist(h.user, h.pm2_home); if (apps) lists.push({ h, apps }); }
  const removed = [];
  for (const { h, apps } of lists) for (const p of apps) {
    if (!['errored', 'waiting restart', 'launching'].includes(p.status)) continue;   // crash-looping only; an app stopped on purpose is left alone
    if (!lists.some((l) => l.apps.some((q) => q.status === 'online' && !(l.h.user === h.user && q.name === p.name)))) continue;
    let tail = '';
    try { const fd = fs.openSync(p.err_log, 'r'); const size = fs.fstatSync(fd).size, n = Math.min(size, 16384), b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, size - n); fs.closeSync(fd); tail = b.toString('utf8'); } catch (_) { continue; }
    if (!new RegExp('EADDRINUSE[^\\n]*:' + port + '\\b').test(tail)) continue;
    const d = await run(h.user, h.pm2_home, ['delete', JSON.stringify(p.name)]);
    if (!d.ok) continue;
    await run(h.user, h.pm2_home, ['save', '--force']);
    removed.push({ user: h.user, name: p.name, restarts: p.restarts, port });
  }
  return removed;
}

module.exports = { dropPortDuplicates, pm2HomesFor, list, listSnapshot, act, health, describeCrash, dumpApps, isDaemonPid, watchdogCrons };
