'use strict';
// GET /api/events?type=&level=&user=&site=&q=&before=&limit=   → { items, nextBefore }
// GET /api/events/types                                          → [{ type, n, last }]
// GET /api/events/summary                                        → { last24h: {info,warn,error,total}, retentionDays }
// PUT /api/events/settings { retentionDays }
const router = require('../http');
const events = require('../events');
const { settings } = require('../db');

router.add('GET', '/api/events/types', { perm: 'events.read' }, () => events.types());
router.add('GET', '/api/events/summary', { perm: 'events.read' }, () => ({
  last24h: events.counts(new Date(Date.now() - 86400_000).toISOString()),
  retentionDays: settings.get('events.retentionDays', events.DEFAULT_RETENTION_DAYS),
}));
router.add('PUT', '/api/events/settings', { perm: 'events.write' }, async (ctx) => {
  const body = await router.readJson(ctx.req);
  const days = Math.max(1, Math.min(3650, parseInt(body.retentionDays, 10) || events.DEFAULT_RETENTION_DAYS));
  settings.set('events.retentionDays', days);
  events.emit('settings.save', { req: ctx.req, target: 'events', message: 'Event retention set to ' + days + ' days' });
  return { ok: true, retentionDays: days };
});
router.add('GET', '/api/events', { perm: 'events.read' }, (ctx) => {
  const q = ctx.query;
  return events.query({ type: q.get('type'), level: q.get('level'), user: q.get('user'), site: q.get('site'), q: q.get('q'), before: q.get('before'), since: q.get('since'), limit: q.get('limit') });
});
