'use strict';
// Who is listening on a TCP port: pid, unix user, command line, working directory, start time, and
// what started it (another user's pm2, a terminal / VS Code session, systemd…). Used when a site's
// pm2 apps are all stopped yet its port answers (self-repair, Processes tab) — so the alert names the
// process instead of restarting into a port that is taken, over and over.
const fs = require('fs');
const { execP } = require('./util');

const userOf = (uid) => {
  try { const l = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => x.split(':')[2] === String(uid)); return l ? l.split(':')[0] : String(uid); } catch (_) { return String(uid); }
};
const cmdline = (pid) => { try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' '); } catch (_) { return ''; } };
const ppidOf = (pid) => { try { return Number((/^PPid:\s*(\d+)/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')) || [])[1]) || 0; } catch (_) { return 0; } };
const uidOf = (pid) => { try { return Number((/^Uid:\s*(\d+)/m.exec(fs.readFileSync('/proc/' + pid + '/status', 'utf8')) || [])[1]); } catch (_) { return null; } };

// What started it: walk up the parents until something recognisable.
function origin(pid) {
  for (let p = ppidOf(pid), i = 0; p > 1 && i < 20; p = ppidOf(p), i++) {
    const c = cmdline(p);
    if (/PM2 v[\d.]+: God Daemon|God Daemon/i.test(c)) return 'pm2 of user ' + userOf(uidOf(p)) + ' (a different pm2 than the site\'s apps)';
    if (/vscode-server|code-server|cursor-server/.test(c)) return 'a VS Code session of ' + userOf(uidOf(p));
    if (/\bsshd: /.test(c)) return 'an SSH session of ' + userOf(uidOf(p));
    if (/\b(tmux|screen)\b/.test(c)) return 'a ' + RegExp.$1 + ' session of ' + userOf(uidOf(p));
    if (/^(-?bash|-?sh|-?zsh|fish)\b/.test(c)) continue;
  }
  return ppidOf(pid) === 1 ? 'nothing any more (orphaned — its parent exited; systemd/init adopted it)' : 'unknown';
}

async function owner(port) {
  port = Number(port);
  if (!(port > 0 && port < 65536)) return null;
  const r = await execP('ss', ['-ltnpH', 'sport = :' + port], { timeout: 10_000 });
  const pids = [...new Set([...String(r.stdout || '').matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
  if (!pids.length) return { port, pids: [] };
  const pid = pids[0];
  let cwd = null; try { cwd = fs.readlinkSync('/proc/' + pid + '/cwd'); } catch (_) {}
  const st = await execP('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 });
  const started = String(st.stdout || '').trim() || null;
  return { port, pid, pids, user: userOf(uidOf(pid)), command: cmdline(pid).slice(0, 300), cwd, started, origin: origin(pid) };
}
function describe(o) {
  if (!o || !o.pid) return 'nothing found listening on the port';
  return 'pid ' + o.pid + ' (user ' + o.user + '): ' + (o.command || '?') + (o.cwd ? ' — in ' + o.cwd : '') + (o.started ? ' — since ' + o.started : '') + ' — started by ' + o.origin;
}

module.exports = { owner, describe };
