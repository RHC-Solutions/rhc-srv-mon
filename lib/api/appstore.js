'use strict';
// App Store API: catalog with installed versions, and install/update/remove as background jobs.
const router = require('../http');
const { readJson, actorOf } = router;
const store = require('../appstore');
router.add('GET', '/api/appstore', { perm: 'settings.read' }, async (ctx) => Object.assign({}, await store.list(ctx.query.get('refresh') === '1'), { jobs: store.recentJobs() }));
router.add('POST', '/api/appstore/:id/:action', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const j = store.run(ctx.params.action, ctx.params.id, String(b.version || 'latest'), actorOf(ctx.req).user || 'local');
  return store.getJob(j.id);
});
router.add('GET', '/api/appstore/jobs/:id', { perm: 'settings.read' }, (ctx) => store.getJob(ctx.params.id));
