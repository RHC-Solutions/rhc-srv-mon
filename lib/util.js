'use strict';
// Helpers shared by several feature modules. Anything used from two or more lib/ files
// belongs here rather than in whichever module happened to define it first.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const PG_SOCKET = '/var/run/postgresql';   // psql -h <dir>: unix socket, peer auth as root → postgres

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

// Promise execFile that never rejects: { err, stdout, stderr }.
function execP(cmd, args, opts) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ maxBuffer: 16 * 1024 * 1024 }, opts), (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Like execP but feeds `input` on stdin (chpasswd, openssl passwd -stdin, psql …).
function execIn(cmd, args, input, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let stdout = '', stderr = '', done = false;
    const finish = (err, code) => { if (done) return; done = true; resolve({ err: err || (code ? Object.assign(new Error(cmd + ' exited ' + code), { code }) : null), code, stdout, stderr }); };
    let child;
    try { child = spawn(cmd, args, { env: opts.env, cwd: opts.cwd, uid: opts.uid, gid: opts.gid }); } catch (e) { return finish(e, -1); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(new Error(cmd + ' timed out'), -1); }, opts.timeout || 60_000);
    child.stdout.on('data', (d) => { if (stdout.length < 16 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 4 * 1024 * 1024) stderr += d; });
    child.on('error', (e) => { clearTimeout(t); finish(e, -1); });
    child.on('close', (code) => { clearTimeout(t); finish(null, code); });
    child.stdin.on('error', () => {});
    child.stdin.end(input == null ? '' : String(input));
  });
}

function dirSize(p) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const fp = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(fp);
      else { try { total += fs.statSync(fp).size; } catch (_) {} }
    }
  } catch (_) {}
  return total;
}

function homeUsers() {
  try { return fs.readdirSync('/home').filter((u) => USER_NAME_RE.test(u) && u !== 'clp'); } catch (_) { return []; }
}
function existingDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

// mkdir and writeFile take a mode, but the kernel masks it with the process umask — 0022 under pm2 —
// so any group-writable mode silently loses its write bit: a docroot meant to be 0770 lands at 0750,
// and the site's own SSH users can read it but never write to it. chmod is not masked, so anywhere
// the group bits actually matter, go through these rather than trusting the mode argument alone.
function mkdirMode(dir, mode) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch (_) {}
  return dir;
}
function writeFileMode(file, data, mode) {
  fs.writeFileSync(file, data, { mode });
  try { fs.chmodSync(file, mode); } catch (_) {}
  return file;
}

// Every TCP port with a listener right now, from the kernel's own tables. The panel's SQLite only
// knows about sites *it* created — on a box that also runs apps started by hand (or a CloudPanel
// site it never imported) a port can be busy without appearing there, and handing that port to a
// new site produces a vhost proxying to something else, or an app that cannot bind at all.
// Bound to a single interface or to the wildcard, the port is spoken for either way, so the
// address half is ignored. Reads /proc directly: no subprocess, and it cannot fail open silently.
function listeningPorts() {
  const ports = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt;
    try { txt = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const line of txt.split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 4 || c[3] !== '0A') continue;          // 0A = TCP_LISTEN
      const port = parseInt(String(c[1]).split(':')[1], 16);
      if (port > 0) ports.add(port);
    }
  }
  return ports;
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

// JSON state files: read with a default, write atomically (tmp + rename) with an optional mode.
function loadJson(file, def) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' ? d : def;
  } catch (_) { return def; }
}
function saveJsonAtomic(file, obj, mode) {
  const opts = mode ? { mode } : undefined;
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2), opts);
  fs.renameSync(file + '.tmp', file);
  if (mode) fs.chmodSync(file, mode);
}

// "Once a day at HH:MM" ticker (call every minute). getCfg() → { enabled, hour, minute } or null.
// Fires at most once per calendar day, within a ±2 minute window of the configured time.
function dailyAt(getCfg, fn, state) {
  state = state || {};
  return () => {
    const cfg = getCfg();
    if (!cfg || !cfg.enabled) return;
    const now = new Date();
    const key = now.toISOString().slice(0, 10);
    if (state.lastKey === key) return;
    const target = Number(cfg.hour) * 60 + Number(cfg.minute);
    const cur = now.getHours() * 60 + now.getMinutes();
    if (Math.abs(cur - target) > 2) return;
    state.lastKey = key;
    Promise.resolve().then(fn).catch((e) => console.error('scheduled job failed:', e.message));
  };
}

module.exports = { USER_NAME_RE, PG_SOCKET, fmtBytes, execP, execIn, dirSize, homeUsers, existingDir, listeningPorts, mkdirMode, writeFileMode, uidToName, loadJson, saveJsonAtomic, dailyAt };
