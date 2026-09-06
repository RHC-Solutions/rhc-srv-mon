'use strict';
/* -------------------------------------------------------------- sites */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { querySitesDb } = require('./cloudpanel');
const store = require('./sites/store');
const history = require('./history');

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

async function checkSiteHealth(site) {
  const result = {
    id: site.id, domain: site.domain, type: site.type, user: site.user,
    root: site.root, revProxy: site.revProxy,
    nodeVersion: site.nodeVer, phpVersion: site.phpVer,
    portUp: false, httpUp: false, disk: '?', pm2: null,
    status: 'unknown', statusLabel: 'Unknown',
    managed_by: site.managed_by || 'clp', application: site.application || null,
  };

  // Check port
  if (site.nodePort) {
    result.portUp = isPortListening(site.nodePort);
  } else if (site.poolPort) {
    result.portUp = isPortListening(site.poolPort);
  } else if (site.type === 'static') {
    result.portUp = true; // served by nginx, no app port
  }

  // HTTP health check
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`https://${site.domain}/`, { signal: ctrl.signal, redirect: 'follow' });
    result.httpUp = res.ok || res.status < 500;
  } catch {
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`http://${site.domain}/`, { signal: ctrl.signal, redirect: 'follow' });
      result.httpUp = res.ok || res.status < 500;
    } catch { result.httpUp = false; }
  }

  // Disk
  if (site.user) {
    const homeDir = `/home/${site.user}`;
    result.disk = getSiteDisk(homeDir);
  }

  // PM2 process data (match against existing PM2 data)
  const latest = history.getLatest();
  if (latest) {
    const userDirs = [];
    const siteHome = (() => { try { return fs.realpathSync(`/home/${site.user}`); } catch { return ''; } })();
    for (const g of latest) {
      if (g.user === site.user) { userDirs.push(g); continue; }
      if (g.pm2_home.includes(`/home/${site.user}/`) || g.pm2_home.includes(`/home/${site.user}.`)) { userDirs.push(g); continue; }
      if (g.user.includes(site.user) || site.user.includes(g.user)) { userDirs.push(g); continue; }
      // Check if home directories resolve to same path (symlinked SSH users)
      if (siteHome) {
        try {
          const pm2HomeDir = path.dirname(g.pm2_home);
          if (fs.realpathSync(pm2HomeDir) === siteHome) { userDirs.push(g); continue; }
        } catch {}
        // Check if PM2 user's htdocs symlink points to site user's htdocs
        try {
          const pm2Htdocs = fs.realpathSync(path.join(path.dirname(g.pm2_home), 'htdocs'));
          const siteHtdocs = path.join(siteHome, 'htdocs');
          if (pm2Htdocs === siteHtdocs) { userDirs.push(g); continue; }
        } catch {}
      }
      // Check PM2 process names for site domain name
      if (g.processes.some(p => p.name.includes(site.domain.split('.')[0]))) { userDirs.push(g); continue; }
    }
    // Deduplicate
    const seen = new Set();
    const deduped = [];
    for (const g of userDirs) {
      if (!seen.has(g.user)) { seen.add(g.user); deduped.push(g); }
    }
    if (deduped.length) {
      result.pm2 = deduped.flatMap(g => g.processes);
    }
  }

  const colors = { 'online': 'up' };
  // Determine overall status
  const pm2Online = result.pm2 ? result.pm2.some(p => p.status === 'online') : false;
  if (site.type === 'static') {
    result.status = result.httpUp ? 'online' : 'down';
  } else if (site.nodePort) {
    // The app is serving if the port is listening AND HTTP responds — that's ground truth,
    // whether or not it's supervised by PM2 (e.g. sites run under bun/systemd show no PM2 match).
    if (result.httpUp && result.portUp) { result.status = 'online'; }
    else if (!result.portUp && !result.httpUp) { result.status = 'down'; }
    else { result.status = 'degraded'; }
  } else if (site.poolPort) {
    if (result.portUp && result.httpUp) { result.status = 'online'; }
    else { result.status = 'down'; }
  }
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
      managed_by: s.managed_by, application: s.application }));
  } catch (e) { console.error('sites: store unavailable, falling back to CloudPanel DB:', e.message); }
  if (!sites.length) sites = querySitesDb();
  const results = await Promise.all(sites.map(s => checkSiteHealth(s)));
  sitesCache = { sites: results, generated_at: new Date().toISOString() };
  sitesCacheAt = Date.now();
  return sitesCache;
}


function getCache() { return sitesCache; }

module.exports = { collectSites, getCache };
