'use strict';
// Router-based backup endpoints (the legacy /api/backup* routes stay in server.js for now).
//   POST /api/backup/sites          → start an ad-hoc backup of EVERY site's files, in one run
//   POST /api/backup/site/:domain   → start an ad-hoc backup of one site's files (409 while another run is active)
//   both take ?mode=diff for a differential run (site files changed since the last full backup)
//   GET  /api/backup/site/:domain   → this site's recent runs from the log
const router = require('../http');
const { httpError, actorOf } = router;
const backups = require('../backups');
const events = require('../events');

router.add('POST', '/api/backup/sites', { perm: 'backups.write' }, (ctx) => {
  const sites = backups.listSites();
  if (!sites.length) throw httpError(400, 'no sites to back up');
  if (backups.isRunning()) throw httpError(409, 'A backup is already running');
  const mode = ctx.query.get('mode') === 'diff' ? 'diff' : 'full';
  events.emit('backups.site.start', { req: ctx.req, message: (mode === 'diff' ? 'Differential site' : 'Site') + ' backup started for all ' + sites.length + ' sites' });
  backups.runAllSitesBackup(actorOf(ctx.req), mode).then((r) => { if (r && r.error) events.emit('backups.run', { req: ctx.req, level: 'warn', message: 'Backup of all sites not run: ' + r.error }); })
    .catch((e) => console.error('all-sites backup failed:', e.message));   // async; UI polls /api/backup
  return { started: true, sites: sites.length, mode };
});
router.add('POST', '/api/backup/site/:domain', { perm: 'backups.write' }, (ctx) => {
  const domain = ctx.params.domain;
  if (!backups.listSites().some((s) => s.domain === domain)) throw httpError(404, 'unknown site ' + domain);
  if (backups.isRunning()) throw httpError(409, 'A backup is already running');
  const mode = ctx.query.get('mode') === 'diff' ? 'diff' : 'full';
  const dbs = ctx.query.get('dbs') !== '0';
  events.emit('backups.site.start', { req: ctx.req, site: domain, message: (mode === 'diff' ? 'Differential site' : 'Site') + ' backup started for ' + domain + (dbs ? ' (files + databases)' : ' (files)') });
  backups.runSiteBackup(domain, actorOf(ctx.req), mode, { dbs }).then((r) => { if (r && r.error) events.emit('backups.run', { req: ctx.req, site: domain, level: 'warn', message: 'Site backup of ' + domain + ' not run: ' + r.error }); })
    .catch((e) => console.error('site backup failed:', e.message));   // async; UI polls /api/backup
  return { started: true, site: domain, mode };
});
router.add('GET', '/api/backup/site/:domain', { perm: 'backups.read' }, (ctx) => {
  const st = backups.getState();
  const archive = 'sites/' + ctx.params.domain + '.tar.zst';
  const covers = (e) => e.site === ctx.params.domain || (e.items || []).includes(archive);
  const covDb = (e) => (e.items || []).some((i) => i.startsWith('sites/' + ctx.params.domain + '-db/'));
  return Object.assign(backups.siteBackupInfo(ctx.params.domain), { runs: (st.log || []).filter((e) => covers(e) || covDb(e)).slice(-15).reverse() });
});
// archives of this site in the bucket(s) — slow (lists the bucket), so its own call
router.add('GET', '/api/backup/site/:domain/archives', { perm: 'backups.read' }, async (ctx) => {
  if (!backups.listSites().some((s) => s.domain === ctx.params.domain)) throw httpError(404, 'unknown site ' + ctx.params.domain);
  return { archives: await backups.listSiteArchives(ctx.params.domain, ctx.query.get('fresh') === '1') };
});
router.add('GET', '/api/backup/site/:domain/download', { perm: 'backups.read' }, async (ctx) => {
  const domain = ctx.params.domain, target = ctx.query.get('target') === 'own' ? 'own' : 'shared';
  const stamp = String(ctx.query.get('stamp') || ''), file = String(ctx.query.get('file') || '');
  if (!/^[A-Za-z0-9._-]+$/.test(stamp) || !/^sites\/[A-Za-z0-9._\/-]+$/.test(file) || file.includes('..')) throw httpError(400, 'bad backup reference');
  events.emit('backups.download', { req: ctx.req, site: domain, message: 'Downloaded backup ' + stamp + '/' + file + ' of ' + domain });
  await backups.downloadSiteArchive(domain, target, stamp, file, ctx.res);
});
router.add('PUT', '/api/backup/site/:domain/nightly', { perm: 'backups.write' }, async (ctx) => {
  const b = await router.readJson(ctx.req).catch(() => ({}));
  if (!backups.listSites().some((s) => s.domain === ctx.params.domain)) throw httpError(404, 'unknown site ' + ctx.params.domain);
  const r = backups.setSiteNightly(ctx.params.domain, !!b.on);
  events.emit('backups.config', { req: ctx.req, site: ctx.params.domain, message: ctx.params.domain + (b.on ? ' included in' : ' left out of') + ' the nightly backup' });
  return r;
});
