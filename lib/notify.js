'use strict';
/* ------------------------------------------------------------ telegram */
// Owns the Telegram config so auth/backups/modules don't reach into the updates cache.
// The config still lives in updates.json (`telegram`); updates.js pushes it here on load/save.

let telegram = null;   // { enabled, botToken, chatId, notifyOnUpdates, notifyOnDone, notifyOnAuth }

function setConfig(cfg) { telegram = cfg || null; }
function getConfig() { return telegram; }

async function sendTelegram(text) {
  const cfg = telegram;
  if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) return;
  try {
    const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {}
}

module.exports = { setConfig, getConfig, sendTelegram };
