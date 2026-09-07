'use strict';
/* ------------------------------------------------------------------- auth */
// Web login (username + password + TOTP) replacing nginx basic auth.
// Users/sessions live in auth.json (mode 600, gitignored). Passwords are
// scrypt-hashed; TOTP is RFC 6238 (SHA-1, 30s, 6 digits). Requests arriving
// directly on the loopback interface *without* proxy headers (curl on the box,
// an SSH tunnel) are trusted — the box itself is root-only already.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { APP_ROOT } = require('./config');
const { clientIp, isLocalDirect, isHttps, authJson, readJsonBody } = require('./http');
const notify = require('./notify');
const { loginPage } = require('./page');
const events = require('./events');

const AUTH_FILE = path.join(APP_ROOT, 'auth.json');
const AUTH_SESSION_TTL_MS = 30 * 24 * 3600_000;   // 30 days
const AUTH_SETUP_TTL_MS = 15 * 60_000;
const AUTH_COOKIE = 'rhc_sid';
const AUTH_MAX_FAILS = 6;                          // per IP before lockout
const AUTH_LOCK_MS = 10 * 60_000;
const AUTH_ISSUER = 'rhc-srv-mon';
let authCache = { users: [], sessions: {}, log: [] };
const authFails = new Map();                        // ip -> { n, until }
const authSetups = new Map();                       // setupToken -> { user, expires }
const authPending = new Map();                      // pendingToken -> { username, expires } (password ok, awaiting TOTP)

function loadAuth() {
  try {
    const d = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (d && typeof d === 'object') authCache = { users: Array.isArray(d.users) ? d.users : [], sessions: d.sessions && typeof d.sessions === 'object' ? d.sessions : {}, log: Array.isArray(d.log) ? d.log : [] };
  } catch (_) {}
  // drop expired sessions
  const now = Date.now();
  for (const [k, s] of Object.entries(authCache.sessions)) if (!s || s.expires < now) delete authCache.sessions[k];
}
function saveAuth() {
  try {
    authCache.log = authCache.log.slice(-200);
    fs.writeFileSync(AUTH_FILE + '.tmp', JSON.stringify(authCache, null, 2), { mode: 0o600 });
    fs.renameSync(AUTH_FILE + '.tmp', AUTH_FILE);
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch (e) { console.error('saveAuth failed:', e.message); }
}
function authLog(ev, req, extra) {
  authCache.log.push(Object.assign({ t: new Date().toISOString(), ev, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120) }, extra || {}));
  authAlert(ev, req, extra || {});
  const level = ev === 'lockout' ? 'error' : /fail/.test(ev) ? 'warn' : 'info';
  const label = (AUTH_ALERT_EVENTS[ev] || ev).replace(/^[^A-Za-z]+/, '');
  events.emit('auth.' + ev, { req, user: (extra && extra.user) || req.authUser || null, level, message: label, data: extra && Object.keys(extra).length ? extra : undefined });
}
// Telegram alert for web login activity (like the fail2ban sshd alerts). Enabled via the Telegram
// settings (Updates tab, "Notify on web login attempts", default on). Bursts from one IP are
// collapsed: at most one message per IP+event per minute, with a suppressed-count on the next one.
const AUTH_ALERT_EVENTS = { login_fail: '🔐❌ Web login failed', totp_fail: '🔐❌ Web login: wrong authenticator code', login: '🔐✅ Web login', lockout: '🔐🚫 Web login lockout', setup: '🔐🆕 First admin account created', password_change: '🔐 Password changed', mfa_reset: '🔐 Authenticator reset' };
const authAlertLast = new Map();   // ip|ev -> { t, n }
function authAlert(ev, req, extra) {
  const title = AUTH_ALERT_EVENTS[ev]; if (!title) return;
  const tel = notify.getConfig(), sl = notify.getSlack();
  if (!(tel && tel.enabled && tel.notifyOnAuth !== false) && !(sl && sl.enabled && sl.notifyOnAuth !== false)) return;
  const ip = clientIp(req), key = ip + '|' + ev, now = Date.now(), last = authAlertLast.get(key);
  if (last && now - last.t < 60_000) { last.n++; return; }
  const suppressed = last ? last.n : 0;
  authAlertLast.set(key, { t: now, n: 0 });
  if (authAlertLast.size > 500) for (const [k, v] of authAlertLast) if (now - v.t > 3600_000) authAlertLast.delete(k);
  const md = (s) => String(s || '').replace(/([_*`\[])/g, '\\$1');
  const lines = ['*' + title + ' on ' + md(os.hostname()) + '*',
    'user: `' + md(extra.user || '?') + '`', 'ip: `' + md(ip) + '`' + (req.headers['cf-ipcountry'] ? ' (' + md(req.headers['cf-ipcountry']) + ')' : ''),
    'ua: ' + md(String(req.headers['user-agent'] || '-').slice(0, 90))];
  if (ev === 'lockout') lines.push('locked for ' + Math.round(AUTH_LOCK_MS / 60000) + ' min after ' + AUTH_MAX_FAILS + ' failures');
  if (suppressed) lines.push('_(+' + suppressed + ' similar in the last minute)_');
  notify.send(lines.join('\n'), 'auth');
}
function authUsersExist() { return authCache.users.length > 0; }
function authFindUser(name) { name = String(name || '').trim().toLowerCase(); return authCache.users.find((u) => u.username.toLowerCase() === name) || null; }

// --- passwords (scrypt)
function pwHash(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  return { salt, hash };
}
function pwVerify(password, user) {
  try { const h = pwHash(password, user.salt).hash; return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(user.hash, 'hex')); } catch (_) { return false; }
}
function pwPolicy(p) {
  if (typeof p !== 'string' || p.length < 10) return 'Password must be at least 10 characters';
  if (p.length > 200) return 'Password too long';
  return null;
}

// --- TOTP (RFC 6238)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  s = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of s) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totpAt(secretB32, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const o = h[19] & 15;
  const code = ((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000;
  return String(code).padStart(6, '0');
}
// returns the matching counter (number) or null; window = ±1 step; never accepts a counter <= lastCounter (replay)
function totpCheck(secretB32, code, lastCounter) {
  code = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return null;
  const now = Math.floor(Date.now() / 30_000);
  for (const c of [now, now - 1, now + 1]) {
    if (lastCounter != null && c <= lastCounter) continue;
    const exp = totpAt(secretB32, c);
    if (exp.length === code.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(code))) return c;
  }
  return null;
}
function totpUri(username, secret) {
  return 'otpauth://totp/' + encodeURIComponent(AUTH_ISSUER + ':' + username) + '?secret=' + secret + '&issuer=' + encodeURIComponent(AUTH_ISSUER) + '&algorithm=SHA1&digits=6&period=30';
}

// --- sessions / cookies
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
function sessionKey(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function authSessionOf(req) {
  const tok = parseCookies(req)[AUTH_COOKIE];
  if (!tok) return null;
  const s = authCache.sessions[sessionKey(tok)];
  if (!s || s.expires < Date.now()) return null;
  if (!authFindUser(s.user)) return null;
  return s;
}
function authCreateSession(req, res, username) {
  const tok = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  authCache.sessions[sessionKey(tok)] = { user: username, created: now, expires: now + AUTH_SESSION_TTL_MS, ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120), seen: now };
  saveAuth();
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=' + tok + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(AUTH_SESSION_TTL_MS / 1000) + (isHttps(req) ? '; Secure' : ''));
}
function authClearSession(req, res) {
  const tok = parseCookies(req)[AUTH_COOKIE];
  if (tok) { delete authCache.sessions[sessionKey(tok)]; saveAuth(); }
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function authTouch(s) { const now = Date.now(); if (now - (s.seen || 0) > 3600_000) { s.seen = now; saveAuth(); } }

// --- brute-force guard (per client IP)
function authLocked(req) { const f = authFails.get(clientIp(req)); return !!(f && f.until && f.until > Date.now()); }
function authFail(req) {
  const ip = clientIp(req); const f = authFails.get(ip) || { n: 0, until: 0 };
  f.n += 1; if (f.n >= AUTH_MAX_FAILS) { f.until = Date.now() + AUTH_LOCK_MS; f.n = 0; authLog('lockout', req); }
  authFails.set(ip, f);
}
function authOk(req) { authFails.delete(clientIp(req)); }

// Routes that never require a session.
// Tab URLs (…/rhc-admin/<slug>) — all serve the SPA; the client picks the tab from the path.
const TAB_ROUTES = new Set(['monitor', 'pm2', 'services', 'postgres', 'postgresql', 'db', 'updates', 'sites', 'modules', 'backups', 'backup', 'ssh', 'terminal', 'events', 'settings']);
const AUTH_PUBLIC = new Set(['/login', '/api/auth/login', '/api/auth/totp', '/api/auth/setup', '/api/auth/setup/verify', '/api/auth/state', '/api/auth/logout']);
// Returns true when the request may proceed; otherwise it has already been answered.
function authGate(req, res, url) {
  if (AUTH_PUBLIC.has(url)) return true;
  if (isLocalDirect(req)) return true;
  const s = authSessionOf(req);
  if (s) { authTouch(s); req.authUser = s.user; return true; }
  if (url.startsWith('/api/') || url.startsWith('/ws/')) {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'unauthenticated' }));
    return false;
  }
  const slug = url.slice(1).toLowerCase();
  res.writeHead(302, { Location: 'login' + (TAB_ROUTES.has(slug) ? '?next=' + slug : ''), 'Cache-Control': 'no-store' });
  res.end();
  return false;
}
// A /ws/ URL arriving here (instead of the 'upgrade' event) means the reverse proxy did not forward
// the handshake as an upgrade — typically nginx sending "Connection: websocket" ($http_upgrade)
// instead of "Connection: Upgrade". The browser only sees close code 1006, so say it out loud.
let wsMisconfigWarnedAt = 0;
function wsNotUpgraded(req, res, url) {
  const up = String(req.headers.upgrade || '').toLowerCase(), conn = String(req.headers.connection || '');
  const why = up === 'websocket'
    ? 'the reverse proxy forwarded "Connection: ' + conn + '" instead of "Connection: Upgrade" — fix its WebSocket config (nginx: proxy_set_header Connection "Upgrade" when $http_upgrade is set)'
    : (req.headers['x-diag'] ? 'WebSocket endpoint reachable' : 'no WebSocket upgrade in the request' + (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] ? ' — the reverse proxy is not forwarding Upgrade/Connection headers' : ''));
  if (up === 'websocket' && Date.now() - wsMisconfigWarnedAt > 60_000) { wsMisconfigWarnedAt = Date.now(); console.error('ws ' + url + ': ' + why); }
  authJson(res, req.headers['x-diag'] && up !== 'websocket' ? 200 : 426, { error: why, upgrade: up || null, connection: conn || null });
}

function handleAuthRoute(req, res, url) {
  if (url === '/login' && req.method === 'GET') {
    if (authSessionOf(req)) { res.writeHead(302, { Location: './' }); return res.end(), true; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(loginPage()); return true;
  }
  if (url === '/api/auth/state') {
    authJson(res, 200, { setupRequired: !authUsersExist(), locked: authLocked(req), issuer: AUTH_ISSUER }); return true;
  }
  if (url === '/api/auth/me') {
    const s = authSessionOf(req);
    authJson(res, 200, { user: s ? s.user : (isLocalDirect(req) ? 'local' : null), local: isLocalDirect(req), sessions: s ? Object.values(authCache.sessions).filter((x) => x.user === s.user).length : 0 }); return true;
  }
  if (url === '/api/auth/logout' && req.method === 'POST') { authLog('logout', req); authClearSession(req, res); authJson(res, 200, { ok: true }); return true; }

  // first-run setup: create the admin account + enrol TOTP
  if (url === '/api/auth/setup' && req.method === 'POST') {
    if (authUsersExist()) return authJson(res, 403, { error: 'Setup already completed' }), true;
    readJsonBody(req, res, (b) => {
      const username = String(b.username || '').trim();
      if (!/^[A-Za-z0-9._@\-]{2,40}$/.test(username)) return authJson(res, 400, { error: 'Username: 2-40 letters, digits, . _ - @' });
      const pe = pwPolicy(b.password); if (pe) return authJson(res, 400, { error: pe });
      const secret = b32encode(crypto.randomBytes(20));
      const token = crypto.randomBytes(24).toString('base64url');
      authSetups.set(token, { user: Object.assign({ username, totpSecret: secret, totpLast: null, created: new Date().toISOString() }, pwHash(b.password)), expires: Date.now() + AUTH_SETUP_TTL_MS });
      authJson(res, 200, { setupToken: token, secret, uri: totpUri(username, secret) });
    });
    return true;
  }
  if (url === '/api/auth/setup/verify' && req.method === 'POST') {
    readJsonBody(req, res, (b) => {
      const st = authSetups.get(String(b.setupToken || ''));
      if (!st || st.expires < Date.now()) return authJson(res, 400, { error: 'Setup expired — start again' });
      if (authUsersExist()) return authJson(res, 403, { error: 'Setup already completed' });
      const c = totpCheck(st.user.totpSecret, b.code, null);
      if (c == null) return authJson(res, 400, { error: 'Code does not match — check the time on your phone and try again' });
      st.user.totpLast = c; authCache.users.push(st.user); authSetups.clear();
      authLog('setup', req, { user: st.user.username });
      authCreateSession(req, res, st.user.username);
      authJson(res, 200, { ok: true });
    });
    return true;
  }
  // login step 1: username + password -> pending token; step 2: TOTP
  if (url === '/api/auth/login' && req.method === 'POST') {
    if (!authUsersExist()) return authJson(res, 409, { error: 'setup', setupRequired: true }), true;
    if (authLocked(req)) return authJson(res, 429, { error: 'Too many failed attempts — locked for 10 minutes' }), true;
    readJsonBody(req, res, (b) => {
      const u = authFindUser(b.username);
      // constant-ish time: hash even when the user is unknown
      const ok = u ? pwVerify(b.password, u) : (pwHash(String(b.password || ''), 'deadbeef'), false);
      if (!ok) { authFail(req); authLog('login_fail', req, { user: String(b.username || '').slice(0, 40) }); return authJson(res, 401, { error: 'Wrong username or password' }); }
      if (typeof b.code === 'string' && b.code.trim()) {
        // one-shot login with the code included
        const c = totpCheck(u.totpSecret, b.code, u.totpLast);
        if (c == null) { authFail(req); authLog('totp_fail', req, { user: u.username }); return authJson(res, 401, { error: 'Invalid authenticator code' }); }
        u.totpLast = c; authOk(req); authLog('login', req, { user: u.username }); authCreateSession(req, res, u.username);
        return authJson(res, 200, { ok: true });
      }
      const tok = crypto.randomBytes(24).toString('base64url');
      authPending.set(tok, { username: u.username, expires: Date.now() + 5 * 60_000 });
      authJson(res, 200, { pending: tok });
    });
    return true;
  }
  if (url === '/api/auth/totp' && req.method === 'POST') {
    if (authLocked(req)) return authJson(res, 429, { error: 'Too many failed attempts — locked for 10 minutes' }), true;
    readJsonBody(req, res, (b) => {
      const p = authPending.get(String(b.pending || ''));
      if (!p || p.expires < Date.now()) return authJson(res, 400, { error: 'Login expired — start again' });
      const u = authFindUser(p.username); if (!u) return authJson(res, 400, { error: 'Unknown user' });
      const c = totpCheck(u.totpSecret, b.code, u.totpLast);
      if (c == null) { authFail(req); authLog('totp_fail', req, { user: u.username }); return authJson(res, 401, { error: 'Invalid authenticator code' }); }
      authPending.delete(String(b.pending)); u.totpLast = c; authOk(req);
      authLog('login', req, { user: u.username }); authCreateSession(req, res, u.username);
      authJson(res, 200, { ok: true });
    });
    return true;
  }
  // account management (session required — enforced by authGate before we get here)
  if (url === '/api/auth/password' && req.method === 'POST') {
    readJsonBody(req, res, (b) => {
      const u = authFindUser(req.authUser); if (!u) return authJson(res, 401, { error: 'No session user (local access has no account)' });
      if (!pwVerify(b.current, u)) return authJson(res, 401, { error: 'Current password is wrong' });
      const pe = pwPolicy(b.next); if (pe) return authJson(res, 400, { error: pe });
      const c = totpCheck(u.totpSecret, b.code, u.totpLast); if (c == null) return authJson(res, 401, { error: 'Invalid authenticator code' });
      u.totpLast = c; Object.assign(u, pwHash(b.next)); authLog('password_change', req, { user: u.username }); saveAuth();
      authJson(res, 200, { ok: true });
    });
    return true;
  }
  if (url === '/api/auth/mfa/reset' && req.method === 'POST') {
    readJsonBody(req, res, (b) => {
      const u = authFindUser(req.authUser); if (!u) return authJson(res, 401, { error: 'No session user' });
      if (!pwVerify(b.password, u)) return authJson(res, 401, { error: 'Password is wrong' });
      const c = totpCheck(u.totpSecret, b.code, u.totpLast); if (c == null) return authJson(res, 401, { error: 'Invalid current authenticator code' });
      u.totpLast = c; u.totpPendingSecret = b32encode(crypto.randomBytes(20)); saveAuth();
      authJson(res, 200, { secret: u.totpPendingSecret, uri: totpUri(u.username, u.totpPendingSecret) });
    });
    return true;
  }
  if (url === '/api/auth/mfa/confirm' && req.method === 'POST') {
    readJsonBody(req, res, (b) => {
      const u = authFindUser(req.authUser); if (!u || !u.totpPendingSecret) return authJson(res, 400, { error: 'No pending authenticator enrolment' });
      const c = totpCheck(u.totpPendingSecret, b.code, null); if (c == null) return authJson(res, 401, { error: 'Code does not match the new authenticator' });
      u.totpSecret = u.totpPendingSecret; delete u.totpPendingSecret; u.totpLast = c; authLog('mfa_reset', req, { user: u.username }); saveAuth();
      authJson(res, 200, { ok: true });
    });
    return true;
  }
  if (url === '/api/auth/sessions/others' && req.method === 'DELETE') {
    const s = authSessionOf(req); if (!s) return authJson(res, 401, { error: 'No session' }), true;
    const mine = sessionKey(parseCookies(req)[AUTH_COOKIE]);
    for (const [k, x] of Object.entries(authCache.sessions)) if (x.user === s.user && k !== mine) delete authCache.sessions[k];
    saveAuth(); authJson(res, 200, { ok: true }); return true;
  }
  if (url === '/api/auth/log') { authJson(res, 200, { log: authCache.log.slice(-50).reverse() }); return true; }
  return false;
}


// Login users for the remote-installer bundle: credentials + authenticator only (no sessions/log).
function exportUsers() {
  return authCache.users.map((u) => ({ username: u.username, salt: u.salt, hash: u.hash, totpSecret: u.totpSecret, totpLast: null, created: u.created || new Date().toISOString() }));
}
function getLog() { return authCache.log; }

module.exports = { TAB_ROUTES, loadAuth, saveAuth, authGate, authSessionOf, handleAuthRoute, wsNotUpgraded, authLog, exportUsers, getLog };
