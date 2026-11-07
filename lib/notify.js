'use strict';
/* -------------------------------------------------------- notifications */
// Telegram + Slack + Brevo (e-mail), configured on the Settings tab and stored in the kv table
// (notify.telegram, notify.slack, notify.brevo). The Telegram block used to live in updates.json; it is migrated on first load.
// send(text) fans out to every enabled channel (Markdown-ish text; Slack gets a plain rendering).
const os = require('os');
const { settings } = require('./db');
const secrets = require('./secrets');

const TG_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
const TG_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
let telegram = null;   // { enabled, botToken, chatId, notifyOnUpdate, notifyOnComplete, notifyOnAuth }
let slack = null;      // { enabled, webhookUrl, notifyOnUpdate, notifyOnComplete, notifyOnAuth }
let brevo = null;      // { enabled, apiKey, senderEmail, senderName, to, notifyOn* } — e-mail through Brevo's API
let loaded = false;
const DEFAULT_EMAIL = 'sys@synergybeam.com';
const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/;
const splitEmails = (v) => String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

// The bot token is stored AES-GCM encrypted (secrets.js); memory holds the plaintext.
function storeTelegram() {
  const t = Object.assign({}, telegram);
  if (t.botToken && !secrets.isEncrypted(t.botToken)) t.botToken = secrets.encrypt(t.botToken);
  settings.set('notify.telegram', t);
}
// The Brevo API key is stored encrypted the same way.
function storeBrevo() {
  const b = Object.assign({}, brevo);
  if (b.apiKey && !secrets.isEncrypted(b.apiKey)) b.apiKey = secrets.encrypt(b.apiKey);
  settings.set('notify.brevo', b);
}
function load() {
  if (loaded) return;
  loaded = true;
  try { telegram = settings.get('notify.telegram', null); slack = settings.get('notify.slack', null); brevo = settings.get('notify.brevo', null); } catch (_) {}
  if (brevo && brevo.apiKey && secrets.isEncrypted(brevo.apiKey)) {
    try { brevo.apiKey = secrets.decrypt(brevo.apiKey); } catch (e) { console.error('brevo key decrypt failed:', e.message); brevo.apiKey = ''; }
  }
  if (telegram && telegram.botToken) {
    if (secrets.isEncrypted(telegram.botToken)) {
      try { telegram.botToken = secrets.decrypt(telegram.botToken); } catch (e) { console.error('telegram token decrypt failed:', e.message); telegram.botToken = ''; }
    } else {
      try { storeTelegram(); } catch (_) {}   // one-time: re-save legacy plaintext token encrypted
    }
  }
}
// Legacy hook: an old updates.json may still carry a telegram block. First call migrates it into kv.
function setConfig(cfg) {
  load();
  if (cfg && !telegram) { telegram = Object.assign({}, cfg); try { storeTelegram(); } catch (_) {} }
}
function getConfig() { load(); return telegram; }
function getSlack() { load(); return slack; }
function getBrevo() { load(); return brevo; }
function saveTelegram(cfg) {
  load();
  telegram = Object.assign({ enabled: false, botToken: '', chatId: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true }, telegram || {}, cfg || {});
  storeTelegram();
  return telegram;
}
function saveSlack(cfg) {
  load();
  slack = Object.assign({ enabled: false, webhookUrl: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true }, slack || {}, cfg || {});
  settings.set('notify.slack', slack);
  return slack;
}

function saveBrevo(cfg) {
  load();
  brevo = Object.assign({ enabled: false, apiKey: '', senderEmail: DEFAULT_EMAIL, senderName: '', to: DEFAULT_EMAIL, notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true, notifyOnSite: true }, brevo || {}, cfg || {});
  storeBrevo();
  return brevo;
}

async function sendTelegram(text, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg || !cfg.enabled && !cfgOverride || !cfg.botToken || !cfg.chatId) return { ok: false, skipped: true };
  if (!TG_TOKEN_RE.test(cfg.botToken) || !TG_CHAT_RE.test(String(cfg.chatId))) return { ok: false, error: 'invalid Telegram bot token or chat id' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.botToken)}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      let d = ''; try { d = (await r.json()).description; } catch (_) {}
      // Text Telegram's Markdown parser cannot read (a password with a stray * _ or `) is resent as
      // plain text rather than lost.
      if (r.status === 400 && /can't parse entities/i.test(d)) {
        const p = await fetch(`https://api.telegram.org/bot${encodeURIComponent(cfg.botToken)}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: cfg.chatId, text: String(text).replace(/\\([_*`\[])/g, '$1') }), signal: AbortSignal.timeout(10000) });
        if (p.ok) return { ok: true, plain: true };
      }
      return { ok: false, error: d || ('HTTP ' + r.status) };
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Telegram-Markdown → Slack mrkdwn: *bold* stays *bold*, `code` stays, _italic_ stays; escape nothing else.
async function sendSlack(text, cfgOverride) {
  const cfg = cfgOverride || getSlack();
  if (!cfg || !cfg.enabled && !cfgOverride || !cfg.webhookUrl) return { ok: false, skipped: true };
  try {
    const r = await fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text).replace(/\\([_*`\[])/g, '$1') }), signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200) };
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Telegram-Markdown → e-mail. Subject: the first line of the message (after the host line).
const unescapeMd = (s) => String(s).replace(/\\([_*`\[])/g, '$1');
const htmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function mdToHtml(text) {
  return htmlEsc(text)
    .replace(/(^|[^\\])\*([^*\n]+)\*/g, '$1<b>$2</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\\([_*`\[])/g, '$1')
    .split('\n').join('<br>\n');
}
const mdToPlain = (text) => unescapeMd(String(text).replace(/(^|[^\\])[*`]/g, '$1'));
async function sendBrevo(text, cfgOverride, subject) {
  const cfg = cfgOverride || getBrevo();
  if (!cfg || !cfg.enabled && !cfgOverride || !cfg.apiKey) return { ok: false, skipped: true };
  const to = splitEmails(cfg.to || DEFAULT_EMAIL), from = String(cfg.senderEmail || DEFAULT_EMAIL).trim();
  if (!to.length || !to.every((e) => EMAIL_RE.test(e)) || !EMAIL_RE.test(from)) return { ok: false, error: 'invalid sender or recipient e-mail' };
  const lines = mdToPlain(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const host = String(os.hostname() || 'server');
  const subj = subject || ('[' + host + '] ' + ((lines[0] && lines[0].replace(/^🖥\s*/, '') === host ? lines[1] : lines[0]) || 'notification')).slice(0, 150);
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: { email: from, name: String(cfg.senderName || '').trim() || host }, to: to.map((email) => ({ email })), subject: subj,
        textContent: mdToPlain(text), htmlContent: '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">' + mdToHtml(text) + '</div>' }),
      signal: AbortSignal.timeout(15000),
    });
    let j = {}; try { j = await r.json(); } catch (_) {}
    if (!r.ok) return { ok: false, error: (j.message || ('HTTP ' + r.status)) + (j.code ? ' (' + j.code + ')' : '') };
    return { ok: true, messageId: j.messageId };
  } catch (e) { return { ok: false, error: e.message }; }
}
// Which machine this came from. One chat can be fed by several servers, and an alert you cannot
// place is most of the way to useless — so it is stamped here, once, rather than at each call site
// where a new notification would sooner or later forget it. Escaped: a hostname containing _ or *
// would otherwise be eaten by Telegram's Markdown parser (sendSlack unescapes it again).
function hostLine() {
  return '🖥 *' + String(os.hostname() || 'unknown').replace(/([_*`\[])/g, '\\$1') + '*';
}
// kind: 'update' | 'complete' | 'auth' | 'site' | undefined (always) — honours the per-channel toggles.
// opts.site: the site this alert is about. Its Overrides tab decides where it goes: the shared
// channels (default), only the site's own Telegram/Slack/Brevo recipients, or nowhere.
async function send(text, kind, opts) {
  text = hostLine() + '\n' + text;
  const key = kind === 'update' ? 'notifyOnUpdate' : kind === 'complete' ? 'notifyOnComplete'
    : kind === 'auth' ? 'notifyOnAuth' : kind === 'site' ? 'notifyOnSite' : null;
  const out = {};
  if (opts && opts.site) {
    let ov = null;
    try { ov = require('./sites/overrides').get(opts.site).notify; } catch (_) {}
    if (ov && ov.mode === 'off') return { skipped: 'notifications are off for ' + opts.site };
    if (ov && ov.mode === 'own') {
      if (ov.telegram.botToken && ov.telegram.chatId) out.telegram = await sendTelegram(text, { botToken: ov.telegram.botToken, chatId: ov.telegram.chatId });
      if (ov.slack.webhookUrl) out.slack = await sendSlack(text, { webhookUrl: ov.slack.webhookUrl });
      const b = getBrevo();
      if (ov.brevo.to && b && b.apiKey) out.brevo = await sendBrevo(text, Object.assign({}, b, { to: ov.brevo.to }));
      return out;
    }
  }
  const t = getConfig(), s = getSlack(), b = getBrevo();
  if (t && t.enabled && (!key || t[key] !== false)) out.telegram = await sendTelegram(text);
  if (s && s.enabled && (!key || s[key] !== false)) out.slack = await sendSlack(text);
  if (b && b.enabled && (!key || b[key] !== false)) out.brevo = await sendBrevo(text);
  return out;
}

// New or changed passwords go to Telegram and Slack (whichever are enabled), regardless of the
// per-category toggles — the admins asked for every new password to land in both.
async function sendPassword(text) {
  text = hostLine() + '\n' + text;
  const out = {}; const t = getConfig(), s = getSlack();
  if (t && t.enabled && t.botToken && t.chatId) out.telegram = await sendTelegram(text);
  if (s && s.enabled && s.webhookUrl) out.slack = await sendSlack(text);
  return out;
}

module.exports = { sendPassword, setConfig, getConfig, getSlack, getBrevo, saveTelegram, saveSlack, saveBrevo, sendTelegram, sendSlack, sendBrevo, send, hostLine, DEFAULT_EMAIL, EMAIL_RE, splitEmails };
