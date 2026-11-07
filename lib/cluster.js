'use strict';
// Server-to-server transport, used by Transfer (left menu → Transfer): moving sites from one SB SRV
// Manager to another WITHOUT joining them permanently. (Clustering — several servers as one system —
// is a separate feature built on this same signed transport.)
//
// Trust. The TARGET creates a one-time transfer code (valid 1 h) holding its URL, a fresh 256-bit pair key
// and the Cloudflare Access service token that lets machines through A's Access login. Server B
// pastes it: B calls A's /api/cluster/join signed with that key, A records B (with B's own Access
// token), B records A. From then on every request between the two carries
//   X-Cluster-Node (sender id) · X-Cluster-Ts (unix s) · X-Cluster-Sig = HMAC-SHA256(pair key,
//   method \n path \n ts \n sha256(body))
// and is refused when the node is unknown, the clock is >5 min off, the signature is wrong, or the
// signature was already seen (replay). Peer routes (/api/cluster/peer/*) are exempt from the browser
// login — the signature IS their login. Pair keys and Access secrets are stored encrypted.
const crypto = require('crypto');
const os = require('os');
const { settings } = require('./db');
const secrets = require('./secrets');
const { execP } = require('./util');

const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const enc = (v) => (v ? secrets.encrypt(v) : null);
const dec = (v) => { try { return v ? secrets.decrypt(v) : null; } catch (_) { return null; } };
const sha256 = (b) => crypto.createHash('sha256').update(b || '').digest('hex');

// ------------------------------------------------------------------ this server
function self() {
  let s = settings.get('cluster.self', null);
  if (!s) { s = { id: crypto.randomUUID(), name: os.hostname(), url: '' }; settings.set('cluster.self', s); }
  return s;
}
function setSelf(p) {
  const s = self();
  if (p.url != null) {
    let u = String(p.url).trim();
    const devLocal = process.env.RHC_DEV && /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(u);   // two dev instances on one box (tests)
    if (u && !devLocal && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u)) throw bad('panel URL must be https://host/path/');
    if (u && !u.endsWith('/')) u += '/';
    s.url = u;
  }
  if (p.name != null) { const n = String(p.name).trim(); if (n.length < 2 || n.length > 60) throw bad('name: 2–60 characters'); s.name = n; }
  if (p.accessClientId != null || p.accessClientSecret != null) {
    const a = settings.get('cluster.access', {}) || {};
    if (p.accessClientId != null) a.clientId = String(p.accessClientId).trim();
    if (p.accessClientSecret) a.secret_enc = enc(String(p.accessClientSecret).trim());
    if (p.accessClientId === '') { a.clientId = ''; a.secret_enc = null; }
    settings.set('cluster.access', a);
  }
  settings.set('cluster.self', s);
  return selfView();
}
function selfAccess() { const a = settings.get('cluster.access', {}) || {}; return a.clientId && a.secret_enc ? { clientId: a.clientId, clientSecret: dec(a.secret_enc) } : null; }
async function version() { const r = await execP('git', ['-c', 'safe.directory=*', '-C', require('./config').APP_ROOT, 'rev-parse', '--short', 'HEAD'], { timeout: 10_000 }); return r.stdout.trim() || null; }
function selfView() { const s = self(); const a = settings.get('cluster.access', {}) || {}; return { id: s.id, name: s.name, url: s.url, accessClientId: a.clientId || '', hasAccessSecret: !!a.secret_enc }; }

// ------------------------------------------------------------------ peers
// Pairings made by a transfer code are temporary: they expire (TEMP_TTL after creation) and are
// forgotten by both sides as soon as the transfer is finished.
const TEMP_TTL = 6 * 3600_000;
const peersRaw = () => {
  const all = settings.get('cluster.peers', []) || [];
  const live = all.filter((p) => !p.expires || p.expires > Date.now());
  if (live.length !== all.length) settings.set('cluster.peers', live);
  return live;
};
const savePeers = (l) => settings.set('cluster.peers', l);
function peers() { return peersRaw().map((p) => ({ temp: !!p.expires, expires: p.expires ? new Date(p.expires).toISOString() : null, id: p.id, name: p.name, url: p.url, added: p.added, lastSeen: p.lastSeen || null, lastError: p.lastError || null, version: p.version || null, sites: p.sites || [] })); }
function peer(id) { const p = peersRaw().find((x) => x.id === id); if (!p) throw bad('unknown cluster member', 404); return p; }
function upsertPeer(p) { const l = peersRaw().filter((x) => x.id !== p.id); l.push(p); savePeers(l); }
function removePeer(id) { savePeers(peersRaw().filter((x) => x.id !== id)); }
function notePeer(id, patch) { const l = peersRaw(); const p = l.find((x) => x.id === id); if (p) { Object.assign(p, patch); savePeers(l); } }

// ------------------------------------------------------------------ signing
function sig(key, method, path, ts, bodyHash) { return crypto.createHmac('sha256', key).update([method.toUpperCase(), path, ts, bodyHash].join('\n')).digest('hex'); }
const seenSigs = new Map();
function verify(req, path, body) {
  const id = String(req.headers['x-cluster-node'] || ''), ts = Number(req.headers['x-cluster-ts']), s = String(req.headers['x-cluster-sig'] || '');
  const p = peersRaw().find((x) => x.id === id);
  if (!p) throw bad('unknown cluster member', 401);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) throw bad('request too old or clock skew > 5 min', 401);
  const want = sig(dec(p.key_enc), req.method, path, String(ts), sha256(body));
  if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) throw bad('bad cluster signature', 401);
  const now = Date.now();
  for (const [k, t] of seenSigs) if (now - t > 600_000) seenSigs.delete(k);
  if (seenSigs.has(s)) throw bad('replayed request', 401);
  seenSigs.set(s, now);
  notePeer(id, { lastSeen: new Date().toISOString() });
  return p;
}
// Call a peer. body: object (JSON) or Buffer (raw). Returns parsed JSON.
async function call(p, method, path, body, opts) {
  opts = opts || {};
  const key = p.key || dec(p.key_enc);
  const raw = body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const u = new URL(p.url);
  const fullPath = u.pathname.replace(/\/$/, '') + path;                       // what the peer's router sees after its prefix… see below
  const relPath = path;                                                         // signed over the path the PEER's panel receives (no proxy prefix)
  const headers = { 'X-Cluster-Node': self().id, 'X-Cluster-Ts': ts, 'X-Cluster-Sig': sig(key, method, relPath, ts, sha256(raw)), 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' };
  const access = p.access || (p.access_enc ? JSON.parse(dec(p.access_enc) || 'null') : null);
  if (access && access.clientId) { headers['CF-Access-Client-Id'] = access.clientId; headers['CF-Access-Client-Secret'] = access.clientSecret; }
  let r;
  try { r = await fetch(new URL(fullPath.replace(/^\//, ''), u.origin + '/'), { method, headers, body: raw.length ? raw : undefined, redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 60_000) }); }
  catch (e) { if (p.id) notePeer(p.id, { lastError: e.message }); throw bad('cannot reach ' + (p.name || p.url) + ': ' + (e.cause && e.cause.code || e.message), 424); }
  if (r.status >= 300 && r.status < 400) { const m = 'redirected to ' + (r.headers.get('location') || '?').slice(0, 80) + ' — Cloudflare Access let it through without a valid service token? Check the Access service token of ' + (p.name || p.url); if (p.id) notePeer(p.id, { lastError: m }); throw bad(m, 424); }
  let j = {}; try { j = await r.json(); } catch (_) {}
  if (!r.ok) { const m = (j && j.error) || 'HTTP ' + r.status; if (p.id) notePeer(p.id, { lastError: m }); throw bad((p.name || p.url) + ': ' + m, r.status === 401 ? 424 : (r.status >= 500 ? 424 : r.status), j && j.detail); }
  if (p.id) notePeer(p.id, { lastSeen: new Date().toISOString(), lastError: null });
  return j;
}

// ------------------------------------------------------------------ join
function createJoinCode() {
  const s = self();
  if (!s.url) throw bad('set this panel\'s public URL first (e.g. https://sbapps01.it-saas.com/srvman/)');
  const key = crypto.randomBytes(32).toString('base64url'), nonce = crypto.randomBytes(16).toString('hex');
  const joins = (settings.get('cluster.joins', []) || []).filter((j) => j.expires > Date.now());
  joins.push({ nonce, key_enc: enc(key), expires: Date.now() + 3600_000 });
  settings.set('cluster.joins', joins);
  const code = 'sbt1.' + Buffer.from(JSON.stringify({ u: s.url, i: s.id, n: s.name, k: key, x: nonce, a: selfAccess() })).toString('base64url');
  return { code, expires: new Date(Date.now() + 3600_000).toISOString() };
}
async function joinWith(code) {
  const s = self();
  if (!s.url) throw bad('set this panel\'s public URL first');
  if (!/^sbt1\.[A-Za-z0-9_-]+$/.test(String(code || '').trim())) throw bad('that is not a transfer code (sbt1.…)');
  let j; try { j = JSON.parse(Buffer.from(String(code).trim().slice(5), 'base64url').toString()); } catch (_) { throw bad('that is not a transfer code'); }
  if (j.i === s.id) throw bad('that transfer code is from this same server');
  const target = { id: j.i, name: j.n, url: j.u, key: j.k, access: j.a };
  const r = await call(target, 'POST', '/api/cluster/join', { nonce: j.x, id: s.id, name: s.name, url: s.url, access: selfAccess() });
  upsertPeer({ id: j.i, name: r.name || j.n, url: j.u, key_enc: enc(j.k), access_enc: enc(JSON.stringify(j.a || null)), added: new Date().toISOString(), version: r.version || null, sites: r.sites || [], expires: Date.now() + TEMP_TTL });
  return { joined: r.name || j.n };
}
// Server side of /api/cluster/join (signed with the one-time key behind the nonce).
async function acceptJoin(req, path, body) {
  let b; try { b = JSON.parse(body.toString() || '{}'); } catch (_) { throw bad('bad request'); }
  const joins = settings.get('cluster.joins', []) || [];
  const jn = joins.find((x) => x.nonce === b.nonce && x.expires > Date.now());
  if (!jn) throw bad('join code unknown, used or expired', 401);
  const key = dec(jn.key_enc);
  const ts = String(req.headers['x-cluster-ts'] || '');
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) throw bad('clock skew > 5 min', 401);
  const want = sig(key, req.method, path, ts, sha256(body)), got = String(req.headers['x-cluster-sig'] || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw bad('bad signature', 401);
  if (!b.id || !(/^https:\/\//.test(String(b.url || '')) || (process.env.RHC_DEV && /^http:\/\/127\.0\.0\.1:/.test(String(b.url || ''))))) throw bad('the joining server sent no id/url');
  settings.set('cluster.joins', joins.filter((x) => x.nonce !== b.nonce));     // one-time
  upsertPeer({ id: String(b.id), name: String(b.name || b.url).slice(0, 60), url: String(b.url), key_enc: enc(key), access_enc: enc(JSON.stringify(b.access || null)), added: new Date().toISOString(), expires: Date.now() + TEMP_TTL });
  const i = await info();
  return { id: self().id, name: self().name, version: i.version, sites: i.sites };
}

// What a peer is told about this server.
async function info() {
  let sites = [];
  try { sites = ((require('./sites').getCache() || {}).sites || []).map((s) => ({ domain: s.domain, type: s.type, status: s.status, user: s.user })); } catch (_) {}
  return { id: self().id, name: self().name, url: self().url, version: await version(), time: new Date().toISOString(), sites };
}
async function refreshPeer(id) {
  const p = peer(id);
  const r = await call(p, 'GET', '/api/cluster/peer/info');
  notePeer(id, { version: r.version, sites: r.sites, name: r.name || p.name });
  return r;
}

// End a temporary pairing on both sides (after the transfers, or by hand).
async function forget(id, tellPeer) {
  const p = peersRaw().find((x) => x.id === id);
  if (!p) return { ok: true };
  if (tellPeer) { try { await call(p, 'POST', '/api/cluster/peer/forget', {}); } catch (_) {} }
  removePeer(id);
  return { ok: true };
}

module.exports = { forget, self, setSelf, selfView, selfAccess, peers, peer, removePeer, notePeer, call, verify, createJoinCode, joinWith, acceptJoin, info, refreshPeer, version, dec, enc, bad };
