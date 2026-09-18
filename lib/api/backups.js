'use strict';
// Router-based backup endpoints (the legacy /api/backup* routes stay in server.js for now).
//   POST /api/backup/sites          → start an ad-hoc backup of EVERY site's files, in one run
//   POST /api/backup/site/:domain   → start an ad-hoc backup of one site's files (409 while another run is active)
//   GET  /api/backup/site/:domain   → this site's recent runs from the log
const router = require('../http');
const { httpError, actorOf } = router;
const backups = require('../backups');
const events = require('../events');

router.add('POST', '/api/backup/sites', { perm: 'backups.write' }, (ctx) => {
  const sites = backups.listSites();
  if (!sites.length) throw httpError(400, 'no sites to back up');
  if (backups.isRunning()) throw httpError(409, 'A backup is already running');
  events.emit('backups.site.start', { req: ctx.req, message: 'Site backup started for all ' + sites.length + ' sites' });
  backups.runAllSitesBackup(actorOf(ctx.req)).then((r) => { if (r && r.error) events.emit('backups.run', { req: ctx.req, level: 'warn', message: 'Backup of all sites not run: ' + r.error }); })
    .catch((e) => console.error('all-sites backup failed:', e.message));   // async; UI polls /api/backup
  return { started: true, sites: sites.length };
});
router.add('POST', '/api/backup/site/:domain', { perm: 'backups.write' }, (ctx) => {
  const domain = ctx.params.domain;
  if (!backups.listSites().some((s) => s.domain === domain)) throw httpError(404, 'unknown site ' + domain);
  if (backups.isRunning()) throw httpError(409, 'A backup is already running');
  events.emit('backups.site.start', { req: ctx.req, site: domain, message: 'Site backup started for ' + domain });
  backups.runSiteBackup(domain, actorOf(ctx.req)).then((r) => { if (r && r.error) events.emit('backups.run', { req: ctx.req, site: domain, level: 'warn', message: 'Site backup of ' + domain + ' not run: ' + r.error }); })
    .catch((e) => console.error('site backup failed:', e.message));   // async; UI polls /api/backup
  return { started: true, site: domain };
});
router.add('GET', '/api/backup/site/:domain', { perm: 'backups.read' }, (ctx) => {
  const st = backups.getState();
  const archive = 'sites/' + ctx.params.domain + '.tar.zst';
  const covers = (e) => e.site === ctx.params.domain || (e.items || []).includes(archive);
  return { running: st.running, runs: (st.log || []).filter(covers).slice(-10).reverse() };
});
