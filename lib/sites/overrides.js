'use strict';
// Shared settings with per-site overrides.
//
// Everything on the Settings page (Telegram, Slack, Brevo, Cloudflare, Wasabi backups, self-repair)
// is the shared default for every current and future site. A site can switch a group to its own
// value — or off — on its Overrides tab; nothing else changes for the other sites.
//
//   notify:     shared | own | off   own = this site's alerts go only to its own Telegram/Slack/Brevo
//   cloudflare: tunnel own | shared   own = a tunnel of its own (default for new sites), shared = a
//               route on the shared host tunnel. The API token itself is per site already
//               (site_cloudflare, Cloudflare tab) and falls back to the shared one.
//   backups:    shared | own          own = also backed up nightly to the site's own Wasabi bucket
//   repair:     inherit | auto | off  self-repair (OODA) for this site's apps
//
// Stored per site in kv `site.overrides:<domain>`; secret fields are encrypted (secrets.js).
const { settings } = require('../db');
const secrets = require('../secrets');

const key = (domain) => 'site.overrides:' + String(domain).toLowerCase();
const SECRET_PATHS = [['notify', 'telegram', 'botToken'], ['notify', 'slack', 'webhookUrl'], ['backups', 'wasabi', 'secretKey']];
const DEFAULTS = () => ({
  notify: { mode: 'shared', telegram: { botToken: '', chatId: '' }, slack: { webhookUrl: '' }, brevo: { to: '' } },
  cloudflare: { tunnel: 'default' },
  backups: { mode: 'shared', wasabi: { accessKey: '', secretKey: '', region: 'eu-central-1', bucket: '', prefix: '' } },
  repair: { mode: 'inherit' },
});

function walk(obj, p, fn) {
  let o = obj;
  for (let i = 0; i < p.length - 1; i++) { if (!o[p[i]] || typeof o[p[i]] !== 'object') return; o = o[p[i]]; }
  const k = p[p.length - 1];
  if (o[k]) o[k] = fn(o[k]);
}
function merge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') merge(base[k], v);
    else if (k in base || typeof base !== 'object') base[k] = v;
  }
  return base;
}

// Full override object for a site, secrets in clear (server-side use only).
function get(domain) {
  const raw = settings.get(key(domain), null);
  const o = merge(DEFAULTS(), raw ? JSON.parse(JSON.stringify(raw)) : {});
  for (const p of SECRET_PATHS) walk(o, p, (v) => { try { return secrets.isEncrypted(v) ? secrets.decrypt(v) : v; } catch (_) { return ''; } });
  return o;
}
// Same, with secrets masked — what the browser gets.
function view(domain) {
  const o = get(domain);
  for (const p of SECRET_PATHS) {
    let has = false;
    walk(o, p, (v) => { has = !!v; return ''; });
    let parent = o; for (let i = 0; i < p.length - 1; i++) parent = parent[p[i]];
    parent['has_' + p[p.length - 1]] = has;
  }
  return o;
}

const bad = (m) => Object.assign(new Error(m), { status: 400 });
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
// Validate + store a patch. Empty secret strings mean "keep the stored one".
function save(domain, patch) {
  const cur = get(domain);
  const p = patch || {};
  const pick = (v, list, what) => { if (v == null) return undefined; if (!list.includes(v)) throw bad(what + ' must be one of ' + list.join(', ')); return v; };
  if (p.notify) {
    const n = p.notify;
    const m = pick(n.mode, ['shared', 'own', 'off'], 'notify.mode'); if (m) cur.notify.mode = m;
    if (n.telegram) {
      if (n.telegram.botToken) { const t = String(n.telegram.botToken).trim(); if (!/^\d{5,12}:[A-Za-z0-9_-]{30,64}$/.test(t)) throw bad('that does not look like a Telegram bot token'); cur.notify.telegram.botToken = t; }
      if (n.telegram.chatId != null) { const c = String(n.telegram.chatId).trim(); if (c && !/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(c)) throw bad('invalid Telegram chat id'); cur.notify.telegram.chatId = c; }
      if (n.telegram.clear) cur.notify.telegram = { botToken: '', chatId: '' };
    }
    if (n.slack) {
      if (n.slack.webhookUrl) { const u = String(n.slack.webhookUrl).trim(); if (!/^https:\/\/hooks\.slack\.com\/services\/\S+$/.test(u)) throw bad('Slack webhook must start with https://hooks.slack.com/services/'); cur.notify.slack.webhookUrl = u; }
      if (n.slack.clear) cur.notify.slack.webhookUrl = '';
    }
    if (n.brevo && n.brevo.to != null) {
      const l = String(n.brevo.to).split(/[\s,;]+/).filter(Boolean);
      if (l.length > 20 || !l.every((e) => EMAIL_RE.test(e))) throw bad('Brevo recipients: up to 20 valid e-mails');
      cur.notify.brevo.to = l.join(', ');
    }
    if (cur.notify.mode === 'own' && !cur.notify.telegram.botToken && !cur.notify.slack.webhookUrl && !cur.notify.brevo.to) throw bad('own notifications need at least one channel: Telegram, Slack or Brevo recipients');
    if (cur.notify.mode === 'own' && cur.notify.telegram.botToken && !cur.notify.telegram.chatId) throw bad('Telegram needs a chat id too');
  }
  if (p.cloudflare) { const t = pick(p.cloudflare.tunnel, ['default', 'own', 'shared'], 'cloudflare.tunnel'); if (t) cur.cloudflare.tunnel = t; }
  if (p.backups) {
    const m = pick(p.backups.mode, ['shared', 'own'], 'backups.mode'); if (m) cur.backups.mode = m;
    const w = p.backups.wasabi || {};
    for (const k of ['accessKey', 'region', 'bucket', 'prefix']) if (w[k] != null) cur.backups.wasabi[k] = String(w[k]).trim();
    if (w.secretKey) cur.backups.wasabi.secretKey = String(w.secretKey).trim();
    if (cur.backups.mode === 'own') {
      const x = cur.backups.wasabi;
      if (!x.accessKey || !x.secretKey || !x.bucket) throw bad('own backups need an access key, a secret key and a bucket');
      if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(x.bucket)) throw bad('invalid bucket name');
      if (x.prefix && !/^[A-Za-z0-9._\/-]{1,200}$/.test(x.prefix)) throw bad('invalid folder name');
    }
  }
  if (p.repair) { const m = pick(p.repair.mode, ['inherit', 'auto', 'off'], 'repair.mode'); if (m) cur.repair.mode = m; }
  const stored = JSON.parse(JSON.stringify(cur));
  for (const sp of SECRET_PATHS) walk(stored, sp, (v) => secrets.encrypt(v));
  settings.set(key(domain), stored);
  return view(domain);
}
function remove(domain) { settings.del(key(domain)); }

// ---- shared defaults (Settings → Sites & apps) --------------------------------------------------
const sharedDefaults = () => Object.assign({ tunnel: 'own', repair: 'auto', githubOwner: 'roman-synergybeam' }, settings.get('sites.defaults', {}) || {});
function saveSharedDefaults(p) {
  const cur = sharedDefaults();
  if (p.tunnel != null) { if (!['own', 'shared'].includes(p.tunnel)) throw bad('tunnel must be own or shared'); cur.tunnel = p.tunnel; }
  if (p.repair != null) { if (!['auto', 'off'].includes(p.repair)) throw bad('repair must be auto or off'); cur.repair = p.repair; }
  if (p.githubOwner != null) { const o = String(p.githubOwner).trim(); if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(o)) throw bad('invalid GitHub owner'); cur.githubOwner = o; }
  settings.set('sites.defaults', cur);
  return cur;
}

// Effective values after inheritance.
function tunnelMode(domain) { const t = get(domain).cloudflare.tunnel; return t === 'default' ? sharedDefaults().tunnel : t; }
function repairMode(domain) { const r = get(domain).repair.mode; return r === 'inherit' ? sharedDefaults().repair : r; }

module.exports = { get, view, save, remove, sharedDefaults, saveSharedDefaults, tunnelMode, repairMode };
