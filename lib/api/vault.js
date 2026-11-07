'use strict';
// Vault API. Lists never carry a secret; every reveal (entry or system secret) is an event.
const router = require('../http');
const { httpError, readJson, actorOf } = router;
const events = require('../events');
const vault = require('../vault');
const notify = require('../notify');

// Every new password is sent to Telegram and Slack. In a code span so it can be copied exactly.
const md = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
async function announce(ctx, what, username, password, url) {
  const text = '🔑 *New password* · ' + md(what) + (username ? '\nUser: `' + username + '`' : '') + '\nPassword: `' + password + '`' + (url ? '\n' + url : '') + '\nby ' + md(who(ctx));
  const r = await notify.sendPassword(text).catch((e) => ({ error: e.message }));
  const sent = Object.entries(r).filter(([, v]) => v && v.ok).map(([k]) => k);
  const failed = Object.entries(r).filter(([, v]) => v && !v.ok).map(([k, v]) => k + ': ' + (v.error || 'failed'));
  return { sentTo: sent, failed, note: sent.length ? null : 'no enabled Telegram or Slack channel received it' };
}

const who = (ctx) => actorOf(ctx.req).user || 'local';
const ev = (ctx, type, message, level) => events.emit(type, { req: ctx.req, target: 'vault', level: level || 'info', message });

router.add('GET', '/api/vault', { perm: 'settings.read' }, async () => ({ kinds: vault.KINDS, entries: vault.list(), system: await vault.systemList() }));
router.add('POST', '/api/vault', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const e = vault.create(b, who(ctx));
  ev(ctx, 'vault.create', 'Vault entry added: ' + e.name);
  if (e.kind === 'password') e.announce = await announce(ctx, e.name, e.username, b.secret, e.url);
  return e;
});
router.add('PUT', '/api/vault/:id', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const e = vault.update(ctx.params.id, b, who(ctx));
  ev(ctx, 'vault.update', 'Vault entry changed: ' + e.name + (b.secret ? ' (new secret)' : ''));
  if (b.secret && e.kind === 'password') e.announce = await announce(ctx, e.name, e.username, b.secret, e.url);
  return e;
});
router.add('DELETE', '/api/vault/:id', { perm: 'settings.write' }, (ctx) => {
  const e = vault.remove(ctx.params.id);
  ev(ctx, 'vault.delete', 'Vault entry deleted: ' + e.name, 'warn');
  return { ok: true };
});
// Set (body.password) or reset (no password → generated) a system password, e.g. the Kuma admin.
router.add('POST', '/api/vault/system/:id/password', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const r = await vault.systemSetPassword(ctx.params.id, b && b.password ? String(b.password) : null);
  ev(ctx, 'vault.password', (r.generated ? 'Password reset: ' : 'Password set: ') + r.name, 'warn');
  const a = await announce(ctx, r.name, r.username, r.password, r.url);
  return { ok: true, name: r.name, username: r.username, password: r.password, generated: r.generated, announce: a };
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
