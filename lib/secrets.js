'use strict';
// At-rest encryption for stored credentials (site-user passwords, DB passwords, API tokens).
// AES-256-GCM with a random per-host key in DATA_DIR/secret.key (0600, created on first use).
// Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>". The key is deliberately excluded from
// backups and git — back it up out of band; without it encrypted values are unrecoverable.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

const KEY_FILE = path.join(DATA_DIR, 'secret.key');
let key = null;

function loadKey() {
  if (key) return key;
  try {
    const raw = fs.readFileSync(KEY_FILE);
    if (raw.length === 32) { key = raw; return key; }
    const hex = raw.toString('utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { key = Buffer.from(hex, 'hex'); return key; }
    throw new Error('unexpected key format');
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('secret.key unreadable: ' + e.message);
    key = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, key.toString('hex') + '\n', { mode: 0o600 });
    fs.chmodSync(KEY_FILE, 0o600);
    console.log('secrets: generated new key ' + KEY_FILE + ' — back it up out of band');
    return key;
  }
}

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', loadKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(blob) {
  if (blob == null || blob === '') return null;
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('not an encrypted value');
  const d = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parts[1], 'base64'));
  d.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([d.update(Buffer.from(parts[3], 'base64')), d.final()]).toString('utf8');
}

function isEncrypted(v) { return typeof v === 'string' && /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/.test(v); }

// Random password: URL-safe alphabet, no ambiguous characters.
function generatePassword(len) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len || 20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

module.exports = { KEY_FILE, encrypt, decrypt, isEncrypted, generatePassword };
