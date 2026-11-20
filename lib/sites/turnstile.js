'use strict';
// Cloudflare Turnstile for every new site (not the panel login — that is lib/turnstile.js).
//
// On create, a "managed" Turnstile widget for the domain (plus www for an apex) is made through the
// Cloudflare API in the account that holds the domain's zone. Its site key and secret are kept in kv
// `site.turnstile:<domain>` (secret encrypted, secrets.js), shown in Vault, and written into the app's
// own encrypted SQLite settings (data/app.db → settings: turnstileSiteKey, turnstileSecret — the format
// of the Next.js stack's src/db, lib/sites/stack-next.js). No .env, no environment variables.
// The app decides which forms it protects. Deleting the site deletes the widget.
//
// Needs the Cloudflare token permission Account › Turnstile › Edit; without it the site is still
// created and the step says what to add.
const { settings } = require('../db');
const secrets = require('../secrets');
const { execIn } = require('../util');

const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const KEY = (d) => 'site.turnstile:' + String(d).toLowerCase();
const PERM_HINT = 'the Cloudflare token may not manage Turnstile — add the permission Account › Turnstile › Edit to it (Settings → Cloudflare), then create the widget on the site page';

function get(domain) {
  const r = settings.get(KEY(domain), null);
  if (!r) return null;
  let secret = ''; try { secret = secrets.decrypt(r.secret_enc) || ''; } catch (_) {}
  return { siteKey: r.sitekey, secret, accountId: r.accountId, domains: r.domains || [domain], created: r.created };
}

async function create(site) {
  const have = get(site.domain);
  if (have) return have;
  const cf = require('../cloudflare');
  if (!cf.configured()) throw bad('Cloudflare is not connected (Settings → Cloudflare)', 409);
  const zone = cf.zoneFor(site.domain, await cf.zones());
  if (!zone || !zone.account) throw bad('no Cloudflare zone covers ' + site.domain + ' in the connected accounts', 409);
  const domains = zone.name === site.domain.toLowerCase() ? [site.domain, 'www.' + site.domain] : [site.domain];
  let r;
  try {
    r = await cf.api('/accounts/' + zone.account.id + '/challenges/widgets', { method: 'POST', body: { name: site.domain, domains, mode: 'managed' } });
  } catch (e) {
    if (e.status === 403 || e.cfStatus === 403 || /authentication|permission/i.test(e.message)) throw bad(PERM_HINT, 403);
    throw e;
  }
  const w = r.result || {};
  if (!w.sitekey || !w.secret) throw bad('Cloudflare made no usable Turnstile widget', 502);
  settings.set(KEY(site.domain), { sitekey: w.sitekey, secret_enc: secrets.encrypt(w.secret), accountId: zone.account.id, domains, created: new Date().toISOString() });
  return get(site.domain);
}

async function remove(domain) {
  const r = settings.get(KEY(domain), null);
  if (!r) return 'none';
  try { await require('../cloudflare').api('/accounts/' + r.accountId + '/challenges/widgets/' + r.sitekey, { method: 'DELETE' }); }
  catch (e) { if (e.cfStatus !== 404) throw e; }
  settings.del(KEY(domain));
  return 'widget ' + r.sitekey + ' deleted';
}

// Writes the keys into data/app.db as the site user (never root in a site's files). Same settings table
// and enc1 format (AES-256-GCM, key in data/.secret.key, made if missing) as the stack's src/db.
// The keys travel on stdin, never in argv.
async function seedApp(site) {
  const t = get(site.domain);
  if (!t) return 'no widget';
  const dir = '/home/' + site.user + '/htdocs/' + site.domain;
  const script = `
const { DatabaseSync } = require('node:sqlite'); const crypto = require('node:crypto'); const fs = require('node:fs');
process.chdir(${JSON.stringify(dir)});
fs.mkdirSync('data', { recursive: true, mode: 0o700 });
let key; try { key = Buffer.from(fs.readFileSync('data/.secret.key', 'utf8').trim(), 'hex'); } catch (_) { key = crypto.randomBytes(32); fs.writeFileSync('data/.secret.key', key.toString('hex') + '\\n', { mode: 0o600, flag: 'wx' }); }
const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
const ct = Buffer.concat([c.update(${JSON.stringify(t.secret)}, 'utf8'), c.final()]);
const enc = ['enc1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
const db = new DatabaseSync('data/app.db');
db.exec('PRAGMA busy_timeout = 5000; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
up.run('turnstileSiteKey', ${JSON.stringify(t.siteKey)}); up.run('turnstileSecret', enc);
try { fs.chmodSync('data/app.db', 0o600); } catch (_) {}
console.log('ok');
`;
  const r = await execIn('sudo', ['-n', '-H', '-u', site.user, 'node', '-'], script, { timeout: 60_000 });
  if (r.err || !/ok/.test(r.stdout)) throw new Error(((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop() || 'could not write data/app.db');
  return 'turnstileSiteKey + turnstileSecret (encrypted) in data/app.db';
}

module.exports = { get, create, remove, seedApp, PERM_HINT };
