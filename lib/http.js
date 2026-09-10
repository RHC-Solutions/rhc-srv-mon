'use strict';
// Request/response helpers shared by every route, plus a small router for new endpoints.
// The pre-split if/else dispatcher in server.js still handles the legacy routes; the router
// runs before it (after authGate) and falls through when nothing matches.

const fs = require('fs');

// --- who is actually calling
//
// Cloudflare terminates TLS in front of this box, so the peer nginx reports is one of its edges, not
// the visitor: every login attempt looked like it came from 162.158.x.x. That matters because the
// brute-force lockout and the auth log both key on this — bucketing unrelated visitors together,
// while an attacker rotating edges gets a fresh allowance from each one.
//
// CF-Connecting-IP carries the real address, but only Cloudflare may be believed about it: anything
// reaching the origin directly could otherwise claim any address it liked, including one it wants
// locked out. So the header counts only when the peer really is Cloudflare, checked against the same
// range list nginx uses (re-read when the file changes, so updating it needs no restart).
const CF_IPS_FILE = '/etc/nginx/cloudflare/ips';
let cfCache = { mtime: -1, v4: [], v6: [] };

function ip4ToInt(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}
function ip6ToBig(s) {
  s = String(s);
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);     // ::ffff:1.2.3.4
  if (mapped) {
    const v4 = ip4ToInt(mapped[2]);
    if (v4 === null) return null;
    s = mapped[1] + Math.floor(v4 / 65536).toString(16) + ':' + (v4 % 65536).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  let groups;
  if (tail === null) { if (head.length !== 8) return null; groups = head; }
  else { const fill = 8 - head.length - tail.length; if (fill < 0) return null; groups = head.concat(Array(fill).fill('0'), tail); }
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}
function cfRanges() {
  let st = null;
  try { st = fs.statSync(CF_IPS_FILE); } catch (_) { return cfCache; }
  if (st.mtimeMs === cfCache.mtime) return cfCache;
  const v4 = [], v6 = [];
  try {
    for (const line of fs.readFileSync(CF_IPS_FILE, 'utf8').split('\n')) {
      const m = /^\s*allow\s+([0-9a-fA-F:.]+)\/(\d+)\s*;/.exec(line);
      if (!m) continue;
      const len = Number(m[2]);
      if (m[1].includes(':')) { const b = ip6ToBig(m[1]); if (b !== null && len >= 0 && len <= 128) v6.push([b, len]); }
      else { const b = ip4ToInt(m[1]); if (b !== null && len >= 0 && len <= 32) v4.push([b, len]); }
    }
  } catch (_) { return cfCache; }
  cfCache = { mtime: st.mtimeMs, v4, v6 };
  return cfCache;
}
function isCloudflareIp(ip) {
  ip = String(ip || '').trim().replace(/^::ffff:/i, '');
  if (!ip) return false;
  const r = cfRanges();
  if (ip.includes(':')) {
    const b = ip6ToBig(ip);
    if (b === null) return false;
    return r.v6.some(([base, len]) => len === 0 || (b >> BigInt(128 - len)) === (base >> BigInt(128 - len)));
  }
  const n = ip4ToInt(ip);
  if (n === null) return false;
  return r.v4.some(([base, len]) => len === 0 || Math.floor(n / 2 ** (32 - len)) === Math.floor(base / 2 ** (32 - len)));
}
// The address nginx saw: the Cloudflare edge in normal operation, or the visitor if someone reached
// the origin without going through it.
function peerIp(req) {
  return String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim();
}
function clientIp(req) {
  const peer = peerIp(req);
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  return cf && isCloudflareIp(peer) ? cf : peer;
}
// Loopback *without* proxy headers (curl on the box, an SSH tunnel) is trusted as root.
function isLocalDirect(req) {
  const ra = req.socket && req.socket.remoteAddress;
  return (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') && !req.headers['x-real-ip'] && !req.headers['x-forwarded-for'];
}
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https' || !!(req.socket && req.socket.encrypted);
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const authJson = json;   // historical name, used by auth/ssh

// Callback-style JSON body reader (legacy routes). Always hands the callback an object;
// answers 400 itself on bad JSON. 256 KB cap.
function readJsonBody(req, res, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 256 * 1024) req.destroy(); });
  req.on('end', () => {
    let parsed;
    try { parsed = body ? JSON.parse(body) : {}; } catch (_) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
    cb(parsed && typeof parsed === 'object' ? parsed : {});
  });
}
// Promise variant for router handlers. Rejects with { status: 400 } on bad JSON / oversize.
function readJson(req, limit) {
  limit = limit || 256 * 1024;
  return new Promise((resolve, reject) => {
    let body = '', over = false;
    req.on('data', (c) => { body += c; if (body.length > limit && !over) { over = true; reject(httpError(413, 'body too large')); req.destroy(); } });
    req.on('end', () => {
      if (over) return;
      try { const p = body ? JSON.parse(body) : {}; resolve(p && typeof p === 'object' ? p : {}); }
      catch (_) { reject(httpError(400, 'Invalid JSON')); }
    });
    req.on('error', (e) => reject(e));
  });
}
// Who performed a request, for the event log: panel login, 'local' for trusted loopback.
function actorOf(req) { return { user: req.authUser || (isLocalDirect(req) ? 'local' : null), ip: clientIp(req) }; }
function httpError(status, message, extra) { const e = new Error(message); e.status = status; if (extra) Object.assign(e, extra); return e; }

/* ------------------------------------------------------------------ router */
// add('GET', '/api/sites/:domain/vhost', { perm: 'sites.write' }, async (ctx) => ({ ... }))
// ctx = { req, res, url (pathname), params, query (URLSearchParams), user, ip, local }
// A handler may return a value (→ 200 JSON), return undefined after writing to res itself,
// or throw an Error with .status (→ that code + { error }).
const routes = [];
let permCheck = () => true;   // (ctx, perm) → boolean; replaced by the users/permissions module later

function compile(pattern) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([A-Za-z_]\w*)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { re, keys };
}
function add(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const { re, keys } = compile(pattern);
  routes.push({ method: method.toUpperCase(), pattern, re, keys, opts: opts || {}, handler });
}
function setPermCheck(fn) { permCheck = fn; }

// Returns true when a route handled the request (response written or in flight).
function dispatch(req, res, url) {
  for (const r of routes) {
    const m = r.re.exec(url);
    if (!m) continue;
    // method mismatch → keep looking, and finally fall through to the legacy dispatcher (it may own
    // e.g. POST /api/sites/check while the router owns GET /api/sites/:domain)
    if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
    const params = {};
    r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(m[i + 1]); } catch (_) { params[k] = m[i + 1]; } });
    const q = req.url.indexOf('?');
    const ctx = { req, res, url, params, query: new URLSearchParams(q >= 0 ? req.url.slice(q + 1) : ''), user: req.authUser || null, ip: clientIp(req), local: isLocalDirect(req) };
    if (r.opts.perm && !permCheck(ctx, r.opts.perm)) { json(res, 403, { error: 'forbidden' }); return true; }
    Promise.resolve().then(() => r.handler(ctx)).then((out) => {
      if (res.writableEnded || res.headersSent) return;
      if (out === undefined) { res.writeHead(204, { 'Cache-Control': 'no-store' }); return res.end(); }
      json(res, 200, out);
    }).catch((e) => {
      if (res.writableEnded) return;
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('route ' + req.method + ' ' + url + ' failed:', e && e.stack || e);
      const body = { error: e && e.message ? e.message : String(e) };
      if (e && e.detail) body.detail = e.detail;
      json(res, status, body);
    });
    return true;
  }
  return false;
}

module.exports = { clientIp, peerIp, isCloudflareIp, isLocalDirect, isHttps, json, authJson, readJsonBody, readJson, httpError, actorOf, add, dispatch, setPermCheck };
