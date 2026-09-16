'use strict';
/* -------------------------------------------------------------- turnstile */
// Cloudflare Turnstile in front of the login form: a CAPTCHA-shaped gate that keeps password
// guessers off /api/auth/login before any hashing happens. Config lives in kv `turnstile`
// ({ enabled, siteKey, secretKey }), the secret encrypted with secrets.js like the Cloudflare
// API token. The site key is public — it is handed to the browser by /api/auth/state.
//
// Trusted loopback (curl on the box, an SSH tunnel) never sees a challenge: there is no browser
// there to solve one, and that path is the way back in if the keys are ever wrong.
const { settings } = require('./db');
const secrets = require('./secrets');

const KEY = 'turnstile';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULTS = { enabled: false, siteKey: '', secretKey: '' };

let cache = null;
function get() {
  if (cache) return cache;
  const raw = settings.get(KEY, null) || {};
  let secret = '';
  if (raw.secretKey) { try { secret = secrets.decrypt(raw.secretKey) || ''; } catch (_) { secret = ''; } }
  cache = Object.assign({}, DEFAULTS, raw, { secretKey: secret });
  return cache;
}
function save(patch) {
  const cur = get();
  const next = Object.assign({}, cur, patch || {});
  next.enabled = !!next.enabled;
  next.siteKey = String(next.siteKey || '').trim();
  next.secretKey = String(next.secretKey || '').trim();
  settings.set(KEY, { enabled: next.enabled, siteKey: next.siteKey, secretKey: next.secretKey ? secrets.encrypt(next.secretKey) : '' });
  cache = next;
  return next;
}
function siteKey() { return get().siteKey || null; }
function configured() { const c = get(); return !!(c.siteKey && c.secretKey); }
// Only an enabled *and* fully keyed widget gates anything — half a config must not lock anyone out.
function enabled() { return get().enabled && configured(); }
function masked() { const s = get().secretKey; return s ? s.slice(0, 6) + '…' + s.slice(-4) : null; }

// What each Cloudflare error code means for the person staring at the login form.
const CODE_HELP = {
  'missing-input-response': 'Human verification did not complete — reload the page and try again.',
  'invalid-input-response': 'Human verification failed. The challenge has been reset — please try again.',
  'timeout-or-duplicate': 'The human-verification challenge expired. It has been reset — please try again.',
  'invalid-input-secret': 'Human verification is misconfigured on this server: Cloudflare rejected the secret key. Fix it in Settings → Turnstile (or reach the panel over an SSH tunnel, where the challenge is skipped).',
  'missing-input-secret': 'Human verification is misconfigured on this server: no secret key is stored.',
  'bad-request': 'Cloudflare rejected the verification request as malformed.',
  'internal-error': 'Cloudflare could not verify the challenge right now — please try again.',
};
// Codes that mean "a human hit a stale widget", not "something is attacking the form" — those must
// not spend one of the six attempts the IP gets before a lockout.
const BENIGN = new Set(['timeout-or-duplicate', 'internal-error']);

// → { ok, codes, error, benign }. A transport failure is NOT a rejection: if this box cannot reach
// challenges.cloudflare.com, refusing every login would lock the panel out over someone else's
// outage, and password + TOTP still stand behind this. Those pass with ok:true and a soft flag.
async function verify(token, ip, secretOverride) {
  const c = secretOverride ? { secretKey: String(secretOverride).trim() } : get();
  if (!c.secretKey) return { ok: false, codes: ['missing-input-secret'], error: CODE_HELP['missing-input-secret'] };
  if (!token) return { ok: false, codes: ['missing-input-response'], error: CODE_HELP['missing-input-response'] };
  const body = new URLSearchParams({ secret: c.secretKey, response: String(token) });
  if (ip) body.set('remoteip', ip);
  let j;
  try {
    const r = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    j = await r.json();
  } catch (e) {
    console.error('turnstile: cannot reach Cloudflare (' + e.message + ') — letting the login through');
    return { ok: true, soft: 'unreachable: ' + e.message };
  }
  if (j && j.success) return { ok: true, hostname: j.hostname || null };
  const codes = Array.isArray(j && j['error-codes']) ? j['error-codes'] : [];
  const help = codes.map((x) => CODE_HELP[x]).filter(Boolean)[0];
  return { ok: false, codes, benign: codes.some((x) => BENIGN.has(x)), error: help || ('Human verification failed' + (codes.length ? ' (' + codes.join(', ') + ')' : '') + '.') };
}

module.exports = { get, save, siteKey, configured, enabled, masked, verify };
