'use strict';
// Transfer API (left menu → Transfer). Admin routes (browser session) manage this server's identity,
// transfer codes and moves; peer routes are called by the server on the other end of a transfer and
// authenticate with the pair-key HMAC signature only. Pairings are temporary.
const router = require('../http');
const { httpError, readJson, actorOf } = router;
const events = require('../events');
const cluster = require('../cluster');
const move = require('../cluster-move');

// raw body (signatures cover the exact bytes)
function rawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(httpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const who = (ctx) => actorOf(ctx.req).user || 'local';

// ---- admin
router.add('GET', '/api/cluster', { perm: 'settings.read' }, async () => ({ self: cluster.selfView(), version: await cluster.version(), peers: cluster.peers(), moves: move.list(), incoming: move.incoming(),
  localSites: require('../sites/store').list().map((s) => s.domain).filter((d) => !require('../db').settings.get('site.movedTo:' + d, null)) }));
router.add('PUT', '/api/cluster/self', { perm: 'settings.write' }, async (ctx) => {
  const r = cluster.setSelf(await readJson(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'cluster', message: 'Cluster identity saved (' + r.name + ', ' + r.url + ')' });
  return r;
});
router.add('POST', '/api/cluster/join-code', { perm: 'settings.write' }, (ctx) => {
  const r = cluster.createJoinCode();
  events.emit('cluster.joincode', { req: ctx.req, target: 'cluster', level: 'warn', message: 'Transfer code created (valid 1 h, one use) — this server can now receive sites'});
  return r;
});
router.add('POST', '/api/cluster/join-with', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const r = await cluster.joinWith(b.code);
  events.emit('cluster.join', { req: ctx.req, target: 'cluster', level: 'warn', message: 'Connected to ' + r.joined + ' with a transfer code (temporary)' });
  return r;
});
router.add('POST', '/api/cluster/peers/:id/refresh', { perm: 'settings.read' }, (ctx) => cluster.refreshPeer(ctx.params.id));
router.add('DELETE', '/api/cluster/peers/:id', { perm: 'settings.write' }, async (ctx) => {
  const p = cluster.peer(ctx.params.id); await cluster.forget(p.id, true);
  events.emit('cluster.leave', { req: ctx.req, target: 'cluster', level: 'warn', message: 'Closed the transfer connection with ' + p.name + ' (on both sides)' });
  return { ok: true };
});
router.add('POST', '/api/cluster/precheck', { perm: 'settings.read' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const domains = (Array.isArray(b.domains) ? b.domains : []).map(String).slice(0, 50);
  if (!domains.length) throw httpError(400, 'pick sites');
  return move.precheck(domains, String(b.peer || ''));
});
router.add('POST', '/api/cluster/move', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const domains = Array.isArray(b.domains) ? b.domains.map(String) : [String(b.domain || '')];
  if (!domains.length || domains.some((d) => !require('../sites/store').get(d))) throw httpError(400, 'pick existing sites');
  const batch = domains.length > 1 ? { id: require('crypto').randomBytes(8).toString('hex'), domains } : null;
  const out = domains.map((d) => move.startMove(d, String(b.peer || ''), who(ctx), batch));
  events.emit('cluster.move', { req: ctx.req, level: 'warn', message: 'Transfer of ' + domains.join(', ') + ' to ' + out[0].peer.name + ' queued' });
  return out.map((j) => move.job(j.id));
});
router.add('POST', '/api/cluster/endpoint', { perm: 'settings.write' }, async (ctx) => {
  const steps = []; const r = await require('../cluster-endpoint').create((a, d) => steps.push(d ? a + ' — ' + d : a));
  events.emit('cluster.endpoint', { req: ctx.req, target: r.host, level: 'warn', message: 'Transfer address created: ' + r.url + ' (signed transfer API only)', data: { steps } });
  return Object.assign(r, { steps });
});
// Incoming transfer requests (target side): accept / reject
router.add('POST', '/api/cluster/requests/:id/:decision', { perm: 'settings.write' }, (ctx) => {
  if (!['accept', 'reject'].includes(ctx.params.decision)) throw httpError(400, 'accept or reject');
  const r = move.decide(ctx.params.id, ctx.params.decision === 'accept', who(ctx));
  events.emit('cluster.request', { req: ctx.req, site: r.domain, level: 'warn', message: (r.state === 'accepted' ? 'Accepted' : 'Rejected') + ' the transfer of ' + r.domain + ' from ' + r.from });
  return r;
});
router.add('POST', '/api/cluster/request-batches/:id/:decision', { perm: 'settings.write' }, (ctx) => {
  if (!['accept', 'reject'].includes(ctx.params.decision)) throw httpError(400, 'accept or reject');
  const r = move.decideBatch(ctx.params.id, ctx.params.decision === 'accept', who(ctx));
  events.emit('cluster.request', { req: ctx.req, level: 'warn', message: (r.state === 'accepted' ? 'Accepted' : 'Rejected') + ' the transfer of ' + r.domains.join(', ') + ' from ' + r.from });
  return r;
});
router.add('GET', '/api/cluster/moves/:id', { perm: 'settings.read' }, (ctx) => move.job(ctx.params.id));

// ---- join (signed with the one-time key of a join code)
router.add('POST', '/api/cluster/join', {}, async (ctx) => {
  const body = await rawBody(ctx.req, 64 * 1024);
  const r = await cluster.acceptJoin(ctx.req, '/api/cluster/join', body);
  events.emit('cluster.join', { req: ctx.req, target: 'cluster', level: 'warn', message: 'A server connected with this server\'s transfer code (temporary) to send sites' });
  return r;
});

// ---- peer routes (HMAC-signed by a member)
async function peer(ctx, limit) { const body = await rawBody(ctx.req, limit || 1024 * 1024); const p = cluster.verify(ctx.req, ctx.url, body); return { p, body }; }
const json = (b) => { try { return JSON.parse(b.toString() || '{}'); } catch (_) { throw httpError(400, 'bad JSON'); } };
router.add('GET', '/api/cluster/peer/info', {}, async (ctx) => { await peer(ctx); return cluster.info(); });
router.add('POST', '/api/cluster/peer/forget', {}, async (ctx) => { const { p } = await peer(ctx); await cluster.forget(p.id, false); return { ok: true }; });
router.add('POST', '/api/cluster/peer/preflight', {}, async (ctx) => { const { p, body } = await peer(ctx); return move.preflightFrom(json(body), p); });
router.add('POST', '/api/cluster/peer/upload/:id/:n', {}, async (ctx) => { const { body } = await peer(ctx, 48 * 1024 * 1024); return move.receiveChunk(ctx.params.id, ctx.params.n, body); });
router.add('POST', '/api/cluster/peer/import/:id', {}, async (ctx) => {
  const { p, body } = await peer(ctx);
  const r = move.startImport(ctx.params.id, json(body), p);
  events.emit('cluster.import', { target: 'cluster', user: 'cluster:' + p.name, level: 'warn', message: 'Importing a site from ' + p.name + ' (transfer ' + ctx.params.id + ')' });
  return r;
});
router.add('GET', '/api/cluster/peer/job/:id', {}, async (ctx) => { await peer(ctx); return move.job(ctx.params.id); });
router.add('POST', '/api/cluster/peer/cutover/:id', {}, async (ctx) => {
  const { p } = await peer(ctx);
  const r = await move.cutover(ctx.params.id);
  events.emit('cluster.import', { target: 'cluster', user: 'cluster:' + p.name, level: 'warn', message: 'Took over the tunnel of a site moved from ' + p.name });
  return r;
});
