'use strict';
// Security API: intel, fail2ban, block rules (host nftables + Cloudflare), keys.
const router = require('../http');
const { readJson, actorOf, httpError } = router;
const events = require('../events');
const sec = require('../security');
const who = (ctx) => actorOf(ctx.req).user || 'local';

router.add('GET', '/api/security', { perm: 'settings.read' }, async () => ({ config: sec.configView(), rules: sec.rules(), fail2ban: await sec.fail2ban(), host: await sec.hostCounters() }));
router.add('PUT', '/api/security/config', { perm: 'settings.write' }, async (ctx) => {
  const r = sec.saveConfig(await readJson(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'security', message: 'Security settings saved (ipinfo ' + (r.hasIpinfo ? 'set' : 'none') + ', AbuseIPDB ' + (r.hasAbuse ? 'set' : 'none') + ', report bans ' + (r.reportBans ? 'on' : 'off') + ')' });
  return r;
});
router.add('GET', '/api/security/intel/:ip', { perm: 'settings.read' }, (ctx) => sec.intel(ctx.params.ip, { fresh: ctx.query.get('fresh') === '1' }));
router.add('POST', '/api/security/intel', { perm: 'settings.read' }, async (ctx) => {
  const ips = ((await readJson(ctx.req)).ips || []).slice(0, 60);
  const out = {}; for (const ip of ips) { try { out[ip] = await sec.intel(ip); } catch (e) { out[ip] = { error: e.message }; } }
  return out;
});
router.add('POST', '/api/security/fail2ban/:jail/ban', { perm: 'settings.write' }, async (ctx) => {
  const ip = String((await readJson(ctx.req)).ip || ''); const r = await sec.ban(ctx.params.jail, ip);
  events.emit('security.ban', { req: ctx.req, target: ip, level: 'warn', message: 'fail2ban: banned ' + ip + ' in ' + ctx.params.jail }); return r;
});
router.add('POST', '/api/security/fail2ban/:jail/unban', { perm: 'settings.write' }, async (ctx) => {
  const ip = String((await readJson(ctx.req)).ip || ''); const r = await sec.unban(ctx.params.jail, ip);
  events.emit('security.unban', { req: ctx.req, target: ip, message: 'fail2ban: unbanned ' + ip + ' in ' + ctx.params.jail }); return r;
});
router.add('POST', '/api/security/report', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req); const r = await sec.reportAbuse(String(b.ip || ''), String(b.comment || 'abusive traffic'), b.categories);
  if (!r.ok) throw httpError(424, 'AbuseIPDB: ' + r.error);
  events.emit('security.report', { req: ctx.req, target: b.ip, message: 'Reported ' + b.ip + ' to AbuseIPDB' }); return r;
});
router.add('POST', '/api/security/rules', { perm: 'settings.write' }, async (ctx) => {
  const r = await sec.addRule(await readJson(ctx.req), who(ctx));
  events.emit('security.block', { req: ctx.req, target: r.type + ':' + r.value, level: 'warn', message: 'Block rule ' + r.type + ' ' + r.value + ' — ' + Object.entries(r.status).map(([k, v]) => k + ': ' + v).join('; ') });
  return r;
});
router.add('DELETE', '/api/security/rules/:id', { perm: 'settings.write' }, async (ctx) => {
  const r = await sec.removeRule(ctx.params.id);
  events.emit('security.unblock', { req: ctx.req, target: ctx.params.id, message: 'Block rule removed — ' + Object.entries(r).map(([k, v]) => k + ': ' + v).join('; ') });
  return r;
});
router.add('POST', '/api/security/rules/refresh', { perm: 'settings.write' }, async () => sec.applyHost());
