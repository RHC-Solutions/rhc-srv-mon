'use strict';
// WordPress (App Store → Web apps): a new site with WordPress installed, and updates for every
// WordPress site on the server.
//
// install: PHP site (Generic template — try_files … /index.php?$args, i.e. pretty permalinks work)
//          + the PHP MySQL extension + MariaDB (installed and registered when missing) + a database
//          and user for the site + wp-cli (/usr/local/bin/wp) → wp core download / config create /
//          core install as the site user. Behind Cloudflare / the tunnel HTTPS arrives as a header, so
//          wp-config honours X-Forwarded-Proto. File editing in wp-admin is off (DISALLOW_FILE_EDIT);
//          updates go through the panel or wp-admin's updater (FS_METHOD direct, files are the site
//          user's). The admin password is shown once and kept encrypted (Vault).
// update:  wp core update + plugins + themes + core update-db, per site, as the site user.
const fs = require('fs');
const path = require('path');
const { execP } = require('./util');
const secrets = require('./secrets');
const { settings } = require('./db');

const WP = '/usr/local/bin/wp';
const WP_URL = 'https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar';
const credKey = (d) => 'app.wordpress:' + String(d).toLowerCase();
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const APT_ENV = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive', HOME: '/root' });

const docroot = (site) => '/home/' + site.user + '/htdocs/' + (site.root_dir || site.domain);
const phpBin = (site) => { const v = site.php && site.php.php_version; return v && fs.existsSync('/usr/bin/php' + v) ? '/usr/bin/php' + v : '/usr/bin/php'; };
// wp-cli as the site user, in its docroot; stdin feeds --prompt answers (passwords never on argv)
function wp(site, args, stdin, t) {
  const sq = (x) => "'" + String(x).replace(/'/g, "'\\''") + "'";
  const cmd = 'cd ' + sq(docroot(site)) + ' && ' + sq(phpBin(site)) + ' ' + WP + ' ' + args.map(sq).join(' ') + ' 2>&1';
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const c = spawn('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { try { c.kill('SIGTERM'); } catch (_) {} }, t || 10 * 60_000);
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    c.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: out.trim() }); });
    c.stdin.on('error', () => {});
    c.stdin.end(stdin || '');
  });
}

async function ensureWpCli(log) {
  if (fs.existsSync(WP)) return;
  log('installing wp-cli → ' + WP);
  const r = await execP('bash', ['-c', 'curl -fsSL ' + WP_URL + ' -o ' + WP + '.new && chmod 755 ' + WP + '.new && mv ' + WP + '.new ' + WP], { timeout: 120_000 });
  if (r.err) throw bad('could not install wp-cli', 502, r.stderr);
}
async function ensurePhpMysql(ver, log) {
  const pkg = 'php' + ver + '-mysql';
  const st = await execP('dpkg-query', ['-W', '--showformat=${Status}', pkg], { timeout: 10_000 });
  if (/install ok installed/.test(st.stdout || '')) return;
  log('installing ' + pkg + ' (WordPress needs mysqli)');
  const r = await execP('bash', ['-c', 'apt-get update -q >/dev/null; apt-get -y -q -o Dpkg::Options::=--force-confold install ' + pkg + ' 2>&1 && systemctl reload php' + ver + '-fpm 2>&1'], { timeout: 15 * 60_000, env: APT_ENV });
  log(r.stdout.trim().split('\n').slice(-3).join('\n'));
  if (r.err) throw bad('could not install ' + pkg, 500, r.stdout.slice(-1500));
}
async function ensureMariadb(log) {
  const store = require('./sites/store');
  const dbs = require('./sites/dbs');
  if (!fs.existsSync('/usr/sbin/mariadbd') && !fs.existsSync('/usr/sbin/mysqld')) {
    log('MariaDB is not installed — installing it (Debian package)');
    const r = await execP('bash', ['-c', 'apt-get update -q >/dev/null; apt-get -y -q -o Dpkg::Options::=--force-confold install mariadb-server 2>&1 && systemctl enable --now mariadb 2>&1'], { timeout: 20 * 60_000, env: APT_ENV });
    log(r.stdout.trim().split('\n').slice(-3).join('\n'));
    if (r.err) throw bad('could not install MariaDB', 500, r.stdout.slice(-1500));
  }
  if (!store.dbServers.byEngine('mariadb')) {
    log('registering MariaDB in the panel and giving root a password (kept encrypted)');
    store.dbServers.upsert({ engine: 'mariadb', host: '127.0.0.1', port: 3306, admin_user: 'root', admin_password_enc: null, is_default: 1 });
    await dbs.resetMariadbRoot();
  }
  await dbs.ensureRunning('mariadb');
}

// opts: { domain, title, adminUser, adminEmail, adminPassword?, php_version?, locale? }
async function install(opts, log, actor) {
  const store = require('./sites/store');
  const domain = String(opts.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) throw bad('enter a domain like blog.example.com');
  if (store.get(domain)) throw bad(domain + ' already exists — WordPress goes on a new site', 409);
  const adminUser = String(opts.adminUser || 'admin').trim();
  if (!/^[A-Za-z0-9_.@-]{3,60}$/.test(adminUser)) throw bad('admin user: 3–60 letters, digits, _ . @ -');
  const adminEmail = String(opts.adminEmail || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) throw bad('a valid admin e-mail is needed (password resets go there)');
  const title = String(opts.title || domain).trim().slice(0, 120) || domain;
  const adminPassword = opts.adminPassword ? String(opts.adminPassword) : secrets.generatePassword(20);
  if (adminPassword.length < 12) throw bad('admin password: at least 12 characters');
  const locale = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(opts.locale || '')) ? String(opts.locale) : 'en_US';

  await ensureMariadb(log);
  await ensureWpCli(log);

  log('creating the site ' + domain + ' (PHP)');
  const created = await require('./sites/create').createSite({ domain, type: 'php', template: 'Generic', php_version: opts.php_version || undefined, sqlite: false, github: false }, { actor });
  for (const s of created.steps || []) log('  ' + s.name + (s.detail ? ' — ' + s.detail : ''));
  const site = created.site;
  const phpVer = (site.php && site.php.php_version) || require('./sites/php').listVersions().slice(-1)[0];
  await ensurePhpMysql(phpVer, log);

  log('creating the database');
  const slug = site.user.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const db = await require('./sites/dbs').create(site, { engine: 'mariadb', name: 'wp_' + slug, user: 'wp_' + slug });
  log('  database ' + db.name + ', user ' + db.user);

  const root = docroot(site);
  log('downloading WordPress (' + locale + ')');
  for (const f of ['index.php', 'index.html']) { try { const p = path.join(root, f); if (fs.existsSync(p) && fs.statSync(p).size < 4096) fs.unlinkSync(p); } catch (_) {} }   // the new-site placeholder
  let r = await wp(site, ['core', 'download', '--locale=' + locale, '--force']);
  log(r.out.split('\n').slice(-2).join('\n'));
  if (!r.ok) throw bad('wp core download failed', 502, r.out.slice(-1500));

  log('writing wp-config.php');
  const extra = [
    "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; }",
    "define('FORCE_SSL_ADMIN', true);",
    "define('DISALLOW_FILE_EDIT', true);",
    "define('FS_METHOD', 'direct');",
    "define('WP_AUTO_UPDATE_CORE', 'minor');",
  ].join('\n');
  r = await wp(site, ['config', 'create', '--dbname=' + db.name, '--dbuser=' + db.user, '--dbhost=127.0.0.1', '--dbcharset=utf8mb4', '--prompt=dbpass', '--force'], db.password + '\n');
  if (!r.ok) throw bad('wp config create failed', 500, r.out.slice(-1500));
  // the extra settings go in just above WordPress's "stop editing" line (written over the same inode: owner stays the site user)
  const cfg = path.join(root, 'wp-config.php');
  let txt = fs.readFileSync(cfg, 'utf8');
  const mark = txt.search(/\/\*\s*That's all, stop editing/i);
  const block = '/* sb-srv-mon */\n' + extra + '\n\n';
  txt = mark >= 0 ? txt.slice(0, mark) + block + txt.slice(mark) : txt.replace(/require_once\s+ABSPATH/, block + 'require_once ABSPATH');
  fs.writeFileSync(cfg, txt);

  log('installing WordPress');
  r = await wp(site, ['core', 'install', '--url=https://' + domain, '--title=' + title, '--admin_user=' + adminUser, '--admin_email=' + adminEmail, '--prompt=admin_password', '--skip-email'], adminPassword + '\n');
  log(r.out.split('\n').slice(-2).join('\n'));
  if (!r.ok) throw bad('wp core install failed', 500, r.out.slice(-1500));
  await wp(site, ['rewrite', 'structure', '/%postname%/', '--hard']);
  try { fs.chmodSync(path.join(root, 'wp-config.php'), 0o640); } catch (_) {}

  settings.set(credKey(domain), { adminUser, adminEmail, password_enc: secrets.encrypt(adminPassword), installedAt: new Date().toISOString() });
  const version = (await wp(site, ['core', 'version'])).out.trim();
  log('WordPress ' + version + ' is ready: https://' + domain + '/wp-admin/ — user ' + adminUser);
  return { domain, url: 'https://' + domain + '/', admin: 'https://' + domain + '/wp-admin/', adminUser, adminPassword, version, database: db.name };
}

// WordPress sites on this server: every site whose docroot has wp-config.php.
function sites() {
  const store = require('./sites/store');
  return store.list().filter((s) => s.type === 'php' && fs.existsSync(path.join(docroot(s), 'wp-config.php')));
}
async function list() {
  const out = [];
  for (const s of sites()) {
    let version = null;
    try { const m = /\$wp_version\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(docroot(s), 'wp-includes', 'version.php'), 'utf8')); version = m ? m[1] : null; } catch (_) {}
    out.push({ domain: s.domain, user: s.user, version, managed: !!settings.get(credKey(s.domain), null) });
  }
  return out;
}
let latestCache = null;
async function latest() {
  if (latestCache && Date.now() - latestCache.at < 3600_000) return latestCache.v;
  try { const j = await (await fetch('https://api.wordpress.org/core/version-check/1.7/', { signal: AbortSignal.timeout(10_000) })).json(); const v = j.offers && j.offers[0] && j.offers[0].current; latestCache = { at: Date.now(), v }; return v || null; } catch (_) { return null; }
}
// Update core, plugins, themes (and the DB schema) of one WordPress site, or every one.
async function update(domain, log) {
  const list = domain ? sites().filter((s) => s.domain === domain) : sites();
  if (!list.length) throw bad(domain ? domain + ' is not a WordPress site' : 'no WordPress sites on this server', 404);
  await ensureWpCli(log);
  let failed = 0;
  for (const s of list) {
    log('— ' + s.domain);
    for (const a of [['core', 'update'], ['core', 'update-db'], ['plugin', 'update', '--all'], ['theme', 'update', '--all'], ['language', 'core', 'update']]) {
      const r = await wp(s, a);
      log('  wp ' + a.join(' ') + ': ' + (r.ok ? 'ok' : 'FAILED') + ' — ' + r.out.split('\n').filter(Boolean).slice(-1).join(''));
      if (!r.ok) failed++;
    }
  }
  if (failed) throw bad(failed + ' update step(s) failed — see the log');
}
function credentials(domain) {
  const c = settings.get(credKey(domain), null);
  if (!c) return null;
  let password = ''; try { password = secrets.decrypt(c.password_enc); } catch (_) {}
  return { adminUser: c.adminUser, adminEmail: c.adminEmail, password };
}

module.exports = { install, update, list, latest, sites, credentials };
