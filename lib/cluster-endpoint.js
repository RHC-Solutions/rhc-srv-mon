'use strict';
// Transfer address: a hostname OUTSIDE Cloudflare Access that answers only the signed transfer API.
//
// The panel itself sits behind Cloudflare Access, which machines cannot pass without a service token
// (and the panel's Cloudflare token may not be allowed to create one). So a target server gets
// xfer-<host>.<zone>: a route on its shared tunnel to an nginx server block that proxies ONLY
// /api/cluster/join and /api/cluster/peer/* to the panel — everything else is 404. Those endpoints
// authenticate every request themselves (one-time join codes, HMAC-signed calls, replay window).
// The panel's transfer URL is switched to it, so transfer codes from this server carry it.
const fs = require('fs');
const os = require('os');
const { execP } = require('./util');
const cf = require('./cloudflare');

const NGINX_FILE = '/etc/nginx/sites-enabled/sb-transfer.conf';
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });

function sharedTunnel() {
  try { const j = JSON.parse(Buffer.from(fs.readFileSync('/etc/cloudflared/token', 'utf8').trim(), 'base64').toString()); return j.a && j.t ? { account: j.a, id: j.t } : null; } catch (_) { return null; }
}
// Where the shared tunnel sends the panel's own hostname (http://127.0.0.1:8890 on sbapps01).
async function panelOrigin(t) {
  const conf = (await cf.api('/accounts/' + t.account + '/cfd_tunnel/' + t.id + '/configurations')).result.config;
  const panelHost = (String(require('./db').settings.get('cluster.panelUrl', null) || require('./cluster').self().url).match(/^https:\/\/([^/]+)/) || [])[1];
  const r = (conf.ingress || []).find((x) => x.hostname && x.hostname === panelHost) || (conf.ingress || []).find((x) => x.hostname && /^http:\/\/127\.0\.0\.1:\d+$/.test(x.service || ''));
  return { conf, panelHost, origin: r ? r.service : null };
}

// A panel published straight through nginx (no Cloudflare Access, e.g. https://web01.heimman.com/rhc-admin/)
// already answers the signed transfer API at its own URL: an unsigned call reaches the panel and is refused there.
async function reachesTransferApi(url) {
  try {
    const r = await fetch(new URL('api/cluster/peer/info', url), { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const j = await r.json().catch(() => ({}));
    return r.status === 401 && j.error === 'unknown cluster member';
  } catch (_) { return false; }
}

async function create(say) {
  say = say || (() => {});
  const t = sharedTunnel();
  if (!t) {
    const url = require('./cluster').self().url;
    if (url && await reachesTransferApi(url)) {
      say('the panel URL ' + url + ' already answers the transfer API (no Cloudflare Access in front) — nothing to create');
      return { host: new URL(url).host, url };
    }
    throw bad('no shared tunnel on this server (/etc/cloudflared/token), and the panel URL ' + (url || '(not set)') + ' does not answer the transfer API — set a reachable panel URL (Transfer → Advanced) or publish the panel through Cloudflare Tunnel', 409);
  }
  const { settings } = require('./db');
  // the panel's own address (kept aside once the transfer address has replaced it as "the URL")
  const panelUrl = settings.get('cluster.panelUrl', null) || require('./cluster').self().url;
  const panelHost = (String(panelUrl).match(/^https:\/\/([^/]+)/) || [])[1];
  if (!panelHost || /^xfer-/.test(panelHost)) throw bad('set the panel URL (Transfer → Advanced) first');
  const zone = cf.zoneFor(panelHost, await cf.zones());
  if (!zone) throw bad('no Cloudflare zone for ' + panelHost);
  const host = 'xfer-' + panelHost.split('.')[0] + '.' + zone.name;
  // 1. nginx: only the transfer API
  const port = Number(process.env.PORT) || 8899;
  const listen = (fs.readFileSync('/etc/nginx/sites-enabled/' + (fs.readdirSync('/etc/nginx/sites-enabled').find((f) => { try { return fs.readFileSync('/etc/nginx/sites-enabled/' + f, 'utf8').includes('server_name ' + panelHost); } catch (_) { return false; } }) || 'none'), 'utf8').match(/listen\s+([0-9.:]+)\s*;/) || [])[1] || '127.0.0.1:8890';
  const conf = `# Managed by sb-srv-mon: transfer address (Transfer → Advanced). Only the signed transfer API is
# reachable here — it authenticates every request itself; the panel stays behind Cloudflare Access.
server {
    listen ${listen};
    server_name ${host};
    client_max_body_size 50m;
    location = /api/cluster/join { proxy_pass http://127.0.0.1:${port}; include /etc/nginx/sb-transfer-proxy.inc; }
    location ^~ /api/cluster/peer/ { proxy_pass http://127.0.0.1:${port}; include /etc/nginx/sb-transfer-proxy.inc; }
    location / { return 404; }
}
`;
  fs.writeFileSync('/etc/nginx/sb-transfer-proxy.inc', 'proxy_http_version 1.1;\nproxy_set_header Host $host;\nproxy_set_header X-Real-IP $http_cf_connecting_ip;\nproxy_set_header X-Forwarded-For $http_cf_connecting_ip;\nproxy_set_header X-Forwarded-Proto https;\nproxy_read_timeout 600s;\nproxy_send_timeout 600s;\nproxy_request_buffering off;\n');
  const prev = fs.existsSync(NGINX_FILE) ? fs.readFileSync(NGINX_FILE, 'utf8') : null;
  fs.writeFileSync(NGINX_FILE, conf);
  const tst = await execP('nginx', ['-t'], { timeout: 30_000 });
  if (tst.err) { if (prev == null) fs.unlinkSync(NGINX_FILE); else fs.writeFileSync(NGINX_FILE, prev); throw bad('nginx refused the transfer server block — nothing changed', 500, tst.stderr); }
  await execP('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
  say('nginx: ' + host + ' answers only the transfer API (everything else 404)', 'listen ' + listen);
  // 2. tunnel route on the shared tunnel → same nginx
  const pc = await panelOrigin(t);
  const ingress = (pc.conf.ingress || []).filter((r) => r.hostname !== host);
  const ci = ingress.findIndex((r) => !r.hostname);
  ingress.splice(ci < 0 ? ingress.length : ci, 0, { hostname: host, service: 'http://' + listen });
  await cf.api('/accounts/' + t.account + '/cfd_tunnel/' + t.id + '/configurations', { method: 'PUT', body: { config: Object.assign({}, pc.conf, { ingress }) } });
  say('tunnel: ' + host + ' → http://' + listen + ' on the shared tunnel');
  // 3. DNS
  const recs = (await cf.api('/zones/' + zone.id + '/dns_records?name=' + host)).result || [];
  const body = { type: 'CNAME', name: host, content: t.id + '.cfargotunnel.com', proxied: true, comment: 'sb-srv-mon transfer address' };
  const ours = recs.find((r) => r.type === 'CNAME');
  if (recs.some((r) => r.type !== 'CNAME')) throw bad(host + ' already has a non-CNAME DNS record — not touching it');
  if (ours) await cf.api('/zones/' + zone.id + '/dns_records/' + ours.id, { method: 'PUT', body }); else await cf.api('/zones/' + zone.id + '/dns_records', { method: 'POST', body });
  say('DNS: ' + host + ' → tunnel (proxied)');
  // 4. the panel hands this address out in its transfer codes
  settings.set('cluster.panelUrl', panelUrl);
  require('./cluster').setSelf({ url: 'https://' + host + '/' });
  say('transfer codes from this server now point to https://' + host + '/');
  return { host, url: 'https://' + host + '/' };
}

module.exports = { create };
