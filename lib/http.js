'use strict';
// Request/response helpers shared by every route, plus a small router for new endpoints.
// The pre-split if/else dispatcher in server.js still handles the legacy routes; the router
// runs before it (after authGate) and falls through when nothing matches.

function clientIp(req) {
  return String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || (req.socket && req.socket.remoteAddress) || '').trim();
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
  let matchedPath = false;
  for (const r of routes) {
    const m = r.re.exec(url);
    if (!m) continue;
    matchedPath = true;
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
  if (matchedPath) { json(res, 405, { error: 'method not allowed' }); return true; }
  return false;
}

module.exports = { clientIp, isLocalDirect, isHttps, json, authJson, readJsonBody, readJson, httpError, actorOf, add, dispatch, setPermCheck };
