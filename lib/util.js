'use strict';
// Helpers shared by several feature modules. Anything used from two or more lib/ files
// belongs here rather than in whichever module happened to define it first.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

module.exports = { USER_NAME_RE, PG_SOCKET, fmtBytes, execP, dirSize, homeUsers, existingDir, uidToName, loadJson, saveJsonAtomic, dailyAt };
