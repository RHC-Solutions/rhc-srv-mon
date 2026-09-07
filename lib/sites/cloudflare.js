'use strict';
// Cloudflare, per site. The panel manages domains spread across several Cloudflare accounts, and an
// account-owned token can only ever see zones in its own account — so the credential belongs to the
// site. A site with no token of its own falls back to the account-wide one in Settings, which is
// enough while every domain lives in one account and stops being enough the moment one does not.
const cf = require('../cloudflare');
const store = require('./store');

const bad = (msg, status, detail) => Object.assign(new Error(msg), { status: status || 400, detail });

// Which credential this site uses: its own, the account-wide one, or nothing.
function source(site) {
  const own = store.cloudflare.token(site.id);
  if (own) return { token: own, source: 'site' };
  const shared = cf.configured() ? undefined : null;      // undefined = use the module's stored token
  if (shared === null) return { token: null, source: null };
  return { token: undefined, source: 'account' };
}

// Resolve the zone that covers this domain, using whichever credential applies.
async function resolveZone(site, tokenOverride) {
  const s = tokenOverride !== undefined ? { token: tokenOverride, source: 'site' } : source(site);
  if (s.source === null) throw bad('no Cloudflare token for this site and none configured account-wide', 409);
  const zones = await cf.zones(s.token);
  const zone = cf.zoneFor(site.domain, zones);
  if (!zone) {
    throw bad('this token cannot see a zone for ' + site.domain, 404,
      'The token authenticates, but no zone it can reach covers this domain.\n\n'
      + (zones.length ? 'Zones it can see: ' + zones.map((z) => z.name).join(', ') : 'It can see no zones at all — add the "Zone → Zone → Read" permission.')
      + '\n\nIf ' + site.domain + ' lives in a different Cloudflare account, no permission change to this token will help: an account-owned token is bound to its account. Connect this site with a token created in the account that holds the domain.');
  }
  return { zone, zones, ...s };
}

// Everything the Cloudflare tab shows for one site.
async function status(site, serverIp) {
  const row = store.cloudflare.get(site.id);
  const s = source(site);
  const out = {
    domain: site.domain, source: s.source, hasOwnToken: s.source === 'site',
    accountWideConfigured: cf.configured(), zone: null, account: null, records: [], www: [],
    points_here: null, proxied: null, serverIp: serverIp || null, error: null, diagnosis: null,
    stored: row ? { zone_name: row.zone_name, account_name: row.account_name, checked_at: row.checked_at, last_error: row.last_error } : null,
  };
  if (s.source === null) return out;
  try {
    const { zone } = await resolveZone(site);
    out.zone = { id: zone.id, name: zone.name, status: zone.status, paused: zone.paused, plan: zone.plan };
    out.account = zone.account || null;
    const recs = await cf.dnsRecords(zone.id, s.token);
    const d = site.domain.toLowerCase();
    const kinds = ['A', 'AAAA', 'CNAME'];
    out.records = recs.filter((r) => kinds.includes(r.type) && r.name.toLowerCase() === d);
    out.www = recs.filter((r) => kinds.includes(r.type) && r.name.toLowerCase() === 'www.' + d);
    out.proxied = out.records.length ? out.records.every((r) => r.proxied) : null;
    out.points_here = serverIp ? out.records.some((r) => r.type === 'A' && r.content === serverIp) : null;
    store.cloudflare.set(site.id, { zone_id: zone.id, zone_name: zone.name, account_id: zone.account && zone.account.id, account_name: zone.account && zone.account.name, last_error: null });
  } catch (e) {
    out.error = e.message;
    out.errorDetail = e.detail || null;
    // 10000 means either "permission absent" or "zone outside this token's resources" — opposite
    // fixes. Ask Cloudflare which, by probing endpoints needing different permissions on this zone.
    if (!out.errorDetail && out.zone && (e.cfCode === 10000 || /\[10000\]/.test(e.message))) {
      try { const d = await cf.diagnoseZone(out.zone.id, s.token); out.diagnosis = d; out.errorDetail = d.message; } catch (_) {}
    }
    if (row) store.cloudflare.set(site.id, { last_error: e.message });
  }
  return out;
}

// Attach a token to this site: verify it, prove it can see the domain's zone, then store it.
async function connect(site, token) {
  const t = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{30,}$/.test(t)) throw bad('that does not look like a Cloudflare API token');
  const v = await cf.verify(t);                                  // throws with a per-endpoint report
  if (!v || v.status !== 'active') throw bad('Cloudflare reports this token as "' + ((v && v.status) || 'invalid') + '"');
  const { zone } = await resolveZone(site, t);                   // must actually cover this domain
  store.cloudflare.set(site.id, { token: t, zone_id: zone.id, zone_name: zone.name,
    account_id: (zone.account && zone.account.id) || (v.account && v.account.id) || null,
    account_name: (zone.account && zone.account.name) || (v.account && v.account.name) || null, last_error: null });
  return { ok: true, zone: { id: zone.id, name: zone.name }, account: zone.account || v.account || null, verify: v };
}
function disconnect(site) { store.cloudflare.remove(site.id); return { ok: true }; }

// Point the domain (and www, if it already exists as A/AAAA) at this server.
async function pointHere(site, serverIp, opts) {
  opts = opts || {};
  const { zone, token } = await resolveZone(site);
  const recs = await cf.dnsRecords(zone.id, token, { fresh: true });
  const d = site.domain.toLowerCase();
  const mine = recs.filter((r) => ['A', 'AAAA', 'CNAME'].includes(r.type) && r.name.toLowerCase() === d);
  const proxied = opts.proxied === undefined ? true : !!opts.proxied;
  const changes = [];
  const a = mine.find((r) => r.type === 'A');
  if (a && a.content === serverIp && a.proxied === proxied) changes.push({ action: 'unchanged', id: a.id, content: a.content });
  else if (a) { await cf.api('/zones/' + zone.id + '/dns_records/' + a.id, { method: 'PATCH', body: { content: serverIp, proxied }, token }); changes.push({ action: 'updated', id: a.id, from: a.content, to: serverIp }); }
  else { const r = await cf.api('/zones/' + zone.id + '/dns_records', { method: 'POST', body: { type: 'A', name: site.domain, content: serverIp, proxied, ttl: 1 }, token }); changes.push({ action: 'created', id: r.result && r.result.id, to: serverIp }); }
  // A CNAME on the apex alongside an A record is a conflict the user has to resolve deliberately.
  for (const c of mine.filter((r) => r.type === 'CNAME')) changes.push({ action: 'left alone', id: c.id, note: 'CNAME → ' + c.content + ' still exists and will win or conflict; remove it in Cloudflare' });
  cf.invalidate(zone.id);
  return { ok: true, zone: zone.name, changes };
}
// Flip the orange cloud on one record.
async function setProxied(site, recordId, proxied) {
  const { zone, token } = await resolveZone(site);
  const r = await cf.api('/zones/' + zone.id + '/dns_records/' + recordId, { method: 'PATCH', body: { proxied: !!proxied }, token });
  cf.invalidate(zone.id);
  return { ok: true, record: r.result };
}
module.exports = { status, connect, disconnect, pointHere, setProxied, resolveZone, source };
