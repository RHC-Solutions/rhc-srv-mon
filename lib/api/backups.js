'use strict';
// Router-based backup endpoints (the legacy /api/backup* routes stay in server.js for now).
//   POST /api/backup/site/:domain   → start an ad-hoc backup of one site's files (409 while another run is active)
//   GET  /api/backup/site/:domain   → this site's recent runs from the log
const router = require('../http');
const { httpError, actorOf } = router;
const backups = require('../backups');
const events = require('../events');

router.add('POST', '/api/backup/site/:domain', { perm: 'backups.write' }, (ctx) => {
  const domain = ctx.params.domain;
  if (!backups.listSites().some((s) => s.domain === domain)) throw httpError(404, 'unknown site ' + domain);
  if (backups.isRunning()) throw httpError(409, 'A backup is already running');
  events.emit('backups.site.start', { req: ctx.req, site: domain, message: 'Site backup started for ' + domain });
  backups.runSiteBackup(domain, actorOf(ctx.req)).catch((e) => console.error('site backup failed:', e.message));   // async; UI polls /api/backup
  return { started: true, site: domain };
});
router.add('GET', '/api/backup/site/:domain', { perm: 'backups.read' }, (ctx) => {
  const st = backups.getState();
  return { running: st.running, runs: (st.log || []).filter((e) => e.site === ctx.params.domain).slice(-10).reverse() };
});
