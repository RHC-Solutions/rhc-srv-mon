'use strict';
// Vault API. Lists never carry a secret; every reveal (entry or system secret) is an event.
const router = require('../http');
const { httpError, readJson, actorOf } = router;
const events = require('../events');
const vault = require('../vault');

const who = (ctx) => actorOf(ctx.req).user || 'local';
const ev = (ctx, type, message, level) => events.emit(type, { req: ctx.req, target: 'vault', level: level || 'info', message });

router.add('GET', '/api/vault', { perm: 'settings.read' }, async () => ({ kinds: vault.KINDS, entries: vault.list(), system: await vault.systemList() }));
router.add('POST', '/api/vault', { perm: 'settings.write' }, async (ctx) => {
  const e = vault.create(await readJson(ctx.req), who(ctx));
  ev(ctx, 'vault.create', 'Vault entry added: ' + e.name);
  return e;
});
router.add('PUT', '/api/vault/:id', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const e = vault.update(ctx.params.id, b, who(ctx));
  ev(ctx, 'vault.update', 'Vault entry changed: ' + e.name + (b.secret ? ' (new secret)' : ''));
  return e;
});
router.add('DELETE', '/api/vault/:id', { perm: 'settings.write' }, (ctx) => {
  const e = vault.remove(ctx.params.id);
  ev(ctx, 'vault.delete', 'Vault entry deleted: ' + e.name, 'warn');
  return { ok: true };
});
router.add('GET', '/api/vault/system/:id/secret', { perm: 'settings.write' }, (ctx) => {
  const r = vault.systemReveal(ctx.params.id);
  ev(ctx, 'vault.reveal', 'System secret revealed: ' + r.name, 'warn');
  return r;
});
router.add('GET', '/api/vault/:id/secret', { perm: 'settings.write' }, (ctx) => {
  if (!/^\d+$/.test(ctx.params.id)) throw httpError(404, 'no such vault entry');
  const r = vault.reveal(ctx.params.id);
  ev(ctx, 'vault.reveal', 'Vault secret revealed: ' + r.name, 'warn');
  return r;
});
