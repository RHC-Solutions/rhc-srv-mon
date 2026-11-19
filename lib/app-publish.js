'use strict';
// Publish an App Store app that listens on 127.0.0.1 (Uptime Kuma, Portainer) under a hostname of
// your choice: it becomes an ordinary reverse-proxy site (listed under Sites, nginx + certificate +
// Cloudflare-only like any other), reached either through its own Cloudflare Tunnel or through a
// proxied A record pointing at this server.
//   how = 'tunnel'  tunnel + route + DNS made by site creation (lib/sites/tunnel.js); if that is not
//                   possible here, falls back to the A record
//   how = 'a'       A record → this server's public IP, orange cloud on (lib/sites/cloudflare.js)
const os = require('os');
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });

function publicIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address)) return i.address;
  return null;
}
function proxyTemplate() {
  const st = require('./sites/store');
  const t = (st.templates.list ? st.templates.list() : []).find((x) => x.type === 'reverse-proxy');
  return t ? t.name : 'ReverseProxy';
}

async function publish(opts, log) {
  const store = require('./sites/store'), vhost = require('./sites/vhost');
  const host = String(opts.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const how = opts.how === 'a' ? 'a' : 'tunnel';
  if (!vhost.validDomain(host)) throw bad('"' + host + '" is not a valid hostname');
  let site = store.get(host);
  if (site) {
    if (site.type !== 'reverse-proxy' || String(site.reverse_proxy_url || '').replace(/\/+$/, '') !== opts.url) throw bad(host + ' is already a site here (' + site.type + (site.reverse_proxy_url ? ' → ' + site.reverse_proxy_url : '') + ') — pick another name or delete that site', 409);
    log('» ' + host + ' is already this app\'s site — kept');
  } else {
    log('» creating the site ' + host + ' (reverse proxy → ' + opts.url + ', Cloudflare only' + (how === 'tunnel' ? ', own Cloudflare Tunnel' : '') + ')');
    const r = await require('./sites/create').createSite({ domain: host, type: 'reverse-proxy', template: proxyTemplate(), reverse_proxy_url: opts.url, cf_only: true,
      tunnel: how === 'tunnel', github: false, sqlite: false, claude: false }, { actor: opts.actor || 'system' });
    for (const s of r.steps) log('  ✓ ' + s.name + (s.detail ? ' — ' + s.detail : ''));
    site = r.site;
    try { require('./events').emit('site.create', { user: opts.actor || 'system', site: host, message: 'Site ' + host + ' created for ' + (opts.app || 'an App Store app') + ' (reverse proxy → ' + opts.url + ')' }); } catch (_) {}
    if (how === 'tunnel' && r.tunnel) { log('» published through Cloudflare Tunnel ' + r.tunnel.id); return done(host, 'tunnel', log); }
    if (how === 'tunnel') log('» no tunnel could be made here — pointing an A record at this server instead');
  }
  const ip = publicIp();
  if (!ip) { log('» this server has no public IPv4 — point DNS for ' + host + ' here yourself'); return done(host, 'manual', log); }
  try {
    const p = await require('./sites/cloudflare').pointHere(site, ip, { proxied: true });
    log('» DNS: ' + host + ' A ' + ip + ' (proxied) — ' + p.changes.map((c) => c.action).join(', '));
    return done(host, 'a', log);
  } catch (e) {
    log('» could not set DNS (' + e.message + ') — create a proxied A record ' + host + ' → ' + ip + ' in Cloudflare');
    return done(host, 'manual', log);
  }
}
function done(host, via, log) {
  log('open https://' + host + ' (DNS can take a minute)');
  return { host, url: 'https://' + host, via };
}

module.exports = { publish, publicIp };
