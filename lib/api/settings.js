'use strict';
// Settings tab API: general info, notifications (Telegram / Slack), Cloudflare + domains overview,
// event retention. Cleanup keeps its existing /api/modules/cleanup* routes; the UI just moved.
const fs = require('fs');
const os = require('os');
const router = require('../http');
const { httpError, readJson } = router;
const events = require('../events');
const notify = require('../notify');
const cloudflare = require('../cloudflare');
const { settings } = require('../db');

function panelDomain() {
  try { const m = /server_name\s+([^;\s]+)/.exec(fs.readFileSync('/etc/nginx/sites-enabled/custom-domain.conf', 'utf8')); if (m) return m[1]; } catch (_) {}
  return os.hostname();
}
function timezone() { try { return fs.readFileSync('/etc/timezone', 'utf8').trim(); } catch (_) { return Intl.DateTimeFormat().resolvedOptions().timeZone; } }
function publicIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address)) return i.address;
  return null;
}
const tgView = (t) => t ? Object.assign({}, t, { botToken: t.botToken ? t.botToken.replace(/^(\d+:)(.{4}).+(.{4})$/, '$1$2…$3') : '' , hasToken: !!t.botToken }) : { enabled: false, botToken: '', chatId: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, hasToken: false };
const slView = (s) => s ? Object.assign({}, s, { webhookUrl: s.webhookUrl ? s.webhookUrl.replace(/^(https:\/\/hooks\.slack\.com\/services\/[^/]+\/)[^/]+\/.+$/, '$1…') : '', hasUrl: !!s.webhookUrl }) : { enabled: false, webhookUrl: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, hasUrl: false };

router.add('GET', '/api/settings', { perm: 'settings.read' }, () => ({
  general: { panelDomain: panelDomain(), hostname: os.hostname(), timezone: timezone(), ip: publicIp(), node: process.version, eventsRetentionDays: settings.get('events.retentionDays', events.DEFAULT_RETENTION_DAYS), acmeEmail: settings.get('acme.email', '') },
  telegram: tgView(notify.getConfig()),
  slack: slView(notify.getSlack()),
  cloudflare: { configured: cloudflare.configured(), token: cloudflare.masked() },
}));
router.add('PUT', '/api/settings/general', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.eventsRetentionDays != null) settings.set('events.retentionDays', Math.max(1, Math.min(3650, parseInt(b.eventsRetentionDays, 10) || events.DEFAULT_RETENTION_DAYS)));
  if (b.acmeEmail != null) { const e = String(b.acmeEmail).trim(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpError(400, 'invalid e-mail'); settings.set('acme.email', e); }
  events.emit('settings.save', { req: ctx.req, target: 'general', message: 'General settings saved', data: b });
  return { ok: true };
});
router.add('PUT', '/api/settings/telegram', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const patch = {};
  for (const k of ['enabled', 'notifyOnUpdate', 'notifyOnComplete', 'notifyOnAuth']) if (b[k] != null) patch[k] = !!b[k];
  if (b.chatId != null) patch.chatId = String(b.chatId).trim();
  if (b.botToken) { if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(String(b.botToken).trim())) throw httpError(400, 'that does not look like a bot token (123456:ABC…)'); patch.botToken = String(b.botToken).trim(); }
  const t = notify.saveTelegram(patch);
  events.emit('settings.save', { req: ctx.req, target: 'telegram', message: 'Telegram settings saved (' + (t.enabled ? 'enabled' : 'disabled') + ')' });
  return { ok: true, telegram: tgView(t) };
});
// The test buttons work before Save: whatever is typed in the form is used for this one call.
router.add('POST', '/api/settings/telegram/test', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const cur = notify.getConfig() || {};
  const t = { botToken: (b.botToken && String(b.botToken).trim()) || cur.botToken, chatId: (b.chatId != null && String(b.chatId).trim()) || cur.chatId };
  if (!t.botToken || !t.chatId) throw httpError(400, 'enter a bot token and chat ID first');
  const r = await notify.sendTelegram('🔔 *RHC SRV Manager* on ' + os.hostname() + ' — Telegram notifications are working.', t);
  if (!r.ok) throw httpError(502, 'Telegram: ' + (r.error || 'failed'));
  return { ok: true };
});
router.add('PUT', '/api/settings/slack', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const patch = {};
  for (const k of ['enabled', 'notifyOnUpdate', 'notifyOnComplete', 'notifyOnAuth']) if (b[k] != null) patch[k] = !!b[k];
  if (b.webhookUrl) { if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(String(b.webhookUrl).trim())) throw httpError(400, 'webhook must start with https://hooks.slack.com/services/'); patch.webhookUrl = String(b.webhookUrl).trim(); }
  const s = notify.saveSlack(patch);
  events.emit('settings.save', { req: ctx.req, target: 'slack', message: 'Slack settings saved (' + (s.enabled ? 'enabled' : 'disabled') + ')' });
  return { ok: true, slack: slView(s) };
});
router.add('POST', '/api/settings/slack/test', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const s = { webhookUrl: (b.webhookUrl && String(b.webhookUrl).trim()) || (notify.getSlack() || {}).webhookUrl };
  if (!s.webhookUrl) throw httpError(400, 'enter a webhook URL first');
  if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(s.webhookUrl)) throw httpError(400, 'webhook must start with https://hooks.slack.com/services/');
  const r = await notify.sendSlack(':bell: *RHC SRV Manager* on ' + os.hostname() + ' — Slack notifications are working.', s);
  if (!r.ok) throw httpError(502, 'Slack: ' + (r.error || 'failed'));
  return { ok: true };
});
router.add('PUT', '/api/settings/cloudflare', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.token === '' || b.token === null) { cloudflare.setToken(null); events.emit('settings.save', { req: ctx.req, target: 'cloudflare', level: 'warn', message: 'Cloudflare API token removed' }); return { ok: true, configured: false }; }
  const t = String(b.token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,}$/.test(t)) throw httpError(400, 'that does not look like a Cloudflare API token');
  const v = await cloudflare.verify(t);
  if (!v || v.status !== 'active') throw Object.assign(httpError(400, 'Cloudflare reports this token as "' + ((v && v.status) || 'invalid') + '"'),
    { detail: v && v.expires_on ? 'It expired on ' + v.expires_on + '. Create a new token, or extend this one\'s TTL in the dashboard.' : 'Only a token in the "active" state can be used.' });
  cloudflare.setToken(t);
  events.emit('settings.save', { req: ctx.req, target: 'cloudflare', message: 'Cloudflare API token saved (verified' + (v.id ? ', id ' + v.id.slice(0, 8) + '…' : ', ' + (v.note || v.kind + ' token')) + ')' });
  return { ok: true, configured: true, token: cloudflare.masked(), verify: v };
});
router.add('POST', '/api/settings/cloudflare/test', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const t = b.token ? String(b.token).trim() : null;
  if (!t && !cloudflare.configured()) throw httpError(400, 'paste an API token above, or save one first');
  if (t && !/^[A-Za-z0-9_-]{30,}$/.test(t)) throw httpError(400, 'that does not look like a Cloudflare API token');
  const v = await cloudflare.verify(t || undefined);
  const z = await cloudflare.zones(t || undefined);
  return { ok: true, status: v.status, kind: v.kind || 'user', note: v.note || null, expires_on: v.expires_on || null,
    zones: z.length, saved: !t, zoneNames: z.slice(0, 8).map((x) => x.name) };
});
router.add('GET', '/api/settings/cloudflare/domains', { perm: 'settings.read' }, async () => {
  if (!cloudflare.configured()) throw httpError(409, 'Cloudflare API token not configured');
  const store = require('../sites/store');
  return cloudflare.overview(store.list().map((s) => s.domain), publicIp());
});
