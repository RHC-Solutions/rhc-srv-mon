'use strict';
// Host-wide SQLite inventory for the Databases tab: every SQLite file under the places apps keep
// data (/opt, /srv, /var/lib, /var/www, /home), not only the per-site ones the panel created.
//
// A file counts when its first 16 bytes are the SQLite magic. Files named like a database that
// are NOT plain SQLite but live in an app folder are listed as "encrypted" (SQLCipher and the
// like) — the panel cannot look inside, but you still want to know they exist and how big they
// are. Files tracked by git (schema templates shipped inside an app's checkout) are skipped, and
// so are caches and logs. "Used by" comes from /proc/*/fd: the systemd unit (or pm2 app) holding
// the file open right now.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOTS = ['/opt', '/srv', '/var/lib', '/var/www', '/home', '/root'];
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.npm', '.local', '.claude', 'plocate', 'dpkg', 'apt', 'systemd', 'docker', 'containerd', 'snapd']);
const NAME_RE = /\.(db|sqlite|sqlite3|db3)$/i;
const MAGIC = Buffer.from('SQLite format 3\0');
const MAX_DEPTH = 6, MAX_FILES = 300, TTL = 300_000;

let cache = null, cacheAt = 0;

function walk(dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (out.length >= MAX_FILES) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.claude')) walk(p, depth + 1, out); }
    else if (e.isFile() && NAME_RE.test(e.name)) out.push(p);
  }
}

function head(p) { try { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b; } catch (_) { return null; } }

function gitTracked(p) {
  try { execFileSync('git', ['-C', path.dirname(p), 'ls-files', '--error-unmatch', path.basename(p)], { stdio: 'ignore', timeout: 3000 }); return true; } catch (_) { return false; }
}

// file → owning unit/pm2 app, from every process's open fds
function openers() {
  const map = new Map(); let pm2 = null;
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds; try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch (_) { continue; }
    let who = null;
    for (const fd of fds) {
      let t; try { t = fs.readlinkSync('/proc/' + pid + '/fd/' + fd); } catch (_) { continue; }
      if (!NAME_RE.test(t)) continue;
      if (who === null) {
        let unit = null; try { unit = (/\/([^/\n]+)\.service/.exec(fs.readFileSync('/proc/' + pid + '/cgroup', 'utf8')) || [])[1] || null; } catch (_) {}
        if (unit && /^pm2-/.test(unit)) {
          try { pm2 = pm2 || JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 5000 }).replace(/^[^[]*/, '')); } catch (_) { pm2 = []; }
          const app = pm2.find((a) => String(a.pid) === pid); if (app) unit = app.name;
        }
        who = unit || (() => { try { return fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim(); } catch (_) { return '?'; } })();
      }
      if (!map.has(t)) map.set(t, new Set());
      map.get(t).add(who);
    }
  }
  return map;
}

function inspect(p) {
  const r = { tables: null, journal: null };
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    try {
      r.tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
      r.journal = db.prepare('PRAGMA journal_mode').get().journal_mode;
    } finally { db.close(); }
  } catch (e) { r.error = String(e.message || e).split('\n')[0]; }
  return r;
}

function scan() {
  const files = [];
  for (const root of ROOTS) walk(root, 0, files);
  const open = openers();
  const out = [];
  for (const p of files) {
    let st; try { st = fs.statSync(p); } catch (_) { continue; }
    if (st.size === 0) continue;
    const h = head(p);
    const plain = h && h.equals(MAGIC);
    const appDir = /^\/(opt|srv|home|var\/www|root)\//.test(p);
    if (!plain && !(appDir && st.size % 512 === 0)) continue;   // not SQLite (gdbm, binary caches, …)
    if (gitTracked(p)) continue;                                 // shipped template, not live data
    let wal = 0; try { wal = fs.statSync(p + '-wal').size; } catch (_) {}
    const row = { path: p, size: st.size, wal, modified: st.mtime.toISOString(), encrypted: !plain, usedBy: [...(open.get(p) || [])] };
    if (plain) Object.assign(row, inspect(p));
    out.push(row);
  }
  return out.sort((a, b) => (b.size + b.wal) - (a.size + a.wal));
}

function get() {
  if (!cache || Date.now() - cacheAt > TTL) { try { cache = scan(); } catch (e) { cache = []; console.error('sqlite scan failed:', e.message); } cacheAt = Date.now(); }
  return cache;
}

module.exports = { get, scan };
