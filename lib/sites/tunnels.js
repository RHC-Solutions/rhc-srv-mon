'use strict';
// Cloudflare Tunnel apps: hostnames this host serves through cloudflared rather than through an
// nginx vhost of its own (a Python/Node app on 127.0.0.1, Uptime Kuma, …). They are not Sites —
// the panel did not create them and does not own their config — but they are what the host
// serves, so the Sites tab lists them read-only.
//
// Discovery, per cloudflared systemd unit:
//   --token / --token-file / TUNNEL_TOKEN  → remotely managed tunnel; the token is base64 JSON
//                                            { a: account, t: tunnel id, s: secret } and the routes
//                                            come from the Cloudflare API (panel's API token).
//   --config <file> or /etc/cloudflared/config.yml → locally managed; routes read from the file.
// Each route's local target is fetched (no redirects followed) to say whether the app answers.
const fs = require('fs');
const { execFileSync } = require('child_process');
const cloudflare = require('../cloudflare');

const TTL = 60_000;
let cache = { tunnels: [], error: null, generated_at: null }, cacheAt = 0, running = null;

function sh(cmd, args) { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); } catch (_) { return ''; } }

function units() {
  return sh('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain', 'cloudflared*'])
    .split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.endsWith('.service'));
}

function unitInfo(unit) {
  const props = Object.fromEntries(sh('systemctl', ['show', unit, '-p', 'ExecStart', '-p', 'ActiveState', '-p', 'Environment', '-p', 'Description'])
    .split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  const argv = ((/argv\[\]=([^;]*)/.exec(props.ExecStart || '') || [])[1] || '').trim().split(/\s+/);
  const arg = (name) => { const i = argv.indexOf(name); if (i >= 0) return argv[i + 1]; const eq = argv.find((a) => a.startsWith(name + '=')); return eq ? eq.slice(name.length + 1) : null; };
  let token = arg('--token');
  const tokenFile = arg('--token-file');
  if (!token && tokenFile) { try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (_) {} }
  if (!token) token = (/(?:^|\s)TUNNEL_TOKEN=(\S+)/.exec(props.Environment || '') || [])[1] || null;
  let config = arg('--config');
  if (!config && !token) config = ['/etc/cloudflared/config.yml', '/etc/cloudflared/config.yaml'].find((f) => fs.existsSync(f)) || null;
  let ids = null;
  if (token) { try { const j = JSON.parse(Buffer.from(token, 'base64').toString('utf8')); ids = { account: j.a, tunnel: j.t }; } catch (_) {} }
  return { unit: unit.replace(/\.service$/, ''), active: props.ActiveState === 'active', ids, config };
}

// Minimal reader for cloudflared's config: `tunnel:` and the `ingress:` list items.
function readConfig(file) {
  let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return { tunnel: null, ingress: [] }; }
  const tunnel = (/^tunnel:\s*["']?([^"'\s#]+)/m.exec(txt) || [])[1] || null;
  const ingress = []; let cur = null, inIngress = false;
  for (const raw of txt.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^ingress:/.test(line)) { inIngress = true; continue; }
    if (inIngress && /^\S/.test(line)) inIngress = false;
    if (!inIngress) continue;
    const m = /^\s*(-\s*)?(hostname|service|path):\s*["']?([^"'\s]+)/.exec(line);
    if (!m) continue;
    if (m[1]) { cur = {}; ingress.push(cur); }
    if (cur) cur[m[2]] = m[3];
  }
  return { tunnel, ingress };
}

async function localStatus(service) {
  if (!/^https?:\/\//.test(service || '')) return null;
  try {
    const r = await fetch(service, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    return r.status;
  } catch (_) { return 0; }
}

async function accessHosts(account) {
  try {
    const apps = await cloudflare.api('/accounts/' + account + '/access/apps?per_page=1000');
    return new Set(((apps && apps.result) || []).map((a) => String(a.domain || '').split('/')[0].toLowerCase()));
  } catch (_) { return null; }   // token without Access read: unknown, not "unprotected"
}

async function collect() {
  const out = []; const errors = []; const accessByAccount = new Map();
  for (const u of units().map(unitInfo)) {
    if (!u.ids && !u.config) continue;   // cloudflared-update and other helpers run no tunnel
    const t = { unit: u.unit, active: u.active, name: null, id: null, status: null, managed: u.ids ? 'remote' : (u.config ? 'local' : 'unknown'), routes: [] };
    let ingress = [];
    if (u.ids) {
      t.id = u.ids.tunnel;
      try {
        const [info, conf] = await Promise.all([
          cloudflare.api('/accounts/' + u.ids.account + '/cfd_tunnel/' + u.ids.tunnel),
          cloudflare.api('/accounts/' + u.ids.account + '/cfd_tunnel/' + u.ids.tunnel + '/configurations'),
        ]);
        t.name = info.result && info.result.name; t.status = info.result && info.result.status;
        ingress = (conf.result && conf.result.config && conf.result.config.ingress) || [];
      } catch (e) { errors.push(u.unit + ': ' + e.message); }
      if (!accessByAccount.has(u.ids.account)) accessByAccount.set(u.ids.account, await accessHosts(u.ids.account));
    } else if (u.config) {
      const c = readConfig(u.config); t.id = c.tunnel; t.name = c.tunnel; ingress = c.ingress;
    }
    const access = u.ids ? accessByAccount.get(u.ids.account) : null;
    for (const r of ingress) {
      if (!r.hostname) continue;   // the catch-all rule
      t.routes.push({ hostname: r.hostname, path: r.path || '', service: r.service || '', access: access ? access.has(r.hostname.toLowerCase()) : null });
    }
    await Promise.all(t.routes.map(async (r) => { r.local = await localStatus(r.service); }));
    out.push(t);
  }
  return { tunnels: out, error: errors.join('; ') || null, generated_at: new Date().toISOString() };
}

function refresh() {
  if (!running) running = collect().then((c) => { cache = c; cacheAt = Date.now(); }).catch((e) => { cache.error = e.message; }).finally(() => { running = null; });
  return running;
}

// Last result immediately; a stale one starts a background refresh (the Sites list polls).
function get() { if (Date.now() - cacheAt > TTL) refresh(); return cache; }

module.exports = { get, refresh, collect };
