'use strict';
// App Store (left menu → App Store): install, update and remove server software from one catalog.
//
// Debian ships one version of each runtime; "all versions" come from the vendors' own repos, which
// are added the first time something needs them:
//   PHP 7.4–8.5 side by side     packages.sury.org (php<v>-fpm + common extensions)
//   PostgreSQL 13–18 side by side apt.postgresql.org (PGDG) — each version its own cluster/port
//   MariaDB 10.11 / 11.4 / 11.8   r.mariadb.com — one server at a time (switching = up/downgrade)
//   Node.js system major          deb.nodesource.com — one at a time (sites can pin their own via nvm)
//   Python versions               uv (astral.sh) → /opt/python, side by side
// AI agents come from lib/agents.js (deploy per user). Everything runs as a background job, one at a
// time (apt holds a lock anyway), with its output kept. Removal refuses what is still in use.
const fs = require('fs');
const crypto = require('crypto');
const { execP } = require('./util');

const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const APT_ENV = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive', HOME: '/root', PATH: '/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' });
const sh = (script, t) => execP('bash', ['-c', 'set -o pipefail; ' + script], { timeout: t || 30 * 60_000, env: APT_ENV });
const APT = 'apt-get -y -q -o Dpkg::Options::=--force-confold';
const exists = (f) => { try { return fs.existsSync(f); } catch (_) { return false; } };

async function dpkgVersion(pkg) { const r = await execP('dpkg-query', ['-W', '--showformat=${Status}|${Version}', pkg], { timeout: 10_000 }); const [st, v] = (r.stdout || '').split('|'); return /install ok installed/.test(st || '') ? v : null; }
async function cmdVersion(cmd) { const r = await sh(cmd + ' 2>&1 | head -3', 15_000); const m = ((r.stdout || '') + (r.stderr || '')).match(/\d+\.\d+(\.\d+)?/); return r.err ? null : (m ? m[0] : null); }

// ---- vendor repos
const REPOS = {
  sury: { file: '/etc/apt/sources.list.d/php-sury.list', setup: 'curl -fsSLo /tmp/debsuryorg-archive-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb && dpkg -i /tmp/debsuryorg-archive-keyring.deb && echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ $(. /etc/os-release; echo $VERSION_CODENAME) main" > /etc/apt/sources.list.d/php-sury.list && apt-get update -q' },
  pgdg: { file: '/etc/apt/sources.list.d/pgdg.sources', alt: '/etc/apt/sources.list.d/pgdg.list', setup: APT + ' install postgresql-common && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y' },
};
async function ensureRepo(name, log) {
  const r = REPOS[name];
  if (exists(r.file) || (r.alt && exists(r.alt))) return;
  log('adding the ' + name + ' apt repository');
  const x = await sh(r.setup);
  log(x.stdout + x.stderr);
  if (x.err) throw bad('could not add the ' + name + ' repository');
}

// ---- catalog
const PHP_VERS = ['7.4', '8.0', '8.1', '8.2', '8.3', '8.4', '8.5'];
const PHP_EXT = ['cli', 'fpm', 'common', 'mysql', 'pgsql', 'sqlite3', 'curl', 'gd', 'mbstring', 'xml', 'zip', 'intl', 'bcmath', 'opcache', 'readline', 'redis', 'imagick'];
const PG_VERS = ['13', '14', '15', '16', '17', '18'];
const MARIA_VERS = ['10.11', '11.4', '11.8'];
// Plus whatever major is installed now: nodejs-update.timer (lib/nodejs.js) moves the system Node to
// each new LTS major on its own, so the installed one may be newer than this list.
const NODE_MAJORS = (() => {
  const l = ['20', '22', '24', '26'];
  try { const m = require('child_process').execFileSync('/usr/bin/node', ['-p', 'process.versions.node.split(".")[0]'], { encoding: 'utf8', timeout: 5000 }).trim(); if (/^\d+$/.test(m) && !l.includes(m)) l.push(m); } catch (_) {}
  return l;
})();
const PY_VERS = ['3.10', '3.11', '3.12', '3.13', '3.14'];

const ITEMS = [
  // ----- languages & runtimes
  { id: 'php', name: 'PHP', category: 'runtimes', desc: 'PHP-FPM with the common extensions; versions side by side, each site picks its own', versions: PHP_VERS, multi: true,
    detect: async () => { const out = {}; for (const v of PHP_VERS) out[v] = await dpkgVersion('php' + v + '-fpm'); return out; },
    install: async (v, log) => { if (v !== '8.4') await ensureRepo('sury', log); const pk = PHP_EXT.map((e) => 'php' + v + '-' + e).join(' '); return sh('apt-get update -q >/dev/null; ' + APT + ' install ' + pk + ' 2>&1 || ' + APT + ' install php' + v + '-fpm php' + v + '-cli php' + v + '-common 2>&1'); },
    inUse: (v) => { const dir = '/etc/php/' + v + '/fpm/pool.d'; try { const pools = fs.readdirSync(dir).filter((f) => f.endsWith('.conf') && f !== 'www.conf'); return pools.length ? pools.length + ' site pool(s): ' + pools.map((f) => f.replace(/\.conf$/, '')).join(', ') : null; } catch (_) { return null; } },
    remove: (v) => sh(APT + ' purge "php' + v + '-*" 2>&1 && ' + APT + ' autoremove 2>&1'),
    update: (v) => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade "php' + v + '-*" 2>&1') },
  { id: 'node', name: 'Node.js (system)', category: 'runtimes', desc: 'The server-wide Node.js (NodeSource, one major at a time) — the panel runs on it; sites can pin any version via nvm', versions: NODE_MAJORS, multi: false, risky: 'the panel itself runs on the system Node.js; pm2 daemons move onto a new binary within ~10 minutes (lib/sites/daemons.js), and nodejs-update.timer moves the system Node to each new LTS major on its own',
    detect: async () => { const v = await cmdVersion('/usr/bin/node --version'); const out = {}; for (const m of NODE_MAJORS) out[m] = v && v.split('.')[0] === m ? v : null; return out; },
    install: (m) => sh('curl -fsSL https://deb.nodesource.com/setup_' + m + '.x | bash - 2>&1 && ' + APT + ' install nodejs 2>&1'),
    update: () => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade nodejs 2>&1') },
  { id: 'python', name: 'Python', category: 'runtimes', desc: 'Extra Python versions via uv, side by side in /opt/python (the system python3 stays as it is)', versions: PY_VERS, multi: true,
    detect: async () => { const r = await sh('UV_PYTHON_INSTALL_DIR=/opt/python uv python list --only-installed 2>/dev/null', 30_000); const out = {}; for (const v of PY_VERS) { const m = (r.stdout || '').match(new RegExp('cpython-(' + v.replace('.', '\\.') + '\\.\\d+)')); out[v] = m ? m[1] : null; } return out; },
    install: (v) => sh('command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh) 2>&1; UV_PYTHON_INSTALL_DIR=/opt/python uv python install ' + v + ' 2>&1'),
    remove: (v) => sh('UV_PYTHON_INSTALL_DIR=/opt/python uv python uninstall ' + v + ' 2>&1') },
  { id: 'bun', name: 'Bun', category: 'runtimes', desc: 'JavaScript runtime & package manager (/usr/local/bin/bun)', versions: ['latest'],
    detect: async () => ({ latest: await cmdVersion('/usr/local/bin/bun --version') }),
    install: () => sh('curl -fsSL https://bun.sh/install | env BUN_INSTALL=/usr/local bash 2>&1'), update: () => sh('/usr/local/bin/bun upgrade 2>&1'), remove: () => sh('rm -f /usr/local/bin/bun /usr/local/bin/bunx && echo removed') },
  { id: 'deno', name: 'Deno', category: 'runtimes', desc: 'JavaScript/TypeScript runtime (/usr/local/bin/deno)', versions: ['latest'],
    detect: async () => ({ latest: await cmdVersion('/usr/local/bin/deno --version') }),
    install: () => sh('curl -fsSL https://deno.land/install.sh | env DENO_INSTALL=/usr/local sh -s -- -y 2>&1'), update: () => sh('/usr/local/bin/deno upgrade 2>&1'), remove: () => sh('rm -f /usr/local/bin/deno && echo removed') },
  { id: 'go', name: 'Go', category: 'runtimes', desc: 'Go toolchain from go.dev (/usr/local/go)', versions: ['latest'],
    detect: async () => ({ latest: await cmdVersion('/usr/local/go/bin/go version') }),
    install: () => sh('V=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1) && A=$(dpkg --print-architecture) && curl -fsSL "https://go.dev/dl/$V.linux-$A.tar.gz" -o /tmp/go.tgz && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz && ln -sf /usr/local/go/bin/go /usr/local/bin/go && ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt && echo installed $V 2>&1'),
    remove: () => sh('rm -rf /usr/local/go /usr/local/bin/go /usr/local/bin/gofmt && echo removed') },
  { id: 'composer', name: 'Composer', category: 'runtimes', desc: 'PHP dependency manager (/usr/local/bin/composer) — needs a PHP version', versions: ['latest'],
    detect: async () => ({ latest: await cmdVersion('/usr/local/bin/composer --version --no-interaction') }),
    install: () => sh('command -v php >/dev/null || { echo "install a PHP version first"; exit 1; }; curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php && php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer 2>&1'),
    update: () => sh('/usr/local/bin/composer self-update --no-interaction 2>&1'), remove: () => sh('rm -f /usr/local/bin/composer && echo removed') },
  // ----- databases
  { id: 'postgresql', name: 'PostgreSQL', category: 'databases', desc: 'Versions side by side (PGDG); each runs its own cluster on its own port', versions: PG_VERS, multi: true,
    detect: async () => { const out = {}; for (const v of PG_VERS) out[v] = await dpkgVersion('postgresql-' + v); return out; },
    install: async (v, log) => { if (v !== '17') await ensureRepo('pgdg', log); return sh('apt-get update -q >/dev/null; ' + APT + ' install postgresql-' + v + ' 2>&1 && pg_lsclusters 2>&1'); },
    inUse: async (v) => { const r = await sh('runuser -u postgres -- psql --cluster ' + v + '/main -Atc "select count(*) from pg_database where not datistemplate and datname <> \'postgres\'" 2>/dev/null', 20_000); const n = Number((r.stdout || '').trim()); return n > 0 ? n + ' database(s) in the ' + v + ' cluster' : null; },
    remove: (v) => sh('pg_dropcluster --stop ' + v + ' main 2>&1; ' + APT + ' purge postgresql-' + v + ' 2>&1'),
    update: (v) => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade postgresql-' + v + ' 2>&1') },
  { id: 'mariadb', name: 'MariaDB', category: 'databases', desc: 'One MariaDB server (official repo for 10.11 / 11.4, Debian\'s 11.8); choosing another version up- or downgrades it', versions: MARIA_VERS, multi: false, risky: 'changing the major version of an existing MariaDB with data is an upgrade — back up first',
    detect: async () => { const v = await dpkgVersion('mariadb-server'); const out = {}; for (const m of MARIA_VERS) out[m] = v && (v.replace(/^\d+:/, '').startsWith(m + '.')) ? v.replace(/^\d+:/, '').split('-')[0].split('+')[0] : null; return out; },
    install: (m) => sh((m === '11.8' ? 'rm -f /etc/apt/sources.list.d/mariadb.list; apt-get update -q >/dev/null; ' : 'curl -LsS https://r.mariadb.com/downloads/mariadb_repo_setup | bash -s -- --mariadb-server-version=mariadb-' + m + ' --skip-maxscale 2>&1 && ') + APT + ' install mariadb-server mariadb-client 2>&1 && systemctl enable --now mariadb 2>&1'),
    inUse: async () => { const r = await sh('mariadb -N -e "select count(*) from information_schema.schemata where schema_name not in (\'mysql\',\'information_schema\',\'performance_schema\',\'sys\',\'test\')" 2>/dev/null', 20_000); const n = Number((r.stdout || '').trim()); return n > 0 ? n + ' database(s)' : null; },
    remove: () => sh('systemctl disable --now mariadb 2>&1; ' + APT + ' purge mariadb-server mariadb-client 2>&1 && ' + APT + ' autoremove 2>&1'),
    update: () => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade mariadb-server mariadb-client 2>&1') },
  ...['redis', 'valkey', 'memcached'].map((id) => ({ id, name: { redis: 'Redis', valkey: 'Valkey', memcached: 'Memcached' }[id], category: 'databases', versions: ['latest'],
    desc: { redis: 'In-memory key-value store (Debian package, bound to 127.0.0.1)', valkey: 'Open-source Redis fork (Linux Foundation), drop-in compatible', memcached: 'Memory object cache' }[id],
    detect: async () => ({ latest: await dpkgVersion(id === 'redis' ? 'redis-server' : id === 'valkey' ? 'valkey-server' : 'memcached') }),
    install: () => sh('apt-get update -q >/dev/null; ' + APT + ' install ' + (id === 'redis' ? 'redis-server' : id === 'valkey' ? 'valkey-server' : 'memcached') + ' 2>&1'),
    update: () => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade ' + (id === 'redis' ? 'redis-server' : id === 'valkey' ? 'valkey-server' : 'memcached') + ' 2>&1'),
    remove: () => sh(APT + ' purge ' + (id === 'redis' ? 'redis-server' : id === 'valkey' ? 'valkey-server' : 'memcached') + ' 2>&1') })),
  // ----- tools
  { id: 'cloudflared', name: 'cloudflared', category: 'tools', desc: 'Cloudflare Tunnel connector (official Cloudflare apt repo) — sites and the panel are published through it, no open ports', versions: ['latest'],
    detect: async () => ({ latest: await dpkgVersion('cloudflared') }),
    install: () => sh('mkdir -p --mode=0755 /usr/share/keyrings && curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg 2>&1'
      + ' && echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list'
      + ' && apt-get update -q 2>&1 && ' + APT + ' install cloudflared 2>&1 && cloudflared --version 2>&1'),
    update: () => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade cloudflared 2>&1'),
    inUse: async () => { const r = await sh("systemctl list-units --type=service --state=active --no-legend --plain 'cloudflared*' | grep -v cloudflared-update | wc -l", 15_000); const n = Number((r.stdout || '0').trim()); return n > 0 ? n + ' running tunnel(s)' : null; },
    remove: () => sh(APT + ' purge cloudflared 2>&1') },
  { id: 'docker', name: 'Docker', category: 'tools', desc: 'Container engine (Debian docker.io + compose)', versions: ['latest'],
    detect: async () => ({ latest: await dpkgVersion('docker.io') }),
    install: () => sh('apt-get update -q >/dev/null; ' + APT + ' install docker.io docker-compose 2>&1 || ' + APT + ' install docker.io 2>&1'),
    update: () => sh('apt-get update -q >/dev/null; ' + APT + ' install --only-upgrade docker.io 2>&1'),
    inUse: async () => { const r = await sh('docker ps -q 2>/dev/null | wc -l', 15_000); const n = Number((r.stdout || '0').trim()); return n > 0 ? n + ' running container(s)' : null; },
    remove: () => sh(APT + ' purge docker.io docker-compose 2>&1') },
];
const CATEGORIES = [['agents', 'AI agents'], ['runtimes', 'Languages & runtimes'], ['databases', 'Databases'], ['tools', 'Tools']];

// ---- state
let cache = null, cacheAt = 0;
async function list(force) {
  if (!force && cache && Date.now() - cacheAt < 60_000) return cache;
  const items = [];
  for (const it of ITEMS) {
    let installed = {}; try { installed = await it.detect(); } catch (_) {}
    items.push({ id: it.id, name: it.name, category: it.category, desc: it.desc, multi: !!it.multi, risky: it.risky || null, versions: it.versions,
      installed, canUpdate: !!it.update, canRemove: !!it.remove });
  }
  let agents = [];
  try {
    const ag = require('./agents'), t = new Set(ag.tracked());
    agents = [{ key: 'claude', label: 'Claude Code', vendor: 'Anthropic', pkg: '@anthropic-ai/claude-code', tracked: true, always: true }, ...ag.all().map((a) => Object.assign({}, a, { tracked: t.has(a.key) || !!a.custom }))];
  } catch (_) {}
  cache = { categories: CATEGORIES, items, agents, generated_at: new Date().toISOString() };
  cacheAt = Date.now();
  return cache;
}

const jobs = new Map(); let chain = Promise.resolve();
function run(action, id, version, actor) {
  const it = ITEMS.find((x) => x.id === id); if (!it) throw bad('unknown app', 404);
  if (!['install', 'update', 'remove'].includes(action)) throw bad('unknown action');
  if (!it[action]) throw bad(it.name + ' cannot be ' + action + 'd here');
  if (!it.versions.includes(version)) throw bad('unknown version ' + version);
  const job = { id: crypto.randomBytes(6).toString('hex'), action, app: id, name: it.name, version, state: 'queued', log: [], started: new Date().toISOString(), by: actor };
  jobs.set(job.id, job);
  const log = (t) => { for (const l of String(t || '').split('\n')) if (l.trim()) job.log.push(l.slice(0, 400)); if (job.log.length > 600) job.log.splice(0, job.log.length - 600); };
  chain = chain.then(async () => {
    job.state = 'running';
    try {
      if (action === 'remove' && it.inUse) { const u = await it.inUse(version); if (u) throw bad('in use — ' + u + '; not removing'); }
      log('$ ' + action + ' ' + it.name + (version !== 'latest' ? ' ' + version : ''));
      const r = await it[action](version, log);
      log((r.stdout || '') + (r.stderr || ''));
      if (r.err) throw bad(action + ' failed (exit ' + (r.err.code || '?') + ')');
      job.state = 'done';
    } catch (e) { job.state = 'failed'; job.error = e.message; log('FAILED: ' + e.message); }
    job.finished = new Date().toISOString();
    cacheAt = 0;
    try { require('./events').emit('appstore.' + action, { user: actor || 'system', target: id + (version !== 'latest' ? '@' + version : ''), level: job.state === 'done' ? (action === 'remove' ? 'warn' : 'info') : 'error', message: (job.state === 'done' ? '' : 'FAILED: ') + action + ' ' + it.name + (version !== 'latest' ? ' ' + version : '') + (job.error ? ' — ' + job.error : '') }); } catch (_) {}
  });
  return job;
}
const jobView = (j) => ({ id: j.id, action: j.action, app: j.app, name: j.name, version: j.version, state: j.state, error: j.error || null, started: j.started, finished: j.finished || null, log: j.log.slice(-200) });
function getJob(id) { const j = jobs.get(id); if (!j) throw bad('unknown job', 404); return jobView(j); }
function recentJobs() { return [...jobs.values()].slice(-15).reverse().map((j) => Object.assign(jobView(j), { log: j.log.slice(-3) })); }

module.exports = { list, run, getJob, recentJobs, ITEMS };
