#!/usr/bin/env node
'use strict';
// Print the Telegram bot token from the panel's encrypted settings (Settings → Telegram).
// The token lives ONLY in the encrypted SQLite store; scripts outside the panel (fail2ban alerts,
// SSH login alerts, geo-fail2ban) call this through /usr/local/sbin/rhc-telegram-token instead of
// keeping a plaintext copy. Needs root (secret.key is 0600). Exit 1 and print nothing when unset.
const { settings } = require('../lib/db');
const secrets = require('../lib/secrets');
let tok = '';
try {
  const t = settings.get('notify.telegram', null);
  tok = (t && t.botToken) || '';
  if (tok && secrets.isEncrypted(tok)) tok = secrets.decrypt(tok);
} catch (e) { console.error('telegram-token: ' + e.message); process.exit(1); }
if (!tok) process.exit(1);
process.stdout.write(tok + '\n');
