'use strict';
// Create and delete a site — the sequence CloudPanel runs, reproduced so this panel can stand alone.
//
// Every step records what it did and how to undo it, and a failure unwinds in reverse: a half-made
// site is worse than none, because the leftovers (a unix user, a pool file, a vhost nginx refuses to
// load) block the retry. Deletion is guarded so it can only ever remove a site this panel records.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execP, listeningPorts, mkdirMode } = require('../util');
const { PORT } = require('../config');
const secrets = require('../secrets');
const store = require('./store');
const users = require('./users');
const vhost = require('./vhost');
const php = require('./php');
const ssl = require('./ssl');
const certstore = require('./certstore');
const tunnel = require('./tunnel');
const claudeCli = require('./claude');
const logs = require('./logs');
const cron = require('./cron');
const dbs = require('./dbs');
const runtime = require('./runtime');
const nodever = require('./nodever');

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
// The default database name for a site: the unix user, in the character set a database name allows.
function sqliteName(user) {
  return (String(user || '').replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+/, '') || 'app').slice(0, 63);
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
function nginxUser() {
  try { const m = /^\s*user\s+([A-Za-z0-9_.-]+)/m.exec(fs.readFileSync('/etc/nginx/nginx.conf', 'utf8')); return m && m[1] !== 'root' ? m[1] : null; } catch (_) { return null; }
}

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
  // GitHub repo for the site: empty = a new private <default owner>/<domain>; given = that repo
  // (created if missing; if it already holds code, the new site takes that code).
  const repo = opts.repo ? String(opts.repo).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '') : '';
  if (repo && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo)) throw bad('GitHub repo must look like owner/name (or a github.com URL)');
  if (fs.existsSync(vhost.confPath(domain))) throw bad('/etc/nginx/sites-enabled/' + domain + '.conf already exists — another panel or a hand-made vhost owns this domain', 409);

  const user = String(opts.user || suggestUser(domain)).trim();
  if (!users.validUsername(user)) throw bad('"' + user + '" is not a usable unix user name');
  if (users.getent(user)) throw bad('unix user ' + user + ' already exists', 409);
  const password = opts.password ? String(opts.password) : secrets.generatePassword(24);
  if (password.length < 12) throw bad('site user password must be at least 12 characters');

  // A host that never had CloudPanel lacks the nginx pieces and templates the vhosts rely on.
  const baseChanged = await tunnel.ensureBase();
  if (baseChanged.length) say('prepared nginx for panel-managed sites', baseChanged.join(', '));

  // template + per-type settings
  const tplName = opts.template || (type === 'php' ? 'Generic' : type === 'nodejs' ? 'Nodejs' : type === 'static' ? 'Static' : type === 'reverse-proxy' ? ((store.templates.list().find((t) => t.type === 'reverse-proxy') || {}).name || 'ReverseProxy') : 'Python');
  const tpl = store.templates.get(tplName);
  if (!tpl) throw bad('no vhost template called "' + tplName + '" — pick one from /api/sites/templates', 404);
  if (tpl.type !== type) throw bad('template "' + tplName + '" is for ' + tpl.type + ' sites, not ' + type);

  if (opts.root_dir !== undefined && !require('./vhost').validRootDir(opts.root_dir)) throw Object.assign(new Error('invalid root directory — folders under ~/htdocs, letters, digits and . _ @ + - only'), { status: 400 });
  const site = {
    // CloudPanel's convention: root_dir is relative to ~/htdocs and starts with the domain, then the
    // template's own subdirectory if it has one (Laravel → public, Drupal → web, …). Getting this
    // wrong points nginx at ~/htdocs itself, which answers 403 because there is no index there.
    domain, type, user, root_dir: opts.root_dir !== undefined ? String(opts.root_dir) : (domain + (tpl.root_dir ? '/' + String(tpl.root_dir).replace(/^\/+/, '') : '')),
    application: tplName, vhost_template: '', varnish_cache: 0, cf_only: opts.cf_only === undefined ? 1 : (opts.cf_only ? 1 : 0),
    reverse_proxy_url: type === 'reverse-proxy' ? String(opts.reverse_proxy_url || '') : null,
    user_password_enc: secrets.encrypt(password), managed_by: 'rhc', vhost_source: 'template',
  };
  if (type === 'reverse-proxy' && !/^https?:\/\/\S+$/.test(site.reverse_proxy_url || '')) throw bad('a reverse proxy site needs a target URL like http://127.0.0.1:8080');
  if (type === 'php') {
    const ver = String(opts.php_version || tpl.php_version || php.listVersions().slice(-1)[0] || '');
    if (!php.listVersions().includes(ver)) throw bad('PHP ' + ver + ' is not installed (have: ' + php.listVersions().join(', ') + ')');
    site.php = { php_version: ver, pool_port: php.nextPoolPort(), memory_limit: '512M', max_execution_time: 60, max_input_time: 60, max_input_vars: 5000, post_max_size: '256M', upload_max_filesize: '256M', additional_configuration: null };
  }
  if (type === 'nodejs') site.nodejs = { node_version: String(opts.node_version || nodever.LATEST), port: opts.port ? checkPort(opts.port, 'app') : freePort(3000), runtime: nodever.isLatest(opts.node_version || nodever.LATEST) ? 'system' : 'nvm' };
  if (type === 'python') site.python = { python_version: String(opts.python_version || '3'), port: opts.port ? checkPort(opts.port, 'app') : freePort(8000) };

  let row = null;
  try {
    // 1. unix user + home from the skeleton (this is what makes htdocs/logs/backups/tmp/.ssh)
    await users.createSiteUser(user, password);
    undo.push(async () => { await execP('userdel', ['-r', user], { timeout: 120_000 }); });
    say('created unix user ' + user, 'uid ' + (users.getent(user) || {}).uid);

    // 1b. nginx's workers must be able to enter the 0770 home: put the nginx user (CloudPanel's
    // `clp`, Debian's `www-data`, whatever nginx.conf says) into the site's group. CloudPanel did
    // this itself; on a host without it, nginx answered 403/404 (stat: permission denied).
    const ngx = nginxUser();
    if (ngx) {
      const g = await execP('usermod', ['-a', '-G', user, ngx], { timeout: 30_000 });
      say(g.err ? 'could not add ' + ngx + ' to group ' + user : 'gave nginx (' + ngx + ') access to the site files', g.err ? String(g.stderr || g.err.message).trim() : 'member of group ' + user);
    }

    // 2. document root
    const ent = users.getent(user);
    const docroot = path.join('/home', user, 'htdocs', domain);
    mkdirMode(docroot, 0o770);
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

    // 6. the certificate: the best match from the central store (e.g. the *.rhc.pw origin wildcard),
    //    otherwise a self-signed one so https answers from the first request
    const stored = opts.from_store !== false ? certstore.match(domain) : null;
    if (stored) {
      ssl.install(domain, stored.certificate, stored.chain, secrets.decrypt(stored.private_key_enc));
      undo.push(() => ssl.remove(domain));
      certstore.copyToSite(row, stored, true);
      say('installed the certificate from the central store', stored.name + ' (' + stored.type.replace('_', ' ') + ', expires ' + String(stored.expires_at).slice(0, 10) + ')');
    } else if (opts.self_signed !== false) {
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

    // 7a. SSH access for the site user from the admin IP whitelist (key pair in the Vault).
    try { await require('../whitelist').enableSiteSsh(row, say); }
    catch (e) { say('could not enable SSH access', e.message + (e.detail ? ' — ' + e.detail : '')); }

    // 7b. Cloudflare Tunnel: its own tunnel, route and DNS, so the site is reachable without opening
    // a port or knowing this host's IP. Outside the unwind like the runtime below: a Cloudflare
    // hiccup leaves a good site that can be published later, not a deleted one. Opt out: tunnel:false.
    let published = null;
    const tv = tunnel.available();
    if (opts.tunnel !== false && tv.ok) {
      try { published = await tunnel.publish(row, say); }
      catch (e) { say('could not publish through Cloudflare Tunnel', e.message + ' (rolled back — the site itself is fine)'); }
    } else if (opts.tunnel !== false) say('not published through Cloudflare Tunnel', tv.reason);

    // 8. logrotate for the site's own logs
    logs.writeLogrotate(user);
    undo.push(() => logs.removeLogrotate(user));
    say('wrote /etc/logrotate.d/' + user);

    // 8b. Cloudflare Turnstile: a widget for the domain, keys stored encrypted (lib/sites/turnstile.js).
    // Outside the unwind: no permission for it on the token is reported, the site is still made.
    let turnstile = null;
    try { turnstile = await require('./turnstile').create(row); say('created the Cloudflare Turnstile widget', 'site key ' + turnstile.siteKey + ' · ' + turnstile.domains.join(', ') + ' · keys in Vault'); }
    catch (e) { say('Turnstile: not set up', e.message); }

    // 9. the Node.js runtime: nvm, the interpreter, pm2, its systemd unit, and a placeholder app.
    // Deliberately outside the unwind: this runs after the site is already serving, and a failed
    // nvm download is a reason to report a half-provisioned runtime, not to delete a good site.
    let runtimeSteps = null;
    // The Next.js stack (the New site form's default for Node.js; the API default stays the plain
    // placeholder — cluster moves and imports bring their own code). A repo with code wins over it.
    const stack = type === 'nodejs' && opts.stack === 'nextjs' ? (repo ? null : 'nextjs') : null;
    if (type === 'nodejs' && opts.stack === 'nextjs' && repo) say('Next.js stack skipped', 'the code comes from ' + repo);
    if (type === 'nodejs') {
      try {
        const rt = await runtime.provisionNode(row, row.nodejs.port, say, { stack });
        runtimeSteps = rt.steps;
        if (rt.ok && rt.runtime) store.setNodejs(row.id, Object.assign({}, row.nodejs, { runtime: rt.runtime }));
      } catch (e) { say('runtime provisioning failed', e.message); }
    }

    // 9b. GitHub, after the runtime so a repo's code can be installed and its apps restarted:
    // the repo given on the form (its code replaces the placeholder if it has any) or a new private
    // <default owner>/<domain>. Auto-sync on. A failure is reported, the site stays.
    // Every connection is approved by a browser sign-in (opts.ghAccount, from the API's ticket);
    // without one the site is created unconnected.
    if (opts.github !== false && !opts.ghAccount) say('GitHub: not connected', 'connecting needs the GitHub sign-in in the browser — do it on the site\'s GitHub tab');
    else if (opts.github !== false) {
      try {
        const gh = await require('./github').connect(row, say, Object.assign(repo ? { repo, mode: 'repo' } : {}, { account: opts.ghAccount }));
        say('GitHub: ' + gh.url, 'auto commit & push every 15 min');
      } catch (e) { say('could not connect GitHub' + (repo ? ' to ' + repo : ''), e.message + (e.detail ? ' — ' + e.detail : '') + ' (connect it later on the site\'s GitHub tab)'); }
    }

    // 10. a SQLite database, ready to use. A small site needs somewhere to keep state, and this is
    // the option that costs nothing: a file in the site's own home, no engine started (MariaDB is
    // deliberately left off on this host), no account, nothing listening. Opt out with sqlite:false.
    let database = null;
    if (opts.sqlite !== false && !stack) {
      try {
        database = await dbs.create(row, { engine: 'sqlite', name: sqliteName(user) });
        say('created the SQLite database ' + database.name, database.file);
      } catch (e) { say('could not create the default SQLite database', e.message); }
    }

    // 10b. the app gets the Turnstile keys in its own encrypted settings (the Next.js stack reads them)
    if (turnstile && stack) {
      try { say('gave the app its Turnstile keys', await require('./turnstile').seedApp(row)); }
      catch (e) { say('could not give the app its Turnstile keys', e.message); }
    }

    // 11. Claude Code CLI for the site user — every site gets it (native installer, self-updating,
    // ~/.local/bin). Outside the unwind like the runtime: a failed download leaves a good site without
    // the CLI, nothing more.
    try {
      const c = await claudeCli.install(user);
      say(c.ok ? 'installed Claude Code for ' + user : 'could not install Claude Code for ' + user, c.ok ? c.version + ' in ~/.local/bin — run `claude` after SSH login' : String(c.output || '').trim().split('\n').pop());
    } catch (e) { say('could not install Claude Code', e.message); }

    // 11b. the App Store agents picked on the form (opts.agents: keys from lib/agents.js), deployed for
    // the site user and tracked in Updates so they stay current. A failed one is reported, the site stays.
    const agentsLib = require('../agents');
    const picked = [...new Set((Array.isArray(opts.agents) ? opts.agents : []).map(String))].filter((k) => k !== 'claude');
    for (const k of picked) {
      const a = agentsLib.find(k);
      if (!a) { say('App Store: unknown agent ' + k + ' — skipped'); continue; }
      try {
        const r = await agentsLib.install(k, user);
        say(r.ok ? 'installed ' + a.label + ' for ' + user : 'could not install ' + a.label + ' for ' + user, r.ok ? (r.version || '') : String(r.output || '').trim().split('\n').pop());
        if (r.ok && !agentsLib.tracked().includes(k)) agentsLib.setTracked([...agentsLib.tracked(), k]);
      } catch (e) { say('could not install ' + a.label, e.message); }
    }

    // Uptime Kuma: run kuma-sync now so the site's service, ports and public hostname are monitored
    // (and on the Monitor page) right away instead of within the next 10 minutes.
    try { require('../kuma').syncSoon(); say('queued Uptime Kuma sync', 'the new site appears in Kuma and on the Monitor page within a minute'); } catch (_) {}

    return { ok: true, site: store.getById(row.id), password, steps: done, user, docroot, runtime: runtimeSteps, database: database || (stack ? { engine: 'sqlite', name: 'data/app.db' } : null), stack, tunnel: published ? { id: published.tunnelId, hosts: published.hosts } : null };
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
  // GitHub: push what the server still has, then take the site's deploy key off the repo. The repo
  // and its history stay on GitHub — deleting a site never deletes code.
  const github = require('./github');
  if (github.state(site.domain)) {
    await tryStep('pushed the last changes to GitHub', async () => { const r = await github.sync(site); return r.summary; });
    await tryStep('disconnected GitHub (deploy key removed, repo kept)', async () => { const st = github.state(site.domain); await github.disconnect(site); return st && st.repo; });
  }
  await tryStep('removed /etc/cron.d/' + site.user, () => cron.remove(site.user));
  if (tunnel.state(site.domain)) await tryStep('removed the Cloudflare tunnel, its service and DNS', async () => { const r = await tunnel.unpublish(site.domain); if (!r.ok) throw new Error(r.errors.join('; ')); return 'tunnel ' + site.domain + ' gone'; });
  if (require('./turnstile').get(site.domain)) await tryStep('deleted the Cloudflare Turnstile widget', () => require('./turnstile').remove(site.domain));
  await tryStep('removed the vhost and reloaded nginx', () => vhost.removeFile(site.domain));
  await tryStep('removed the Claude Code Remote Control service', async () => { await require('./claudeRemote').removeSite(site.domain); return require('./claudeRemote').unitName(site.domain); });
  if (site.php) await tryStep('removed the php-fpm pool', async () => { php.removePool(site.php.php_version, site.domain); const r = await php.reloadFpm(site.php.php_version); return r.ok ? 'php' + site.php.php_version + '-fpm reloaded' : r.output; });
  await tryStep('removed the certificate files', () => { ssl.remove(site.domain); });
  await tryStep('removed /etc/logrotate.d/' + site.user, () => logs.removeLogrotate(site.user));
  await tryStep('removed the basic-auth file', () => { try { fs.unlinkSync(path.join(vhost.BASIC_AUTH_DIR, site.domain)); return 'removed'; } catch (_) { return 'none'; } });

  // The pm2 unit and the linger flag live outside the home, so `userdel -r` does not reach them.
  // Unconditional rather than gated on site.type: a site converted away from nodejs would otherwise
  // strand the unit it was given while it still was one.
  await tryStep('removed the pm2 systemd unit and linger for ' + site.user, async () => (await runtime.deprovisionNode(site.user)).output);

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
  // per-domain panel state outside the site tables (GitHub, Dependabot cache, SSH key, code scan,
  // overrides, cluster move marker …) — a re-added site with the same name must start from nothing.
  // The tunnel record stays only if removing the tunnel failed above, so it can still be cleaned up.
  await tryStep('removed the site\'s panel state', () => {
    const { open, settings } = require('../db');
    // records of Cloudflare objects whose removal failed above stay, so they can still be cleaned up
    const keep = [tunnel.state(site.domain) ? 'tunnel.site:' + site.domain : null, require('./turnstile').get(site.domain) ? 'site.turnstile:' + site.domain.toLowerCase() : null].filter(Boolean);
    const rows = open().prepare("SELECT key FROM kv WHERE lower(key) LIKE '%:' || lower(?)").all(site.domain).map((r) => r.key).filter((k) => !keep.includes(k));
    for (const k of rows) settings.del(k);
    return rows.length ? rows.join(', ') : 'none';
  });
  // the site's users leave the sshd AllowUsers list (rendered from the remaining sites)
  await tryStep('updated the SSH allow-list', async () => { const wl = require('../whitelist'); let msg = ''; await wl.applySshd(wl.get(), (m) => { msg = m; }); return msg; });
  try { require('../kuma').syncSoon(); say('queued Uptime Kuma sync', 'the site\'s monitors are removed within a minute'); } catch (_) {}
  // The rate-limit zones live in their own include, outside the vhost that was already removed, so
  // they have to be rebuilt or a zone for a site that no longer exists is left declared.
  const zones = vhost.writeTrafficZones();
  if (zones.changed) {
    await tryStep('rebuilt the traffic-zone include', async () => { const r = await vhost.reloadNginx(); return r.ok ? 'nginx reloaded' : r.output; });
  }
  return { ok: true, domain: site.domain, steps: done, errors };
}

module.exports = { createSite, deleteSite, suggestUser, freePort, checkPort, sqliteName, TYPES };
