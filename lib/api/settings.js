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
const wasabi = require('../wasabi');
const tunnels = require('../sites/tunnels');
const { execP } = require('../util');

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
const brView = (b) => Object.assign({ enabled: false, senderEmail: notify.DEFAULT_EMAIL, senderName: '', to: notify.DEFAULT_EMAIL, notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true }, b || {},
  { apiKey: b && b.apiKey ? b.apiKey.slice(0, 8) + '…' + b.apiKey.slice(-4) : '', hasKey: !!(b && b.apiKey) });
const slView = (s) => s ? Object.assign({}, s, { webhookUrl: s.webhookUrl ? s.webhookUrl.replace(/^(https:\/\/hooks\.slack\.com\/services\/[^/]+\/)[^/]+\/.+$/, '$1…') : '', hasUrl: !!s.webhookUrl }) : { enabled: false, webhookUrl: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true, hasUrl: false };

router.add('GET', '/api/settings', { perm: 'settings.read' }, (ctx) => { const pd = panelDomain(ctx && ctx.req), ip = publicIp(); return {
  general: { panelDomain: pd.value, panelDomainSource: pd.source, panelName: panelName(), panelNameDefault: DEFAULT_NAME, logo: brand.logo(), hostname: os.hostname(), timezone: timezone(), ip: ip.value, ipSource: ip.source, lanIps: ifaceIps().filter((a) => PRIVATE.test(a)), node: process.version, eventsRetentionDays: settings.get('events.retentionDays', events.DEFAULT_RETENTION_DAYS), acmeEmail: settings.get('acme.email', '') },
  telegram: tgView(notify.getConfig()),
  slack: slView(notify.getSlack()),
  brevo: brView(notify.getBrevo()),
  sitesDefaults: require('../sites/overrides').sharedDefaults(),
  cloudflare: { configured: cloudflare.configured(), token: cloudflare.masked() },
  wasabi: wasabi.view(),
  turnstile: (() => { const t = turnstile.get(); return { enabled: t.enabled, siteKey: t.siteKey, hasSecret: !!t.secretKey, secretKey: turnstile.masked(), active: turnstile.enabled() }; })(),
}; });
// Server timezone (timedatectl): the list for the picker, and setting it. Affects the clock in the
// top bar, scheduled jobs (backups, updates, cleanup run at local HH:MM) and every log timestamp.
let tzList = null;
router.add('GET', '/api/settings/timezones', { perm: 'settings.read' }, async () => {
  if (!tzList) { const r = await execP('timedatectl', ['list-timezones'], { timeout: 15_000 }); tzList = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean); }
  return { current: timezone(), zones: tzList };
});
router.add('PUT', '/api/settings/general', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  if (b.timezone != null && String(b.timezone) !== timezone()) {
    const tz = String(b.timezone).trim();
    if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+){0,2}$/.test(tz)) throw httpError(400, 'invalid timezone');
    const r = await execP('timedatectl', ['set-timezone', tz], { timeout: 20_000 });
    if (r.err) throw httpError(400, 'timedatectl refused ' + tz, { detail: (r.stderr || r.err.message).trim() });
    try { fs.writeFileSync('/etc/timezone', tz + '\n'); } catch (_) {}   // Debian keeps both in step
    events.emit('settings.save', { req: ctx.req, target: 'timezone', level: 'warn', message: 'Server timezone set to ' + tz });
  }
  if (b.eventsRetentionDays != null) settings.set('events.retentionDays', Math.max(1, Math.min(3650, parseInt(b.eventsRetentionDays, 10) || events.DEFAULT_RETENTION_DAYS)));
  if (b.panelName != null) { const n = String(b.panelName).trim(); if (n.length > 60 || /[<>\n\r]/.test(n)) throw httpError(400, 'panel name: up to 60 characters, no < > or line breaks'); if (n && n !== DEFAULT_NAME) settings.set('panel.name', n); else settings.del('panel.name'); }
  if (b.acmeEmail != null) { const e = String(b.acmeEmail).trim(); if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw httpError(400, 'invalid e-mail'); settings.set('acme.email', e); }
  events.emit('settings.save', { req: ctx.req, target: 'general', message: 'General settings saved', data: b });
  return { ok: true };
});
router.add('PUT', '/api/settings/wasabi', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  if (b && b.remove) { wasabi.clear(); events.emit('settings.save', { req: ctx.req, target: 'wasabi', level: 'warn', message: 'Wasabi settings removed' }); return wasabi.view(); }
  const v = wasabi.save(b || {});
  events.emit('settings.save', { req: ctx.req, target: 'wasabi', message: 'Wasabi settings saved (' + v.bucket + '/' + v.prefix + ', ' + v.region + ')' });
  return v;
});
router.add('POST', '/api/settings/wasabi/test', { perm: 'settings.write' }, async (ctx) => {
  const r = await wasabi.test(execP);
  events.emit('settings.test', { req: ctx.req, target: 'wasabi', level: r.ok ? 'info' : 'warn', message: 'Wasabi test ' + (r.ok ? 'passed' : 'failed: ' + r.error) });
  return r;
});

router.add('POST', '/api/settings/logo/upload', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req, 3 * 1024 * 1024);   // 2 MB image as base64
  const l = brand.setFromUpload(b && b.data, b && b.name);
  events.emit('settings.save', { req: ctx.req, target: 'logo', message: 'Logo uploaded (' + l.source.replace(/^upload: /, '') + ', ' + l.type + ')' });
  return { ok: true, logo: l };
});
router.add('PUT', '/api/settings/logo', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const url = String((b && b.url) || '').trim();
  if (!url) { brand.clear(); events.emit('settings.save', { req: ctx.req, target: 'logo', message: 'Logo removed (built-in mark restored)' }); return { ok: true, logo: null }; }
  const l = await brand.setFromUrl(url);
  events.emit('settings.save', { req: ctx.req, target: 'logo', message: 'Logo set from ' + url });
  return { ok: true, logo: l };
});

// Cloudflare Tunnels on this host (every cloudflared unit) with their tokens masked. The full
// token is a separate call that needs settings.write and lands in the event log, like a password reveal.
router.add('GET', '/api/settings/tunnels', { perm: 'settings.read' }, async (ctx) => {
  if (ctx.query.get('refresh') === '1' || !tunnels.get().generated_at) await tunnels.refresh();
  return tunnels.get();
});
// Uptime Kuma monitors for the Monitor page (cached 30 s server-side; ?refresh=1 forces).
const kuma = require('../kuma');
router.add('GET', '/api/kuma', { perm: 'settings.read' }, (ctx) => kuma.get(ctx.query.get('refresh') === '1'));

// cloudflared binary: version, update, auto-update (Tunnels page).
const cloudflared = require('../cloudflared');
router.add('GET', '/api/settings/tunnels/cloudflared', { perm: 'settings.read' }, () => cloudflared.status());
router.add('POST', '/api/settings/tunnels/cloudflared/check', { perm: 'settings.write' }, () => cloudflared.check());
router.add('POST', '/api/settings/tunnels/cloudflared/update', { perm: 'settings.write' }, async (ctx) => {
  const s = await cloudflared.status();
  const r = await cloudflared.update();
  events.emit('settings.save', { req: ctx.req, target: 'cloudflared', message: 'cloudflared update started (installed ' + s.installed + (s.latest ? ', repo has ' + s.latest : '') + ')' });
  return r;
});
router.add('PUT', '/api/settings/tunnels/cloudflared/auto-update', { perm: 'settings.write' }, async (ctx) => {
  const on = !!(await readJson(ctx.req)).enabled;
  const s = await cloudflared.setAutoUpdate(on);
  events.emit('settings.save', { req: ctx.req, target: 'cloudflared', message: 'cloudflared auto-update ' + (on ? 'enabled (daily)' : 'disabled') });
  return s;
});
router.add('GET', '/api/settings/tunnels/:unit/token', { perm: 'settings.write' }, (ctx) => {
  const r = tunnels.reveal(ctx.params.unit);
  if (!r) throw httpError(404, 'no tunnel token for ' + ctx.params.unit);
  events.emit('settings.reveal', { req: ctx.req, target: 'tunnel', level: 'warn', message: 'Tunnel token revealed: ' + r.unit });
  return r;
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
// Brevo (transactional e-mail API). The sender must be a verified sender/domain in the Brevo account.
function brevoPatch(b) {
  const patch = {};
  for (const k of ['enabled', 'notifyOnUpdate', 'notifyOnComplete', 'notifyOnAuth', 'notifyOnSite']) if (b[k] != null) patch[k] = !!b[k];
  if (b.apiKey) { const k = String(b.apiKey).trim(); if (!/^[A-Za-z0-9_\-]{20,200}$/.test(k)) throw httpError(400, 'that does not look like a Brevo API key (xkeysib-…)'); patch.apiKey = k; }
  if (b.senderEmail != null) { const e = String(b.senderEmail).trim() || notify.DEFAULT_EMAIL; if (!notify.EMAIL_RE.test(e)) throw httpError(400, 'invalid sender e-mail'); patch.senderEmail = e; }
  if (b.senderName != null) { const n = String(b.senderName).trim(); if (n.length > 70 || /[<>\n\r"]/.test(n)) throw httpError(400, 'sender name: up to 70 characters, no < > " or line breaks'); patch.senderName = n; }
  if (b.to != null) { const l = notify.splitEmails(b.to); if (!l.length) l.push(notify.DEFAULT_EMAIL); if (l.length > 20 || !l.every((e) => notify.EMAIL_RE.test(e))) throw httpError(400, 'recipients: up to 20 valid e-mails, separated by commas'); patch.to = l.join(', '); }
  return patch;
}
router.add('PUT', '/api/settings/brevo', { perm: 'settings.write' }, async (ctx) => {
  const b = notify.saveBrevo(brevoPatch(await readJson(ctx.req)));
  events.emit('settings.save', { req: ctx.req, target: 'brevo', message: 'Brevo settings saved (' + (b.enabled ? 'enabled' : 'disabled') + ', to ' + b.to + ')' });
  return { ok: true, brevo: brView(b) };
});
router.add('POST', '/api/settings/brevo/test', { perm: 'settings.write' }, async (ctx) => {
  const b = Object.assign({ senderEmail: notify.DEFAULT_EMAIL, to: notify.DEFAULT_EMAIL }, notify.getBrevo() || {}, brevoPatch(await readJson(ctx.req)));
  if (!b.apiKey) throw httpError(400, 'enter a Brevo API key first');
  const r = await notify.sendBrevo('🔔 *' + panelName() + '* on ' + os.hostname() + ' — Brevo e-mail notifications are working.', b, panelName() + ' on ' + os.hostname() + ': test e-mail');
  if (!r.ok) throw httpError(502, 'Brevo: ' + (r.error || 'failed'));
  return { ok: true, to: b.to };
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

// ---- Sites & apps: shared defaults every current and future site inherits (Overrides tab per site)
const siteOverrides = require('../sites/overrides');
router.add('GET', '/api/settings/sites-defaults', { perm: 'settings.read' }, () => siteOverrides.sharedDefaults());
router.add('PUT', '/api/settings/sites-defaults', { perm: 'settings.write' }, async (ctx) => {
  const d = siteOverrides.saveSharedDefaults(await readJson(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'sites-defaults', message: 'Shared site defaults: tunnel ' + d.tunnel + ', self-repair ' + d.repair + ', GitHub owner ' + d.githubOwner });
  return d;
});

// ---- Self-repair (OODA loop)
const ooda = require('../ooda');
router.add('GET', '/api/ooda', { perm: 'settings.read' }, () => ooda.status());
router.add('PUT', '/api/ooda', { perm: 'settings.write' }, async (ctx) => {
  const c = ooda.setConfig(await readJson(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'ooda', level: c.enabled ? 'info' : 'warn', message: 'Self-repair ' + (c.enabled ? 'enabled' : 'DISABLED') });
  return ooda.status();
});
router.add('POST', '/api/ooda/run', { perm: 'settings.write' }, async () => { await ooda.cycle(); return ooda.status(); });

// ---- Admin IP whitelist: sshd AllowUsers (admins + every site's SSH users), ufw 22/tcp, fail2ban ignoreip
const whitelist = require('../whitelist');
const { clientIp, isLocalDirect } = router;
router.add('GET', '/api/settings/whitelist', { perm: 'settings.read' }, (ctx) => {
  const w = whitelist.get(), ip = isLocalDirect(ctx.req) ? null : clientIp(ctx.req);
  // Still a Cloudflare address after clientIp(): the real visitor IP was not passed on (proxy setup) —
  // never offer that one for the whitelist.
  const viaCf = ip ? router.isCloudflareIp(ip) : false;
  return { ips: w.ips, adminUsers: w.adminUsers, siteUsers: whitelist.siteSshUsers(), yourIp: ip, yourIpIsCloudflare: viaCf, yourIpListed: ip && !viaCf ? whitelist.covers(w.ips, ip) : null };
});
router.add('PUT', '/api/settings/whitelist', { perm: 'settings.write' }, async (ctx) => {
  const b = await readJson(ctx.req);
  const r = await whitelist.save(b, isLocalDirect(ctx.req) ? null : clientIp(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'whitelist', level: 'warn', message: 'Admin IP whitelist saved: ' + r.whitelist.ips.map((e) => e.ip).join(', '), data: { steps: r.steps } });
  return r;
});
