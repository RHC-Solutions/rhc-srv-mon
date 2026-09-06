'use strict';
// Certificates: inspect PEMs with node:crypto, read/write /etc/nginx/ssl-certificates/<domain>.{crt,key},
// self-signed via openssl. Let's Encrypt / Cloudflare-API issued certs come with the Settings phase.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execP } = require('../util');

const SSL_DIR = '/etc/nginx/ssl-certificates';
const PEM_CERT_RE = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function splitChain(pem) { return String(pem || '').match(PEM_CERT_RE) || []; }

// { subject, sans[], issuer, expires_at, not_before, fingerprint (sha256 hex of DER), serial }
function inspect(pem) {
  const leaf = splitChain(pem)[0];
  if (!leaf) return null;
  try {
    const x = new crypto.X509Certificate(leaf);
    const cn = (s) => { const m = /(?:^|\n)CN=([^\n]+)/.exec(s || ''); return m ? m[1] : (s || '').split('\n')[0]; };
    const sans = (x.subjectAltName || '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
    return {
      subject: cn(x.subject), sans, issuer: (x.issuer || '').split('\n').filter(Boolean).map((l) => l.replace(/^[A-Z]+=/, '')).join(', '),
      issuer_cn: cn(x.issuer), expires_at: new Date(x.validTo).toISOString(), not_before: new Date(x.validFrom).toISOString(),
      fingerprint: x.fingerprint256.replace(/:/g, '').toLowerCase(), serial: x.serialNumber,
      self_signed: x.issuer === x.subject,
    };
  } catch (_) { return null; }
}
function keyMatches(certPem, keyPem) {
  try { const x = new crypto.X509Certificate(splitChain(certPem)[0]); return x.checkPrivateKey(crypto.createPrivateKey(keyPem)); } catch (_) { return false; }
}

// What nginx serves right now for a domain (leaf + chain + key), or null.
function readInstalled(domain) {
  try {
    const crt = fs.readFileSync(path.join(SSL_DIR, domain + '.crt'), 'utf8');
    const parts = splitChain(crt);
    if (!parts.length) return null;
    const info = inspect(parts[0]);
    let key = null; try { key = fs.readFileSync(path.join(SSL_DIR, domain + '.key'), 'utf8'); } catch (_) {}
    return Object.assign(info, { certificate: parts[0], chain: parts.length > 1 ? parts.slice(1).join('\n') : null, key });
  } catch (_) { return null; }
}

// Write <domain>.crt (leaf + chain) and <domain>.key. Caller reloads nginx (via vhost write or reloadNginx()).
function install(domain, certificate, chain, key) {
  if (!splitChain(certificate).length) throw new Error('certificate is not a PEM certificate');
  if (!/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(String(key || ''))) throw new Error('private key is not a PEM key');
  if (!keyMatches(certificate, key)) throw new Error('private key does not match the certificate');
  fs.mkdirSync(SSL_DIR, { recursive: true, mode: 0o755 });
  const crt = [splitChain(certificate)[0]].concat(splitChain(chain)).join('\n') + '\n';
  const crtFile = path.join(SSL_DIR, domain + '.crt'), keyFile = path.join(SSL_DIR, domain + '.key');
  fs.writeFileSync(crtFile + '.tmp', crt, { mode: 0o644 }); fs.renameSync(crtFile + '.tmp', crtFile);
  fs.writeFileSync(keyFile + '.tmp', String(key).trim() + '\n', { mode: 0o600 }); fs.renameSync(keyFile + '.tmp', keyFile);
  fs.chmodSync(keyFile, 0o600);
}
function remove(domain) {
  for (const ext of ['.crt', '.key']) { try { fs.unlinkSync(path.join(SSL_DIR, domain + ext)); } catch (_) {} }
}

// Self-signed RSA-2048, 10 years, SANs: domain (+ www.domain for apex / www) — like CLP at site creation.
async function selfSigned(domain, sans) {
  const names = [...new Set([domain].concat(sans || []))];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rhc-ss-'));
  try {
    const keyFile = path.join(tmp, 'k.pem'), crtFile = path.join(tmp, 'c.pem');
    const r = await execP('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-keyout', keyFile, '-out', crtFile,
      '-subj', '/CN=' + domain, '-addext', 'subjectAltName=' + names.map((n) => 'DNS:' + n).join(',')], { timeout: 60_000 });
    if (r.err) throw new Error('openssl failed: ' + (r.stderr || r.err.message).split('\n')[0]);
    return { certificate: fs.readFileSync(crtFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8') };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
function defaultSans(domain) {
  const { splitDomain } = require('./vhost');
  const { registrable, subdomain } = splitDomain(domain);
  return subdomain === null ? ['www.' + registrable] : subdomain === 'www' ? [registrable] : [];
}

module.exports = { SSL_DIR, splitChain, inspect, keyMatches, readInstalled, install, remove, selfSigned, defaultSans };
