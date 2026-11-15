'use strict';
// App Store API: catalog with installed versions, and install/update/remove as background jobs.
const router = require('../http');
const { readJson, actorOf } = router;
const store = require('../appstore');
router.add('GET', '/api/appstore', { perm: 'settings.read' }, async (ctx) => Object.assign({}, await store.list(ctx.query.get('refresh') === '1'), { jobs: store.recentJobs() }));
// WordPress (Web apps) — registered before the generic :id/:action route
router.add('POST', '/api/appstore/wordpress/install', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const who = actorOf(ctx.req).user || 'local';
  const j = store.runTask('install', 'wordpress', 'WordPress on ' + String(b.domain || '?'), (log) => require('../wordpress').install(b, log, actorOf(ctx.req)), who);
  return store.getJob(j.id);
});
router.add('POST', '/api/appstore/wordpress/update', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req).catch(() => ({}));
  const d = b && b.domain ? String(b.domain) : null;
  const j = store.runTask('update', 'wordpress', 'WordPress' + (d ? ' on ' + d : ' (every site)'), (log) => require('../wordpress').update(d, log), actorOf(ctx.req).user || 'local');
  return store.getJob(j.id);
});
router.add('GET', '/api/appstore/wordpress/:domain/login', { perm: 'settings.write' }, (ctx) => {
  const c = require('../wordpress').credentials(ctx.params.domain);
  if (!c) throw router.httpError(404, 'no stored WordPress login for ' + ctx.params.domain);
  return c;
});
router.add('POST', '/api/appstore/:id/:action', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const j = store.run(ctx.params.action, ctx.params.id, String(b.version || 'latest'), actorOf(ctx.req).user || 'local');
  return store.getJob(j.id);
});
router.add('GET', '/api/appstore/jobs/:id', { perm: 'settings.read' }, (ctx) => store.getJob(ctx.params.id));
