'use strict';
// PHP-FPM pools per site, CloudPanel layout: /etc/php/<ver>/fpm/pool.d/<domain>.conf, user/group =
// site user, listen 127.0.0.1:<port> where port = highest existing + 1 (default.conf seeds 20000).
const fs = require('fs');
const path = require('path');
const { execP, listeningPorts } = require('../util');

const PHP_DIR = '/etc/php';

function listVersions() {
  try {
    return fs.readdirSync(PHP_DIR).filter((v) => /^\d+\.\d+$/.test(v) && fs.existsSync(path.join(PHP_DIR, v, 'fpm', 'pool.d'))).sort((a, b) => parseFloat(a) - parseFloat(b));
  } catch (_) { return []; }
}
function poolDir(ver) { return path.join(PHP_DIR, ver, 'fpm', 'pool.d'); }
function poolFile(ver, domain) { return path.join(poolDir(ver), domain + '.conf'); }

// Highest `listen = 127.0.0.1:<port>` across every version's pool.d, + 1 (CLP's PoolReader), then
// stepped past anything already listening — a pool file is not the only way a port gets taken, and
// php-fpm fails the whole reload (every site on that version) if one pool cannot bind.
function nextPoolPort() {
  let max = 20000;
  for (const v of listVersions()) {
    for (const f of fs.readdirSync(poolDir(v))) {
      try { const m = /^\s*listen\s*=\s*127\.0\.0\.1:(\d+)/m.exec(fs.readFileSync(path.join(poolDir(v), f), 'utf8')); if (m) max = Math.max(max, Number(m[1])); } catch (_) {}
    }
  }
  const live = listeningPorts();
  let p = max + 1;
  while (p <= 65535 && live.has(p)) p++;
  return p;
}

function poolContent(domain, user, port) {
  return `[${domain}]
listen = 127.0.0.1:${port}
user = ${user}
group = ${user}
listen.allowed_clients = 127.0.0.1
pm = ondemand
pm.max_children = 250
pm.process_idle_timeout = 10s
pm.max_requests = 100
listen.backlog = 65535
pm.status_path = /status
request_terminate_timeout = 7200s
rlimit_files = 131072
rlimit_core = unlimited
catch_workers_output = yes
`;
}
function writePool(ver, domain, user, port) {
  if (!listVersions().includes(ver)) throw new Error('PHP ' + ver + ' is not installed');
  fs.writeFileSync(poolFile(ver, domain), poolContent(domain, user, port), { mode: 0o644 });
}
function readPool(ver, domain) { try { return fs.readFileSync(poolFile(ver, domain), 'utf8'); } catch (_) { return null; } }
function removePool(ver, domain) { try { fs.unlinkSync(poolFile(ver, domain)); return true; } catch (_) { return false; } }
// Which version currently has a pool for this domain (the DB says one thing; disk is the truth).
function findPoolVersion(domain) { return listVersions().find((v) => fs.existsSync(poolFile(v, domain))) || null; }

async function testFpm(ver) {
  const r = await execP('php-fpm' + ver, ['-t'], { timeout: 30_000 });
  return { ok: !r.err, output: ((r.stderr || '') + (r.stdout || '')).trim() };
}
async function reloadFpm(ver) {
  const r = await execP('systemctl', ['reload', 'php' + ver + '-fpm'], { timeout: 60_000 });
  return { ok: !r.err, output: ((r.stderr || '') + (r.stdout || '')).trim() };
}
// Move a site's pool to another PHP version: write new pool, test, remove old, reload both.
async function switchVersion(domain, user, port, fromVer, toVer) {
  writePool(toVer, domain, user, port);
  const t = await testFpm(toVer);
  if (!t.ok) { removePool(toVer, domain); throw new Error('php-fpm' + toVer + ' -t failed: ' + t.output.split('\n').pop()); }
  if (fromVer && fromVer !== toVer) removePool(fromVer, domain);
  const out = [await reloadFpm(toVer)];
  if (fromVer && fromVer !== toVer) out.push(await reloadFpm(fromVer));
  return out;
}

// Stop / start one site's pool without touching the other sites on that PHP version: the pool file
// is parked as <domain>.conf.stopped (php-fpm only includes pool.d/*.conf) and php-fpm is reloaded
// gracefully. Restart = graceful reload of that version (workers finish their request; opcache reset).
const STOPPED = '.stopped';
function stoppedPoolVersion(domain) { return listVersions().find((v) => fs.existsSync(poolFile(v, domain) + STOPPED)) || null; }
async function control(site, action) {
  const domain = site.domain;
  const ver = findPoolVersion(domain), parked = stoppedPoolVersion(domain);
  const res = (ok, command, output) => ({ ok, results: [{ user: site.user, ok, command, output: output || '' }] });
  if (action === 'stop') {
    if (!ver) return res(!!parked, 'php-fpm pool ' + domain, parked ? 'already stopped' : 'no php-fpm pool for this site');
    fs.renameSync(poolFile(ver, domain), poolFile(ver, domain) + STOPPED);
    const r = await reloadFpm(ver);
    if (!r.ok) { fs.renameSync(poolFile(ver, domain) + STOPPED, poolFile(ver, domain)); await reloadFpm(ver); }
    return res(r.ok, 'stopped pool ' + domain + ', systemctl reload php' + ver + '-fpm', r.output);
  }
  if (action === 'start' || action === 'restart' || action === 'resurrect') {
    let v = ver;
    if (!v && parked) {
      if (fs.existsSync(poolFile(parked, domain))) fs.unlinkSync(poolFile(parked, domain) + STOPPED);
      else fs.renameSync(poolFile(parked, domain) + STOPPED, poolFile(parked, domain));
      v = parked;
      const t = await testFpm(v);
      if (!t.ok) { fs.renameSync(poolFile(v, domain), poolFile(v, domain) + STOPPED); return res(false, 'php-fpm' + v + ' -t', t.output); }
    }
    if (!v) return res(false, 'php-fpm pool ' + domain, 'no php-fpm pool for this site');
    const r = await reloadFpm(v);
    return res(r.ok, (v === ver ? '' : 'started pool ' + domain + ', ') + 'systemctl reload php' + v + '-fpm', r.output);
  }
  return res(false, action, 'unsupported for a PHP site (start | stop | restart)');
}

module.exports = { control, stoppedPoolVersion, listVersions, nextPoolPort, poolContent, writePool, readPool, removePool, findPoolVersion, poolFile, testFpm, reloadFpm, switchVersion };
