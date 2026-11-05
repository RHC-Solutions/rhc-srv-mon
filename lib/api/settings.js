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
const turnstile = require('../turnstile');
const { settings } = require('../db');
const { panelName, DEFAULT_NAME } = require('../page');
const brand = require('../brand');

// Panel domain: CloudPanel's custom-domain.conf when there is one, else the hostname the browser
// used to reach us (behind Cloudflare/nginx: X-Forwarded-Host or Host), else the machine name.
function panelDomain(req) {
  try { const m = /server_name\s+([^;\s]+)/.exec(fs.readFileSync('/etc/nginx/sites-enabled/custom-domain.conf', 'utf8')); if (m) return { value: m[1], source: 'nginx custom-domain.conf' }; } catch (_) {}
  const h = req && String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().replace(/:\d+$/, '');
  if (h && !/^(localhost|127\.|\[?::1|\d+\.\d+\.\d+\.\d+$)/.test(h)) return { value: h, source: 'address this page was opened with' };
  return { value: os.hostname(), source: 'machine hostname' };
}
function timezone() { try { return fs.readFileSync('/etc/timezone', 'utf8').trim(); } catch (_) { return Intl.DateTimeFormat().resolvedOptions().timeZone; } }
const PRIVATE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
function ifaceIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
// Behind NAT no interface carries the public address, so ask Cloudflare's trace endpoint what
// address our traffic leaves from (cached for an hour; refreshed in the background).
let egress = { ip: null, at: 0 };
async function refreshEgress() {
  try {
    const t = await (await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(5000) })).text();
    const m = /^ip=(.+)$/m.exec(t); if (m) egress = { ip: m[1].trim(), at: Date.now() };
  } catch (_) {}
}
refreshEgress();
function publicIp() {
  const direct = ifaceIps().find((a) => !PRIVATE.test(a));
  if (direct) return { value: direct, source: 'network interface' };
  if (Date.now() - egress.at > 3600_000) refreshEgress();
  return egress.ip ? { value: egress.ip, source: 'outgoing address (behind NAT)' } : { value: null, source: '' };
}
const tgView = (t) => t ? Object.assign({}, t, { botToken: t.botToken ? t.botToken.replace(/^(\d+:)(.{4}).+(.{4})$/, '$1$2…$3') : '' , hasToken: !!t.botToken }) : { enabled: false, botToken: '', chatId: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true, hasToken: false };
const slView = (s) => s ? Object.assign({}, s, { webhookUrl: s.webhookUrl ? s.webhookUrl.replace(/^(https:\/\/hooks\.slack\.com\/services\/[^/]+\/)[^/]+\/.+$/, '$1…') : '', hasUrl: !!s.webhookUrl }) : { enabled: false, webhookUrl: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true, hasUrl: false };

router.add('GET', '/api/settings', { perm: 'settings.read' }, (ctx) => { const pd = panelDomain(ctx && ctx.req), ip = publicIp(); return {
  general: { panelDomain: pd.value, panelDomainSource: pd.source, panelName: panelName(), panelNameDefault: DEFAULT_NAME, logo: brand.logo(), hostname: os.hostname(), timezone: timezone(), ip: ip.value, ipSource: ip.source, lanIps: ifaceIps().filter((a) => PRIVATE.test(a)), node: process.version, eventsRetentionDays: settings.get('events.retentionDays', events.DEFAULT_RETENTION_DAYS), acmeEmail: settings.get('acme.email', '') },
  telegram: tgView(notify.getConfig()),
  slack: slView(notify.getSlack()),
  cloudflare: { configured: cloudflare.configured(), token: cloudflare.masked() },
  turnstile: (() => { const t = turnstile.get(); return { enabled: t.enabled, siteKey: t.siteKey, hasSecret: !!t.secretKey, secretKey: turnstile.masked(), active: turnstile.enabled() }; })(),
}; });
router.add('PUT', '/api/settings/general', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.eventsRetentionDays != null) settings.set('events.retentionDays', Math.max(1, Math.min(3650, parseInt(b.eventsRetentionDays, 10) || events.DEFAULT_RETENTION_DAYS)));
  if (b.panelName != null) { const n = String(b.panelName).trim(); if (n.length > 60 || /[<>\n\r]/.test(n)) throw httpError(400, 'panel name: up to 60 characters, no < > or line breaks'); if (n && n !== DEFAULT_NAME) settings.set('panel.name', n); else settings.del('panel.name'); }
  if (b.acmeEmail != null) { const e = String(b.acmeEmail).trim(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpError(400, 'invalid e-mail'); settings.set('acme.email', e); }
  events.emit('settings.save', { req: ctx.req, target: 'general', message: 'General settings saved', data: b });
  return { ok: true };
});
router.add('PUT', '/api/settings/logo', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const url = String((b && b.url) || '').trim();
  if (!url) { brand.clear(); events.emit('settings.save', { req: ctx.req, target: 'logo', message: 'Logo removed (built-in mark restored)' }); return { ok: true, logo: null }; }
  const l = await brand.setFromUrl(url);
  events.emit('settings.save', { req: ctx.req, target: 'logo', message: 'Logo set from ' + url });
  return { ok: true, logo: l };
});

router.add('PUT', '/api/settings/telegram', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const patch = {};
  for (const k of ['enabled', 'notifyOnUpdate', 'notifyOnComplete', 'notifyOnAuth', 'notifyOnSite']) if (b[k] != null) patch[k] = !!b[k];
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
  const r = await notify.sendTelegram('🔔 *' + panelName() + '* on ' + os.hostname() + ' — Telegram notifications are working.', t);
  if (!r.ok) throw httpError(502, 'Telegram: ' + (r.error || 'failed'));
  return { ok: true };
});
router.add('PUT', '/api/settings/slack', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const patch = {};
  for (const k of ['enabled', 'notifyOnUpdate', 'notifyOnComplete', 'notifyOnAuth', 'notifyOnSite']) if (b[k] != null) patch[k] = !!b[k];
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
  const r = await notify.sendSlack(':bell: *' + panelName() + '* on ' + os.hostname() + ' — Slack notifications are working.', s);
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
  // A token can be perfectly valid and still be useless here: account-only permissions authenticate
  // fine but list no zones, and the Domains card would just look empty for no stated reason.
  const warning = z.length ? null : 'This token is valid, but no zone is visible to it — the Domains card will stay empty. Add the Zone-scoped permissions "Zone → Zone → Read" and "Zone → DNS → Read" (or Edit), and make sure the token\'s Zone Resources include your zones.';
  return { ok: true, status: v.status, kind: v.kind || 'user', note: v.note || null, expires_on: v.expires_on || null,
    account: v.account || null, zones: z.length, saved: !t, warning, zoneNames: z.slice(0, 8).map((x) => x.name) };
});
router.add('GET', '/api/settings/cloudflare/domains', { perm: 'settings.read' }, async () => {
  if (!cloudflare.configured()) throw httpError(409, 'Cloudflare API token not configured');
  const store = require('../sites/store');
  return cloudflare.overview(store.list().map((s) => s.domain), publicIp());
});

// Turnstile: the site key is public (the login page ships it), the secret is write-only here —
// an empty field on save keeps the stored one, "REMOVE" clears it.
router.add('PUT', '/api/settings/turnstile', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const patch = {};
  if (b.enabled != null) patch.enabled = !!b.enabled;
  if (b.siteKey != null) {
    const k = String(b.siteKey).trim();
    if (k && !/^0x[A-Za-z0-9_-]{10,}$/.test(k)) throw httpError(400, 'that does not look like a Turnstile site key (0x4AAA…)');
    patch.siteKey = k;
  }
  if (b.secretKey) {
    const k = String(b.secretKey).trim();
    if (k === 'REMOVE') patch.secretKey = '';
    else if (!/^0x[A-Za-z0-9_-]{10,}$/.test(k)) throw httpError(400, 'that does not look like a Turnstile secret key (0x4AAA…)');
    else patch.secretKey = k;
  }
  const want = Object.assign({}, turnstile.get(), patch);
  if (want.enabled && !(want.siteKey && want.secretKey)) throw httpError(400, 'both the site key and the secret key are needed before the challenge can be enabled');
  const t = turnstile.save(patch);
  events.emit('settings.save', { req: ctx.req, target: 'turnstile', message: 'Turnstile ' + (turnstile.enabled() ? 'enabled' : 'disabled') + ' on the login page' });
  return { ok: true, turnstile: { enabled: t.enabled, siteKey: t.siteKey, hasSecret: !!t.secretKey, secretKey: turnstile.masked(), active: turnstile.enabled() } };
});
// Ask Cloudflare whether the stored secret is one it knows: a deliberately invalid response gets
// 'invalid-input-response' from a good secret and 'invalid-input-secret' from a bad one.
router.add('POST', '/api/settings/turnstile/test', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const typed = b.secretKey && String(b.secretKey).trim();
  const secret = typed && typed !== 'REMOVE' ? typed : null;      // test what is typed, without saving it
  if (!secret && !turnstile.configured()) throw httpError(400, 'enter the site key and secret key first');
  const r = await turnstile.verify('probe-not-a-real-token', null, secret);
  const codes = r.codes || [];
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) throw httpError(400, 'Cloudflare rejected the secret key — check it was copied in full from the Turnstile widget page');
  if (r.soft) throw httpError(502, 'could not reach challenges.cloudflare.com: ' + r.soft);
  return { ok: true, note: 'Cloudflare accepted the secret key (it answered "' + (codes.join(', ') || 'ok') + '" to a deliberately invalid challenge response, which is the expected reply).' };
});
