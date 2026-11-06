'use strict';
// Cloudflare Tunnel publishing for sites, and the nginx base a host without CloudPanel needs.
//
// publish(site): one tunnel per site ("site-<domain>"), remotely managed, run by its own systemd
// unit cloudflared-site-<domain>.service with the token in /etc/cloudflared/site-<domain>.token.
// Routes <domain> (and www.<domain> for an apex) → https://127.0.0.1:443 with SNI = the domain,
// i.e. into the site's own nginx vhost, so everything the panel does to the vhost (SSL, rules,
// basic auth, Cloudflare-only) keeps applying. DNS: proxied CNAME → <tunnel>.cfargotunnel.com; an
// existing record that is NOT a tunnel CNAME is left alone and reported, never overwritten.
// unpublish(domain) undoes all of it. State per site in kv `tunnel.site:<domain>`.
//
// ensureBase(): on hosts that never had CloudPanel, the vhost templates reference things CLP's
// nginx.conf provided — `log_format main/cloudflare`, /etc/nginx/cloudflare/ips — and there are no
// vhost templates at all. This writes the missing pieces (only what is missing) and seeds built-in
// templates. Tunnel traffic reaches nginx from 127.0.0.1, so the Cloudflare-only allow-list also
// allows loopback.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cf = require('../cloudflare');
const store = require('./store');
const { settings } = require('../db');
const { execP } = require('../util');

const CF_DIR = '/etc/cloudflared';
const UNIT_DIR = '/etc/systemd/system';
const BASE_CONF = '/etc/nginx/conf.d/rhc-base.conf';
const CF_IPS = '/etc/nginx/cloudflare/ips';
const SSL_DIR = '/etc/nginx/ssl-certificates';
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });

const slug = (domain) => String(domain).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const unitName = (domain) => 'cloudflared-site-' + slug(domain);
const tokenFile = (domain) => path.join(CF_DIR, 'site-' + slug(domain) + '.token');
const stateKey = (domain) => 'tunnel.site:' + String(domain).toLowerCase();
const state = (domain) => settings.get(stateKey(domain), null);

function hasBinary() { try { execFileSync('cloudflared', ['--version'], { stdio: 'ignore', timeout: 5000 }); return true; } catch (_) { return false; } }

// Whether new sites get a tunnel: needs cloudflared and a Cloudflare token; off with kv tunnel.autoPublish=false.
function available() {
  if (settings.get('tunnel.autoPublish', true) === false) return { ok: false, reason: 'turned off (Settings)' };
  if (!cf.configured()) return { ok: false, reason: 'no Cloudflare API token (Settings → Cloudflare)' };
  if (!hasBinary()) return { ok: false, reason: 'cloudflared is not installed' };
  return { ok: true };
}

// ------------------------------------------------------------------ nginx base + templates
async function cloudflareRanges() {
  try {
    const j = await (await fetch('https://api.cloudflare.com/client/v4/ips', { signal: AbortSignal.timeout(10000) })).json();
    return [...(j.result.ipv4_cidrs || []), ...(j.result.ipv6_cidrs || [])];
  } catch (_) { return null; }
}
function nginxDefines(re) { try { return re.test(execFileSync('nginx', ['-T'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 })); } catch (_) { return false; } }

async function ensureBase() {
  const changed = [];
  fs.mkdirSync(SSL_DIR, { recursive: true, mode: 0o750 });
  if (!fs.existsSync(BASE_CONF) && !nginxDefines(/log_format\s+cloudflare\b/)) {
    fs.writeFileSync(BASE_CONF, [
      '# Written by rhc-srv-mon: what CloudPanel\'s nginx.conf would provide to the site vhosts.',
      "log_format main '$remote_addr - $remote_user [$time_local] \"$request\" $status $body_bytes_sent \"$http_referer\" \"$http_user_agent\" $request_time';",
      "log_format cloudflare '$http_cf_connecting_ip - $remote_user [$time_local] \"$request\" $status $body_bytes_sent \"$http_referer\" \"$http_user_agent\" $request_time';",
      'server_names_hash_bucket_size 128;',
      'client_max_body_size 256m;',
      '',
    ].join('\n'));
    changed.push(BASE_CONF);
  }
  if (!fs.existsSync(CF_IPS)) {
    const ranges = await cloudflareRanges();
    if (!ranges) throw bad('could not fetch Cloudflare\'s IP ranges for ' + CF_IPS);
    fs.mkdirSync(path.dirname(CF_IPS), { recursive: true });
    fs.writeFileSync(CF_IPS, '# Cloudflare edge (https://api.cloudflare.com/client/v4/ips) + loopback for Cloudflare Tunnel\n'
      + ranges.map((r) => 'allow ' + r + ';').join('\n') + '\nallow 127.0.0.1;\nallow ::1;\ndeny all;\n');
    changed.push(CF_IPS);
  }
  if (!store.templates.list().length) { seedTemplates(); changed.push('built-in vhost templates'); }
  return changed;
}

const HEAD = `server {
  listen 80;
  listen [::]:80;
  listen 443 ssl;
  listen [::]:443 ssl;
  http2 on;
  {{ssl_certificate_key}}
  {{ssl_certificate}}
  {{server_name}}
  {{root}}

  {{nginx_access_log}}
  {{nginx_error_log}}

  if ($scheme != "https") {
    rewrite ^ https://$host$request_uri permanent;
  }

  location ~ /.well-known {
    auth_basic off;
    allow all;
  }

  {{settings}}
`;
const STATIC_ASSETS = `
  location ~* ^.+\\.(css|js|jpg|jpeg|gif|png|ico|gz|svg|svgz|ttf|otf|woff|woff2|eot|mp4|ogg|ogv|webm|webp|zip)$ {
    add_header Access-Control-Allow-Origin "*";
    expires max;
    access_log off;
  }
`;
const PROXY = (target) => `
  location / {
    proxy_pass ${target};
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-For $http_cf_connecting_ip;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 300s;
  }
}
`;
const BUILTIN = [
  { name: 'Static', type: 'static', template: HEAD + '\n  index index.html;\n\n  location / {\n    try_files $uri $uri/ =404;\n  }\n' + STATIC_ASSETS + '}\n' },
  { name: 'Nodejs', type: 'nodejs', template: HEAD + PROXY('http://127.0.0.1:{{app_port}}') },
  { name: 'Python', type: 'python', template: HEAD + PROXY('http://127.0.0.1:{{app_port}}') },
  { name: 'Reverse Proxy', type: 'reverse-proxy', template: HEAD + PROXY('{{reverse_proxy_url}}') },
  { name: 'Generic', type: 'php', template: HEAD + `
  index index.php index.html;

  location / {
    try_files $uri $uri/ /index.php?$args;
  }

  location ~ \\.php$ {
    include fastcgi_params;
    fastcgi_intercept_errors on;
    fastcgi_index index.php;
    fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    fastcgi_param PHP_VALUE "{{php_settings}}";
    fastcgi_read_timeout 3600;
    fastcgi_pass 127.0.0.1:{{php_fpm_port}};
  }
` + STATIC_ASSETS + '}\n' },
];
function seedTemplates() {
  for (const t of BUILTIN) if (!store.templates.get(t.name)) store.templates.upsert({ name: t.name, type: t.type, php_version: null, root_dir: null, template: t.template, varnish_settings: null, source: 'builtin' });
}

// ------------------------------------------------------------------ publish / unpublish
async function api(p, opts) { return cf.api(p, opts); }

async function zoneOf(domain) {
  const zone = cf.zoneFor(domain, await cf.zones());
  if (!zone) throw bad('no Cloudflare zone for ' + domain + ' in the configured account');
  if (!zone.account) throw bad('zone ' + zone.name + ' has no account id');
  return zone;
}

async function upsertCname(zone, name, target, say) {
  const recs = (await api('/zones/' + zone.id + '/dns_records?name=' + encodeURIComponent(name))).result || [];
  const ours = recs.find((r) => r.type === 'CNAME' && /\.cfargotunnel\.com$/.test(r.content));
  const other = recs.find((r) => !(r.type === 'CNAME' && /\.cfargotunnel\.com$/.test(r.content)));
  if (other && !ours) { say('left DNS for ' + name + ' alone', 'it already has a ' + other.type + ' record → ' + other.content + '; point it at ' + target + ' yourself if this server should serve it'); return null; }
  const body = { type: 'CNAME', name, content: target, proxied: true, comment: 'rhc-srv-mon site tunnel' };
  const r = ours ? await api('/zones/' + zone.id + '/dns_records/' + ours.id, { method: 'PUT', body }) : await api('/zones/' + zone.id + '/dns_records', { method: 'POST', body });
  say((ours ? 'repointed' : 'created') + ' DNS ' + name, 'proxied CNAME → ' + target);
  return r.result.id;
}

async function publish(site, say) {
  const domain = String(site.domain).toLowerCase();
  if (state(domain)) throw bad(domain + ' already has a tunnel', 409);
  const zone = await zoneOf(domain);
  const acct = zone.account.id;
  const hosts = domain === zone.name ? [domain, 'www.' + domain] : [domain];
  const rec = { domain, account: acct, zoneId: zone.id, hosts, dns: [], unit: unitName(domain), tokenFile: tokenFile(domain) };
  try {
    const secret = require('crypto').randomBytes(32).toString('base64');
    const t = (await api('/accounts/' + acct + '/cfd_tunnel', { method: 'POST', body: { name: 'site-' + domain, config_src: 'cloudflare', tunnel_secret: secret } })).result;
    rec.tunnelId = t.id; rec.tunnelName = t.name;
    say('created Cloudflare tunnel ' + t.name, t.id);
    await api('/accounts/' + acct + '/cfd_tunnel/' + t.id + '/configurations', { method: 'PUT', body: { config: { ingress: [
      ...hosts.map((h) => ({ hostname: h, service: 'https://127.0.0.1:443', originRequest: { originServerName: domain, noTLSVerify: true, httpHostHeader: h } })),
      { service: 'http_status:404' },
    ] } } });
    say('routed ' + hosts.join(', '), '→ https://127.0.0.1:443 (this site\'s nginx vhost)');
    const token = (await api('/accounts/' + acct + '/cfd_tunnel/' + t.id + '/token')).result;
    fs.mkdirSync(CF_DIR, { recursive: true });
    fs.writeFileSync(rec.tokenFile, token + '\n', { mode: 0o600 });
    fs.writeFileSync(path.join(UNIT_DIR, rec.unit + '.service'), [
      '[Unit]', 'Description=cloudflared tunnel for ' + domain + ' (rhc-srv-mon site)', 'After=network-online.target nginx.service', 'Wants=network-online.target', '',
      '[Service]', 'Type=notify', 'ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file ' + rec.tokenFile,
      'Restart=on-failure', 'RestartSec=5s', '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n'));
    await execP('systemctl', ['daemon-reload'], { timeout: 30_000 });
    const en = await execP('systemctl', ['enable', '--now', rec.unit], { timeout: 60_000 });
    if (en.err) throw bad('could not start ' + rec.unit, 500, String(en.stderr || en.err.message));
    say('started ' + rec.unit + '.service');
    for (const h of hosts) { const id = await upsertCname(zone, h, t.id + '.cfargotunnel.com', say); if (id) rec.dns.push({ name: h, id }); }
    settings.set(stateKey(domain), rec);
    return rec;
  } catch (e) {
    settings.set(stateKey(domain), rec);           // so unpublish can clean up whatever was made
    try { await unpublish(domain); } catch (_) {}
    throw e;
  }
}

async function unpublish(domain, say) {
  say = say || (() => {});
  const rec = state(domain);
  if (!rec) return { ok: true, note: 'no tunnel' };
  const errors = [];
  const t = async (name, fn) => { try { const d = await fn(); say(name, d); } catch (e) { errors.push(name + ': ' + e.message); } };
  await t('stopped ' + rec.unit + '.service', async () => { await execP('systemctl', ['disable', '--now', rec.unit], { timeout: 60_000 }); try { fs.unlinkSync(path.join(UNIT_DIR, rec.unit + '.service')); } catch (_) {} try { fs.unlinkSync(rec.tokenFile); } catch (_) {} await execP('systemctl', ['daemon-reload'], { timeout: 30_000 }); });
  for (const d of rec.dns || []) await t('removed DNS ' + d.name, () => api('/zones/' + rec.zoneId + '/dns_records/' + d.id, { method: 'DELETE' }).then(() => null));
  if (rec.tunnelId) await t('deleted tunnel ' + (rec.tunnelName || rec.tunnelId), async () => {
    try { await api('/accounts/' + rec.account + '/cfd_tunnel/' + rec.tunnelId + '/connections', { method: 'DELETE' }); } catch (_) {}
    await api('/accounts/' + rec.account + '/cfd_tunnel/' + rec.tunnelId, { method: 'DELETE' });
  });
  if (!errors.length) settings.del(stateKey(domain));
  return { ok: !errors.length, errors };
}

module.exports = { available, ensureBase, seedTemplates, publish, unpublish, state, unitName };
