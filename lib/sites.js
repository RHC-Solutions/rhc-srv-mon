'use strict';
/* -------------------------------------------------------------- sites */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { querySitesDb } = require('./cloudpanel');
const store = require('./sites/store');
const procs = require('./sites/procs');
const php = require('./sites/php');

let sitesCache = null, sitesCacheAt = 0;

function getSiteDisk(dir) {
  try {
    const out = execFileSync('du', ['-sh', dir], { timeout: 3000, encoding: 'utf8' });
    return out.trim().split('\t')[0];
  } catch { return '?'; }
}

// One `ss` for the whole pass instead of one per site, and it keeps the pid — which is what lets us
// name the interpreter actually serving a port without depending on the pm2 collector having run.
function listeners() {
  const map = new Map();
  let out = '';
  try { out = execFileSync('ss', ['-tlnpH'], { timeout: 5000, encoding: 'utf8' }); } catch { return map; }
  for (const line of out.split('\n')) {
    const addr = /(?:^|\s)(?:\[[^\]]*\]|[\d.*]+):(\d+)\s/.exec(line);
    if (!addr) continue;
    const port = Number(addr[1]);
    const pid = /pid=(\d+)/.exec(line);
    if (!map.has(port)) map.set(port, { pid: pid ? Number(pid[1]) : null });
  }
  return map;
}
// The binary behind a pid. '(deleted)' means the file was replaced (a runtime upgrade) while the
// process kept running on the old inode — it only moves across on a restart.
//
// `-v` is memoised by path for the length of a sweep: a site can have a dozen processes and they
// almost all execute the same /usr/bin/node, so without this one pass spawns that binary dozens of
// times to be told the same version each time. Cleared at the start of every sweep — the whole point
// of measuring rather than trusting the record is to notice an upgrade, and a memo kept across
// sweeps would go on reporting the version from before it for as long as the panel stayed up.
const versionMemo = new Map();
function nodeVersionOf(path) {
  if (versionMemo.has(path)) return versionMemo.get(path);
  let v = null;
  try { v = execFileSync(path, ['-v'], { timeout: 4000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a -v binary */ }
  versionMemo.set(path, v);
  return v;
}
function exeOf(pid) {
  if (!pid) return null;
  let exe = null;
  try { exe = fs.readlinkSync('/proc/' + pid + '/exe'); } catch { return null; }
  const stale = / \(deleted\)$/.test(exe);
  const path = exe.replace(/ \(deleted\)$/, '');
  return { path, stale, version: stale ? null : nodeVersionOf(path) };
}
// In PM2 cluster mode the God Daemon itself holds the listening socket and hands connections to its
// workers, so the listener pid is the daemon, not the app. A daemon left on a replaced binary is
// harmless to the app (workers are fresh node processes) — it is read apart from the app, never as it.
function isPm2Daemon(pid) {
  try { return /^PM2 v[\d.]+: God Daemon/.test(fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')); } catch { return false; }
}

// One GET to 127.0.0.1 with the site's Host/SNI. Never follows redirects (a 301 is a healthy answer)
// and never rejects a certificate — we are talking to our own nginx, not validating its cert here.
function httpProbe(opts) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (done) return; done = true; resolve(r); };
    const mod = opts.tls ? https : http;
    let req;
    try {
      req = mod.request({
        host: '127.0.0.1', port: opts.port, method: 'GET', path: '/',
        headers: { Host: opts.domain, 'User-Agent': 'rhc-srv-mon/health', Accept: '*/*', Connection: 'close' },
        servername: opts.domain, rejectUnauthorized: false, timeout: opts.timeout || 5000,
      }, (res) => { res.resume(); finish({ status: res.statusCode }); });
    } catch (e) { return finish({ error: e.code || e.message }); }
    req.on('timeout', () => { req.destroy(); finish({ error: 'timeout' }); });
    req.on('error', (e) => finish({ error: e.code || e.message }));
    req.end();
  });
}

async function checkSiteHealth(site, lmap, live) {
  const listening = lmap || listeners();
  const isPortListening = (port) => listening.has(Number(port));
  const result = {
    id: site.id, domain: site.domain, type: site.type, user: site.user,
    root: site.root, revProxy: site.revProxy,
    nodeVersion: site.nodeVer, phpVersion: site.phpVer,
    // The recorded versions above are CloudPanel bookkeeping. These are measured: the interpreter the
    // site's processes actually execute, and the php-fpm pool that actually exists on disk.
    nodeActual: null, nodeStale: false, nodeExe: null, phpActual: null,
    nodePort: site.nodePort || null, poolPort: site.poolPort || null,
    portUp: false, httpUp: false, disk: '?', pm2: null, pm2DaemonStale: [],
    originStatus: null, originError: null, originUp: false, appStatus: null, appError: null, appUp: null,
    cfOnly: !!site.cfOnly, statusReason: '',
    status: 'unknown', statusLabel: 'Unknown',
    managed_by: site.managed_by || 'clp', application: site.application || null,
    pm2Homes: [], canControl: false,
  };

  // Check port
  if (site.nodePort) {
    result.portUp = isPortListening(site.nodePort);
  } else if (site.poolPort) {
    result.portUp = isPortListening(site.poolPort);
  } else if (site.type === 'static') {
    result.portUp = true; // served by nginx, no app port
  }

  // Ask nginx on THIS host (127.0.0.1, SNI + Host header) instead of resolving the public name:
  // through public DNS the answer comes from Cloudflare, which serves a cached or "Always Online"
  // page for a site whose origin is dead — so every site looked healthy while every app was down.
  let origin = await httpProbe({ tls: true, port: 443, domain: site.domain });
  if (origin.error) { const plain = await httpProbe({ tls: false, port: 80, domain: site.domain }); if (!plain.error) origin = plain; }
  result.originStatus = origin.status != null ? origin.status : null;
  result.originError = origin.error || null;
  result.originUp = origin.status != null;
  if (!result.originUp) result.httpUp = false;
  else if (result.cfOnly && origin.status === 403) result.httpUp = null;   // nginx refused US, not the app
  else result.httpUp = origin.status < 500;

  // For an app behind nginx, the app's own port is the ground truth: nginx answering 502 tells us
  // the app is gone, and a Cloudflare-only vhost tells us nothing at all from here.
  if (site.nodePort && result.portUp) {
    const a = await httpProbe({ tls: false, port: site.nodePort, domain: site.domain, timeout: 3000 });
    result.appStatus = a.status != null ? a.status : null;
    result.appError = a.error || null;
    result.appUp = a.status != null || /^HPE_/.test(a.error || '');   // HPE_* = it answered, just not HTTP
  } else if (site.nodePort) { result.appUp = false; result.appError = 'port not listening'; }

  // Disk
  if (site.user) {
    const homeDir = `/home/${site.user}`;
    result.disk = getSiteDisk(homeDir);
  }

  if (site.poolPort || site.type === 'php') { try { result.phpActual = php.findPoolVersion(site.domain); } catch (_) {} }

  // PM2 processes of this site — including apps whose daemon is dead but that are named in dump.pm2,
  // which is the state a downed site is actually in.
  try {
    const p = await procs.list(site, { live: !!live });
    result.pm2 = p.processes.length ? p.processes : null;
    result.pm2Homes = p.homes.map((h) => ({ user: h.user, running: h.running, apps: h.dump.length, daemonStale: !!(h.daemon && h.daemon.stale) }));
    result.canControl = p.homes.length > 0;
    result.pm2DaemonStale = p.homes.filter((h) => h.daemon && h.daemon.stale).map((h) => h.user);
  } catch (e) { result.pm2 = null; }

  // The interpreter the site's *app* actually executes.
  //
  // This used to read the exe of whatever pid held the app port, which is wrong for pm2's cluster
  // mode: there the God Daemon owns the listening socket and the workers run the app. A daemon that
  // has been up since before a node upgrade reports its old, deleted binary forever — restarting the
  // app replaces the worker but never the daemon, so "Node ⚠ replaced" could never be cleared. Read
  // the app processes instead, and keep a stale daemon as its own, separately actionable fact.
  const appExes = [];
  for (const pr of result.pm2 || []) {
    const e = pr.pid && exeOf(pr.pid);
    if (e && !appExes.some((x) => x.path === e.path && x.stale === e.stale)) appExes.push(e);
  }
  // Nothing under pm2 (a plain systemd unit, or an app started by hand): fall back to the pid on the
  // port, which is that app itself when no pm2 daemon is in front of it.
  if (!appExes.length && site.nodePort && result.portUp) {
    const l = listening.get(Number(site.nodePort));
    const e = l && exeOf(l.pid);
    if (e && !isPm2Daemon(l.pid)) appExes.push(e);
  }
  if (appExes.length) {
    const fresh = appExes.find((e) => !e.stale);
    result.nodeActual = (fresh && fresh.version) || appExes.map((e) => e.version).find(Boolean) || null;
    result.nodeStale = appExes.every((e) => e.stale);
    result.nodeExe = (fresh || appExes[0]).path;
  }

  // Status. `httpUp === null` means nginx blocked this probe because the vhost is Cloudflare-only —
  // that says nothing about the app, so it never counts as a failure on its own.
  const httpBad = result.httpUp === false;
  const why = [];

  // What pm2 says about the site's own apps. This is the ground truth the port check cannot give:
  // under cluster mode the God Daemon holds the listening socket whether or not a single worker is
  // up, so `portUp` stays true across a `pm2 stop` and the site read "Online" while serving nothing.
  const managed = (result.pm2 || []).filter((p) => !p.fromDump || p.status === 'daemon down');
  const pm2Up = managed.filter((p) => p.status === 'online').length;
  const pm2Known = managed.length;
  const pm2AllDown = pm2Known > 0 && pm2Up === 0;

  if (site.type === 'static') {
    result.status = result.originUp && !httpBad ? 'online' : 'down';
    if (!result.originUp) why.push('nginx did not answer on this host (' + (result.originError || 'no response') + ')');
    else if (httpBad) why.push('nginx returned ' + result.originStatus);
  } else if (site.nodePort) {
    const stoppedNames = () => managed.filter((p) => p.status !== 'online').map((p) => p.name + ' ' + p.status).join(', ');
    if (!result.portUp) { result.status = 'down'; why.push('nothing is listening on port ' + site.nodePort); }
    else if (result.appUp === false) { result.status = 'down'; why.push('the app does not answer on port ' + site.nodePort + ' (' + (result.appError || 'no response') + ')'); }
    // Port open and answering, but pm2 holds nothing up. Under cluster mode the daemon keeps the
    // socket after `pm2 stop`, so this is a real state — never call it Online just because the
    // socket exists. It is only 'degraded' rather than 'down' when the port genuinely answered,
    // which means something outside pm2 is serving the site and that is worth saying, not hiding.
    else if (pm2AllDown) { result.status = result.appUp === true ? 'degraded' : 'down'; why.push('every pm2 process of this site is stopped (' + stoppedNames() + ')' + (result.appUp === true ? ', yet port ' + site.nodePort + ' still answers — something outside pm2 is serving it' : '')); }
    else if (pm2Known && pm2Up < pm2Known) { result.status = 'degraded'; why.push(pm2Up + ' of ' + pm2Known + ' pm2 processes are up (' + stoppedNames() + ')'); }
    else if (!result.originUp) { result.status = 'degraded'; why.push('the app answers but nginx did not (' + (result.originError || 'no response') + ')'); }
    else if (httpBad) { result.status = 'degraded'; why.push('the app answers but nginx returned ' + result.originStatus); }
    else result.status = 'online';
  } else if (site.poolPort) {
    if (!result.portUp) { result.status = 'down'; why.push('php-fpm pool is not listening on port ' + site.poolPort); }
    else if (!result.originUp) { result.status = 'down'; why.push('nginx did not answer on this host (' + (result.originError || 'no response') + ')'); }
    else if (httpBad) { result.status = 'down'; why.push('nginx returned ' + result.originStatus); }
    else result.status = 'online';
  }
  if (result.status !== 'online' && result.pm2 && !result.pm2.some((p) => p.status === 'online')) {
    const dead = result.pm2Homes.filter((h) => !h.running && h.apps);
    if (dead.length) why.push('the pm2 daemon of ' + dead.map((h) => h.user).join(', ') + ' is not running (' + dead.reduce((n, h) => n + h.apps, 0) + ' saved app(s))');
  }
  if (result.httpUp === null && why.length) why.push('this vhost only accepts Cloudflare, so the panel cannot fetch the page itself');
  result.statusReason = why.join('; ');
  result.statusLabel = result.status.charAt(0).toUpperCase() + result.status.slice(1);
  return result;
}

function siteRows() {
  // Our own table once the CloudPanel import has run; the CLP DB as a fallback before that.
  let sites = [];
  try {
    sites = store.list().map((s) => ({ id: String(s.id), domain: s.domain, type: s.type, user: s.user, root: s.root_dir, revProxy: s.reverse_proxy_url || '',
      varnish: s.varnish_cache, nodePort: s.nodejs ? String(s.nodejs.port) : null, nodeVer: s.nodejs ? s.nodejs.node_version : null,
      phpVer: s.php ? s.php.php_version : null, poolPort: s.php ? String(s.php.pool_port) : null, phpMem: s.php ? s.php.memory_limit : null,
      managed_by: s.managed_by, application: s.application, cfOnly: !!s.cf_only }));
  } catch (e) { console.error('sites: store unavailable, falling back to CloudPanel DB:', e.message); }
  if (!sites.length) sites = querySitesDb();
  return sites;
}

async function collectSites() {
  versionMemo.clear();
  const sites = siteRows();
  const lmap = listeners();
  const results = await Promise.all(sites.map(s => checkSiteHealth(s, lmap)));
  sitesCache = { sites: results, generated_at: new Date().toISOString() };
  sitesCacheAt = Date.now();
  return sitesCache;
}

// Re-check one site and splice it into the cache, asking pm2 itself rather than the collector's
// snapshot. This is what a start/stop/restart calls before answering: sweeping all thirteen sites
// takes seconds, and the caller only ever changed one of them — but until that one is re-read the
// list still shows the state from before the action, which is indistinguishable from it not working.
async function refreshSite(domain) {
  versionMemo.clear();
  const row = siteRows().find((s) => s.domain === domain);
  if (!row) return null;
  const fresh = await checkSiteHealth(row, listeners(), true);
  if (sitesCache) {
    const i = sitesCache.sites.findIndex((s) => s.domain === domain);
    if (i >= 0) sitesCache.sites[i] = fresh; else sitesCache.sites.push(fresh);
    sitesCache.generated_at = new Date().toISOString();
  }
  return fresh;
}

// The sweep runs every 5 min, but its PM2 view is only a copy of the collector's latest sample (60s)
// taken at sweep time — so a restart, a crash, or a sweep that raced the first sample after boot
// (every app then reads "not started" from dump.pm2) stayed wrong for up to 5 min. Re-derive the PM2
// fields from the current sample on every read; it is fs reads and an in-memory lookup.
function withLivePm2(s) {
  try {
    const p = procs.list({ id: s.id, user: s.user });
    return Object.assign({}, s, { pm2: p.processes.length ? p.processes : null,
      pm2Homes: p.homes.map((h) => ({ user: h.user, running: h.running, apps: h.dump.length })), canControl: p.homes.length > 0 });
  } catch (_) { return s; }
}
function getCache() { return sitesCache && Object.assign({}, sitesCache, { sites: sitesCache.sites.map(withLivePm2) }); }

module.exports = { collectSites, refreshSite, getCache };
