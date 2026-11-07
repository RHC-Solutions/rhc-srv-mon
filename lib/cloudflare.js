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

// ---- several Cloudflare accounts (Settings → Cloudflare accounts)
// The main token (Settings → Cloudflare) plus any number of connected accounts, each with its own token
// (kv cloudflare.accounts, encrypted). Every API call names its zone or account in the path, so api()
// routes it to the token that can see that zone/account — callers never pick a token.
const acctList = () => settings.get('cloudflare.accounts', []) || [];
const decTok = (v) => { try { return v ? secrets.decrypt(v) : null; } catch (_) { return null; } };
function mainToken() { return decTok(settings.get('cloudflare.token', null)); }
function token() { return mainToken() || (acctList()[0] ? decTok(acctList()[0].token_enc) : null); }
function configured() { return !!settings.get('cloudflare.token', null) || acctList().length > 0; }
function allTokens() {
  const out = []; const m = mainToken(); if (m) out.push({ key: 'main', token: m });
  for (const a of acctList()) { const t = decTok(a.token_enc); if (t) out.push({ key: a.id, token: t, name: a.name }); }
  return out;
}
// zone id / account id → token, built from each token's zone list (5 min)
let routes = null, routesAt = 0, routing = null;
async function routeTable() {
  if (routes && Date.now() - routesAt < 300_000) return routes;
  if (routing) return routing;
  routing = (async () => {
    const zone = new Map(), acct = new Map();
    for (const t of allTokens()) {
      let zl = []; try { zl = await zones(t.token); } catch (_) {}
      for (const z of zl) { if (!zone.has(z.id)) zone.set(z.id, t.token); if (z.account && !acct.has(z.account.id)) acct.set(z.account.id, t.token); }
      if (t.key !== 'main' && !acct.has(t.key)) acct.set(t.key, t.token);
    }
    routes = { zone, acct }; routesAt = Date.now(); routing = null; return routes;
  })();
  return routing;
}
async function routeToken(path) {
  const all = allTokens(); if (all.length <= 1) return all[0] ? all[0].token : null;
  const m = /^\/(zones|accounts)\/([0-9a-f]{32})/.exec(path);
  if (!m) return token();
  const r = await routeTable();
  return (m[1] === 'zones' ? r.zone.get(m[2]) : r.acct.get(m[2])) || token();
}
function setToken(t) {
  cache.clear();
  if (!t) { settings.del('cloudflare.token'); return false; }
  settings.set('cloudflare.token', secrets.encrypt(String(t).trim()));
  return true;
}
function masked() { const t = token(); return t ? t.slice(0, 4) + '…' + t.slice(-4) : null; }

async function api(path, opts) {
  const t = (opts && opts.token) || await routeToken(path);
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
// No token given: the zones of EVERY connected account (each zone carries its account).
async function zonesAll(opts) {
  const seen = new Map();
  for (const t of allTokens()) { let zl = []; try { zl = await zonesOne(t.token, opts); } catch (_) {} for (const z of zl) if (!seen.has(z.id)) seen.set(z.id, z); }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function zones(tok, opts) {
  if (!tok && allTokens().length > 1) return zonesAll(opts);
  return zonesOne(tok, opts);
}
async function zonesOne(tok, opts) {
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
// Cloudflare answers 10000 "Authentication error" both when a permission is absent and when the zone
// is outside the token's resources, which are opposite fixes. Probing endpoints that need different
// permissions on the SAME zone tells them apart: if Zone:Read works on the zone, the zone is in
// scope and the failure is a missing permission; if it does not, the resource list is the problem.
const zonePermCache = new Map();   // zoneId|tokenKey -> diagnosis
async function diagnoseZone(zoneId, tok) {
  const key = zoneId + '|' + ckey(tok);
  const hit = zonePermCache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const probe = async (path) => { try { await api(path, tok ? { token: tok } : undefined); return true; } catch (e) { return e.cfCode || false; } };
  const zoneRead = await probe('/zones/' + zoneId);
  const dnsRecords = await probe('/zones/' + zoneId + '/dns_records?per_page=1');
  const dnsSettings = zoneRead === true && dnsRecords !== true ? await probe('/zones/' + zoneId + '/dns_settings') : null;
  let verdict, message;
  if (dnsRecords === true) { verdict = 'ok'; message = 'The token can read this zone\'s DNS records.'; }
  else if (zoneRead !== true) {
    verdict = 'zone-not-in-scope';
    message = 'The token cannot read this zone at all, so the problem is its Zone Resources (or the zone belongs to another Cloudflare account) — not a missing DNS permission. '
      + 'Edit the token and set Zone Resources to include this zone, or connect a token created in the account that owns the domain.';
  } else {
    verdict = 'dns-permission-missing';
    message = 'The zone IS within this token\'s resources' + (dnsSettings === true ? ' — Zone:Read and Zone DNS Settings both work on it' : '')
      + ', so the DNS records permission is simply absent. Edit the token and tick the row literally called "DNS" ("Grants read access to DNS") → Edit, '
      + 'then complete the save (Continue to summary → Update token) — ticking the box alone does not persist it. '
      + 'Note that "Zone DNS Settings" is a different permission and never grants access to records.';
  }
  const value = { verdict, message, probes: { zoneRead, dnsSettings, dnsRecords } };
  zonePermCache.set(key, { at: Date.now(), value });
  return value;
}

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
    if (!byZone.has(z.id)) byZone.set(z.id, await dnsRecords(z.id).catch(async (e) => ({ error: e.message, diagnosis: await diagnoseZone(z.id).catch(() => null) })));
    const recs = byZone.get(z.id);
    if (recs.error) { sites.push({ domain, zone: z.name, zone_status: z.status, account: z.account ? z.account.name : null, error: recs.error, diagnosis: recs.diagnosis || null }); continue; }
    const mine = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === domain.toLowerCase());
    const www = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === 'www.' + domain.toLowerCase());
    sites.push({ domain, zone: z.name, zone_status: z.status, account: z.account ? z.account.name : null, records: mine, www, points_here: mine.some((r) => r.type === 'A' && r.content === serverIp), proxied: mine.length ? mine.every((r) => r.proxied) : null });
  }
  return { zones: zl, sites };
}
// What a token can do — read checks, plus one real DNS write test (a TXT record created and deleted
// at once) because "can read DNS" does not mean "can edit DNS" (that was exactly the gap on sbapps01).
async function capabilities(tok, acctId, zoneList) {
  const T = { token: tok };
  const ok = async (p) => { try { await api(p, T); return true; } catch (_) { return false; } };
  const caps = { zones: zoneList.length, dnsRead: 0, dnsEdit: null, tunnels: null, access: null, firewall: null, ssl: null };
  let editZone = null;
  for (const z of zoneList.slice(0, 60)) if (await ok('/zones/' + z.id + '/dns_records?per_page=1')) { caps.dnsRead++; if (!editZone) editZone = z; }
  if (editZone) {
    try {
      const r = await api('/zones/' + editZone.id + '/dns_records', Object.assign({ method: 'POST', body: { type: 'TXT', name: '_sb-srv-mon-check.' + editZone.name, content: 'permission check, deleted at once', ttl: 60 } }, T));
      await api('/zones/' + editZone.id + '/dns_records/' + r.result.id, Object.assign({ method: 'DELETE' }, T));
      caps.dnsEdit = true;
    } catch (_) { caps.dnsEdit = false; }
  }
  if (acctId) {
    caps.tunnels = await ok('/accounts/' + acctId + '/cfd_tunnel?per_page=1');
    caps.access = await ok('/accounts/' + acctId + '/access/apps?per_page=1');
    caps.firewall = await ok('/accounts/' + acctId + '/firewall/access_rules/rules?per_page=1');
  }
  if (zoneList[0]) caps.ssl = await ok('/zones/' + zoneList[0].id + '/ssl/certificate_packs?per_page=1');
  return caps;
}
async function describeToken(tok) {
  const zl = await zonesOne(tok, { fresh: true }).catch(() => []);
  let acct = zl.find((z) => z.account) ? zl.find((z) => z.account).account : null;
  if (!acct) { try { const r = await api('/accounts?per_page=5', { token: tok }); if (r.result && r.result[0]) acct = { id: r.result[0].id, name: r.result[0].name }; } catch (_) {} }
  if (!acct) throw Object.assign(new Error('this token sees no Cloudflare account or zone — check it has Zone → Zone → Read for all zones of the account'), { status: 400 });
  const own = zl.filter((z) => z.account && z.account.id === acct.id);
  return { account: acct, zones: own.length ? own : zl };
}
async function connectAccount(tokenStr) {
  const t = String(tokenStr || '').trim();
  if (!/^[A-Za-z0-9_\-.]{20,200}$/.test(t)) throw Object.assign(new Error('that does not look like a Cloudflare API token'), { status: 400 });
  const d = await describeToken(t);
  const caps = await capabilities(t, d.account.id, d.zones);
  const list = acctList().filter((a) => a.id !== d.account.id);
  list.push({ id: d.account.id, name: d.account.name, token_enc: secrets.encrypt(t), zones: d.zones.map((z) => z.name), caps, checked: new Date().toISOString(), added: new Date().toISOString() });
  settings.set('cloudflare.accounts', list);
  cache.clear(); routes = null;
  return accountView(list.find((a) => a.id === d.account.id));
}
async function recheck(id) {
  if (id === 'main') { const t = mainToken(); if (!t) throw Object.assign(new Error('no main token'), { status: 404 }); const d = await describeToken(t); const caps = await capabilities(t, d.account.id, d.zones); settings.set('cloudflare.mainCaps', { account: d.account, zones: d.zones.map((z) => z.name), caps, checked: new Date().toISOString() }); return mainView(); }
  const list = acctList(); const a = list.find((x) => x.id === id); if (!a) throw Object.assign(new Error('no such account'), { status: 404 });
  const t = decTok(a.token_enc); const d = await describeToken(t);
  Object.assign(a, { name: d.account.name, zones: d.zones.map((z) => z.name), caps: await capabilities(t, a.id, d.zones), checked: new Date().toISOString() });
  settings.set('cloudflare.accounts', list); cache.clear(); routes = null;
  return accountView(a);
}
function disconnect(id) {
  if (id === 'main') { settings.del('cloudflare.token'); settings.del('cloudflare.mainCaps'); }
  else settings.set('cloudflare.accounts', acctList().filter((a) => a.id !== id));
  cache.clear(); routes = null;
}
// The old single "main token" (Settings → Cloudflare, removed) folds into Cloudflare accounts:
// every account it sees that is not connected yet becomes a connected account with that token; accounts
// already connected keep their own token. Then the main token is dropped. Network failure → try next start.
async function migrateMain() {
  const t = mainToken(); if (!t) return null;
  const zl = await zonesOne(t, { fresh: true });
  const byAcct = new Map();
  for (const z of zl) if (z.account) { if (!byAcct.has(z.account.id)) byAcct.set(z.account.id, { account: z.account, zones: [] }); byAcct.get(z.account.id).zones.push(z); }
  if (!byAcct.size) { const d = await describeToken(t); byAcct.set(d.account.id, d); }
  const list = acctList(); const added = [], kept = [];
  for (const d of byAcct.values()) {
    if (list.some((a) => a.id === d.account.id)) { kept.push(d.account.name); continue; }
    const caps = await capabilities(t, d.account.id, d.zones);
    list.push({ id: d.account.id, name: d.account.name, token_enc: secrets.encrypt(t), zones: d.zones.map((z) => z.name), caps, checked: new Date().toISOString(), added: new Date().toISOString(), from: 'main token' });
    added.push(d.account.name);
  }
  settings.set('cloudflare.accounts', list);
  settings.del('cloudflare.token'); settings.del('cloudflare.mainCaps');
  cache.clear(); routes = null;
  return { added, kept };
}
const accountView = (a) => ({ id: a.id, name: a.name, zones: a.zones || [], caps: a.caps || null, checked: a.checked || null, main: false, token: (() => { const t = decTok(a.token_enc); return t ? t.slice(0, 4) + '…' + t.slice(-4) : ''; })() });
function mainView() { const m = settings.get('cloudflare.mainCaps', null); const t = mainToken(); if (!t) return null; return { id: 'main', name: m && m.account ? m.account.name + ' (main token)' : 'Main token', accountId: m && m.account ? m.account.id : null, zones: m ? m.zones : [], caps: m ? m.caps : null, checked: m ? m.checked : null, main: true, token: t.slice(0, 4) + '…' + t.slice(-4) }; }
function accounts() { return [mainView(), ...acctList().map(accountView)].filter(Boolean); }
function accountToken(id) { if (id === 'main') return mainToken(); const a = acctList().find((x) => x.id === id); return a ? decTok(a.token_enc) : null; }
// Pre-filled "Create API token" page in the Cloudflare dashboard (account-owned token; Cloudflare asks which account).
function connectLink() {
  const keys = [{ key: 'dns', type: 'edit' }];
  return 'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=' + encodeURIComponent(JSON.stringify(keys)) + '&name=' + encodeURIComponent('sb-srv-mon (' + require('os').hostname() + ')');
}

module.exports = { migrateMain, accounts, connectAccount, recheck, disconnect, accountToken, connectLink, capabilities, configured, setToken, masked, verify, accountVerify, diagnose, diagnoseZone, accountOwned, invalidate, zones, dnsRecords, zoneFor, overview, api };
