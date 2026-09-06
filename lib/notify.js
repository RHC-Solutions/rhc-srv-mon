'use strict';
/* -------------------------------------------------------- notifications */
// Telegram + Slack, configured on the Settings tab and stored in the kv table (notify.telegram,
// notify.slack). The Telegram block used to live in updates.json; it is migrated on first load.
// send(text) fans out to every enabled channel (Markdown-ish text; Slack gets a plain rendering).
const { settings } = require('./db');

let telegram = null;   // { enabled, botToken, chatId, notifyOnUpdate, notifyOnComplete, notifyOnAuth }
let slack = null;      // { enabled, webhookUrl, notifyOnUpdate, notifyOnComplete, notifyOnAuth }
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  try { telegram = settings.get('notify.telegram', null); slack = settings.get('notify.slack', null); } catch (_) {}
}
// Legacy hook: updates.js hands us its telegram block on load/save. First call migrates it into kv.
function setConfig(cfg) {
  load();
  if (cfg && !telegram) { telegram = cfg; try { settings.set('notify.telegram', telegram); } catch (_) {} }
}
function getConfig() { load(); return telegram; }
function getSlack() { load(); return slack; }
function saveTelegram(cfg) {
  load();
  telegram = Object.assign({ enabled: false, botToken: '', chatId: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true }, telegram || {}, cfg || {});
  settings.set('notify.telegram', telegram);
  return telegram;
}
function saveSlack(cfg) {
  load();
  slack = Object.assign({ enabled: false, webhookUrl: '', notifyOnUpdate: true, notifyOnComplete: true, notifyOnAuth: true }, slack || {}, cfg || {});
  settings.set('notify.slack', slack);
  return slack;
}

async function sendTelegram(text, cfgOverride) {
  const cfg = cfgOverride || getConfig();
  if (!cfg || !cfg.enabled && !cfgOverride || !cfg.botToken || !cfg.chatId) return { ok: false, skipped: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { let d = ''; try { d = (await r.json()).description; } catch (_) {} return { ok: false, error: d || ('HTTP ' + r.status) }; }
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
// kind: 'update' | 'complete' | 'auth' | undefined (always) — honours the per-channel notify toggles.
async function send(text, kind) {
  const key = kind === 'update' ? 'notifyOnUpdate' : kind === 'complete' ? 'notifyOnComplete' : kind === 'auth' ? 'notifyOnAuth' : null;
  const out = {};
  const t = getConfig(), s = getSlack();
  if (t && t.enabled && (!key || t[key] !== false)) out.telegram = await sendTelegram(text);
  if (s && s.enabled && (!key || s[key] !== false)) out.slack = await sendSlack(text);
  return out;
}

module.exports = { setConfig, getConfig, getSlack, saveTelegram, saveSlack, sendTelegram, sendSlack, send };
