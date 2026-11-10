'use strict';
// Firewall API: ufw (state, policies, logging, rules) and fail2ban (service, jails, bans, banaction).
const router = require('../http');
const { readJson } = router;
const events = require('../events');
const fw = require('../firewall');
const f2 = require('../fail2ban');

// Switching the firewall or a ban backend on/off is worth a line in the chat, whoever did it.
const tell = (text) => { try { require('../notify').send(text, 'complete').catch(() => {}); } catch (_) {} };
const actor = (ctx) => (router.actorOf(ctx.req).user || 'local');

router.add('GET', '/api/firewall', { perm: 'settings.read' }, async () => {
  const [ufw, fail2ban] = await Promise.all([fw.status().catch((e) => ({ installed: true, error: e.message })), f2.status().catch((e) => ({ installed: true, error: e.message, jails: [] }))]);
  return { ufw, fail2ban };
});

// ---- ufw
router.add('POST', '/api/firewall/ufw/enable', { perm: 'settings.write' }, async (ctx) => {
  const r = await fw.enable();
  events.emit('firewall.enable', { req: ctx.req, target: 'ufw', level: 'warn', message: 'ufw switched on — ' + r.log.join('; ') });
  tell('🧱 *Firewall on* (ufw) — by ' + actor(ctx));
  return r;
});
router.add('POST', '/api/firewall/ufw/disable', { perm: 'settings.write' }, async (ctx) => {
  const r = await fw.disable();
  events.emit('firewall.disable', { req: ctx.req, target: 'ufw', level: 'warn', message: 'ufw switched off' });
  tell('⚠️ *Firewall off* (ufw) — by ' + actor(ctx));
  return r;
});
router.add('POST', '/api/firewall/ufw/rules', { perm: 'settings.write' }, async (ctx) => {
  const r = await fw.addRule(await readJson(ctx.req));
  events.emit('firewall.rule.add', { req: ctx.req, target: 'ufw', message: r.spec });
  return r;
});
router.add('POST', '/api/firewall/ufw/rules/delete', { perm: 'settings.write' }, async (ctx) => {
  const spec = String((await readJson(ctx.req)).spec || '');
  const r = await fw.deleteRule(spec);
  events.emit('firewall.rule.delete', { req: ctx.req, target: 'ufw', level: 'warn', message: 'deleted ufw ' + spec });
  return r;
});
router.add('PUT', '/api/firewall/ufw/default', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req); const r = await fw.setDefault(String(b.direction || ''), String(b.policy || ''));
  events.emit('firewall.default', { req: ctx.req, target: 'ufw', level: 'warn', message: 'ufw default ' + b.direction + ': ' + b.policy });
  return r;
});
router.add('PUT', '/api/firewall/ufw/logging', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req); const r = await fw.setLogging(String(b.level || ''));
  events.emit('firewall.logging', { req: ctx.req, target: 'ufw', message: 'ufw logging ' + b.level });
  return r;
});

// ---- fail2ban
router.add('PUT', '/api/firewall/fail2ban/jails/:jail', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req); const r = await f2.setJail(ctx.params.jail, b);
  const what = Object.entries(b).filter(([, v]) => v != null && v !== '').map(([k, v]) => k + '=' + v).join(', ');
  events.emit('fail2ban.jail', { req: ctx.req, target: ctx.params.jail, level: b.enabled === false ? 'warn' : 'info', message: 'fail2ban jail ' + ctx.params.jail + ': ' + what });
  return r;
});
router.add('DELETE', '/api/firewall/fail2ban/jails/:jail', { perm: 'settings.write' }, async (ctx) => {
  const r = await f2.resetJail(ctx.params.jail);
  events.emit('fail2ban.jail', { req: ctx.req, target: ctx.params.jail, message: 'fail2ban jail ' + ctx.params.jail + ': panel settings removed (back to jail.local / defaults)' });
  return r;
});
router.add('PUT', '/api/firewall/fail2ban/banaction', { perm: 'settings.write' }, async (ctx) => {
  const c = (await readJson(ctx.req)).choice; const r = await f2.setBanaction(c || null);
  events.emit('fail2ban.banaction', { req: ctx.req, target: 'fail2ban', level: 'warn', message: 'fail2ban bans enforced with ' + (c || 'the jail.local default') });
  tell('🧱 fail2ban bans are now enforced with *' + (c || 'the jail.local default') + '* — by ' + actor(ctx));
  return r;
});
router.add('POST', '/api/firewall/fail2ban/service/:action', { perm: 'settings.write' }, async (ctx) => {
  const r = await f2.service(ctx.params.action);
  events.emit('fail2ban.service', { req: ctx.req, target: 'fail2ban', level: ctx.params.action === 'unban-all' ? 'warn' : 'info', message: 'fail2ban ' + ctx.params.action });
  return r;
});
router.add('POST', '/api/firewall/fail2ban/:jail/:op', { perm: 'settings.write' }, async (ctx) => {
  const op = ctx.params.op; if (op !== 'ban' && op !== 'unban') throw router.httpError(404, 'not found');
  const ip = String((await readJson(ctx.req)).ip || '').trim();
  const r = await (op === 'ban' ? f2.ban : f2.unban)(ctx.params.jail, ip);
  events.emit('security.' + op, { req: ctx.req, target: ip, level: op === 'ban' ? 'warn' : 'info', message: 'fail2ban: ' + op + 'ned ' + ip + ' in ' + ctx.params.jail });
  return r;
});
