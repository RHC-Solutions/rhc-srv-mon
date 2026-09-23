'use strict';
// Decommission a site: archive everything that belongs to it, deliver the archive to Telegram, and
// only once Telegram has confirmed every byte, delete the site and all its leftovers.
//
//   plan(site)          what would be archived and removed — accounts, homes, databases (registered
//                       with the panel AND discovered from .env files / role owners), system files
//   start(site, opts)   runs the job in the background; get(id) polls it
//
// The archive is one .tar.zst of the site's homes (regenerable junk excluded: node_modules, build
// output, caches, editor servers, logs, .git — the repo is kept as a bundle of whatever the remote
// does not have) plus _decommission/ with database dumps, every config file outside the homes, the
// panel's and CloudPanel's records, and a manifest. Telegram bots can upload at most 50 MB per file,
// so a bigger archive goes as numbered 49 MB parts with the sha256 of the whole and the rejoin
// command. Any part that Telegram does not acknowledge with the exact size aborts the job BEFORE
// anything is deleted, and the staged archive is kept so nothing is lost.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { execP, PG_SOCKET, fmtBytes } = require('../util');
const store = require('./store');
const procs = require('./procs');
const dbs = require('./dbs');
const runtime = require('./runtime');
const create = require('./create');
const users = require('./users');
const vhost = require('./vhost');
const cloudpanel = require('../cloudpanel');
const notify = require('../notify');
const events = require('../events');

const STAGE_ROOT = '/var/tmp/rhc-decommission';          // root fs, not the /tmp tmpfs
const PART_BYTES = 49 * 1000 * 1000;                      // under Telegram's 50 MB bot upload cap
const CLAUDE_RC_CONF = '/etc/claude-rc/sites.conf';
const IDENT = /^[A-Za-z0-9_]{1,63}$/;
// Matched against every path component (tar --exclude without a slash is unanchored).
const EXCLUDE_NAMES = ['node_modules', '.next', '.nuxt', '.turbo', '.svelte-kit', '.parcel-cache', '.cache', '.npm', '.pnpm-store',
  '.yarn/cache', '.vscode-server', '.cursor-server', '.windsurf-server', '.codex', '.claude', '.nvm', '.bun', '.rustup', '.cargo',
  '__pycache__', '.venv', 'venv', '.git', '*.sock'];
// Only at a home's top level (a site's own dir called "logs" or "tmp" deeper down is left alone).
// ~/.local is per-user tool installs (codex, pnpm, playwright…); ~/.pm2 is logs + sockets — its
// dump.pm2, the one file that matters, is copied into _decommission/pm2/ separately.
const EXCLUDE_TOP = ['logs', 'tmp', '.pm2', '.local', '.vscode-cli', '.pw-syslibs', '.dotnet', '.gradle', '.m2'];

const jobs = new Map();
let running = null;
const bad = (m, s, d) => Object.assign(new Error(m), { status: s || 400, detail: d });
const realpath = (p) => { try { return fs.realpathSync(p); } catch (_) { return null; } };
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (_) { return false; } };

/* ------------------------------------------------------------------ discovery */
// Every unix account of a site: the site user, its SSH/FTP users, and any account whose pm2 runs
// the site's apps (found by home/htdocs symlinks). An account another site also claims is shared
// and is never deleted from here.
function accountsOf(site) {
  const names = new Set([site.user]);
  for (const u of store.sshUsers.list(site.id)) names.add(u.username);
  for (const u of store.ftpUsers.list(site.id)) names.add(u.username);
  try { for (const h of procs.pm2HomesFor(site)) names.add(h.user); } catch (_) {}
  const others = new Set();
  for (const s of store.list()) {
    if (s.id === site.id) continue;
    others.add(s.user);
    for (const u of store.sshUsers.list(s.id)) others.add(u.username);
    for (const u of store.ftpUsers.list(s.id)) others.add(u.username);
  }
  const known = store.knownUnixUsers();
  return [...names].map((name) => {
    const ent = users.getent(name);
    return { name, uid: ent ? ent.uid : null, home: ent ? ent.home : null, exists: !!ent, shared: others.has(name), managed: known.has(name) };
  });
}

// Homes to archive: each account's home once, skipping one that lives inside another (FTP users).
function homesOf(accounts) {
  const list = accounts.filter((a) => a.exists && !a.shared && a.home && a.home.startsWith('/home/') && fs.existsSync(a.home))
    .map((a) => ({ account: a.name, path: realpath(a.home) || a.home }));
  return list.filter((h, i) => !list.some((o, j) => j !== i && o.path !== h.path && h.path.startsWith(o.path + '/')))
    .filter((h, i, arr) => arr.findIndex((o) => o.path === h.path) === i);
}

// .env* files of a home, junk directories pruned; returns the postgres databases they point at locally.
async function envDbRefs(home) {
  const r = await execP('find', [home, '-maxdepth', '7', '(', '-name', 'node_modules', '-o', '-name', '.git', '-o', '-name', '.next', '-o', '-name', '.pnpm-store', '-o', '-name', '.cache', ')', '-prune',
    '-o', '-type', 'f', '-name', '.env*', '!', '-name', '*.example', '!', '-name', '*.sample', '-print'], { timeout: 60_000 });
  const refs = new Set();
  for (const f of String(r.stdout || '').split('\n').filter(Boolean)) {
    let text = ''; try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const re = /postgres(?:ql)?:\/\/[^\s'"@]*@(localhost|127\.0\.0\.1|\[::1\]|%2F[^/\s'"]*)(?::\d+)?\/([A-Za-z0-9_]+)/g;
    let m; while ((m = re.exec(text))) refs.add(m[2]);
  }
  return refs;
}

// An unclaimed database named after the site, e.g. "nicolina" for nicolinastyles.com: the db (or its
// owner) and the domain's first label / an account name share a prefix of at least 5 characters.
function nameMatches(d, site, accounts) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const keys = [site.domain.split('.')[0]].concat(accounts.map((a) => a.name)).map(norm).filter((k) => k.length >= 5);
  return [d.name, d.owner].map(norm).filter((n) => n.length >= 5).some((n) => keys.some((k) => k.startsWith(n) || n.startsWith(k)));
}
async function pgDatabases() {
  const r = await execP('psql', ['-U', 'postgres', '-h', PG_SOCKET, '-d', 'postgres', '-tAF', '|', '-c',
    'SELECT d.datname, r.rolname, pg_database_size(d.datname) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE NOT d.datistemplate AND d.datname <> \'postgres\' ORDER BY 1'], { timeout: 20_000 });
  if (r.err) return null;
  return String(r.stdout).trim().split('\n').filter(Boolean).map((l) => { const [name, owner, size] = l.split('|'); return { name, owner, size: Number(size) || 0 }; });
}

// Registered databases (panel records) + postgres databases this site uses but the panel never knew
// about. `linked` = referenced by this site's .env or owned by one of its accounts (selected by default);
// `unclaimed` = no site at all points at it (listed so it can be ticked by hand); anything another site
// uses is never offered.
async function databasesOf(site, accounts, homes) {
  const registered = store.databases.list(site.id).map((d) => ({ id: d.id, engine: d.engine, name: d.name, source: 'registered', selected: true }));
  const all = await pgDatabases();
  if (!all) return { registered, discovered: [], pgError: 'could not list PostgreSQL databases' };
  const mine = new Set(accounts.filter((a) => !a.shared).map((a) => a.name));
  const refs = new Set();
  for (const h of homes) for (const n of await envDbRefs(h.path)) refs.add(n);
  // what every OTHER site uses: registered, .env-referenced, or owned by one of its accounts
  const theirs = new Set();
  for (const s of store.list()) {
    if (s.id === site.id) continue;
    for (const d of store.databases.list(s.id)) theirs.add(d.name);
    const acc = accountsOf(s);
    const accNames = new Set(acc.map((a) => a.name));
    for (const d of all) if (accNames.has(d.owner)) theirs.add(d.name);
    for (const h of homesOf(acc)) for (const n of await envDbRefs(h.path)) theirs.add(n);
  }
  const regNames = new Set(registered.filter((d) => d.engine === 'postgres').map((d) => d.name));
  const discovered = [];
  for (const d of all) {
    if (regNames.has(d.name) || theirs.has(d.name)) continue;
    const why = refs.has(d.name) ? 'referenced in .env' : mine.has(d.owner) ? 'owned by ' + d.owner : nameMatches(d, site, accounts) ? 'name matches the site (unclaimed)' : null;
    discovered.push({ engine: 'postgres', name: d.name, owner: d.owner, size: d.size, source: why ? 'linked' : 'unclaimed', why: why || 'no site references it', selected: !!why });
  }
  discovered.sort((a, b) => (b.selected - a.selected) || a.name.localeCompare(b.name));
  return { registered, discovered };
}

// Files outside the homes that belong to the site: archived into _decommission/system and removed.
function systemFiles(site, accounts) {
  const out = [];
  const add = (p, what) => { if (exists(p)) out.push({ path: p, what }); };
  add(path.join(vhost.SITES_DIR, site.domain + '.conf'), 'nginx vhost');
  for (const ext of ['.crt', '.key', '.pem', '.csr']) add(path.join(vhost.SSL_DIR, site.domain + ext), 'certificate');
  add(path.join(vhost.BASIC_AUTH_DIR, site.domain), 'basic-auth file');
  for (const d of ['live', 'archive']) add('/etc/letsencrypt/' + d + '/' + site.domain, "Let's Encrypt " + d);
  add('/etc/letsencrypt/renewal/' + site.domain + '.conf', "Let's Encrypt renewal");
  if (site.php) add('/etc/php/' + site.php.php_version + '/fpm/pool.d/' + site.domain + '.conf', 'php-fpm pool');
  for (const a of accounts.filter((x) => !x.shared)) {
    add('/etc/cron.d/' + a.name.replace(/[^A-Za-z0-9_-]/g, '_'), 'cron.d');
    add('/var/spool/cron/crontabs/' + a.name, 'user crontab');
    add('/etc/logrotate.d/' + a.name, 'logrotate');
    add('/etc/systemd/system/pm2-' + a.name + '.service', 'pm2 boot unit');
    add('/var/lib/systemd/linger/' + a.name, 'systemd linger');
    add('/var/mail/' + a.name, 'mail spool');
  }
  return out;
}

function claudeRcLines(accounts) {
  let text = ''; try { text = fs.readFileSync(CLAUDE_RC_CONF, 'utf8'); } catch (_) { return []; }
  const names = new Set(accounts.filter((a) => !a.shared).map((a) => a.name));
  return text.split('\n').filter((l) => !/^\s*#/.test(l) && names.has(l.split('|')[0].trim()));
}

// nginx files other than the site's own vhost that still mention the domain — reported, never edited.
async function nginxMentions(site) {
  const r = await execP('grep', ['-rlF', site.domain, '/etc/nginx'], { timeout: 15_000 });
  const own = path.join(vhost.SITES_DIR, site.domain + '.conf');
  return String(r.stdout || '').split('\n').filter((f) => f && f !== own && !f.includes('/ssl-certificates/') && !/\.bak|\.backup|~$/.test(f));
}

function clpSite(site) {
  return cloudpanel.withDb((db) => db.prepare('SELECT id, domain_name, user FROM site WHERE domain_name = ?').get(site.domain) || null, null);
}

// tar applies matching options to the --exclude flags that follow them: names anywhere, then the
// home-top-level ones anchored with * unable to cross a slash.
function tarExcludes() {
  return EXCLUDE_NAMES.map((n) => '--exclude=' + n).concat(['--anchored', '--no-wildcards-match-slash'], EXCLUDE_TOP.map((n) => '--exclude=home/*/' + n));
}

async function estimate(homes) {
  let bytes = 0;
  for (const h of homes) {
    const r = await execP('du', ['-sb'].concat(EXCLUDE_NAMES.concat(EXCLUDE_TOP).map((n) => '--exclude=' + n), [h.path]), { timeout: 120_000 });
    bytes += Number(String(r.stdout || '').split('\t')[0]) || 0;
  }
  return bytes;
}

async function plan(site) {
  const accounts = accountsOf(site);
  const homes = homesOf(accounts);
  const [databases, mentions, rawBytes] = await Promise.all([databasesOf(site, accounts, homes), nginxMentions(site), estimate(homes)]);
  const tg = notify.getConfig();
  return {
    domain: site.domain, accounts, homes, databases,
    system: systemFiles(site, accounts), claudeRc: claudeRcLines(accounts), nginxMentions: mentions,
    cloudpanel: clpSite(site), rawBytes, raw: fmtBytes(rawBytes),
    // zstd on source trees typically lands at 20–35 %; the real count is known only after compressing
    estParts: Math.max(1, Math.ceil(rawBytes * 0.35 / PART_BYTES)),
    excludes: EXCLUDE_NAMES.concat(EXCLUDE_TOP.map((n) => '~/' + n)),
    telegram: { configured: !!(tg && tg.botToken && tg.chatId) },
    running: running ? { id: running.id, domain: running.domain } : null,
  };
}

/* ------------------------------------------------------------------ telegram */
function tgCfg() {
  const c = notify.getConfig();
  if (!c || !c.botToken || !c.chatId) throw bad('Telegram is not configured (Settings → Notifications) — the archive has nowhere to go', 409);
  return c;
}
async function tgCall(method, init, timeoutMs) {
  const c = tgCfg();
  for (let attempt = 1; ; attempt++) {
    let j = null, err = null;
    try {
      const r = await fetch('https://api.telegram.org/bot' + c.botToken + '/' + method, Object.assign({}, init(), { signal: AbortSignal.timeout(timeoutMs || 30_000) }));
      try { j = await r.json(); } catch (_) { j = { ok: false, description: 'HTTP ' + r.status }; }
    } catch (e) { err = e.message; }
    if (j && j.ok) return j.result;
    const retryAfter = j && j.parameters && j.parameters.retry_after;
    if (attempt >= 5) throw new Error('Telegram ' + method + ': ' + (err || (j && j.description) || 'failed'));
    await new Promise((r) => setTimeout(r, (retryAfter ? retryAfter + 1 : attempt * 5) * 1000));
  }
}
function tgText(text) {
  const c = tgCfg();
  return tgCall('sendMessage', () => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.chatId, text: text.slice(0, 4000), disable_web_page_preview: true }) }));
}
async function tgFile(file, caption) {
  const c = tgCfg();
  const size = fs.statSync(file).size;
  const blob = await fs.openAsBlob(file);
  const res = await tgCall('sendDocument', () => {
    const fd = new FormData();
    fd.append('chat_id', String(c.chatId));
    fd.append('caption', caption.slice(0, 1000));
    fd.append('disable_content_type_detection', 'true');
    fd.append('document', blob, path.basename(file));
    return { method: 'POST', body: fd };
  }, 20 * 60_000);
  const got = res && res.document && res.document.file_size;
  if (got !== size) throw new Error('Telegram stored ' + path.basename(file) + ' as ' + got + ' bytes, expected ' + size);
  return { message_id: res.message_id, file_id: res.document.file_id, size };
}

/* ------------------------------------------------------------------ the job */
function newJob(site) {
  const job = { id: crypto.randomBytes(6).toString('hex'), domain: site.domain, phase: 'starting', startedAt: new Date().toISOString(),
    finishedAt: null, done: false, ok: false, deleted: false, log: [], errors: [], archive: null, stage: null };
  jobs.set(job.id, job);
  return job;
}
const say = (job, line) => { job.log.push(new Date().toISOString().slice(11, 19) + '  ' + line); if (job.log.length > 500) job.log.shift(); };

async function sh(cmd, timeoutMs) {
  const r = await execP('bash', ['-o', 'pipefail', '-c', cmd], { timeout: timeoutMs || 30 * 60_000 });
  return r;
}
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// .git is excluded from the tar; keep what the remote cannot give back.
async function gitState(homes, dir, job) {
  const lines = [];
  for (const h of homes) {
    const r = await execP('find', [h.path, '-maxdepth', '6', '-name', 'node_modules', '-prune', '-o', '-type', 'd', '-name', '.git', '-print'], { timeout: 60_000 });
    for (const g of String(r.stdout || '').split('\n').filter(Boolean)) {
      const repo = path.dirname(g);
      const git = (args) => execP('git', ['-c', 'safe.directory=*', '-C', repo].concat(args), { timeout: 5 * 60_000 });
      const remote = String((await git(['remote', '-v'])).stdout || '').trim();
      const branch = String((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout || '').trim();
      const head = String((await git(['rev-parse', 'HEAD'])).stdout || '').trim();
      const status = String((await git(['status', '--porcelain'])).stdout || '').trim();
      const unpushed = String((await git(['rev-list', '--count', '--branches', '--not', '--remotes'])).stdout || '').trim();
      const name = repo.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
      let bundle = 'none needed';
      const target = path.join(dir, name + '.bundle');
      if (!remote) { const b = await git(['bundle', 'create', target, '--all']); bundle = b.err ? 'FAILED: ' + (b.stderr || '').trim() : 'full (no remote)'; }
      else if (Number(unpushed) > 0) { const b = await git(['bundle', 'create', target, '--branches', '--not', '--remotes']); bundle = b.err ? 'FAILED: ' + (b.stderr || '').trim() : unpushed + ' unpushed commit(s)'; }
      if (/^FAILED/.test(bundle)) job.errors.push('git bundle ' + repo + ': ' + bundle);
      lines.push('## ' + repo + '\nbranch: ' + branch + '\nHEAD:   ' + head + '\nbundle: ' + bundle + '\nremotes:\n' + (remote || '(none)') + '\nuncommitted:\n' + (status || '(clean)') + '\n');
    }
  }
  fs.writeFileSync(path.join(dir, 'README.txt'), lines.join('\n') || 'no git repositories\n');
  return lines.length;
}

async function dumpDatabases(site, selected, dir, job) {
  const out = [];
  for (const d of selected) {
    if (d.engine === 'sqlite') { out.push({ name: d.name, engine: d.engine, note: 'file inside the home, archived with it' }); continue; }
    if (d.engine === 'postgres') {
      if (!IDENT.test(d.name)) throw new Error('refusing odd database name ' + d.name);
      const file = path.join(dir, 'postgres-' + d.name + '.dump');
      const r = await execP('pg_dump', ['-U', 'postgres', '-h', PG_SOCKET, '-Fc', '-f', file, d.name], { timeout: 60 * 60_000 });
      if (r.err) throw new Error('pg_dump ' + d.name + ': ' + (r.stderr || r.err.message).split('\n')[0]);
      out.push({ name: d.name, engine: d.engine, file: path.basename(file), size: fs.statSync(file).size, owner: d.owner || null });
    } else {
      // MariaDB goes through the panel's own exporter (it holds the admin credential); it writes into the home.
      const r = await dbs.exportDb(site, d.id);
      fs.copyFileSync(r.file, path.join(dir, 'mariadb-' + d.name + '.sql.gz'));
      out.push({ name: d.name, engine: d.engine, file: 'mariadb-' + d.name + '.sql.gz', size: r.size });
    }
    say(job, 'dumped ' + d.engine + ' ' + d.name);
  }
  // the roles the dumps belong to, without every other role's password hash on the server
  const roles = [...new Set(selected.filter((d) => d.engine === 'postgres').map((d) => d.owner).filter(Boolean))];
  if (roles.length) {
    const r = await execP('pg_dumpall', ['-U', 'postgres', '-h', PG_SOCKET, '--roles-only'], { timeout: 60_000 });
    const keep = String(r.stdout || '').split('\n').filter((l) => roles.some((ro) => new RegExp('\\b(ROLE|TO|role) "?' + ro + '"?\\b').test(l)));
    fs.writeFileSync(path.join(dir, 'postgres-roles.sql'), keep.join('\n') + '\n');
  }
  return out;
}

function recordOf(site) {
  const db = require('../db').open();
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(name) + ')').all().map((c) => c.name);
    if (name === 'sites') out[name] = db.prepare('SELECT * FROM sites WHERE id = ?').all(site.id);
    else if (cols.includes('site_id')) out[name] = db.prepare('SELECT * FROM ' + JSON.stringify(name) + ' WHERE site_id = ?').all(site.id);
  }
  return out;
}
function clpRecordOf(site) {
  return cloudpanel.withDb((db) => {
    const s = db.prepare('SELECT * FROM site WHERE domain_name = ?').get(site.domain);
    if (!s) return null;
    const out = { site: s };
    for (const t of ['php_settings', 'nodejs_settings', 'python_settings', 'ssh_user', 'ftp_user', 'cron_job', 'certificate', 'blocked_ip', 'blocked_bot', 'database']) {
      try { out[t] = db.prepare('SELECT * FROM ' + t + ' WHERE site_id = ?').all(s.id); } catch (_) {}
    }
    try { out.database_user = db.prepare('SELECT u.* FROM database_user u JOIN database d ON d.id = u.database_id WHERE d.site_id = ?').all(s.id); } catch (_) {}
    return out;
  }, null);
}

const RESTORE = (base, parts) => [
  parts > 1 ? 'cat ' + base + '.part* > ' + base : null,
  'sha256sum ' + base + '   # must match the checksum above',
  'mkdir restore && tar -I zstd -xf ' + base + ' -C restore',
  '# homes are under restore/home/, dumps and configs under restore/_decommission/',
].filter(Boolean).join('\n');

async function archiveAndSend(site, p, opts, job) {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const stage = path.join(STAGE_ROOT, site.domain + '-' + stamp);
  const meta = path.join(stage, '_decommission');
  fs.mkdirSync(path.join(meta, 'databases'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(meta, 'git'), { recursive: true });
  fs.mkdirSync(path.join(meta, 'system'), { recursive: true });
  fs.chmodSync(STAGE_ROOT, 0o700);
  job.stage = stage;

  const free = fs.statfsSync(STAGE_ROOT);
  if (free.bavail * free.bsize < p.rawBytes * 0.6 + 2e9) throw new Error('not enough free space in ' + STAGE_ROOT + ' for the archive (' + fmtBytes(free.bavail * free.bsize) + ' free, ~' + fmtBytes(p.rawBytes * 0.6) + ' needed)');

  job.phase = 'dumping databases';
  const selected = p.databases.registered.concat(p.databases.discovered.filter((d) => (opts.databases || []).includes(d.name)));
  const dumps = await dumpDatabases(site, selected, path.join(meta, 'databases'), job);

  job.phase = 'collecting configs';
  const sysList = p.system.map((s) => s.path);
  if (sysList.length) {
    const r = await sh('tar --ignore-failed-read -cf - ' + sysList.map(q).join(' ') + ' 2>/dev/null | tar -xf - -C ' + q(path.join(meta, 'system')));
    if (r.err) job.errors.push('copying system files: ' + (r.stderr || '').trim().split('\n')[0]);
  }
  for (const h of p.homes) { const d = path.join(h.path, '.pm2', 'dump.pm2'); if (exists(d)) { fs.mkdirSync(path.join(meta, 'pm2', h.account), { recursive: true }); fs.copyFileSync(d, path.join(meta, 'pm2', h.account, 'dump.pm2')); } }
  fs.writeFileSync(path.join(meta, 'panel-record.json'), JSON.stringify(recordOf(site), null, 2));
  const clp = clpRecordOf(site);
  if (clp) fs.writeFileSync(path.join(meta, 'cloudpanel-record.json'), JSON.stringify(clp, null, 2));
  if (p.claudeRc.length) fs.writeFileSync(path.join(meta, 'claude-rc-sites.conf'), p.claudeRc.join('\n') + '\n');
  const repos = await gitState(p.homes, path.join(meta, 'git'), job);
  say(job, 'configs, records and ' + repos + ' git repo state(s) collected');
  fs.writeFileSync(path.join(meta, 'manifest.json'), JSON.stringify({ domain: site.domain, host: os.hostname(), created: new Date().toISOString(),
    type: site.type, accounts: p.accounts, homes: p.homes, databases: dumps, system: p.system, excluded: p.excludes, nginxMentions: p.nginxMentions }, null, 2));

  job.phase = 'archiving';
  const base = site.domain + '-' + stamp + '.tar.zst';
  const file = path.join(STAGE_ROOT, base);
  const homes = p.homes.map((h) => q(h.path.replace(/^\/+/, ''))).join(' ');
  const excl = tarExcludes().map(q).join(' ');
  // tar exit 1 = "a file changed while being read" — normal on a live site; 2 is fatal
  const rc = await sh('tar --warning=no-file-changed --warning=no-file-ignored --ignore-failed-read ' + excl + ' -cf - -C / ' + homes + ' -C ' + q(stage) + ' _decommission'
    + ' 2>' + q(path.join(stage, 'tar.err')) + ' | zstd -q -T0 -6 -o ' + q(file) + ' -f; s=("${PIPESTATUS[@]}"); [ "${s[0]}" -le 1 ] && [ "${s[1]}" -eq 0 ]', 4 * 3600_000);
  if (rc.err || !exists(file)) throw new Error('archive failed: ' + (fs.existsSync(path.join(stage, 'tar.err')) ? fs.readFileSync(path.join(stage, 'tar.err'), 'utf8').trim().split('\n').slice(-3).join(' | ') : rc.stderr || 'tar/zstd error'));
  const test = await execP('zstd', ['-tq', file], { timeout: 3600_000 });
  if (test.err) throw new Error('archive failed its integrity test: ' + (test.stderr || '').trim());
  const size = fs.statSync(file).size;
  const sha = String((await execP('sha256sum', [file], { timeout: 3600_000 })).stdout || '').split(' ')[0];
  say(job, 'archive ' + base + ': ' + fmtBytes(size) + ', sha256 ' + sha.slice(0, 16) + '…');

  let partFiles = [file];
  if (size > PART_BYTES) {
    job.phase = 'splitting';
    const s = await execP('split', ['-b', String(PART_BYTES), '-d', '-a', '3', file, file + '.part'], { timeout: 3600_000 });
    if (s.err) throw new Error('split failed: ' + (s.stderr || '').trim());
    partFiles = fs.readdirSync(STAGE_ROOT).filter((f) => f.startsWith(base + '.part')).sort().map((f) => path.join(STAGE_ROOT, f));
    const sum = partFiles.reduce((n, f) => n + fs.statSync(f).size, 0);
    if (sum !== size) throw new Error('split produced ' + sum + ' bytes, expected ' + size);
    say(job, 'split into ' + partFiles.length + ' parts of ≤49 MB');
  }
  job.archive = { name: base, size, sha256: sha, parts: partFiles.length, sent: 0, file, partFiles };

  job.phase = 'sending to Telegram';
  const header = '🗄 Site archive before deletion\n🖥 ' + os.hostname() + '\n🌐 ' + site.domain + '\n\n'
    + 'File: ' + base + '\nSize: ' + fmtBytes(size) + (partFiles.length > 1 ? ' in ' + partFiles.length + ' parts' : '') + '\nsha256: ' + sha + '\n'
    + 'Contains: ' + p.homes.map((h) => h.path).join(', ') + (dumps.length ? '; databases ' + dumps.map((d) => d.name).join(', ') : '') + '; configs + records\n\n'
    + 'Restore:\n' + RESTORE(base, partFiles.length) + '\n\nThe site is deleted only after every part below is confirmed.';
  await tgText(header);
  const sent = [];
  for (let i = 0; i < partFiles.length; i++) {
    const f = partFiles[i];
    const cap = site.domain + ' · ' + path.basename(f) + (partFiles.length > 1 ? ' · part ' + (i + 1) + '/' + partFiles.length : '') + ' · ' + os.hostname();
    sent.push(await tgFile(f, cap));
    job.archive.sent = i + 1;
    say(job, 'Telegram confirmed ' + path.basename(f) + ' (' + fmtBytes(sent[i].size) + ')');
  }
  job.archive.telegram = sent.map((s) => ({ message_id: s.message_id, file_id: s.file_id, size: s.size }));
  await tgText('✅ ' + site.domain + ': all ' + partFiles.length + ' file(s) of ' + base + ' delivered (' + fmtBytes(size) + ', sha256 ' + sha.slice(0, 16) + '…). Deleting the site now.');
  return { base, size, sha, parts: partFiles.length };
}

/* ------------------------------------------------------------------ deletion */
async function removeEverything(site, p, opts, job) {
  const steps = [];
  const step = async (name, fn) => { try { const d = await fn(); steps.push(name + (d ? ' — ' + d : '')); say(job, '✓ ' + name + (d ? ' — ' + d : '')); } catch (e) { job.errors.push(name + ': ' + e.message); say(job, '⚠ ' + name + ': ' + e.message); } };
  const mine = p.accounts.filter((a) => !a.shared && a.exists);

  // 1. stop anything that would restart the apps while the accounts are being removed
  for (const a of mine) {
    await step('disabled pm2 boot unit / linger of ' + a.name, async () => (await runtime.deprovisionNode(a.name)).output);
    const unit = 'claude-rc@' + a.name + '.service';
    const en = String((await execP('systemctl', ['is-enabled', unit])).stdout || '').trim();
    const act = String((await execP('systemctl', ['is-active', unit])).stdout || '').trim();
    if (en === 'enabled' || act === 'active' || act === 'activating') await step('stopped ' + unit, async () => { await execP('systemctl', ['disable', '--now', unit], { timeout: 60_000 }); return null; });
  }
  if (p.claudeRc.length) await step('removed ' + p.claudeRc.length + ' line(s) from ' + CLAUDE_RC_CONF, () => {
    const names = new Set(mine.map((a) => a.name));
    const text = fs.readFileSync(CLAUDE_RC_CONF, 'utf8');
    fs.writeFileSync(CLAUDE_RC_CONF, text.split('\n').filter((l) => /^\s*#/.test(l) || !names.has(l.split('|')[0].trim())).join('\n'));
    return null;
  });
  for (const a of mine) {
    if (exists('/var/spool/cron/crontabs/' + a.name)) await step('removed crontab of ' + a.name, () => { fs.unlinkSync('/var/spool/cron/crontabs/' + a.name); return null; });
  }

  // 2. databases the panel never registered (registered ones go with deleteSite below)
  for (const d of p.databases.discovered.filter((x) => (opts.databases || []).includes(x.name))) {
    if (!IDENT.test(d.name)) { job.errors.push('skipped odd database name ' + d.name); continue; }
    await step('dropped postgres database ' + d.name, async () => {
      const r = await execP('psql', ['-U', 'postgres', '-h', PG_SOCKET, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE IF EXISTS "' + d.name + '" WITH (FORCE)'], { timeout: 120_000 });
      if (r.err) throw new Error((r.stderr || r.err.message).trim());
      return null;
    });
  }
  // owner roles nothing else needs any more
  const roles = [...new Set(p.databases.discovered.filter((x) => (opts.databases || []).includes(x.name)).map((x) => x.owner).filter((o) => o && IDENT.test(o) && o !== 'postgres'))];
  for (const role of roles) {
    const left = ((await pgDatabases()) || []).filter((d) => d.owner === role);
    if (left.length) { say(job, '· kept role ' + role + ' — still owns ' + left.map((d) => d.name).join(', ')); continue; }
    await step('dropped postgres role ' + role, async () => {
      const r = await execP('psql', ['-U', 'postgres', '-h', PG_SOCKET, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP ROLE IF EXISTS "' + role + '"'], { timeout: 60_000 });
      if (r.err) throw new Error((r.stderr || r.err.message).trim());
      return null;
    });
  }

  // 3. the site itself: registered databases, vhost, pool, certs, cron.d, logrotate, SSH/FTP users,
  //    the site user and every home (userdel -r), the panel record
  job.phase = 'deleting the site';
  const r = await create.deleteSite(site, { dropDatabases: true });
  for (const s of r.steps) { steps.push(s.name); say(job, '✓ ' + s.name + (typeof s.detail === 'string' && s.detail ? ' — ' + s.detail : '')); }
  for (const e of r.errors) { job.errors.push(e); say(job, '⚠ ' + e); }
  job.deleted = true;

  // 4. leftovers deleteSite does not know about
  for (const a of mine) {
    if (users.getent(a.name)) continue;                     // still there: deleteSite already reported why
    if (a.home && a.home.startsWith('/home/') && exists(a.home)) await step('removed leftover ' + a.home, async () => { const x = await execP('rm', ['-rf', '--one-file-system', a.home], { timeout: 30 * 60_000 }); if (x.err) throw new Error(x.stderr.trim()); return null; });
    if (a.uid != null && a.uid >= 1000) {
      const f = await execP('find', ['/tmp', '/var/tmp', '/dev/shm', '/run/user', '-xdev', '-uid', String(a.uid), '-not', '-path', STAGE_ROOT + '*', '-delete'], { timeout: 120_000 });
      if (!f.err) say(job, '✓ cleared temp files of uid ' + a.uid + ' (' + a.name + ')');
      const ps = await execP('pgrep', ['-u', String(a.uid)]);
      if (String(ps.stdout || '').trim()) { await execP('pkill', ['-KILL', '-u', String(a.uid)]); say(job, '✓ killed stray processes of uid ' + a.uid); }
    }
    for (const f of ['/etc/logrotate.d/' + a.name, '/var/mail/' + a.name]) if (exists(f)) await step('removed ' + f, () => { fs.unlinkSync(f); return null; });
  }
  for (const s of p.system.filter((x) => /Let's Encrypt/.test(x.what))) await step('removed ' + s.path, async () => { await execP('rm', ['-rf', s.path]); return null; });
  for (const s of p.system.filter((x) => exists(x.path) && !/Let's Encrypt/.test(x.what))) await step('removed leftover ' + s.path, () => { fs.rmSync(s.path, { recursive: true, force: true }); return null; });
  // the backup scope must not keep asking for a site that is gone
  await step('pruned the backup scope', () => {
    const b = require('../backups');
    const sc = b.exportSettings().scope || {};
    const goneDbs = new Set(p.databases.registered.map((d) => d.name).concat(opts.databases || []));
    const goneHomes = p.homes.map((h) => h.path).concat(mine.map((a) => a.home).filter(Boolean));
    const next = {};
    if (Array.isArray(sc.siteDomains) && sc.siteDomains.includes(site.domain)) next.siteDomains = sc.siteDomains.filter((d) => d !== site.domain);
    if (Array.isArray(sc.pgDatabases) && sc.pgDatabases.some((d) => goneDbs.has(d))) next.pgDatabases = sc.pgDatabases.filter((d) => !goneDbs.has(d));
    const extra = (sc.extraPaths || []).filter((x) => !goneHomes.some((h) => x === h || x.startsWith(h + '/')));
    if (extra.length !== (sc.extraPaths || []).length) next.extraPaths = extra;
    if (!Object.keys(next).length) return 'nothing referenced the site';
    b.setConfig({ scope: next });
    return Object.keys(next).join(', ');
  });

  // 5. CloudPanel's own record — otherwise its UI shows a ghost and the next import resurrects it
  if (opts.cloudpanel !== false && p.cloudpanel) {
    await step('removed the site from CloudPanel', () => {
      const bak = path.join('/var/backups', 'clp-db.sq3.before-delete-' + site.domain + '-' + Date.now());
      fs.copyFileSync(cloudpanel.CLP_DB, bak);
      const db = new DatabaseSync(cloudpanel.CLP_DB, { timeout: 10_000 });
      try {
        db.exec('PRAGMA foreign_keys = ON');
        const n = db.prepare('DELETE FROM site WHERE domain_name = ?').run(site.domain).changes;
        return n + ' row (+ cascaded settings/users/certs/databases); CLP DB copy kept at ' + bak;
      } finally { db.close(); }
    });
  }
  if (p.nginxMentions.length) say(job, '· still mentioned in (left untouched): ' + p.nginxMentions.join(', '));
  return steps;
}

async function runJob(site, opts, job) {
  try {
    job.phase = 'planning';
    const p = await plan(site);
    job.plan = { accounts: p.accounts.map((a) => a.name + (a.shared ? ' (shared — kept)' : '')), homes: p.homes.map((h) => h.path) };
    say(job, 'accounts: ' + job.plan.accounts.join(', ') + ' · homes: ' + job.plan.homes.join(', '));
    const a = await archiveAndSend(site, p, opts, job);
    const steps = await removeEverything(site, p, opts, job);
    job.phase = 'cleaning up';
    for (const f of job.archive.partFiles.concat(job.archive.file)) { try { fs.unlinkSync(f); } catch (_) {} }
    fs.rmSync(job.stage, { recursive: true, force: true });
    say(job, '✓ removed the local staging copy');
    job.ok = job.errors.length === 0;
    try { await tgText((job.ok ? '🗑 ' : '⚠ ') + site.domain + ' deleted from ' + os.hostname() + (job.errors.length ? ' with ' + job.errors.length + ' problem(s):\n' + job.errors.join('\n') : '') + '\n\n' + steps.length + ' step(s); archive ' + a.base + ' above is the only copy now.'); } catch (_) {}
    events.emit('site.delete', { user: opts.actor || 'system', site: site.domain, level: job.ok ? 'warn' : 'error', message: 'Site ' + site.domain + ' archived to Telegram (' + fmtBytes(a.size) + ', ' + a.parts + ' file(s)) and deleted' + (job.errors.length ? ' with ' + job.errors.length + ' problem(s)' : ''), data: { steps, errors: job.errors, archive: { name: a.base, sha256: a.sha, parts: a.parts } } });
  } catch (e) {
    job.errors.push(e.message);
    say(job, '✗ ' + e.message);
    say(job, job.deleted ? '✗ stopped part-way through deletion — re-run delete to finish the rest' : '✗ nothing was deleted' + (job.stage ? '; the staged copy is kept in ' + job.stage : ''));
    try { await tgText('✗ ' + site.domain + ' on ' + os.hostname() + ': ' + (job.deleted ? 'deletion stopped part-way' : 'archive/delivery failed, the site was NOT deleted') + '\n' + e.message); } catch (_) {}
    events.emit('site.delete', { user: opts.actor || 'system', site: site.domain, level: 'error', message: 'Deleting ' + site.domain + ' failed at "' + job.phase + '": ' + e.message + (job.deleted ? '' : ' — nothing deleted') });
  } finally {
    job.done = true; job.finishedAt = new Date().toISOString(); job.phase = job.ok ? 'done' : (job.deleted ? 'finished with problems' : 'failed');
    running = null;
    try { require('../sites').collectSites().catch(() => {}); } catch (_) {}
  }
}

function start(site, opts) {
  opts = opts || {};
  if (running) throw bad('a site deletion is already running (' + running.domain + ')', 409);
  tgCfg();
  const job = newJob(site);
  running = job;
  runJob(site, opts, job);
  return view(job);
}
function view(job) {
  if (!job) return null;
  const { partFiles, file, ...archive } = job.archive || {};
  return Object.assign({}, job, { archive: job.archive ? archive : null });
}
function get(id) { return view(jobs.get(id)); }
function current() { return running ? view(running) : null; }

module.exports = { plan, start, get, current, PART_BYTES };
