'use strict';
// nginx vhost rendering + safe writes, mirroring CloudPanel's two-stage model:
//   materialize(globalTemplate, site) — at site creation / "reset to template": prepends the
//     www↔apex redirect block and fills server_name/redirect placeholders (and, for PHP, the
//     fpm port + PHP_VALUE block) → this is what gets STORED in sites.vhost_template.
//   render(site) — at every write: fills ssl/root/logs/{{settings}}/app_port/varnish/proxy url
//     from the stored template and strips whatever placeholder is left.
// Output formats are byte-for-byte those of CLP's Processor classes (incl. the "www1." quirk).
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('../config');
const { execP, execIn } = require('../util');
const store = require('./store');
const secrets = require('../secrets');

const SITES_DIR = '/etc/nginx/sites-enabled';
const SSL_DIR = '/etc/nginx/ssl-certificates';
const BASIC_AUTH_DIR = '/etc/nginx/basic-auth';
const BAK_DIR = '/var/lib/rhc-srv-mon/vhost-bak';
const PROTECTED = new Set(['default.conf', 'custom-domain.conf']);   // never ours to write

/* ---- domain helpers (CLP uses the public suffix list; this covers the common 2-level TLDs) ---- */
const SLD = new Set(['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br', 'com.mx', 'co.jp', 'co.in', 'co.il', 'com.tr', 'com.pt', 'com.pl', 'com.ar', 'com.sg', 'com.hk', 'co.kr']);
function splitDomain(domain) {
  const labels = String(domain).toLowerCase().split('.').filter(Boolean);
  const n = labels.length >= 3 && SLD.has(labels.slice(-2).join('.')) ? 3 : 2;
  const registrable = labels.slice(-n).join('.');
  const subdomain = labels.length > n ? labels.slice(0, -n).join('.') : null;
  return { registrable, subdomain };
}
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
function validDomain(d) { return DOMAIN_RE.test(String(d || '')); }

/* ---- processors (stage 2 unless noted) ---- */
function serverName(site) {           // stage 1
  const { registrable, subdomain } = splitDomain(site.domain);
  const names = [];
  if (subdomain === null) names.push(registrable); else names.push(subdomain + '.' + registrable);
  if (subdomain === null || subdomain === 'www') names.push('www1.' + registrable);
  return 'server_name ' + names.join(' ') + ';';
}
function redirectServerName(site) {   // stage 1
  const { registrable, subdomain } = splitDomain(site.domain);
  return 'server_name ' + (subdomain === null ? 'www.' + registrable : registrable) + ';';
}
function redirectDomain(site) {       // stage 1
  const { registrable, subdomain } = splitDomain(site.domain);
  return subdomain === null ? registrable : 'www.' + registrable;
}
function needsRedirectBlock(site) { const { subdomain } = splitDomain(site.domain); return subdomain === null || subdomain === 'www'; }
function rootDirective(site) { return ('root /home/' + site.user + '/htdocs/' + site.root_dir + ';').replace(/\/+;$/, ';'); }
function accessLog(site) { return 'access_log /home/' + site.user + '/logs/nginx/access.log ' + (site.cf_only ? 'cloudflare' : 'main') + ';'; }
function errorLog(site) { return 'error_log /home/' + site.user + '/logs/nginx/error.log;'; }
function sslCert(site) { return 'ssl_certificate ' + SSL_DIR + '/' + site.domain + '.crt;'; }
function sslKey(site) { return 'ssl_certificate_key ' + SSL_DIR + '/' + site.domain + '.key;'; }
function phpErrorLog(site) { return '/home/' + site.user + '/logs/php/error.log'; }
function phpSettings(site) {          // stage 1 in CLP (value of fastcgi_param PHP_VALUE "…")
  const p = site.php || {};
  const cfg = { error_log: phpErrorLog(site), memory_limit: p.memory_limit, max_execution_time: p.max_execution_time, max_input_time: p.max_input_time, max_input_vars: p.max_input_vars, post_max_size: p.post_max_size, upload_max_filesize: p.upload_max_filesize };
  if (site.varnish_cache && varnishSettings(site).enabled) cfg.auto_prepend_file = '/home/' + site.user + '/.varnish-cache/controller.php';
  let out = '';
  for (const [k, v] of Object.entries(cfg)) out += '\n' + k + '=' + v + ';';
  if (p.additional_configuration == null) out += '\n' + DEFAULT_PHP_ADDITIONAL;
  else if (p.additional_configuration !== '') out += '\n' + p.additional_configuration;
  return out;
}
const DEFAULT_PHP_ADDITIONAL = 'date.timezone=UTC;\ndisplay_errors=off;';
const PHP_INI_COLS = { memory_limit: 'memory_limit', max_execution_time: 'max_execution_time', max_input_time: 'max_input_time', max_input_vars: 'max_input_vars', post_max_size: 'post_max_size', upload_max_filesize: 'upload_max_filesize' };
// Parse a literal PHP_VALUE block ("\nkey=value;\n…") back into site_php fields + additional_configuration.
function parsePhpValue(block, site) {
  const php = {}, extra = [];
  for (const raw of String(block).split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = /^([A-Za-z0-9_.]+)=(.*?);?$/.exec(line);
    if (m && PHP_INI_COLS[m[1]]) php[PHP_INI_COLS[m[1]]] = m[2];
    else if (m && m[1] === 'error_log' && m[2] === phpErrorLog(site)) { /* generated */ }
    else if (m && m[1] === 'auto_prepend_file' && m[2] === '/home/' + site.user + '/.varnish-cache/controller.php') { /* generated */ }
    else extra.push(line.endsWith(';') ? line : line + ';');
  }
  php.additional_configuration = extra.join('\n');
  return php;
}
function varnishSettings(site) {
  try { return JSON.parse(fs.readFileSync('/home/' + site.user + '/.varnish-cache/settings.json', 'utf8')) || {}; } catch (_) { return {}; }
}
function varnishProxyPass(site) {
  let target = 'http://127.0.0.1:8080';
  if (site.varnish_cache) { const v = varnishSettings(site); if (v.enabled && v.server) target = 'http://' + String(v.server).replace(/^\/+|\/+$/g, ''); }
  return 'proxy_pass ' + target + ';';
}
// {{settings}}: basic auth → pagespeed → cloudflare-only → (only without active basic auth) blocked bots → blocked IPs
function settingsBlock(site) {
  const el = [];
  const ba = store.basicAuth.get(site.id);
  if (ba && ba.is_active) {
    let s = '';
    if (ba.allowed_ips.length) { s += '  satisfy any;\n'; for (const ip of ba.allowed_ips) s += '  allow ' + ip + ';\n'; s += '  deny all;\n'; }
    s += '  auth_basic "Restricted Area";\n';
    s += '  auth_basic_user_file ' + BASIC_AUTH_DIR + '/' + site.domain + ';';
    el.push(s);
  }
  if (site.pagespeed_enabled && site.pagespeed_settings) {
    let s = '  pagespeed on;\n  pagespeed FileCachePath "/home/' + site.user + '/tmp/pagespeed_cache/";\n';
    for (const line of String(site.pagespeed_settings).split('\n')) { const t = line.trim(); if (t) s += '  ' + t + '\n'; }
    el.push(s);
  }
  if (site.cf_only) el.push('  include /etc/nginx/cloudflare/ips;');
  if (!(ba && ba.is_active)) {
    const bots = [...new Set(store.blockedBots.list(site.id).map((b) => b.toLowerCase().replace(/ /g, '\\s')))];
    if (bots.length) el.push('  if ($http_user_agent ~* (' + bots.join('|') + ')) {\n    return 444;\n  }');
    const ips = [...new Set(store.blockedIps.list(site.id))];
    if (ips.length) el.push('  if ($' + (site.cf_only ? 'http_cf_connecting_ip' : 'remote_addr') + ' ~ "^(' + ips.map((ip) => ip.replace(/\./g, '\\.')).join('|') + ')$") {\n    return 403;\n  }');
  }
  return el.join('\n\n');
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
function fill(content, map) {
  return content.replace(PLACEHOLDER_RE, (m, key) => (key in map ? String(map[key]()) : m));
}
function stripPlaceholders(content) { return content.replace(PLACEHOLDER_RE, ''); }

// Stage 1. globalTemplate = vhost_templates.template (e.g. "Nodejs", "Generic"). Returns the text to store.
function materialize(globalTemplate, site) {
  let tpl = String(globalTemplate);
  if (needsRedirectBlock(site)) tpl = fs.readFileSync(path.join(APP_ROOT, 'resources', 'nginx', 'redirect-http3.conf'), 'utf8') + '\n' + tpl;
  const map = { server_name: () => serverName(site), redirect_server_name: () => redirectServerName(site), redirect_domain: () => redirectDomain(site) };
  if (site.type === 'php' && site.php) { map.php_fpm_port = () => site.php.pool_port; map.php_settings = () => phpSettings(site); }
  return fill(tpl, map);
}
// Import: turn the file nginx is serving back into a stage-1 template by replacing the
// directives we generate with their placeholders (exact-string, so render() reproduces the file
// byte for byte). Also infers cf_only from the access_log format and parses a literal PHP_VALUE
// block into site.php. Returns { template, php, cf_only, placeholders }.
function retemplate(disk, site) {
  let t = String(disk);
  const found = [];
  const rep = (literal, ph, all) => { if (!literal || !t.includes(literal)) return false; t = all ? t.split(literal).join(ph) : t.replace(literal, ph); found.push(ph); return true; };
  // effective cloudflare-only state comes from the file, not CLP's flag
  const cfOnly = t.includes('access_log /home/' + site.user + '/logs/nginx/access.log cloudflare;');
  const eff = Object.assign({}, site, { cf_only: cfOnly });
  rep(sslKey(eff), '{{ssl_certificate_key}}'); rep(sslCert(eff), '{{ssl_certificate}}');
  rep(rootDirective(eff), '{{root}}'); rep(accessLog(eff), '{{nginx_access_log}}'); rep(errorLog(eff), '{{nginx_error_log}}');
  let php = null;
  if (site.type === 'php' && site.php) {
    const m = /fastcgi_param\s+PHP_VALUE\s+"([\s\S]*?)";/.exec(t);
    if (m) {
      php = Object.assign({}, site.php, parsePhpValue(m[1], eff));
      eff.php = php;
      rep(m[1], '{{php_settings}}');
    }
    rep('fastcgi_pass 127.0.0.1:' + site.php.pool_port + ';', 'fastcgi_pass 127.0.0.1:{{php_fpm_port}};', true);
    rep(varnishProxyPass(eff), '{{varnish_proxy_pass}}');
  }
  const port = site.nodejs ? site.nodejs.port : site.python ? site.python.port : null;
  if (port) { rep('proxy_pass http://127.0.0.1:' + port + '/;', 'proxy_pass http://127.0.0.1:{{app_port}}/;', true); rep('proxy_pass http://127.0.0.1:' + port + ';', 'proxy_pass http://127.0.0.1:{{app_port}};', true); }
  if (site.type === 'reverse-proxy' && site.reverse_proxy_url) rep('proxy_pass ' + site.reverse_proxy_url + ';', 'proxy_pass {{reverse_proxy_url}};');
  // {{settings}}: the rendered block (indented by the template's two spaces), or the empty two-space line CLP leaves behind
  const block = settingsBlock(eff);
  if (block) rep('  ' + block, '  {{settings}}');
  else if (/\n  \n/.test(t)) { t = t.replace(/\n  \n/, '\n  {{settings}}\n'); found.push('{{settings}}'); }
  return { template: t, php, cf_only: cfOnly, placeholders: found };
}

// Stage 2. From the stored template to the file content (CLP writes a trailing newline).
function render(site, stored) {
  const tpl = stored != null ? String(stored) : String(site.vhost_template);
  const map = {
    ssl_certificate_key: () => sslKey(site), ssl_certificate: () => sslCert(site), root: () => rootDirective(site),
    nginx_access_log: () => accessLog(site), nginx_error_log: () => errorLog(site), php_error_log: () => phpErrorLog(site),
    settings: () => settingsBlock(site), varnish_proxy_pass: () => varnishProxyPass(site), reverse_proxy_url: () => site.reverse_proxy_url || '',
    app_port: () => (site.nodejs ? site.nodejs.port : site.python ? site.python.port : ''),
    // stage-1 placeholders are re-filled too so a hand-restored template still renders
    server_name: () => serverName(site), redirect_server_name: () => redirectServerName(site), redirect_domain: () => redirectDomain(site),
    php_fpm_port: () => (site.php ? site.php.pool_port : ''), php_settings: () => phpSettings(site),
  };
  const out = stripPlaceholders(fill(tpl, map));
  return out.endsWith('\n') ? out : out + '\n';
}

/* ---- imported sites: patch literal values CLP already baked into the stored template ---- */
function patchLiteralPort(stored, kind, port) {
  const re = kind === 'php' ? /(fastcgi_pass\s+127\.0\.0\.1:)\d+/g : /(proxy_pass\s+http:\/\/127\.0\.0\.1:)\d+(\/?;)/g;
  return kind === 'php' ? stored.replace(re, '$1' + port) : stored.replace(/(location \/ \{[\s\S]*?proxy_pass\s+http:\/\/127\.0\.0\.1:)\d+/, '$1' + port);
}
function patchLiteralPhpValue(stored, site) {
  return stored.replace(/(fastcgi_param\s+PHP_VALUE\s+")[\s\S]*?(";)/, (m, a, b) => a + phpSettings(site) + b);
}
function hasPlaceholder(stored, name) { return new RegExp('\\{\\{\\s*' + name + '\\s*\\}\\}').test(stored); }

/* ---- files ---- */
function confPath(domain) { return path.join(SITES_DIR, domain + '.conf'); }
function readCurrentFile(domain) { try { return fs.readFileSync(confPath(domain), 'utf8'); } catch (_) { return null; } }

async function nginxTest() {
  const r = await execP('nginx', ['-t'], { timeout: 30_000 });
  return { ok: !r.err, output: ((r.stderr || '') + (r.stdout || '')).trim() };
}
async function reloadNginx() {
  const r = await execP('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
  return { ok: !r.err, output: ((r.stderr || '') + (r.stdout || '')).trim() };
}

// Write the rendered vhost, test the whole nginx config, reload; restore the previous file on failure.
// Returns { ok, changed, test, reload, backup }.
async function writeWithRollback(site, content) {
  const file = confPath(site.domain);
  if (PROTECTED.has(path.basename(file))) throw new Error('refusing to write ' + file);
  const prev = readCurrentFile(site.domain);
  if (prev === content) { return { ok: true, changed: false, test: null, reload: null }; }
  let backup = null;
  if (prev !== null) {
    fs.mkdirSync(BAK_DIR, { recursive: true, mode: 0o700 });
    backup = path.join(BAK_DIR, site.domain + '.' + new Date().toISOString().replace(/[:.]/g, '-') + '.conf');
    fs.writeFileSync(backup, prev, { mode: 0o600 });
    pruneBackups(site.domain, 20);
  }
  fs.writeFileSync(file + '.tmp', content, { mode: 0o644 });
  fs.renameSync(file + '.tmp', file);
  const test = await nginxTest();
  if (!test.ok) {
    if (prev !== null) fs.writeFileSync(file, prev, { mode: 0o644 }); else { try { fs.unlinkSync(file); } catch (_) {} }
    return { ok: false, changed: false, test, reload: null, backup };
  }
  const reload = await reloadNginx();
  return { ok: reload.ok, changed: true, test, reload, backup };
}
function pruneBackups(domain, keep) {
  try {
    const files = fs.readdirSync(BAK_DIR).filter((f) => f.startsWith(domain + '.')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(BAK_DIR, f));
  } catch (_) {}
}
async function removeFile(domain) {
  const file = confPath(domain);
  if (PROTECTED.has(path.basename(file))) throw new Error('refusing to remove ' + file);
  const prev = readCurrentFile(domain);
  if (prev === null) return { ok: true, changed: false };
  fs.mkdirSync(BAK_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(BAK_DIR, domain + '.deleted.' + new Date().toISOString().replace(/[:.]/g, '-') + '.conf'), prev, { mode: 0o600 });
  fs.unlinkSync(file);
  const test = await nginxTest();
  const reload = test.ok ? await reloadNginx() : null;
  return { ok: test.ok && reload && reload.ok, changed: true, test, reload };
}

// Basic-auth credentials file for the {{settings}} block (htpasswd, SHA-512 crypt via openssl).
async function writeBasicAuthFile(site) {
  const ba = store.basicAuth.get(site.id);
  const file = path.join(BASIC_AUTH_DIR, site.domain);
  if (!ba || !ba.is_active) { try { fs.unlinkSync(file); } catch (_) {} return; }
  if (!ba.username || !ba.password_enc) { if (!fs.existsSync(file)) throw new Error('basic auth is active but no password is stored — set one'); return; }   // keep CLP's file
  const pw = secrets.decrypt(ba.password_enc);
  const r = await execIn('openssl', ['passwd', '-6', '-stdin'], pw + '\n', { timeout: 10_000 });
  if (r.err) throw new Error('openssl passwd failed: ' + (r.stderr || r.err.message));
  fs.mkdirSync(BASIC_AUTH_DIR, { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, ba.username + ':' + r.stdout.trim() + '\n', { mode: 0o644 });
}

module.exports = { SITES_DIR, SSL_DIR, BASIC_AUTH_DIR, BAK_DIR, splitDomain, validDomain, materialize, render, retemplate, parsePhpValue, settingsBlock, phpSettings,
  patchLiteralPort, patchLiteralPhpValue, hasPlaceholder, confPath, readCurrentFile, nginxTest, reloadNginx, writeWithRollback, removeFile, writeBasicAuthFile };
