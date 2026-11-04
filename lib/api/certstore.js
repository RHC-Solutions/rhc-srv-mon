'use strict';
// Central certificate store API (Settings → Certificate store). Keys never leave the server.
const router = require('../http');
const { httpError, readJson } = router;
const events = require('../events');
const certstore = require('../sites/certstore');
const store = require('../sites/store');

const emit = (type, ctx, message, extra) => events.emit(type, Object.assign({ req: ctx.req, target: 'certstore', message }, extra || {}));
const one = (id) => { const r = certstore.get(id); if (!r) throw httpError(404, 'unknown store certificate'); return r; };

router.add('GET', '/api/certstore', { perm: 'sites.read' }, () => ({ certificates: certstore.list() }));
router.add('GET', '/api/certstore/match', { perm: 'sites.read' }, (ctx) => {
  const r = certstore.match(String(ctx.query.get('domain') || '').trim().toLowerCase().replace(/^www\./, ''));
  return { match: r ? { id: r.id, name: r.name, type: r.type, sans: r.sans, expires_at: r.expires_at } : null };
});
router.add('POST', '/api/certstore', { perm: 'sites.write' }, async (ctx) => {
  const b = await readJson(ctx.req, 1024 * 1024);
  let r;
  try { r = certstore.add({ certificate: b.certificate, key: b.key, chain: b.chain, name: b.name, source: 'upload' }); }
  catch (e) { throw httpError(e.status || 400, e.message); }
  if (r.created) emit('certstore.add', ctx, 'Certificate added to the central store (' + r.row.name + ', expires ' + String(r.row.expires_at).slice(0, 10) + ')', { data: { id: r.row.id, sans: r.row.sans } });
  return { ok: true, created: r.created, id: r.row.id, certificate: certstore.list().find((c) => c.id === r.row.id) };
});
router.add('POST', '/api/certstore/import', { perm: 'sites.write' }, (ctx) => {
  const r = certstore.seed(true);
  emit('certstore.import', ctx, 'Central store: imported ' + r.added + ' new certificate(s) from sites and ' + '/etc/nginx/ssl-certificates', { data: r });
  return Object.assign({ ok: true }, r);
});
router.add('PATCH', '/api/certstore/:id', { perm: 'sites.write' }, async (ctx) => {
  const row = one(ctx.params.id);
  const b = await readJson(ctx.req);
  certstore.rename(row.id, b.name);
  return { ok: true };
});
router.add('DELETE', '/api/certstore/:id', { perm: 'sites.write' }, (ctx) => {
  const row = one(ctx.params.id);
  certstore.remove(row.id);   // sites keep their own copy; only future sites stop getting it
  emit('certstore.delete', ctx, 'Certificate removed from the central store (' + row.name + ')', { level: 'warn' });
  return { ok: true };
});
// Serve this cert on the given sites (default: every covered site not already serving it).
router.add('POST', '/api/certstore/:id/deploy', { perm: 'sites.write' }, async (ctx) => {
  const row = one(ctx.params.id);
  const b = await readJson(ctx.req);
  const listed = certstore.list().find((c) => c.id === row.id);
  const targets = Array.isArray(b.domains) ? b.domains.map(String) : listed.matches.filter((d) => !listed.used_by.includes(d));
  const results = [];
  for (const d of targets) {
    const site = store.get(d);
    if (!site) { results.push({ domain: d, ok: false, error: 'unknown site' }); continue; }
    if (!certstore.namesFor(d).every((n) => certstore.covers(row.sans, n))) { results.push({ domain: d, ok: false, error: 'not covered by this certificate' }); continue; }
    try {
      await certstore.applyToSite(site, row);
      store.claim(site.id);
      events.emit('sites.certificate.activate', { req: ctx.req, site: d, message: 'Certificate from the central store activated (' + row.name + ', expires ' + String(row.expires_at).slice(0, 10) + ')', data: { store_id: row.id } });
      results.push({ domain: d, ok: true });
    } catch (e) { results.push({ domain: d, ok: false, error: e.message }); }
  }
  return { ok: results.every((r) => r.ok), results };
});
