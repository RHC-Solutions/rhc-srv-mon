'use strict';
// Central certificate store (table cert_store). One copy of each certificate + its key, encrypted,
// independent of any site:
//   match(domain)          — the best stored cert whose SANs cover the domain (and its www alias for an apex)
//   applyToSite(site, row) — copy it into the site's own certificates, install the files, nginx -t, reload
//   seed()                 — first boot: import every real (non-self-signed) cert already on disk or in sites
// Site creation calls match() + applyToSite()-equivalent; a cert uploaded to any site is added here too.
const fs = require('fs');
const path = require('path');
const { open, settings } = require('../db');
const secrets = require('../secrets');
const ssl = require('./ssl');
const store = require('./store');

const now = () => new Date().toISOString();
const q = (sql) => open().prepare(sql);
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });

function typeOf(info) {
  return /CloudFlare Origin/i.test(info.issuer || '') ? 'cloudflare_origin' : /Let's Encrypt/i.test(info.issuer || '') ? 'letsencrypt' : info.self_signed ? 'self_signed' : 'custom';
}
const parse = (r) => r && Object.assign(r, { sans: JSON.parse(r.sans || '[]') });

// Does a SAN list cover a host name? Exact, or a wildcard one label deep (*.rhc.pw ⊃ a.rhc.pw, not a.b.rhc.pw).
function covers(sans, name) {
  name = String(name || '').toLowerCase();
  return (sans || []).some((s) => {
    s = String(s).toLowerCase();
    if (s === name) return true;
    if (!s.startsWith('*.')) return false;
    const rest = name.slice(name.indexOf('.') + 1);
    return name.includes('.') && rest === s.slice(2);
  });
}

// Rows without the key, with which sites serve each one and which sites it could serve.
function list() {
  const rows = q('SELECT id, name, type, subject, sans, issuer, not_before, expires_at, fingerprint, source, created_at FROM cert_store ORDER BY name COLLATE NOCASE, expires_at DESC').all().map(parse);
  const sites = store.list();
  const activeFp = new Map();
  for (const s of sites) { const a = store.certs.active(s.id); activeFp.set(s.domain, a ? a.fingerprint : null); }
  for (const r of rows) {
    r.used_by = sites.filter((s) => activeFp.get(s.domain) === r.fingerprint).map((s) => s.domain);
    r.matches = sites.filter((s) => covers(r.sans, s.domain)).map((s) => s.domain);
    r.expired = r.expires_at ? Date.parse(r.expires_at) < Date.now() : false;
  }
  return rows;
}
const get = (id) => parse(q('SELECT * FROM cert_store WHERE id = ?').get(Number(id)) || null);
const byFingerprint = (fp) => parse(q('SELECT * FROM cert_store WHERE fingerprint = ?').get(fp) || null);

// Add (or find) a cert. Self-signed certs are refused — the store is for certs worth sharing.
function add({ certificate, key, chain, name, source }) {
  let cert = String(certificate || '');
  const parts = ssl.splitChain(cert);
  if (!parts.length) throw bad('certificate is not a PEM certificate');
  if (parts.length > 1 && !chain) { cert = parts[0]; chain = parts.slice(1).join('\n'); } else cert = parts[0];
  const info = ssl.inspect(cert);
  if (!info) throw bad('certificate could not be parsed');
  if (info.self_signed) throw bad('self-signed certificates are not kept in the central store');
  if (!/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(String(key || ''))) throw bad('private key is not a PEM key');
  if (!ssl.keyMatches(cert, key)) throw bad('private key does not match the certificate');
  const existing = byFingerprint(info.fingerprint);
  if (existing) return { row: existing, created: false };
  const id = Number(q('INSERT INTO cert_store (name, type, subject, sans, issuer, not_before, expires_at, fingerprint, certificate, chain, private_key_enc, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(name || '').trim() || info.sans.join(', ') || info.subject, typeOf(info), info.subject, JSON.stringify(info.sans), info.issuer, info.not_before, info.expires_at,
      info.fingerprint, cert, chain ? ssl.splitChain(chain).join('\n') : null, secrets.encrypt(String(key).trim() + '\n'), source || 'upload', now()).lastInsertRowid);
  return { row: get(id), created: true };
}
function rename(id, name) { return q('UPDATE cert_store SET name = ? WHERE id = ?').run(String(name || '').trim().slice(0, 200), Number(id)).changes; }
function remove(id) { return q('DELETE FROM cert_store WHERE id = ?').run(Number(id)).changes; }

// Names a cert must cover for a site: the domain, plus www.<apex> for an apex domain.
function namesFor(domain) { return [domain].concat(ssl.defaultSans(domain)); }

// Best cert for a domain: covers every name, not expired, latest expiry wins. null if none.
function match(domain) {
  const names = namesFor(domain);
  const rows = q('SELECT * FROM cert_store').all().map(parse)
    .filter((r) => names.every((n) => covers(r.sans, n)) && (!r.expires_at || Date.parse(r.expires_at) > Date.now() + 86400e3));
  rows.sort((a, b) => String(b.expires_at).localeCompare(String(a.expires_at)));
  return rows[0] || null;
}

// Copy a store cert into a site's certificates (dedupe by fingerprint) and return that row id.
function copyToSite(site, row, isActive) {
  const own = store.certs.byFingerprint(site.id, row.fingerprint);
  if (own) { if (!own.private_key_enc) store.certs.setKey(own.id, row.private_key_enc); return own.id; }
  return store.certs.insert({ site_id: site.id, type: row.type, subject: row.subject, sans: row.sans, issuer: row.issuer, expires_at: row.expires_at,
    private_key_enc: row.private_key_enc, certificate: row.certificate, chain: row.chain, fingerprint: row.fingerprint, is_active: isActive ? 1 : 0 });
}

// Install a store cert on a live site: files, nginx -t (restore the previous pair on failure), reload.
async function applyToSite(site, row) {
  const vhost = require('./vhost');
  const key = secrets.decrypt(row.private_key_enc);
  const prev = ssl.readInstalled(site.domain);
  ssl.install(site.domain, row.certificate, row.chain, key);
  const t = await vhost.nginxTest();
  if (!t.ok) {
    if (prev && prev.key) ssl.install(site.domain, prev.certificate, prev.chain, prev.key);
    throw bad('nginx rejected the certificate for ' + site.domain + ' — previous one restored', 409, t.output);
  }
  await vhost.reloadNginx();
  const id = copyToSite(site, row, false);
  store.certs.setActive(site.id, id);
  return id;
}

// One-time import of every real certificate this host already has: the per-site rows and the files
// nginx serves (/etc/nginx/ssl-certificates/*.crt with a matching .key, custom-domain included).
function seed(force) {
  if (!force && settings.get('certstore.seeded', false)) return null;
  let added = 0, seen = 0;
  const tryAdd = (certificate, key, chain, source) => {
    seen++;
    try { if (add({ certificate, key, chain, source }).created) added++; } catch (_) { /* self-signed, no key, mismatch */ }
  };
  for (const r of q('SELECT * FROM certificates WHERE private_key_enc IS NOT NULL').all()) {
    let key; try { key = secrets.decrypt(r.private_key_enc); } catch (_) { continue; }
    const s = store.getById(r.site_id);
    tryAdd(r.certificate, key, r.chain, 'site:' + (s ? s.domain : r.site_id));
  }
  let files = [];
  try { files = fs.readdirSync(ssl.SSL_DIR).filter((f) => f.endsWith('.crt')); } catch (_) {}
  for (const f of files) {
    try {
      const crt = fs.readFileSync(path.join(ssl.SSL_DIR, f), 'utf8');
      const key = fs.readFileSync(path.join(ssl.SSL_DIR, f.replace(/\.crt$/, '.key')), 'utf8');
      const parts = ssl.splitChain(crt);
      tryAdd(parts[0], key, parts.slice(1).join('\n') || null, 'disk:' + f);
    } catch (_) {}
  }
  settings.set('certstore.seeded', true);
  return { added, seen };
}

module.exports = { covers, list, get, byFingerprint, add, rename, remove, namesFor, match, copyToSite, applyToSite, seed, typeOf };
