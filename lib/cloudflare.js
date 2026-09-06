'use strict';
// Cloudflare API v4 client. The token (Zone:Read, DNS:Edit is enough for now) is stored encrypted in
// kv `cloudflare.token`. Read helpers are cached for 60 s; DNS management arrives with the Settings phase.
const { settings } = require('./db');
const secrets = require('./secrets');

const API = 'https://api.cloudflare.com/client/v4';
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
    const msg = (j.errors && j.errors.map((e) => e.message).join('; ')) || ('HTTP ' + r.status);
    throw Object.assign(new Error('Cloudflare: ' + msg), { status: r.status === 401 || r.status === 403 ? 403 : 502 });
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
async function verify(t) {
  const j = await api('/user/tokens/verify', { token: t });
  return j.result;   // { id, status, expires_on, not_before }
}
async function zones() {
  return cached('zones', async () => {
    const out = [];
    for (let page = 1; page < 20; page++) {
      const j = await api('/zones?per_page=50&page=' + page);
      out.push(...j.result.map((z) => ({ id: z.id, name: z.name, status: z.status, paused: z.paused, plan: z.plan && z.plan.name, name_servers: z.name_servers, account: z.account && z.account.name })));
      if (!j.result_info || page >= j.result_info.total_pages) break;
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  });
}
async function dnsRecords(zoneId) {
  return cached('dns:' + zoneId, async () => {
    const out = [];
    for (let page = 1; page < 40; page++) {
      const j = await api('/zones/' + zoneId + '/dns_records?per_page=100&page=' + page);
      out.push(...j.result.map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: !!r.proxied, ttl: r.ttl })));
      if (!j.result_info || page >= j.result_info.total_pages) break;
    }
    return out;
  });
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
    if (!byZone.has(z.id)) byZone.set(z.id, await dnsRecords(z.id).catch((e) => ({ error: e.message })));
    const recs = byZone.get(z.id);
    if (recs.error) { sites.push({ domain, zone: z.name, error: recs.error }); continue; }
    const mine = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === domain.toLowerCase());
    const www = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === 'www.' + domain.toLowerCase());
    sites.push({ domain, zone: z.name, zone_status: z.status, records: mine, www, points_here: mine.some((r) => r.type === 'A' && r.content === serverIp), proxied: mine.length ? mine.every((r) => r.proxied) : null });
  }
  return { zones: zl, sites };
}
module.exports = { configured, setToken, masked, verify, zones, dnsRecords, zoneFor, overview, api };
