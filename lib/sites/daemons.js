'use strict';
// Keeps every pm2 God Daemon on the node binary that is actually on disk.
//
// An apt upgrade of nodejs replaces /usr/bin/node under daemons that have been up for weeks. Their
// apps pick the new interpreter up on their next restart, but the daemon itself only does when it is
// restarted — so after every upgrade every site showed "pm2 daemon on a replaced binary" until
// someone ran `pm2 update` by hand as each of a dozen-odd users (2026-10-22: all 18 daemons stale).
// This finds those daemons and restarts them, one user at a time, checking that each user's apps
// come back online before going on to the next.
//
// How a daemon is restarted depends on who owns it:
//   * a pm2-<user> unit exists → save, kill, and let systemd start the new daemon. That also hands an
//     unowned daemon (unit inactive/failed, daemon spawned from a shell) back to systemd, which is the
//     only state in which it survives logout and reboot reliably (PM2 v7 writes pm2.pid only then);
//   * no unit → `pm2 update`, which saves, kills and resurrects under the user's own login PATH.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const events = require('../events');
const notify = require('../notify');

const USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
const SETTLE_MS = 3 * 60_000;      // a binary this freshly replaced may still be mid-apt-run
const RETRY_MS = 6 * 3600_000;     // a user whose refresh failed is not retried in a loop
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

const lastFail = new Map();        // user -> ms of the last failed attempt
let running = false;

function run(argv, timeout) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: timeout || 120_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, out: strip((stdout || '') + (stderr || '')).trim() }));
  });
}
const asUser = (user, script, timeout) =>
  run(['sudo', '-n', '-H', '-u', user, 'bash', '-lc', 'cd ~ && export PM2_HOME="$HOME/.pm2" && ' + script], timeout);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daemonOf(user) {
  let pid = null;
  try { pid = parseInt(fs.readFileSync('/home/' + user + '/.pm2/pm2.pid', 'utf8').trim(), 10) || null; } catch (_) { return null; }
  let exe;
  try { exe = fs.readlinkSync('/proc/' + pid + '/exe'); } catch (_) { return null; }
  const stale = / \(deleted\)$/.test(exe);
  return { user, pid, stale, path: exe.replace(/ \(deleted\)$/, '') };
}

// Every live daemon still executing a binary that has been replaced on disk.
function staleDaemons() {
  let homes = [];
  try { homes = fs.readdirSync('/home'); } catch (_) {}
  return homes.filter((u) => USER_RE.test(u)).map(daemonOf).filter((d) => d && d.stale);
}

async function onlineApps(user) {
  const r = await asUser(user, 'pm2 jlist 2>/dev/null', 30_000);
  const i = r.out.indexOf('[');
  if (i < 0) return null;
  try { return JSON.parse(r.out.slice(i)).filter((p) => p.pm2_env && p.pm2_env.status === 'online').map((p) => p.name); } catch (_) { return null; }
}

// Restart one user's daemon on the current binary and confirm nothing that was online is not now.
async function refreshUser(user) {
  if (!USER_RE.test(user)) throw new Error('invalid unix user');
  const before = await onlineApps(user);
  if (before === null) return { user, ok: false, how: 'jlist', detail: 'could not list the apps of ' + user };
  const unit = 'pm2-' + user;
  let how, step;
  // A masked unit is a symlink to /dev/null: someone took this user off systemd on purpose.
  let unitFile = null; try { unitFile = fs.realpathSync('/etc/systemd/system/' + unit + '.service'); } catch (_) {}
  if (unitFile && unitFile !== '/dev/null') {
    how = 'systemd';
    step = await asUser(user, 'pm2 save --force && pm2 kill', 120_000);
    await run(['systemctl', 'reset-failed', unit], 30_000);
    const st = await run(['systemctl', 'restart', unit], 180_000);
    step = { ok: step.ok && st.ok, out: (step.out + '\n' + st.out).trim() };
    // A unit that will not start must not leave the site down: bring the apps back the plain way.
    if (!st.ok) { how = 'systemd failed, resurrected'; await asUser(user, 'pm2 resurrect', 120_000); }
  } else {
    how = 'pm2 update';
    step = await asUser(user, 'pm2 update', 180_000);
  }
  await sleep(8000);
  const after = (await onlineApps(user)) || [];
  const missing = before.filter((n) => !after.includes(n));
  const d = daemonOf(user);
  const ok = !missing.length && !!d && !d.stale;
  return { user, ok, how, before: before.length, after: after.length, missing,
    detail: ok ? '' : (missing.length ? 'not online again: ' + missing.join(', ') : (!d ? 'no daemon running afterwards' : 'daemon still on a replaced binary')) + (step.ok ? '' : ' — ' + step.out.split('\n').slice(-2).join(' ').slice(0, 300)) };
}

// Refresh every stale daemon. `opts.force` ignores the settle and retry windows (manual run).
async function refreshStale(opts) {
  opts = opts || {};
  if (running) return { skipped: 'already running', results: [] };
  running = true;
  const results = [];
  try {
    const now = Date.now();
    for (const d of staleDaemons()) {
      if (!opts.force) {
        let mtime = 0; try { mtime = fs.statSync(d.path).mtimeMs; } catch (_) { continue; }   // binary gone, not replaced
        if (now - mtime < SETTLE_MS) continue;
        if (now - (lastFail.get(d.user) || 0) < RETRY_MS) continue;
      }
      let r;
      try { r = await refreshUser(d.user); } catch (e) { r = { user: d.user, ok: false, how: '?', detail: e.message }; }
      if (r.ok) lastFail.delete(d.user); else lastFail.set(d.user, Date.now());
      results.push(r);
      events.emit('site.pm2.daemon_refresh', { user: (opts.by && opts.by.user) || 'system', ip: opts.by && opts.by.ip, target: d.user, level: r.ok ? 'info' : 'error',
        message: (r.ok ? 'Restarted' : 'Failed to restart') + ' the pm2 daemon of ' + d.user + ' on ' + path.basename(d.path) + ' (' + r.how + ')' + (r.detail ? ': ' + r.detail : ''), data: r });
    }
  } finally { running = false; }
  if (results.length) {
    const esc = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
    const bad = results.filter((r) => !r.ok);
    const lines = ['🔄 *pm2 daemons moved to the new node binary* — ' + (results.length - bad.length) + '/' + results.length + ' ok'];
    for (const r of results) lines.push((r.ok ? '✅ ' : '❌ ') + esc(r.user) + ' · ' + r.after + '/' + r.before + ' apps online' + (r.ok ? '' : ' — ' + esc(r.detail)));
    notify.send(lines.join('\n'), 'site').catch(() => {});
  }
  return { results };
}

module.exports = { staleDaemons, refreshUser, refreshStale };
