'use strict';
// Cloudflare API v4 client. The token (Zone:Read, DNS:Edit is enough for now) is stored encrypted in
// kv `cloudflare.token`. Read helpers are cached for 60 s; DNS management arrives with the Settings phase.
const crypto = require('crypto');
const { settings } = require('./db');
const secrets = require('./secrets');

const API = 'https://api.cloudflare.com/client/v4';
// What Cloudflare's error codes actually mean, in words the person holding the token can act on.
// The API is terse and, worse, inconsistent: the same dead token yields 1000 from one endpoint and
// 9109 from another, so the code alone is not enough to tell a user what to fix.
const UNKNOWN_TOKEN = 'Cloudflare does not recognise this token string at all. Either it was rolled or deleted in the dashboard, or a character was lost when it was copied. Cloudflare shows a token only once, so it cannot be looked up — create a new one.';
const IP_BLOCKED = 'The token is real, but it is restricted to specific client IP addresses and this server is not one of them. In the Cloudflare dashboard open My Profile → API Tokens → this token → Client IP Address Filtering, and either add the address named in the error above or remove the condition.';
const CODE_HELP = {
  1000: UNKNOWN_TOKEN + ' Cloudflare also answers 1000 when an account-owned token (cfat_…) is sent to the user-token endpoint, so read the other lines before concluding the token is dead.',
  1001: 'Cloudflare could not resolve the request — usually a malformed path rather than a credential problem.',
  6003: 'The Authorization header itself was rejected: the token is empty, truncated, or contains characters that cannot be in a bearer token.',
  9103: 'Unknown or invalid API token.',
  9106: 'No API token was sent at all.',
  9109: UNKNOWN_TOKEN,   // Cloudflare reuses 9109 for "Invalid access token" AND for the IP restriction below
  10502: 'Cloudflare has temporarily rate-limited authentication from this server after repeated failures. Wait a few minutes before testing again — retrying immediately only extends the block.',
  10000: 'Authentication failed: the token exists but is not permitted to make this particular call. Check the token\'s Permissions and the Account/Zone Resources it was scoped to.',
};
// Pull the useful bits out of a Cloudflare error envelope.
function cfErrors(j, status) {
  const list = (j && Array.isArray(j.errors) ? j.errors : []).map((e) => ({
    code: e.code || null,
    message: e.message || '',
    chain: (e.error_chain || []).map((c) => '[' + c.code + '] ' + c.message),
  }));
  if (!list.length) list.push({ code: null, message: 'HTTP ' + status, chain: [] });
  return list;
}
const fmtErr = (e) => (e.code ? '[' + e.code + '] ' : '') + e.message + (e.chain.length ? ' — ' + e.chain.join('; ') : '');
const cache = new Map();   // key -> { at, value }
const TTL = 60_000;

function token() {
  const enc = settings.get('cloudflare.token', null);
  if (!enc) return null;
  try { return secrets.decrypt(enc); } catch (_) { return null; }
}
function configured() { return !!settings.get('cloudflare.token', null); }
function setToken(t) {
  cache.clear();
  if (!t) { settings.del('cloudflare.token'); return false; }
  settings.set('cloudflare.token', secrets.encrypt(String(t).trim()));
  return true;
}
function masked() { const t = token(); return t ? t.slice(0, 4) + '…' + t.slice(-4) : null; }

async function api(path, opts) {
  const t = (opts && opts.token) || token();
  if (!t) throw Object.assign(new Error('Cloudflare API token not configured'), { status: 409 });
  const r = await fetch(API + path, { method: (opts && opts.method) || 'GET', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: opts && opts.body ? JSON.stringify(opts.body) : undefined, signal: AbortSignal.timeout(20_000) });
  let j; try { j = await r.json(); } catch (_) { j = {}; }
  if (!r.ok || j.success === false) {
    const errs = cfErrors(j, r.status);
    // No 'Cloudflare: ' prefix here — every caller already says which service failed, and prefixing
    // at both layers is what produced "Cloudflare: Cloudflare: Invalid API Token".
    throw Object.assign(new Error(errs.map(fmtErr).join('; ')), {
      status: r.status === 401 || r.status === 403 ? 403 : 502,
      cfErrors: errs, cfCode: errs[0].code, cfStatus: r.status, cfPath: path,
    });
  }
  return j;
}
async function cached(key, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.at < TTL) return c.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const accountOwned = (t) => /^cfat_/.test(String(t || ''));
// Ask several endpoints and report what each one said. One call cannot distinguish "this token does
// not exist" from "it exists but may not be used from here" — /user/tokens/verify answers 1000 to
// both, and to a perfectly good account-owned token as well.
// The right verify endpoint for an account-owned token: /user/tokens/verify only knows user tokens.
// Needs the account id, which the token itself can tell us if it carries any account permission.
async function accountVerify(t) {
  const a = await api('/accounts?per_page=1', t ? { token: t } : undefined);
  const acct = (a.result || [])[0];
  if (!acct) throw Object.assign(new Error('no account visible to this token'), { status: 403 });
  const j = await api('/accounts/' + acct.id + '/tokens/verify', t ? { token: t } : undefined);
  return Object.assign({}, j.result, { account: { id: acct.id, name: acct.name } });
}
async function diagnose(t, seed) {
  const out = seed ? [seed] : [];
  for (const [label, path] of [['/zones', '/zones?per_page=1'], ['/accounts', '/accounts?per_page=1']]) {
    if (out.some((p) => p.ok)) break;                     // one working endpoint is proof enough
    if (out.some((p) => p.code === 10502)) break;          // rate-limited: stop adding failed auths
    try { const j = await api(path, t ? { token: t } : undefined); out.push({ label, ok: true, note: j.result_info ? j.result_info.total_count + ' visible' : 'ok' }); }
    catch (e) { out.push({ label, ok: false, code: e.cfCode || null, message: e.message }); }
  }
  return out;
}
function report(probes, t) {
  const lines = probes.map((p) => '  ' + p.label.padEnd(22) + (p.ok ? '→ ok · ' + p.note : '→ ' + p.message));
  const codes = probes.filter((p) => !p.ok && p.code).map((p) => p.code);
  // The same code means different things depending on the message, so match on both and de-duplicate
  // the resulting advice — a dead token otherwise gets told twice that it is dead, in two wordings.
  const hints = [];
  const exists = probes.some((p) => !p.ok && /from location/i.test(p.message));   // it answered about *this* token
  for (const p of probes) {
    if (p.ok || !p.code) continue;
    const h = /from location/i.test(p.message) ? IP_BLOCKED : CODE_HELP[p.code];
    if (!h) continue;
    if (exists && h.startsWith(UNKNOWN_TOKEN)) continue;          // do not also claim it does not exist
    const dup = hints.findIndex((x) => x.startsWith(UNKNOWN_TOKEN) && h.startsWith(UNKNOWN_TOKEN));
    if (dup >= 0) { if (h.length > hints[dup].length) hints[dup] = h; continue; }
    if (!hints.includes(h)) hints.push(h);
  }
  if (accountOwned(t) && codes.includes(1000) && probes.some((p) => p.ok || p.code === 9109))
    hints.push('This is an account-owned token (the cfat_ prefix). Cloudflare\'s /user/tokens/verify only accepts user tokens, which is why it reports 1000 even when the token works — the panel falls back to listing zones for these.');
  return 'What each Cloudflare endpoint said:\n' + lines.join('\n') + (hints.length ? '\n\n' + hints.join('\n\n') : '');
}
// { id, status, expires_on, not_before, kind, note } — throws with a per-endpoint report on failure.
async function verify(t) {
  try {
    const j = await api('/user/tokens/verify', { token: t });
    return Object.assign({ kind: 'user' }, j.result);
  } catch (first) {
    // Before giving up, ask the endpoint that actually understands account-owned tokens.
    try {
      const r = await accountVerify(t);
      if (r && r.status) return { id: r.id || null, status: r.status, expires_on: r.expires_on || null, not_before: r.not_before || null,
        kind: 'account', account: r.account, note: 'verified as an account-owned token via /accounts/' + r.account.id + '/tokens/verify (Cloudflare\'s /user/tokens/verify only accepts user tokens)' };
    } catch (_) { /* fall through to the full diagnosis */ }
    const probes = await diagnose(t, { label: '/user/tokens/verify', ok: false, code: first.cfCode || null, message: first.message });
    const usable = probes.find((p) => p.ok && p.label !== '/user/tokens/verify');
    if (usable) {
      // The token works; only the user-token endpoint refuses it (account-owned tokens do this).
      return { id: null, status: 'active', expires_on: null, not_before: null, kind: accountOwned(t) ? 'account' : 'user',
        note: 'checked by calling ' + usable.label + ' — Cloudflare\'s /user/tokens/verify does not accept this token type' };
    }
    const specific = probes.filter((p) => !p.ok && p.code && p.code !== 1000)[0] || probes.filter((p) => !p.ok)[0];
    throw Object.assign(new Error(specific ? specific.message : first.message),
      { status: first.status || 403, detail: report(probes, t), cfErrors: first.cfErrors, cfCode: specific ? specific.code : first.cfCode });
  }
}
// Cache per credential: sites hold their own tokens now, and two tokens see different zones, so a
// single 'zones' key would hand one site another's account.
const ckey = (tok) => (tok ? 'k' + crypto.createHash('sha1').update(String(tok)).digest('hex').slice(0, 10) : 'acct');
async function zones(tok, opts) {
  const run = async () => {
    const out = [];
    for (let page = 1; page < 20; page++) {
      const j = await api('/zones?per_page=50&page=' + page, tok ? { token: tok } : undefined);
      out.push(...j.result.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan && z.plan.name, name_servers: z.name_servers,
        account: z.account ? { id: z.account.id, name: z.account.name } : null })));
      if (!j.result_info || page >= j.result_info.total_pages) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  };
  if (opts && opts.fresh) { const v = await run(); cache.set('zones:' + ckey(tok), { at: Date.now(), value: v }); return v; }
  return cached('zones:' + ckey(tok), run);
}
async function dnsRecords(zoneId, tok, opts) {
  const run = async () => {
    const out = [];
    for (let page = 1; page < 40; page++) {
      const j = await api('/zones/' + zoneId + '/dns_records?per_page=100&page=' + page, tok ? { token: tok } : undefined);
      out.push(...j.result.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: !!r.proxied, ttl: r.ttl })));
      if (!j.result_info || page >= j.result_info.total_pages) break;
    }
    return out;
  };
  if (opts && opts.fresh) { const v = await run(); cache.set('dns:' + zoneId, { at: Date.now(), value: v }); return v; }
  return cached('dns:' + zoneId, run);
}
// Drop cached records for a zone after a write, so the tab redraws from the truth.
function invalidate(zoneId) { if (zoneId) cache.delete('dns:' + zoneId); else cache.clear(); }
function zoneFor(domain, zoneList) {
  const d = String(domain).toLowerCase();
  return zoneList.filter((z) => d === z.name || d.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0] || null;
}
// Which zones exist and how each of our site domains resolves through Cloudflare.
async function overview(domains, serverIp) {
  const zl = await zones();
  const byZone = new Map();
  const sites = [];
  for (const domain of domains) {
    const z = zoneFor(domain, zl);
    if (!z) { sites.push({ domain, zone: null }); continue; }
    if (!byZone.has(z.id)) byZone.set(z.id, await dnsRecords(z.id).catch((e) => ({ error: e.message })));
    const recs = byZone.get(z.id);
    if (recs.error) { sites.push({ domain, zone: z.name, zone_status: z.status, account: z.account ? z.account.name : null, error: recs.error }); continue; }
    const mine = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === domain.toLowerCase());
    const www = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === 'www.' + domain.toLowerCase());
    sites.push({ domain, zone: z.name, zone_status: z.status, account: z.account ? z.account.name : null, records: mine, www, points_here: mine.some((r) => r.type === 'A' && r.content === serverIp), proxied: mine.length ? mine.every((r) => r.proxied) : null });
  }
  return { zones: zl, sites };
}
module.exports = { configured, setToken, masked, verify, accountVerify, diagnose, accountOwned, invalidate, zones, dnsRecords, zoneFor, overview, api };
