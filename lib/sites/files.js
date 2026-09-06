'use strict';
// File manager for a site: every operation runs bin/fileop.js AS THE SITE USER (uid/gid), so the
// kernel decides what is readable/writable and new files get the same ownership/mode as files the
// user creates over SSH (umask 007 → 0660/0770). Uploads/downloads stream through the child.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { APP_ROOT } = require('../config');
const { getent } = require('./users');

const HELPER_SRC = path.join(APP_ROOT, 'bin', 'fileop.js');
const HELPER_DIR = '/var/lib/rhc-srv-mon';
const HELPER = path.join(HELPER_DIR, 'fileop.js');
const JSON_TIMEOUT = 5 * 60_000;

// The helper runs AS THE SITE USER, so that user has to be able to read it — but a normal install
// keeps the app directory root-only (0700). Copy it somewhere world-readable on first use and keep
// that copy in sync with the source, the same way the ssh pty helper is installed.
let helperReady = false;
function ensureHelper() {
  if (helperReady) return HELPER;
  const src = fs.readFileSync(HELPER_SRC, 'utf8');
  let cur = null; try { cur = fs.readFileSync(HELPER, 'utf8'); } catch (_) {}
  if (cur !== src) { fs.mkdirSync(HELPER_DIR, { recursive: true }); fs.writeFileSync(HELPER, src, { mode: 0o755 }); }
  fs.chmodSync(HELPER, 0o755);
  try { fs.chmodSync(HELPER_DIR, 0o755); } catch (_) {}   // traversable; vhost-bak inside stays 0700
  helperReady = true;
  return HELPER;
}

function ctxFor(site) {
  const ent = getent(site.user);
  if (!ent) throw Object.assign(new Error('site user ' + site.user + ' does not exist'), { status: 409 });
  return { uid: ent.uid, gid: ent.gid, root: ent.home, env: { HOME: ent.home, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' } };
}
function spawnHelper(site, argv, stdio) {
  const c = ctxFor(site);
  return spawn(process.execPath, [ensureHelper(), '--root', c.root].concat(argv), { uid: c.uid, gid: c.gid, env: c.env, stdio: stdio || ['pipe', 'pipe', 'pipe'] });
}
function parseErr(stderr, code) {
  try { const j = JSON.parse(String(stderr).trim().split('\n').pop()); if (j && j.error) return j.error; } catch (_) {}
  return String(stderr).trim() || ('helper exited ' + code);
}

// Run one JSON op → parsed result. Errors from the helper become HTTP 400 (or 403 for permission denied).
function op(site, body) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnHelper(site, ['json']); } catch (e) { return reject(e); }
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, JSON_TIMEOUT);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) { const msg = parseErr(err, code); return reject(Object.assign(new Error(msg), { status: /permission denied/i.test(msg) ? 403 : 400 })); }
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error('bad helper output')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(body));
  });
}

// Stream a file to an HTTP response (as the site user). Resolves when the response has ended, so the
// router does not answer 204 while bytes are still flowing.
function download(site, filePath, res, filename) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnHelper(site, ['download', filePath]); } catch (e) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return resolve(); }
    let err = '';
    const disp = 'attachment; filename="' + String(filename || path.basename(filePath)).replace(/[^\x20-\x7e]|"/g, '_') + '"';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disp, 'Cache-Control': 'no-store' });
      res.write(d);
    });
    child.on('close', (code) => {
      if (code !== 0 && !res.headersSent) { res.writeHead(/permission denied/i.test(err) ? 403 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: parseErr(err, code) })); return resolve(); }
      if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': disp, 'Cache-Control': 'no-store' });   // empty file
      res.end(); resolve();
    });
    child.on('error', (e) => { if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } resolve(); });
    res.on('close', () => { try { child.kill('SIGKILL'); } catch (_) {} });
  });
}

// Stream a request body into a file (as the site user). Resolves with the helper's { path, size }.
function upload(site, filePath, req, maxBytes) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnHelper(site, ['upload', filePath]); } catch (e) { return reject(e); }
    let out = '', err = '', got = 0, failed = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    req.on('data', (d) => { got += d.length; if (maxBytes && got > maxBytes && !failed) { failed = true; child.kill('SIGKILL'); req.destroy(); reject(Object.assign(new Error('file too large'), { status: 413 })); } });
    req.on('error', () => { if (!failed) { failed = true; child.kill('SIGKILL'); reject(new Error('upload aborted')); } });
    req.pipe(child.stdin);
    child.stdin.on('error', () => {});
    child.on('error', (e) => { if (!failed) { failed = true; reject(e); } });
    child.on('close', (code) => {
      if (failed) return;
      if (code !== 0) { const msg = parseErr(err, code); return reject(Object.assign(new Error(msg), { status: /permission denied/i.test(msg) ? 403 : 400 })); }
      try { resolve(JSON.parse(out)); } catch (_) { reject(new Error('bad helper output')); }
    });
  });
}

module.exports = { op, download, upload };
