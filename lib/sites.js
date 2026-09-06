'use strict';
/* -------------------------------------------------------------- sites */

const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const { querySitesDb } = require('./cloudpanel');
const store = require('./sites/store');
const procs = require('./sites/procs');

let sitesCache = null, sitesCacheAt = 0;

function getSiteDisk(dir) {
  try {
    const out = execFileSync('du', ['-sh', dir], { timeout: 3000, encoding: 'utf8' });
    return out.trim().split('\t')[0];
  } catch { return '?'; }
}

function isPortListening(port) {
  try {
    const out = execFileSync('ss', ['-tlnpH'], { timeout: 3000, encoding: 'utf8' });
    return out.includes(`:${port} `);
  } catch { return false; }
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

async function checkSiteHealth(site) {
  const result = {
    id: site.id, domain: site.domain, type: site.type, user: site.user,
    root: site.root, revProxy: site.revProxy,
    nodeVersion: site.nodeVer, phpVersion: site.phpVer,
    portUp: false, httpUp: false, disk: '?', pm2: null,
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

  // PM2 processes of this site — including apps whose daemon is dead but that are named in dump.pm2,
  // which is the state a downed site is actually in.
  try {
    const p = procs.list(site);
    result.pm2 = p.processes.length ? p.processes : null;
    result.pm2Homes = p.homes.map((h) => ({ user: h.user, running: h.running, apps: h.dump.length }));
    result.canControl = p.homes.length > 0;
  } catch (e) { result.pm2 = null; }

  // Status. `httpUp === null` means nginx blocked this probe because the vhost is Cloudflare-only —
  // that says nothing about the app, so it never counts as a failure on its own.
  const httpBad = result.httpUp === false;
  const why = [];
  if (site.type === 'static') {
    result.status = result.originUp && !httpBad ? 'online' : 'down';
    if (!result.originUp) why.push('nginx did not answer on this host (' + (result.originError || 'no response') + ')');
    else if (httpBad) why.push('nginx returned ' + result.originStatus);
  } else if (site.nodePort) {
    if (!result.portUp) { result.status = 'down'; why.push('nothing is listening on port ' + site.nodePort); }
    else if (result.appUp === false) { result.status = 'down'; why.push('the app does not answer on port ' + site.nodePort + ' (' + (result.appError || 'no response') + ')'); }
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

async function collectSites() {
  // Our own table once the CloudPanel import has run; the CLP DB as a fallback before that.
  let sites = [];
  try {
    sites = store.list().map((s) => ({ id: String(s.id), domain: s.domain, type: s.type, user: s.user, root: s.root_dir, revProxy: s.reverse_proxy_url || '',
      varnish: s.varnish_cache, nodePort: s.nodejs ? String(s.nodejs.port) : null, nodeVer: s.nodejs ? s.nodejs.node_version : null,
      phpVer: s.php ? s.php.php_version : null, poolPort: s.php ? String(s.php.pool_port) : null, phpMem: s.php ? s.php.memory_limit : null,
      managed_by: s.managed_by, application: s.application, cfOnly: !!s.cf_only }));
  } catch (e) { console.error('sites: store unavailable, falling back to CloudPanel DB:', e.message); }
  if (!sites.length) sites = querySitesDb();
  const results = await Promise.all(sites.map(s => checkSiteHealth(s)));
  sitesCache = { sites: results, generated_at: new Date().toISOString() };
  sitesCacheAt = Date.now();
  return sitesCache;
}


function getCache() { return sitesCache; }

module.exports = { collectSites, getCache };
