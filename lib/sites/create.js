'use strict';
// Create and delete a site — the sequence CloudPanel runs, reproduced so this panel can stand alone.
//
// Every step records what it did and how to undo it, and a failure unwinds in reverse: a half-made
// site is worse than none, because the leftovers (a unix user, a pool file, a vhost nginx refuses to
// load) block the retry. Deletion is guarded so it can only ever remove a site this panel records.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execP, listeningPorts } = require('../util');
const { PORT } = require('../config');
const secrets = require('../secrets');
const store = require('./store');
const users = require('./users');
const vhost = require('./vhost');
const php = require('./php');
const ssl = require('./ssl');
const logs = require('./logs');
const cron = require('./cron');
const dbs = require('./dbs');

const TYPES = ['php', 'nodejs', 'static', 'reverse-proxy', 'python'];
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });

// A site user CloudPanel would accept: derived from the domain, trimmed to useradd's 32-char limit.
function suggestUser(domain) {
  const { registrable, subdomain } = vhost.splitDomain(domain);
  const base = ((subdomain && subdomain !== 'www' ? subdomain + '-' : '') + registrable.split('.')[0])
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (base || 'site').slice(0, 32).replace(/-+$/, '');
}
// A port is free only if all three say so: no other site is recorded against it, nothing on the box
// is listening on it right now, and it is not the panel's own. The middle check is the one that
// matters in practice — most apps on this host are started outside the panel, so its SQLite is a
// partial view, and trusting it alone hands out ports that are already taken.
function portsInUse() {
  const used = store.usedPorts();
  for (const p of listeningPorts()) used.add(p);
  used.add(PORT);
  return used;
}
function freePort(from) {
  const used = portsInUse();
  let p = Math.min(65535, Math.max(1024, Number(from) || 3000));
  while (p <= 65535 && used.has(p)) p++;
  if (p > 65535) throw bad('no free port left above ' + (from || 3000));
  return p;
}
// Why a port the operator typed is refused, in the words they need to act on it.
function checkPort(port, label) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw bad('the ' + label + ' port must be between 1024 and 65535');
  if (p === PORT) throw bad('port ' + p + ' is this panel — pick another');
  if (store.usedPorts().has(p)) throw bad('port ' + p + ' is already assigned to another site');
  if (listeningPorts().has(p)) throw bad('something on this server is already listening on port ' + p);
  return p;
}

// `systemctl reload nginx` returns before the new configuration is actually serving: old workers
// drain while new ones start, and a TLS request in that window fails the handshake outright. So
// creation is not reported as finished until the new server block answers on 127.0.0.1:443 under
// its own SNI — otherwise the API says "created" about a site that briefly refuses connections.
function servesYet(domain, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  const once = () => new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = https.request({ host: '127.0.0.1', port: 443, method: 'HEAD', path: '/', servername: domain,
        headers: { Host: domain, Connection: 'close' }, rejectUnauthorized: false, timeout: 2500 },
        (res) => { res.resume(); fin(true); });
    } catch (_) { return fin(false); }
    req.on('timeout', () => { req.destroy(); fin(false); });
    req.on('error', () => fin(false));
    req.end();
  });
  return (async () => {
    while (Date.now() < deadline) { if (await once()) return true; await new Promise((r) => setTimeout(r, 250)); }
    return false;
  })();
}

// ------------------------------------------------------------------ create
async function createSite(opts, ctx) {
  opts = opts || {};
  const steps = [];
  const undo = [];
  const step = (name, fn, rollback) => steps.push({ name, fn, rollback });
  const done = [];
  const say = (name, detail) => done.push({ name, detail: detail || null });

  const domain = String(opts.domain || '').trim().toLowerCase().replace(/^www\./, '');
  const type = String(opts.type || '').toLowerCase();
  if (!vhost.validDomain(domain)) throw bad('"' + domain + '" is not a valid domain name');
  if (!TYPES.includes(type)) throw bad('unknown site type "' + type + '" (' + TYPES.join(', ') + ')');
  if (store.get(domain)) throw bad('this panel already manages ' + domain, 409);
  if (fs.existsSync(vhost.confPath(domain))) throw bad('/etc/nginx/sites-enabled/' + domain + '.conf already exists — another panel or a hand-made vhost owns this domain', 409);

  const user = String(opts.user || suggestUser(domain)).trim();
  if (!users.validUsername(user)) throw bad('"' + user + '" is not a usable unix user name');
  if (users.getent(user)) throw bad('unix user ' + user + ' already exists', 409);
  const password = opts.password ? String(opts.password) : secrets.generatePassword(24);
  if (password.length < 12) throw bad('site user password must be at least 12 characters');

  // template + per-type settings
  const tplName = opts.template || (type === 'php' ? 'Generic' : type === 'nodejs' ? 'Nodejs' : type === 'static' ? 'Static' : type === 'reverse-proxy' ? 'Reverse Proxy' : 'Python');
  const tpl = store.templates.get(tplName);
  if (!tpl) throw bad('no vhost template called "' + tplName + '" — pick one from /api/sites/templates', 404);
  if (tpl.type !== type) throw bad('template "' + tplName + '" is for ' + tpl.type + ' sites, not ' + type);

  const site = {
    // CloudPanel's convention: root_dir is relative to ~/htdocs and starts with the domain, then the
    // template's own subdirectory if it has one (Laravel → public, Drupal → web, …). Getting this
    // wrong points nginx at ~/htdocs itself, which answers 403 because there is no index there.
    domain, type, user, root_dir: opts.root_dir !== undefined ? String(opts.root_dir) : (domain + (tpl.root_dir ? '/' + String(tpl.root_dir).replace(/^\/+/, '') : '')),
    application: tplName, vhost_template: '', varnish_cache: 0, cf_only: !!opts.cf_only,
    reverse_proxy_url: type === 'reverse-proxy' ? String(opts.reverse_proxy_url || '') : null,
    user_password_enc: secrets.encrypt(password), managed_by: 'rhc', vhost_source: 'template',
  };
  if (type === 'reverse-proxy' && !/^https?:\/\/\S+$/.test(site.reverse_proxy_url || '')) throw bad('a reverse proxy site needs a target URL like http://127.0.0.1:8080');
  if (type === 'php') {
    const ver = String(opts.php_version || tpl.php_version || php.listVersions().slice(-1)[0] || '');
    if (!php.listVersions().includes(ver)) throw bad('PHP ' + ver + ' is not installed (have: ' + php.listVersions().join(', ') + ')');
    site.php = { php_version: ver, pool_port: php.nextPoolPort(), memory_limit: '512M', max_execution_time: 60, max_input_time: 60, max_input_vars: 5000, post_max_size: '256M', upload_max_filesize: '256M', additional_configuration: null };
  }
  if (type === 'nodejs') site.nodejs = { node_version: String(opts.node_version || (process.version.replace(/^v/, '').split('.')[0])), port: opts.port ? checkPort(opts.port, 'app') : freePort(3000), runtime: 'system' };
  if (type === 'python') site.python = { python_version: String(opts.python_version || '3'), port: opts.port ? checkPort(opts.port, 'app') : freePort(8000) };

  let row = null;
  try {
    // 1. unix user + home from the skeleton (this is what makes htdocs/logs/backups/tmp/.ssh)
    await users.createSiteUser(user, password);
    undo.push(async () => { await execP('userdel', ['-r', user], { timeout: 120_000 }); });
    say('created unix user ' + user, 'uid ' + (users.getent(user) || {}).uid);

    // 2. document root
    const ent = users.getent(user);
    const docroot = path.join('/home', user, 'htdocs', domain);
    fs.mkdirSync(docroot, { recursive: true, mode: 0o770 });
    try { fs.chownSync(docroot, ent.uid, ent.gid); } catch (_) {}
    say('created ' + docroot);

    // 3. the row, so render() has real values to fill in
    row = store.insert(site);
    undo.push(() => store.remove(row.id));
    say('recorded the site', 'id ' + row.id + ', template ' + tplName);

    // 4. stage-1 template (literal server_name, PHP port, redirect block for an apex/www domain)
    const stage1 = vhost.materialize(tpl.template, row);
    store.update(row.id, { vhost_template: stage1 });
    row = store.getById(row.id);
    say('materialised the vhost template', stage1.split('\n').length + ' lines');

    // 5. php-fpm pool
    if (type === 'php') {
      php.writePool(row.php.php_version, domain, user, row.php.pool_port);
      undo.push(() => php.removePool(row.php.php_version, domain));
      const rl = await php.reloadFpm(row.php.php_version);
      say('wrote the php-fpm pool on 127.0.0.1:' + row.php.pool_port, rl.ok ? 'php' + row.php.php_version + '-fpm reloaded' : 'reload said: ' + rl.output);
    }

    // 6. a self-signed certificate, so https answers from the first request
    if (opts.self_signed !== false) {
      const cert = await ssl.selfSigned(domain, ssl.defaultSans(domain));
      const info = ssl.inspect(cert.certificate);
      ssl.install(domain, cert.certificate, null, cert.key);
      undo.push(() => ssl.remove(domain));
      store.certs.insert({ site_id: row.id, type: 'self_signed', subject: info.subject, sans: info.sans, issuer: info.issuer,
        expires_at: info.expires_at, fingerprint: info.fingerprint, private_key_enc: secrets.encrypt(cert.key), certificate: cert.certificate, chain: null, is_active: 1 });
      say('installed a self-signed certificate', 'expires ' + String(info.expires_at).slice(0, 10) + ' — replace it under SSL/TLS');
    }

    // 7. write the vhost — nginx -t decides whether this site exists at all
    const content = vhost.render(row);
    const w = await vhost.writeWithRollback(row, content);
    if (!w.ok) throw bad('nginx refused the new vhost', 409, (w.test && w.test.output) || w.error || 'nginx -t failed');
    undo.push(async () => { await vhost.removeFile(domain); });
    const serving = await servesYet(domain);
    say('wrote /etc/nginx/sites-enabled/' + domain + '.conf',
      serving ? 'nginx reloaded and the site answers on 127.0.0.1:443' : 'nginx reloaded, but the site did not answer within 6s — check `nginx -T` and the error log');

    // 8. logrotate for the site's own logs
    logs.writeLogrotate(user);
    undo.push(() => logs.removeLogrotate(user));
    say('wrote /etc/logrotate.d/' + user);

    return { ok: true, site: store.getById(row.id), password, steps: done, user, docroot };
  } catch (e) {
    // unwind in reverse; report what could not be undone rather than hiding it
    const failedUndo = [];
    for (const fn of undo.reverse()) { try { await fn(); } catch (u) { failedUndo.push(u.message); } }
    throw Object.assign(e, {
      detail: [e.detail, done.length ? 'Completed before the failure: ' + done.map((d) => d.name).join('; ') : null,
        failedUndo.length ? 'COULD NOT UNDO: ' + failedUndo.join('; ') : 'Everything done so far was rolled back.'].filter(Boolean).join('\n\n'),
    });
  }
}

// ------------------------------------------------------------------ delete
async function deleteSite(site, opts) {
  opts = opts || {};
  const done = [];
  const errors = [];
  const say = (n, d) => done.push({ name: n, detail: d || null });
  const tryStep = async (name, fn) => { try { const d = await fn(); say(name, d); } catch (e) { errors.push(name + ': ' + e.message); } };

  if (!site || !site.id) throw bad('unknown site', 404);

  // databases first: dropping the unix user later would orphan them
  if (opts.dropDatabases !== false) {
    for (const d of store.databases.list(site.id)) {
      await tryStep('dropped database ' + d.name + ' (' + d.engine + ')', async () => { await dbs.drop(site, d.id, {}); });
    }
  }
  await tryStep('removed /etc/cron.d/' + site.user, () => cron.remove(site.user));
  await tryStep('removed the vhost and reloaded nginx', () => vhost.removeFile(site.domain));
  if (site.php) await tryStep('removed the php-fpm pool', async () => { php.removePool(site.php.php_version, site.domain); const r = await php.reloadFpm(site.php.php_version); return r.ok ? 'php' + site.php.php_version + '-fpm reloaded' : r.output; });
  await tryStep('removed the certificate files', () => { ssl.remove(site.domain); });
  await tryStep('removed /etc/logrotate.d/' + site.user, () => logs.removeLogrotate(site.user));
  await tryStep('removed the basic-auth file', () => { try { fs.unlinkSync(path.join(vhost.BASIC_AUTH_DIR, site.domain)); return 'removed'; } catch (_) { return 'none'; } });

  // SSH/FTP users belong to this site's group; they have to go before the site user
  for (const u of store.sshUsers.list(site.id)) await tryStep('removed ssh user ' + u.username, () => users.deleteUnixUser(u.username, {}));
  for (const u of store.ftpUsers.list(site.id)) await tryStep('removed ftp user ' + u.username, () => users.deleteUnixUser(u.username, {}));

  if (opts.keepUser !== true) {
    await tryStep('removed unix user ' + site.user + (opts.keepHome ? ' (home kept)' : ' and /home/' + site.user), async () => {
      const r = await users.deleteUnixUser(site.user, { keepHome: !!opts.keepHome });
      return r.removed ? (r.keptHome ? 'home kept at ' + r.home : 'home removed') : r.reason;
    });
  }
  store.remove(site.id);
  say('removed the site record', 'and everything referencing it');
  // The rate-limit zones live in their own include, outside the vhost that was already removed, so
  // they have to be rebuilt or a zone for a site that no longer exists is left declared.
  const zones = vhost.writeTrafficZones();
  if (zones.changed) {
    await tryStep('rebuilt the traffic-zone include', async () => { const r = await vhost.reloadNginx(); return r.ok ? 'nginx reloaded' : r.output; });
  }
  return { ok: true, domain: site.domain, steps: done, errors };
}

module.exports = { createSite, deleteSite, suggestUser, freePort, TYPES };
