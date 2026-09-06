'use strict';
// Audit / event log in SQLite. Every action a user or scheduler takes goes through emit();
// the Events tab queries it, and (later) notification rules subscribe to it.
//
//   events.emit('updates.run', { user, ip, target: 'claude', message: 'Updated Claude Code', level: 'info', data: {...} })
//   events.emit('auth.login_fail', { req, message: '...' })      // req → user/ip filled in
const { open, settings } = require('./db');
const { clientIp, isLocalDirect } = require('./http');

const LEVELS = new Set(['info', 'warn', 'error']);
const DEFAULT_RETENTION_DAYS = 90;
const listeners = [];

function emit(type, o) {
  o = o || {};
  const row = {
    ts: new Date().toISOString(),
    level: LEVELS.has(o.level) ? o.level : 'info',
    type: String(type),
    user: o.user != null ? String(o.user) : (o.req ? (o.req.authUser || (isLocalDirect(o.req) ? 'local' : null)) : 'system'),
    ip: o.ip != null ? String(o.ip) : (o.req ? clientIp(o.req) : null),
    site: o.site != null ? String(o.site) : null,
    target: o.target != null ? String(o.target) : null,
    message: String(o.message || type),
    data: o.data === undefined ? null : safeJson(o.data),
  };
  try {
    const r = open().prepare('INSERT INTO events (ts, level, type, user, ip, site, target, message, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.ts, row.level, row.type, row.user, row.ip, row.site, row.target, row.message, row.data);
    row.id = Number(r.lastInsertRowid);
  } catch (e) { console.error('events.emit failed:', e.message); }
  for (const fn of listeners) { try { fn(row); } catch (_) {} }
  return row;
}
function safeJson(v) {
  try { const s = JSON.stringify(v); return s.length > 64 * 1024 ? JSON.stringify({ truncated: true, head: s.slice(0, 64 * 1024) }) : s; }
  catch (_) { return JSON.stringify(String(v)); }
}
function on(fn) { listeners.push(fn); }

// query({ type, level, user, site, q, before (id), limit }) → { items, nextBefore }
function query(f) {
  f = f || {};
  const where = [], args = [];
  if (f.type) { where.push('type LIKE ?'); args.push(String(f.type).replace(/\*/g, '%') + (String(f.type).includes('*') ? '' : '%')); }
  if (f.level) { where.push('level = ?'); args.push(String(f.level)); }
  if (f.user) { where.push('user = ?'); args.push(String(f.user)); }
  if (f.site) { where.push('site = ?'); args.push(String(f.site)); }
  if (f.q) { where.push('(message LIKE ? OR target LIKE ? OR data LIKE ?)'); const like = '%' + String(f.q) + '%'; args.push(like, like, like); }
  if (f.before) { where.push('id < ?'); args.push(Number(f.before)); }
  if (f.since) { where.push('ts >= ?'); args.push(String(f.since)); }
  const limit = Math.max(1, Math.min(500, Number(f.limit) || 100));
  const sql = 'SELECT * FROM events' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ?';
  const items = open().prepare(sql).all(...args, limit).map((r) => { if (r.data) { try { r.data = JSON.parse(r.data); } catch (_) {} } return r; });
  return { items, nextBefore: items.length === limit ? items[items.length - 1].id : null };
}

function types() {
  return open().prepare('SELECT type, count(*) AS n, max(ts) AS last FROM events GROUP BY type ORDER BY type').all();
}
function counts(sinceIso) {
  const r = open().prepare("SELECT level, count(*) AS n FROM events WHERE ts >= ? GROUP BY level").all(sinceIso || '');
  const out = { info: 0, warn: 0, error: 0, total: 0 };
  for (const x of r) { out[x.level] = x.n; out.total += x.n; }
  return out;
}

function prune() {
  const days = Number(settings.get('events.retentionDays', DEFAULT_RETENTION_DAYS)) || DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
  const r = open().prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
  if (r.changes) console.log('events: pruned ' + r.changes + ' rows older than ' + days + ' days');
  return r.changes;
}

module.exports = { emit, on, query, types, counts, prune, DEFAULT_RETENTION_DAYS };
