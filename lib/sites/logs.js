'use strict';
// Per-site logs: tail the last N lines (reading only the tail of the file), optional substring filter.
// Kinds: nginx-access, nginx-error, php-error, varnish-purge, pm2-out/<name>, pm2-err/<name>.
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('../config');
const history = require('../history');
const { execP } = require('../util');

const logrotateTpl = () => fs.readFileSync(path.join(APP_ROOT, 'resources', 'logrotate.tpl'), 'utf8');

function kinds(site) {
  const home = '/home/' + site.user;
  const out = [
    { key: 'nginx-access', label: 'nginx access', file: home + '/logs/nginx/access.log' },
    { key: 'nginx-error', label: 'nginx error', file: home + '/logs/nginx/error.log' },
  ];
  if (site.type === 'php') out.push({ key: 'php-error', label: 'PHP error', file: home + '/logs/php/error.log' });
  if (site.varnish_cache) out.push({ key: 'varnish-purge', label: 'Varnish purge', file: home + '/logs/varnish-cache/purge.log' });
  // pm2 logs of processes that belong to this site (same matching the Sites list uses)
  const latest = history.getLatest() || [];
  for (const g of latest) {
    let pm2Home = g.pm2_home || '';
    let mine = g.user === site.user || pm2Home.startsWith(home + '/');
    if (!mine) { try { mine = fs.realpathSync(path.dirname(pm2Home)) === fs.realpathSync(home); } catch (_) {} }
    if (!mine) { try { mine = fs.realpathSync(path.join(path.dirname(pm2Home), 'htdocs')) === fs.realpathSync(home + '/htdocs'); } catch (_) {} }
    if (!mine) continue;
    for (const p of g.processes || []) {
      if (p.out_log) out.push({ key: 'pm2-out/' + p.name, label: 'pm2 ' + p.name + ' · out', file: p.out_log });
      if (p.err_log) out.push({ key: 'pm2-err/' + p.name, label: 'pm2 ' + p.name + ' · err', file: p.err_log });
    }
  }
  for (const k of out) { try { const st = fs.statSync(k.file); k.size = st.size; k.mtime = st.mtime.toISOString(); } catch (_) { k.size = null; } }
  return out;
}

// Last `lines` lines of `file` (max 64 MB read from the end), optional case-insensitive filter.
function tail(file, lines, filter) {
  lines = Math.max(1, Math.min(5000, Number(lines) || 200));
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return { lines: [], error: e.code === 'ENOENT' ? 'no such log file' : e.message, size: 0 }; }
  try {
    const size = fs.fstatSync(fd).size;
    const want = filter ? 8 * 1024 * 1024 : Math.min(size, lines * 512 + 65536);
    const start = Math.max(0, size - Math.min(size, want, 64 * 1024 * 1024));
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let all = buf.toString('utf8').split('\n');
    if (start > 0) all.shift();                 // partial first line
    if (all.length && all[all.length - 1] === '') all.pop();
    if (filter) { const f = String(filter).toLowerCase(); all = all.filter((l) => l.toLowerCase().includes(f)); }
    return { lines: all.slice(-lines), size, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

function read(site, kind, lines, filter) {
  const k = kinds(site).find((x) => x.key === kind);
  if (!k) throw Object.assign(new Error('unknown log'), { status: 404 });
  return Object.assign({ kind: k.key, label: k.label, file: k.file }, tail(k.file, lines, filter));
}

// /etc/logrotate.d/<siteUser> from CLP's template.
const LOGROTATE_DIR = '/etc/logrotate.d';
function writeLogrotate(user) {
  fs.writeFileSync(path.join(LOGROTATE_DIR, user), logrotateTpl().replace(/\{\{user\}\}/g, user).replace(/\{\{group\}\}/g, user).replace(/\n?$/, '\n'), { mode: 0o644 });
}
function removeLogrotate(user) { try { fs.unlinkSync(path.join(LOGROTATE_DIR, user)); return true; } catch (_) { return false; } }

module.exports = { kinds, tail, read, writeLogrotate, removeLogrotate };
