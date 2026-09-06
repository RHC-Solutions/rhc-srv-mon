#!/usr/bin/env node
/**
 * rhc-srv-mon (RHC SRV Manager) — server entry point.
 *
 * Feature code lives in lib/ (one module per tab/section), the browser UI in ui/ (assembled by
 * lib/page.js). This file wires the HTTP dispatcher, the WebSocket upgrade for the SSH terminal,
 * and the boot sequence (state loading + background jobs). Zero npm dependencies.
 *
 * Binds to 127.0.0.1 only; exposed via nginx at /rhc-srv-mon/ (in-app login + TOTP).
 */
'use strict';
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { PORT, HOST, NO_JOBS } = require('./lib/config');
const httpu = require('./lib/http');
const { readJsonBody, authJson, actorOf } = httpu;
const db = require('./lib/db');
const events = require('./lib/events');
require('./lib/api/events');
const page = require('./lib/page');
const auth = require('./lib/auth');
const history = require('./lib/history');
const postgres = require('./lib/postgres');
const updates = require('./lib/updates');
const sites = require('./lib/sites');
const modules = require('./lib/modules');
const backups = require('./lib/backups');
const ssh = require('./lib/ssh');

/* ----------------------------------------------------------------- server */

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (!auth.authGate(req, res, url)) return;
  if (url === '/login' || url.startsWith('/api/auth/')) { if (auth.handleAuthRoute(req, res, url)) return; }
  if (url.startsWith('/ws/')) return auth.wsNotUpgraded(req, res, url);   // upgrade was not forwarded by the proxy
  if (url === '/' || url === '/index.html' || auth.TAB_ROUTES.has(url.slice(1).toLowerCase())) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page.page());
  }
  if (httpu.dispatch(req, res, url)) return;   // router-based routes (new features)
  if (url === '/api/status' || url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(history.buildPayload()));
  }
  if (url === '/api/db') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(postgres.buildDbPayload()));
  }
  if (url === '/api/updates') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const updatesCache = updates.getCache();
    return res.end(JSON.stringify(updatesCache || { components: [], lastChecked: null, schedule: { enabled: false }, telegram: { enabled: false }, log: [] }));
  }
  if (url === '/api/updates/check' && req.method === 'POST') {
    updates.collectUpdates().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/updates/run-all' && req.method === 'POST') {
    const updatesCache = updates.getCache();
    const outdated = (updatesCache ? updatesCache.components : []).filter(c => c.updateAvailable && c.key !== 'node');
    const actor = actorOf(req);
    Promise.all(outdated.map(c => updates.runUpdate(c.key, actor))).then((results) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    });
    return;
  }
  if (url === '/api/updates/run-all-users' && req.method === 'POST') {
    const updatesCache = updates.getCache();
    const users = (updatesCache && updatesCache.users) ? updatesCache.users : {};
    const comps = updatesCache ? updatesCache.components : [];
    const jobs = [], actor = actorOf(req);
    for (const [user, uv] of Object.entries(users)) {
      for (const c of comps) {
        if (c.key === 'node') continue;
        const userV = (uv && uv[c.key]) || null;
        if (userV && c.latestVersion && userV !== c.latestVersion) jobs.push([user, c.key]);
      }
    }
    // Run sequentially — avoids spawning dozens of concurrent npm installs on a memory-tight box
    (async () => {
      const results = [];
      for (const [user, key] of jobs) {
        try { results.push(await updates.runUserUpdate(user, key, actor)); }
        catch (e) { results.push({ user, component: key, success: false, output: e.message }); }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: results.length, results }));
    })();
    return;
  }
  if (url.startsWith('/api/updates/run/') && req.method === 'POST') {
    const parts = url.slice('/api/updates/run/'.length).split('/');
    const promise = parts.length >= 2 && parts[1]
      ? updates.runUserUpdate(parts[0], parts[1], actorOf(req))
      : updates.runUpdate(parts[0], actorOf(req));
    promise.then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }
  if (url === '/api/updates/config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        updates.setConfig(cfg || {});
        events.emit('settings.save', { req, target: 'updates', message: 'Updates settings saved (' + Object.keys(cfg || {}).join(', ') + ')', data: cfg && cfg.schedule ? { schedule: cfg.schedule } : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  if (url === '/api/updates/log' && req.method === 'DELETE') {
    updates.clearLog();
    events.emit('updates.log-clear', { req, message: 'Update log cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url === '/api/sites') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(sites.getCache() || { sites: [], generated_at: null }));
  }
  if (url.startsWith('/api/pm2/') && req.method === 'POST') {
    const parts = url.slice('/api/pm2/'.length).split('/');
    const action = parts[0];
    const targetUser = parts[1];
    const appName = parts[2];
    const pm2Home = `/home/${targetUser}/.pm2`;
    const cmd = action === 'start' ? 'start' : action === 'stop' ? 'stop' : 'restart';
    execFile('sudo', ['-n', '-u', targetUser, 'sh', '-c',
      `PM2_HOME=${pm2Home} pm2 ${cmd} ${appName} 2>&1`],
      { timeout: 30000 },
      (err, stdout) => {
        const result = { action, user: targetUser, app: appName, success: !err, output: stdout.trim() };
        events.emit('pm2.' + cmd, { req, target: targetUser + '/' + appName, level: err ? 'error' : 'info', message: 'pm2 ' + cmd + ' ' + appName + ' (' + targetUser + ')' + (err ? ' failed' : ''), data: err ? { output: result.output.slice(0, 1000) } : undefined });
        res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    return;
  }
  if (url === '/api/sites/check' && req.method === 'POST') {
    sites.collectSites().then((data) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/modules') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modules.apiState()));
  }
  if (url === '/api/modules/check' && req.method === 'POST') {
    if (modules.isScanning()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'scan already in progress', progress: modules.scanProgress() }));
    }
    modules.collectModules().catch((e) => console.error('modules scan failed:', e.message));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, started: true }));
  }
  if (url === '/api/modules/update' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'invalid JSON' })); }
      const { dir, user, packages } = payload || {};
      if (!dir || !user) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'dir and user required' }));
      }
      modules.runModuleUpdate(dir, user, packages || [], actorOf(req)).then((result) => {
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      });
    });
    return;
  }
  if (url === '/api/modules/update-all' && req.method === 'POST') {
    if (modules.isUpdateAllRunning()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'update-all already running', progress: modules.updateAllProgress() }));
    }
    if (modules.isScanning()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'scan in progress' }));
    }
    // Kick off in the background; the UI polls /api/modules for progress + per-dir activeUpdates.
    events.emit('modules.update-all', { req, message: 'Update-all pass started' });
    modules.runUpdateAllPass().catch((e) => console.error('update-all failed:', e.message));
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, started: true }));
  }
  if (url === '/api/modules/log' && req.method === 'DELETE') {
    modules.clearUpdateLog();
    events.emit('modules.log-clear', { req, message: 'Module update log cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url === '/api/modules/auto/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        const next = modules.setAutoUpdateConfig(cfg || {});
        events.emit('settings.save', { req, target: 'auto-update', message: 'Auto-update settings saved', data: next });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, autoUpdate: next }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
      }
    });
    return;
  }
  if (url === '/api/modules/auto/run-now' && req.method === 'POST') {
    if (modules.isAutoUpdateRunning()) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'auto-update already running' }));
    }
    modules.runAutoUpdatePass('manual', actorOf(req)).then((r) => {
      res.writeHead(r.skipped ? 409 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/modules/auto/log' && req.method === 'DELETE') {
    modules.clearAutoUpdateLog();
    events.emit('modules.log-clear', { req, target: 'auto-update', message: 'Auto-update log cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url === '/api/modules/cleanup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(modules.getCleanupState()));
  }
  if (url === '/api/modules/cleanup/measure' && req.method === 'POST') {
    modules.measureCleanup().then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, cleanup: modules.getCleanupState() }));
    }).catch((e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (url === '/api/modules/cleanup/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        modules.setCleanupConfig(cfg || {});
        events.emit('settings.save', { req, target: 'cleanup', message: 'Cleanup settings saved', data: cfg });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cleanup: modules.getCleanupState() }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
      }
    });
    return;
  }
  if (url === '/api/modules/cleanup/run' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let overrides = {};
      try { overrides = body ? (JSON.parse(body) || {}) : {}; } catch (_) { overrides = {}; }
      const clean = {};
      for (const k of Object.keys(modules.DEFAULT_CLEANUP)) if (typeof overrides[k] === 'boolean') clean[k] = overrides[k];
      modules.runCleanup('manual', clean, actorOf(req)).then((r) => {
        res.writeHead(r.skipped ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.assign({}, r, { cleanup: modules.getCleanupState() })));
      }).catch((e) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    });
    return;
  }
  if (url === '/api/modules/cleanup/log' && req.method === 'DELETE') {
    modules.clearCleanupLog();
    events.emit('modules.log-clear', { req, target: 'cleanup', message: 'Cleanup log cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url === '/api/backup') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Object.assign({}, backups.getState(), { available: backups.backupAvailable() })));
  }
  if (url === '/api/backup/run' && req.method === 'POST') {
    if (backups.isRunning()) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'A backup is already running' })); }
    backups.runBackup('manual', actorOf(req)).catch((e) => console.error('backup run failed:', e.message));  // async; UI polls /api/backup
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ started: true }));
  }
  if (url === '/api/backup/remote') {
    backups.listRemoteBackups().then((list) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));
    }).catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('[]'); });
    return;
  }
  if (url === '/api/backup/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const cfg = JSON.parse(body);
        backups.setConfig(cfg || {});
        events.emit('settings.save', { req, target: 'backups', message: 'Backup settings saved (' + Object.keys(cfg || {}).join(', ') + ')' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }
  if (url === '/api/backup/log' && req.method === 'DELETE') {
    backups.clearLog();
    events.emit('backups.log-clear', { req, message: 'Backup log cleared' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }
  /* ---- ssh client / remote installer ---- */
  if (url === '/api/ssh' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(ssh.sshApiState()));
  }
  if (url === '/api/ssh/hosts' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      try {
        const h = ssh.sshSanitizeHost(body, { id: crypto.randomBytes(5).toString('hex'), createdAt: new Date().toISOString() });
        ssh.addHost(h);
        events.emit('ssh.host.add', { req, target: h.name || h.host, message: 'SSH host added: ' + (h.name || h.host) + ' (' + h.user + '@' + h.host + ':' + h.port + ')' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, host: ssh.sshPublicHost(h) }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
  }
  {
    const m = url.match(/^\/api\/ssh\/hosts\/([a-f0-9]{6,16})(\/test)?$/);
    if (m) {
      const h = ssh.sshFindHost(m[1]);
      if (!h) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unknown host' })); }
      if (m[2] && req.method === 'POST') {
        ssh.sshTestHost(h).then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); })
          .catch((e) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, output: e.message })); });
        return;
      }
      if (!m[2] && req.method === 'PUT') {
        return readJsonBody(req, res, (body) => {
          try {
            const next = ssh.sshSanitizeHost(body, h);
            Object.keys(h).forEach((k) => { if (!(k in next)) delete h[k]; });
            Object.assign(h, next); ssh.saveSsh();
            events.emit('ssh.host.update', { req, target: h.name || h.host, message: 'SSH host updated: ' + (h.name || h.host) });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, host: ssh.sshPublicHost(h) }));
          } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
        });
      }
      if (!m[2] && req.method === 'DELETE') {
        ssh.removeHost(h.id);
        events.emit('ssh.host.delete', { req, target: h.name || h.host, level: 'warn', message: 'SSH host deleted: ' + (h.name || h.host) + ' (' + h.user + '@' + h.host + ')' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
    }
  }
  if (url === '/api/ssh/install' && req.method === 'POST') {
    return readJsonBody(req, res, (body) => {
      try {
        const job = ssh.sshStartInstall(String(body.hostId || ''), body.opts || {});
        events.emit('ssh.install', { req, target: job.hostName || body.hostId, message: 'Remote install started on ' + (job.hostName || body.hostId), data: { jobId: job.id, appDir: body.opts && body.opts.appDir } });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jobId: job.id }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    });
  }
  {
    const m = url.match(/^\/api\/ssh\/install\/([a-f0-9]{6,16})$/);
    if (m && req.method === 'GET') {
      const job = ssh.sshFindJob(m[1]);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unknown job' })); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(job));
    }
  }
  {
    const up = url.match(/^\/api\/ssh\/sessions\/([a-f0-9]{6,16})\/upload$/);
    if (up && req.method === 'POST') {
      const s = ssh.getSession(up[1]);
      if (!s || s.ended) { authJson(res, 404, { error: 'session gone' }); return req.destroy(); }
      return ssh.sshUploadToSession(req, res, s);
    }
    const m = url.match(/^\/api\/ssh\/sessions\/([a-f0-9]{6,16})$/);
    if (m && req.method === 'GET') {
      // used by the page to check whether a detached session is still alive before re-attaching
      const s = ssh.getSession(m[1]);
      if ((!s || s.ended) && ssh.sessionMetaExists(m[1])) { return authJson(res, 200, { id: m[1], attached: false, adopting: true }); }
      res.writeHead(s && !s.ended ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(s && !s.ended ? { id: s.id, target: s.target, startedAt: s.startedAt, attached: !!s.socket, detachedAt: s.detachedAt } : { error: 'session gone' }));
    }
    if (m && req.method === 'DELETE') {
      const s = ssh.getSession(m[1]);
      if (s) { s.hangup(); if (s.socket) ssh.wsClose(s.socket, 1000, 'closed by admin'); events.emit('ssh.session.close', { req, target: s.target, message: 'SSH session closed: ' + s.target }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: !!s }));
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});

// WebSocket endpoint for the SSH terminal tab: /ws/ssh?id=<hostId>&cols=&rows=
// (or ?host=&user=&port= for an ad-hoc connection).
server.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url || '/', 'http://localhost'); } catch (_) { return socket.destroy(); }
  if (u.pathname !== '/ws/ssh') { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  socket.on('error', () => {});
  if (!httpu.isLocalDirect(req) && !auth.authSessionOf(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  try { ssh.sshOpenTerminal(req, socket, head, u.searchParams); }
  catch (e) { console.error('ssh ws failed:', e.message); try { socket.destroy(); } catch (_) {} }
});

/* ------------------------------------------------------------------- boot */
page.page();                               // assemble + syntax-check the UI before anything else
db.open();                                 // SQLite (runs pending migrations)
ssh.ensureSshHelpers();
ssh.loadSsh();
ssh.sshAdoptDaemons();
auth.loadAuth();
history.loadHistory();
updates.loadUpdates();
modules.loadModulesCache();
backups.loadBackups();

// PM2 heartbeat + PostgreSQL sample (postgres → history is one-way; the timer sequences them).
const sampleAll = () => history.sample().then(() => postgres.dbSample()).catch((e) => console.error('db sample failed:', e.message));
sampleAll();                               // first sample immediately
setInterval(sampleAll, history.SAMPLE_MS);
sites.collectSites();                      // initial sites data
setInterval(() => sites.collectSites(), 300_000); // re-check sites every 5 min

if (NO_JOBS) {
  console.log('RHC_NO_JOBS set: schedulers (updates, modules scan, auto-update, cleanup, backups) disabled');
} else {
  updates.collectUpdates().then(() => updates.startScheduler());  // initial updates check + scheduler
  setInterval(() => updates.collectUpdates(), updates.CHECK_INTERVAL_MS); // hourly re-check
  // modules: kick off first scan in background (slow — registry-bound), then refresh every 6h
  setTimeout(() => { modules.collectModules().catch((e) => console.error('initial modules scan failed:', e.message)); }, 8_000);
  setInterval(() => modules.collectModules().catch(() => {}), modules.MODULES_INTERVAL_MS);
  // auto-update: tick every minute, fires if config matches the configured HH:MM (cleanup rides on it)
  setInterval(modules.autoUpdateTick, 60_000);
  // backups: tick every minute for the daily scheduled run
  setInterval(backups.backupTick, 60_000);
  // events: prune beyond the retention window once a day
  setInterval(() => { try { events.prune(); } catch (e) { console.error('events prune failed:', e.message); } }, 24 * 3600_000);
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { history.saveHistory(true); process.exit(0); });
}

server.listen(PORT, HOST, () => {
  console.log(`rhc-srv-mon (RHC SRV Manager) listening on http://${HOST}:${PORT}`);
});
