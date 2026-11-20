'use strict';
// GitHub per site (site → GitHub tab).
//
//   connect   the site's code gets its own private repo — <default owner>/<domain>, the default owner
//             being Settings → Sites & apps (roman-synergybeam), unless a repo was set by hand on the
//             site's GitHub tab (any owner/name; connecting again moves the site there) — a deploy key of its own (write access to that repo only, key in
//             ~/.ssh/github_deploy of the site user, private half in the Vault), origin → that repo.
//             A clone of someone else's project (Kuma = louislam/uptime-kuma) keeps it as "upstream".
//             Connecting to a repo that already holds other code (histories unrelated) asks how:
//             mode 'repo' = the site takes the repo's code (old code kept on a local rhc-before-* branch,
//             dependencies installed, apps restarted); mode 'server' = the server's code is committed on
//             top of the repo's history (nothing on GitHub is rewritten).
//   disconnect  the deploy key leaves the repo and syncing stops; the site's files and .git stay.
//   sync      every 15 min (auto-sync on): commit what changed on the server and push it to main.
//             If GitHub has commits the server does not, nothing is pulled behind the site's back —
//             the tab shows "N new on GitHub" and Update brings them in.
//   update    commit local changes, pull main (rebase), install dependencies when their manifest
//             changed, restart the site's apps.
//
// Never committed, enforced by a managed block in .gitignore and checked before every push: data/,
// logs, node_modules, virtualenvs, databases, keys, .env files. Git runs as the site user, never root.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execP } = require('../util');
const { settings } = require('../db');
const secrets = require('../secrets');
const store = require('./store');

const defaultOwner = () => { try { return require('./overrides').sharedDefaults().githubOwner; } catch (_) { return 'roman-synergybeam'; } };
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
// "owner/name" from anything people paste: owner/name, github.com/owner/name, http(s)://(www.)github.com/
// owner/name[.git][/][/tree/main…][?…][#…], git@github.com:owner/name.git, ssh://git@github.com/owner/name.
// null when it is not a GitHub repo.
function parseRepo(input) {
  let v = String(input || '').trim().replace(/^<|>$/g, '');
  v = v.replace(/^git\+/, '').replace(/^(?:https?|ssh|git):\/\//i, '').replace(/^[^@\/]+@(?=github\.com[:\/])/i, '');
  v = v.replace(/^(?:www\.)?github\.com[:\/]/i, '');
  v = v.split(/[?#]/)[0];
  const parts = v.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const repo = parts[0] + '/' + parts[1].replace(/\.git$/i, '');
  return REPO_RE.test(repo) ? repo : null;
}
const BRANCH = 'main';
const KEY_FILE = '.ssh/github_deploy';
const stateKey = (d) => 'site.github:' + String(d).toLowerCase();
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const docroot = (site) => path.join('/home', site.user, 'htdocs', site.domain);
const IGNORE_BLOCK = ['# --- managed by rhc-srv-mon: never commit data, secrets or build output ---',
  '/data/', 'logs/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*', '*.key', '*.pem', '.env', '.env.*', '!.env.example', '/.*.prebuild/', '# --- end sb-srv-mon ---'];
const SECRETISH = /(^|\/)(data\/|\.env($|\.(?!example$))|[^/]*\.(key|pem|db|sqlite3?)$|id_(rsa|ed25519|ecdsa)$)/;

const state = (domain) => settings.get(stateKey(domain), null);
const setState = (domain, s) => settings.set(stateKey(domain), s);

// Run git in the site's docroot as the site user, with its deploy key.
// A repo whose organisation disables deploy keys is reached over HTTPS with the token of the signed-in
// account that can see it (state.auth 'token'). The token goes to git through GIT_CONFIG_* environment
// variables (an Authorization header) — never on a command line, where ps would show it — and only
// for the length of one git command; nothing is written to the site's .git/config.
const tokenRepos = new Map();   // domain -> repo, while a connect in token mode is running
// git runs as the site user, so a checkout (or part of one) owned by anyone else breaks it: "dubious
// ownership", "insufficient permission for adding an object", "cannot lock ref". Files get the wrong
// owner on any server — copied/restored from another server (numeric uids differ), git/npm run as
// root by an admin… So before every git command: if the docroot or its .git is not the site user's,
// give the tree back (users.fixOwnership); and if git still fails with a permission error, fix the
// whole tree and retry once. Works for every site and every repo, on any server.
const PERM_RE = /dubious ownership|insufficient permission|permission denied|unable to (create|write|unlink|append)|cannot lock ref|not owned by current user|Operation not permitted/i;
const ownerFixed = new Map();   // domain -> time of the last full-tree fix (don't rescan on every retry)
async function healOwnership(site, why) {
  const users = require('./users'), dir = docroot(site);
  if (!fs.existsSync(dir)) return null;
  const r = await users.fixOwnership(site.user, dir);
  ownerFixed.set(site.domain, Date.now());
  if (r.fixed) {
    try { require('../events').emit('site.ownership', { site: site.domain, target: site.domain, level: 'warn', message: 'Gave ' + r.fixed + ' file(s) in ' + dir + ' back to ' + site.user + ' (' + why + ')' }); } catch (_) {}
  }
  return r;
}
async function git(site, args, opts) {
  const users = require('./users');
  if (!users.ownedBy(site.user, docroot(site))) await healOwnership(site, 'git runs as ' + site.user);
  let r = await gitRaw(site, args, opts);
  if (r.err && PERM_RE.test(r.stderr || '') && Date.now() - (ownerFixed.get(site.domain) || 0) > 60_000) {
    const h = await healOwnership(site, 'git failed: ' + (r.stderr || '').trim().split('\n').pop().slice(0, 160)).catch(() => null);
    if (h && h.fixed) r = await gitRaw(site, args, opts);
  }
  return r;
}
async function gitRaw(site, args, opts) {
  const keyPath = path.join('/home', site.user, KEY_FILE);
  const st = state(site.domain);
  const viaToken = tokenRepos.get(site.domain) || (st && st.auth === 'token' ? st.repo : null);
  const env = Object.assign({}, process.env), keep = [];
  if (viaToken) {
    const tok = (await tokenForRepo(viaToken, { push: true })) || (await tokenForRepo(viaToken));
    if (tok) {
      Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: 'AUTHORIZATION: basic ' + Buffer.from('x-access-token:' + tok).toString('base64') });
      keep.push('--preserve-env=GIT_CONFIG_COUNT,GIT_CONFIG_KEY_0,GIT_CONFIG_VALUE_0');
    }
  }
  return execP('sudo', ['-n', '-H', ...keep, '-u', site.user, 'env', 'GIT_SSH_COMMAND=ssh -i ' + keyPath + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes',
    'GIT_TERMINAL_PROMPT=0', 'git', '-C', docroot(site), ...args], Object.assign({ timeout: 5 * 60_000, env }, opts || {}));
}
async function gitOk(site, args, what) {
  const r = await git(site, args);
  if (r.err) throw bad(what + ' failed', 424, ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-6).join('\n'));
  return r.stdout.trim();
}
// The server can be signed in to several GitHub accounts (gh auth login). A repo owned by one of
// them is handled with that account's token (a personal account can only create repos for itself);
// anything else (an organisation) with the active account.
let accCache = null;
async function accounts() {
  if (accCache && Date.now() - accCache.at < 60_000) return accCache.list;
  const r = await execP('gh', ['auth', 'status'], { timeout: 30_000, env: Object.assign({}, process.env, { HOME: '/root' }) });
  const list = [...((r.stdout || '') + (r.stderr || '')).matchAll(/account (\S+)/g)].map((x) => x[1]);
  accCache = { at: Date.now(), list };
  return list;
}
async function tokenFor(owner) {
  const who = (await accounts()).find((a) => a.toLowerCase() === String(owner || '').toLowerCase());
  if (!who) return null;
  const r = await execP('gh', ['auth', 'token', '--user', who], { timeout: 30_000, env: Object.assign({}, process.env, { HOME: '/root' }) });
  return r.err ? null : r.stdout.trim();
}
// Which signed-in account can see a repo: the one named like its owner first, then every other one
// (an org repo, or a repo shared with one of them). Remembered per repo; null = none of them can.
const repoAcct = new Map();
// A connection made after a browser sign-in is pinned to the account approved there (state.account):
// everything for that repo uses that account only. Connections made before pinning: any account.
let pinCache = null;
function pinnedAccount(repo) {
  if (!pinCache || Date.now() - pinCache.at > 60_000) {
    const m = new Map();
    for (const st of Object.values(settings.list('site.github:'))) if (st && st.repo && st.account) m.set(String(st.repo).toLowerCase(), st.account);
    pinCache = { at: Date.now(), m };
  }
  return pinCache.m.get(String(repo || '').toLowerCase()) || null;
}
const connectPins = new Map();   // repo (lower) -> account, while a connect for it is running
const pinFor = (repo) => connectPins.get(String(repo || '').toLowerCase()) || pinnedAccount(repo);
// opts.push: only an account with write access (git pushing over HTTPS with its token);
// opts.admin: only a repo admin (managing deploy keys).
async function tokenForRepo(repo, opts) {
  const push = opts && opts.admin ? 'admin' : opts && opts.push ? 'push' : '';
  const pin = (opts && opts.account) || pinFor(repo);
  const accs = pin ? (await accounts()).filter((a) => a.toLowerCase() === String(pin).toLowerCase()) : await accounts();
  const key = String(repo).toLowerCase() + (push ? '#' + push : '') + (pin ? '@' + pin.toLowerCase() : ''), owner = ownerOf(repo).toLowerCase();
  const known = repoAcct.get(key);
  if (known && accs.includes(known)) { const t = await tokenFor(known); if (t) return t; }
  for (const a of [...accs].sort((x, y) => (y.toLowerCase() === owner) - (x.toLowerCase() === owner))) {
    const t = await tokenFor(a); if (!t) continue;
    const v = await execP('gh', ['api', 'repos/' + repo, '--jq', push ? '.permissions.' + push : '.full_name'], { timeout: 30_000, env: Object.assign({}, process.env, { HOME: '/root', GH_TOKEN: t }) });
    if (!v.err && (!push || v.stdout.trim() === 'true')) { repoAcct.set(key, a); return t; }
  }
  return null;
}
function resetAccounts() { accCache = null; repoAcct.clear(); pinCache = null; }
// target: "owner/name" (→ the account that can see that repo, else the owner's) or an owner name.
// opts.admin: prefer an account that is an admin of the repo (deploy keys).
async function gh(args, target, opts) {
  const t = String(target || '');
  const pin = t.includes('/') ? pinFor(t) : null;
  const tok = !t ? null : pin ? await tokenFor(pin)
    : t.includes('/') ? (opts && opts.admin && (await tokenForRepo(t, { admin: true }))) || (await tokenForRepo(t)) || (await tokenFor(ownerOf(t))) : await tokenFor(t);
  if (pin && !tok) return { err: new Error('not signed in'), stdout: '', stderr: 'the GitHub account ' + pin + ' this site is connected with is no longer signed in on this server (HTTP 401)' };
  return execP('gh', args, { timeout: 60_000, env: Object.assign({}, process.env, { HOME: '/root' }, tok ? { GH_TOKEN: tok } : {}) });
}
const ownerOf = (repo) => String(repo).split('/')[0];

function ensureIgnore(site) {
  const f = path.join(docroot(site), '.gitignore');
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) {}
  // Blocks written before the rename still end with the old marker: find either, so they are replaced, not doubled.
  const endMark = [IGNORE_BLOCK[IGNORE_BLOCK.length - 1], '# --- end rhc-srv-mon ---'].find((m) => txt.includes(m)) || IGNORE_BLOCK[IGNORE_BLOCK.length - 1];
  const start = txt.indexOf(IGNORE_BLOCK[0]), end = txt.indexOf(endMark);
  const block = IGNORE_BLOCK.join('\n');
  const next = start >= 0 && end > start ? txt.slice(0, start) + block + txt.slice(end + endMark.length)
    : (txt && !txt.endsWith('\n') ? txt + '\n' : txt) + (txt ? '\n' : '') + block + '\n';
  if (next !== txt) {
    fs.writeFileSync(f, next);
    try { const st = fs.statSync(docroot(site)); fs.chownSync(f, st.uid, st.gid); } catch (_) {}
  }
}
// Files about to be committed (new or changed, not ignored) that look like data or secrets → refuse.
// Files already in git history (e.g. Kuma's upstream template db/kuma.db) are not new exposure.
async function secretCheck(site) {
  const lines = (await git(site, ['status', '--porcelain', '--untracked-files=all'])).stdout.split('\n').filter(Boolean);
  const files = lines.filter((l) => !/^ ?D/.test(l)).map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''));
  const hits = files.filter((f) => SECRETISH.test(f));
  if (hits.length) throw bad('refusing to push: files that look like data or secrets would be committed', 409, hits.slice(0, 20).join('\n') + '\n\nAdd them to .gitignore (or move them out of the site folder), then sync again.');
}

async function ensureDeployKey(site, repo, retried) {
  const ent = require('./users').getent(site.user);
  const keyPath = path.join(ent.home, KEY_FILE);
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const r = await execP('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'deploy ' + site.domain + ' @' + os.hostname(), '-f', keyPath], { timeout: 30_000 });
    if (r.err) throw bad('ssh-keygen failed', 500, r.stderr);
    for (const f of [keyPath, keyPath + '.pub', path.dirname(keyPath)]) fs.chownSync(f, ent.uid, ent.gid);
    fs.chmodSync(keyPath, 0o600);
  }
  const pub = fs.readFileSync(keyPath + '.pub', 'utf8').trim();
  const keys = await gh(['api', 'repos/' + repo + '/keys'], repo, { admin: true });
  if (keys.err) {
    // Deploy keys are an admin-only API: GitHub answers 404 (or 403) to an account that can see/push the
    // repo but is not its admin (a collaborator on someone else's repo). Connect then falls back to HTTPS
    // with that account's token, like for organisations that disable deploy keys.
    if (/HTTP 40[34]/.test(keys.stderr || '')) throw Object.assign(bad('not an admin of ' + repo + ' (deploy keys need admin)', 424, keys.stderr), { code: 'deploy-keys-no-admin' });
    throw bad('cannot read the deploy keys of ' + repo, 424, keys.stderr);
  }
  const have = JSON.parse(keys.stdout || '[]').find((k) => String(k.key).split(' ').slice(0, 2).join(' ') === pub.split(' ').slice(0, 2).join(' '));
  if (have) return have.id;
  const add = await gh(['api', '-X', 'POST', 'repos/' + repo + '/keys', '-f', 'title=' + os.hostname() + ' · ' + site.domain, '-f', 'key=' + pub, '-F', 'read_only=false'], repo, { admin: true });
  if (add.err) {
    // gh puts the API's JSON body on stdout and only "Validation Failed (HTTP 422)" on stderr — the actual reason
    // (e.g. "key is already in use": GitHub allows one deploy key on ONE repo) is in errors[].message
    let why = ''; try { const j = JSON.parse(add.stdout || '{}'); why = (j.errors || []).map((e) => e.message || e.code).filter(Boolean).join('; ') || j.message || ''; } catch (_) {}
    // Key already registered elsewhere on GitHub (another repo or a user's SSH keys): set it aside and
    // generate a fresh one for this site, once. The old pair stays on disk as <key>.in-use-<ts>.
    if (!retried && (/already in use/i.test(why) || (!why && /HTTP 422/.test(add.stderr || '')))) {
      const aside = keyPath + '.in-use-' + Date.now();
      fs.renameSync(keyPath, aside); fs.renameSync(keyPath + '.pub', aside + '.pub');
      return ensureDeployKey(site, repo, true);
    }
    if (/deploy keys are disabled/i.test(why)) throw Object.assign(bad('deploy keys are disabled for ' + repo, 424, why), { code: 'deploy-keys-disabled' });
    throw bad('could not add the deploy key to ' + repo + (why ? ': ' + why : ''), 424,
      (add.stderr || '').trim() + (/already in use/i.test(why) ? '\nThis site\'s key ' + keyPath + '.pub is already a deploy key on another repository (or a user\'s SSH keys). Remove it there, or delete the key file so a new one is generated.' : ''));
  }
  return JSON.parse(add.stdout).id;
}

// The repo's default branch and its head commit, or null when the repo does not exist or is empty.
async function remoteHead(repo) {
  const v = await gh(['api', 'repos/' + repo, '--jq', '.default_branch'], repo);
  if (v.err) return null;
  const branch = v.stdout.trim() || BRANCH;
  const c = await gh(['api', 'repos/' + repo + '/commits/' + branch, '--jq', '.sha'], repo);
  return c.err || !c.stdout.trim() ? null : { branch, sha: c.stdout.trim() };
}

// Dependencies of the files that changed (all of them after a switch), then restart the site's apps.
// The project's own package manager, from its lock file. pnpm / yarn are rarely installed system-wide:
// they run through corepack (at the version package.json's "packageManager" names) or npx.
// ci* keep the lock file as it is; install* is the fallback when the lock no longer matches.
function pmFor(dir, pkg) {
  const has = (f) => fs.existsSync(path.join(dir, f));
  const want = /^(pnpm|yarn)@([\w.+-]+)/.exec(String((pkg && pkg.packageManager) || ''));
  const COREPACK = '/usr/lib/node_modules/corepack/dist/corepack.js';
  const via = (tool, ver) => '$(command -v ' + tool + ' >/dev/null 2>&1 && echo ' + tool + ' || { [ -f ' + COREPACK + ' ] && echo "env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 node ' + COREPACK + ' ' + tool + '" || echo "npx --yes ' + tool + '@' + ver + '"; })';
  if (has('pnpm-lock.yaml')) {
    const p = via('pnpm', want && want[1] === 'pnpm' ? want[2] : 'latest');
    return { name: 'pnpm', ci: p + ' install --frozen-lockfile', ciProd: p + ' install --frozen-lockfile --prod', install: p + ' install --no-frozen-lockfile', installProd: p + ' install --no-frozen-lockfile --prod', run: p + ' run' };
  }
  if (has('yarn.lock')) {
    const berry = want && want[1] === 'yarn' && !/^1\./.test(want[2]);
    const y = via('yarn', want && want[1] === 'yarn' ? want[2] : '1');
    return berry ? { name: 'yarn', ci: y + ' install --immutable', ciProd: y + ' install --immutable', install: y + ' install', installProd: y + ' install', run: y + ' run' }
      : { name: 'yarn', ci: y + ' install --frozen-lockfile', ciProd: y + ' install --frozen-lockfile --production', install: y + ' install', installProd: y + ' install --production', run: y + ' run' };
  }
  if ((has('bun.lock') || has('bun.lockb')) && fs.existsSync('/usr/local/bin/bun')) return { name: 'bun', ci: '/usr/local/bin/bun install --frozen-lockfile', ciProd: '/usr/local/bin/bun install --frozen-lockfile --production', install: '/usr/local/bin/bun install', installProd: '/usr/local/bin/bun install --production', run: '/usr/local/bin/bun run' };
  return has('package-lock.json') ? { name: 'npm', ci: 'npm ci', ciProd: 'npm ci --omit=dev', install: 'npm install', installProd: 'npm install --omit=dev', run: 'npm run' }
    : { name: 'npm', ci: 'npm install', ciProd: 'npm install --omit=dev', install: null, installProd: null, run: 'npm run' };
}
async function installAndRestart(site, files, say, opts) {
  opts = opts || {};
  const dir = docroot(site);
  const asUser = (cmd, t) => execP('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', 'cd ' + JSON.stringify(dir) + ' && ' + cmd + ' 2>&1'], { timeout: t || 15 * 60_000 });
  const tail = (r) => ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-12).join('\n');
  if (files.includes('requirements.txt') && fs.existsSync(path.join(dir, '.venv'))) { say('installing Python requirements…'); const r = await asUser('.venv/bin/pip install -q -r requirements.txt'); say(r.err ? 'pip install FAILED' : 'installed Python requirements', r.err ? tail(r) : ''); }
  let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) {}
  // An app with a build step (Next.js, Vite, …) needs its dev dependencies and a fresh build before a
  // restart; restarting onto unbuilt code is what turns a pull into a crash loop. A failed build
  // leaves the running app alone (it still serves the previous build) and stops here.
  const build = !!(pkg && pkg.scripts && pkg.scripts.build);
  if (pkg) {
    const pmx = pmFor(dir, pkg);
    const depsChanged = files.some((f) => f === 'package.json' || !!LOCKS[path.basename(f)]) || !fs.existsSync(path.join(dir, 'node_modules'));
    if (depsChanged) {
      say('installing dependencies with ' + pmx.name + (build ? ' (including dev, for the build)' : '') + ' — can take a few minutes…');
      let r = await asUser(build ? pmx.ci : pmx.ciProd);
      if (r.err && pmx.install) { say(pmx.name + ': the lock file does not match package.json — installing without it', tail(r).split('\n').slice(-2).join(' ')); r = await asUser(build ? pmx.install : pmx.installProd); }
      if (r.err) { say(pmx.name + ' install FAILED — the app was not restarted', tail(r)); throw bad(pmx.name + ' install failed — the app was not restarted', 424, tail(r)); }
      say('installed dependencies (' + pmx.name + ')');
    }
    if (build && files.length) {
      say('building (' + pmx.name + ' run build) — can take a few minutes…');
      const r = await asUser('NODE_ENV=production ' + pmx.run + ' build', 20 * 60_000);
      if (r.err) { say('build FAILED — the app was not restarted', tail(r)); throw bad(pmx.name + ' run build failed — the app was not restarted', 424, tail(r)); }
      say('built', tail(r).split('\n').slice(-3).join(' · '));
    }
  }
  say('restarting the site\'s apps…');
  if (opts.ecosystem && fs.existsSync(path.join(dir, 'ecosystem.config.js'))) {
    await fitEcosystem(site, dir, say);
    // the process definition changed: pm2 must read it again. restart/startOrRestart only refresh env —
    // an existing process keeps its old script/args (e.g. the removed placeholder app.js → crash loop),
    // so drop the apps this file defines and start them fresh from it.
    const r = await asUser('(pm2 delete ecosystem.config.js >/dev/null 2>&1 || true) && pm2 start ecosystem.config.js --update-env && pm2 save --force', 120_000);
    say(r.err ? 'pm2 could not start the app' : 'started the app from ecosystem.config.js', r.err ? tail(r) : '');
    if (r.err) throw bad('pm2 could not start the app from ecosystem.config.js', 424, tail(r));
  } else {
    const a = await require('./procs').act(site, 'restart', {});
    say(a.ok ? 'restarted the site\'s apps' : 'restart reported a problem', (a.results || []).map((x) => (x.command || '') + ': ' + (x.ok ? 'ok' : String(x.output || 'failed').slice(-300))).join('\n'));
  }
  await checkUp(site, say, asUser);
}

// A repo's ecosystem.config.js may come from another server or an earlier copy of this site (other
// user, port, folder). With one app in it, point it at this site: name, cwd, port, log files —
// written as the site user. Files with several apps are left to their author.
async function fitEcosystem(site, dir, say) {
  const f = path.join(dir, 'ecosystem.config.js');
  let s; try { s = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  if ((s.match(/\bname\s*:/g) || []).length !== 1) return;
  const port = site.nodejs && site.nodejs.port, logs = '/home/' + site.user + '/logs/nodejs/';
  let n = s.replace(/(\bname\s*:\s*)(["'`])[^"'`]*\2/, (_, a) => a + JSON.stringify(site.domain))
    .replace(/(\bcwd\s*:\s*)(["'`])[^"'`]*\2/, (_, a) => a + JSON.stringify(dir))
    .replace(/(\b(?:out_file|error_file|log_file)\s*:\s*)(["'`])\/home\/[^"'`]*\/([^\/"'`]+)\2/g, (_, a, q, file) => a + JSON.stringify(logs + file));
  if (port) n = n.replace(/(\bPORT\s*:\s*["']?)\d+/g, '$1' + port).replace(/((?:^|[\s"'])(?:-p|--port)[\s=])\d+/g, '$1' + port);
  if (n === s) return;
  await require('./files').op(site, { op: 'write', path: '/htdocs/' + site.domain + '/ecosystem.config.js', content: n });
  say('fitted ecosystem.config.js to this site', 'name ' + site.domain + (port ? ', port ' + port : '') + ', cwd and logs under /home/' + site.user);
}

// "pm2 says online" is not "the site answers": a crash-looping app shows online between restarts.
// Wait for the app's port to accept connections and say plainly when it does not, with the error log.
function portOpen(port) {
  return new Promise((resolve) => {
    const sock = require('net').connect({ host: '127.0.0.1', port: Number(port) });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(1500, () => done(false)); sock.once('connect', () => done(true)); sock.once('error', () => done(false));
  });
}
async function checkUp(site, say, asUser) {
  const port = site.nodejs && site.nodejs.port;
  if (!port) return true;
  for (const until = Date.now() + 60_000; Date.now() < until;) {
    if (await portOpen(port)) { say('the app answers on port ' + port); return true; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  const log = await asUser('tail -n 15 ~/logs/nodejs/error*.log 2>/dev/null | grep -v "^==> .* <==$" | tail -n 15', 15_000);
  say('NOT ONLINE: nothing listens on port ' + port + ' a minute after the restart', ((log.stdout || '') + (log.stderr || '')).trim());
  return false;
}

// ------------------------------------------------------------------ connect
// opts.repo: "owner/name" set by hand on the GitHub tab; otherwise <default owner>/<domain>.
// opts.mode: 'repo' | 'server' — only needed when that repo already holds code the site does not have.
// opts.account: the GitHub account approved in the browser just before (required by the API — see
// ghlogin.js); everything for this repo then uses that account only, and the site stays pinned to it.
async function connect(site, say, opts) {
  opts = opts || {};
  if (!opts.account) throw Object.assign(bad('sign in with GitHub first — every connection is approved in the browser', 428), { code: 'gh-login-required' });
  const pins = [];
  try { return await connectAs(site, say, opts, (repo) => { const k = String(repo).toLowerCase(); connectPins.set(k, opts.account); pins.push(k); }); }
  finally { for (const k of pins) connectPins.delete(k); pinCache = null; }
}
async function connectAs(site, say, opts, pin) {
  say = say || (() => {});
  const dir = docroot(site);
  if (!fs.existsSync(dir)) throw bad('no docroot ' + dir, 404);
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  // git runs as the site user; files owned by anyone else (e.g. copied from another server) break it.
  if (!require('./users').ownedBy(site.user, dir)) {
    say('fixing ownership: ' + dir + ' is not owned by ' + site.user + ' (git runs as ' + site.user + ')…');
    const h = await healOwnership(site, 'GitHub connect');
    say('ownership fixed', h.fixed + ' file(s) given to ' + site.user + (h.remaining ? ' — ' + h.remaining + ' shared hard-linked file(s) left alone' : ''));
  }
  let origin = '';
  if (hasGit) origin = (await git(site, ['remote', 'get-url', 'origin'])).stdout.trim();
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(origin);
  // A checkout sitting exactly on a release tag (e.g. Uptime Kuma 2.5.9) is what module auto-update
  // recognises as "pinned release — leave its packages alone". Our commits move HEAD off the tag, so
  // make the opt-out explicit first; otherwise the nightly auto-update upgrades it to majors it was
  // never built for (2026-11-07: Kuma got express 5 and crashed).
  if (hasGit && !(await git(site, ['describe', '--tags', '--exact-match', 'HEAD'])).err) {
    const marker = path.join(dir, '.rhc-no-module-updates');
    if (!fs.existsSync(marker)) {
      const tag = (await git(site, ['describe', '--tags', '--exact-match', 'HEAD'])).stdout.trim();
      fs.writeFileSync(marker, 'Release ' + tag + ' of ' + (m ? m[1] + '/' + m[2] : 'an upstream project') + ': package.json is pinned to what that release was tested with.\nsb-srv-mon module auto-update skips folders with this file — update by moving to the next release.\n');
      try { const st = fs.statSync(dir); fs.chownSync(marker, st.uid, st.gid); } catch (_) {}
      say('release ' + tag + ': excluded from module auto-update', '.rhc-no-module-updates');
    }
  }
  const prev = state(site.domain);
  const manual = opts.repo ? parseRepo(opts.repo) : (prev && prev.manual ? prev.repo : null);
  if (opts.repo && !manual) throw bad('"' + String(opts.repo).trim().slice(0, 200) + '" is not a GitHub repository — use owner/name or its github.com link');
  const def = defaultOwner();
  const repo = manual || (m && m[1].toLowerCase() === def.toLowerCase() ? def + '/' + m[2] : def + '/' + site.domain);
  // A repo with code the site does not have (another project, or a README GitHub made) cannot just
  // be pushed to: ask which code wins before changing anything.
  pin(repo);
  if (!(await accounts()).some((a) => a.toLowerCase() === opts.account.toLowerCase())) { resetAccounts(); if (!(await accounts()).some((a) => a.toLowerCase() === opts.account.toLowerCase())) throw Object.assign(bad('the GitHub account ' + opts.account + ' is not signed in on this server any more', 424), { code: 'gh-no-access' }); }
  say('GitHub account ' + opts.account + ' (approved in the browser)');
  say('checking ' + repo + ' on GitHub…');
  const head = await remoteHead(repo);
  say(head ? repo + ' exists — ' + head.branch + ' at ' + head.sha.slice(0, 7) : repo + ' is new or empty (or not visible to ' + opts.account + ')');
  let related = !head || (hasGit && !(await git(site, ['cat-file', '-e', head.sha + '^{commit}'])).err);
  if (!related && hasGit) {   // or GitHub is just ahead: it already has the server's current commit
    const local = (await git(site, ['rev-parse', '-q', '--verify', 'HEAD'])).stdout.trim();
    if (local) related = !(await gh(['api', 'repos/' + repo + '/commits/' + local, '--jq', '.sha'], repo)).err;
  }
  const mode = related ? null : opts.mode;
  if (!related && mode !== 'repo' && mode !== 'server')
    throw Object.assign(bad(repo + ' already has code that is not this site\'s', 409, 'Its ' + head.branch + ' is at ' + head.sha.slice(0, 7) + '. Choose: use the repo\'s code on the site (the current code stays on a local backup branch), or commit the server\'s code on top of the repo\'s history.'), { code: 'repo-has-code', repo, branch: head.branch });
  // repo
  const view = await gh(['repo', 'view', repo, '--json', 'name'], repo);
  if (view.err) {
    const c = await gh(['repo', 'create', repo, '--private', '--description', site.domain + ' — served by ' + os.hostname() + ' (sb-srv-mon)'], repo);
    if (c.err) {
      throw Object.assign(bad('the GitHub account ' + opts.account + ' cannot see ' + repo, 424,
        'If ' + repo + ' exists, sign in with a GitHub account that has access to it, then connect again. If it does not exist, sign in with the account that may create it under ' + ownerOf(repo) + '.\n\nGitHub said: ' + String(c.stderr || '').trim()), { code: 'gh-no-access' });
    }
    say('created the private repo ' + repo);
  } else say('using the repo ' + repo);
  let keyId = null, auth = 'key';
  try {
    keyId = await ensureDeployKey(site, repo);
    say('deploy key with write access to ' + repo + ' only', '~' + site.user + '/' + KEY_FILE);
  } catch (e) {
    if (e.code !== 'deploy-keys-disabled' && e.code !== 'deploy-keys-no-admin') throw e;
    // organisation policy, or the account is a collaborator, not an admin: use the signed-in account
    // that can push to the repo, over HTTPS
    const why = e.code === 'deploy-keys-disabled' ? 'deploy keys are disabled for ' + repo + ' (organisation policy)' : opts.account + ' is not an admin of ' + repo + ' (deploy keys need admin)';
    if (!(await tokenForRepo(repo, { push: true }))) throw Object.assign(bad(why + ', and ' + opts.account + ' has no write access to it either', 424, 'Give ' + opts.account + ' write access to ' + repo + ' (collaborator or team), or sign in with an account that has it, then connect again.'), { code: 'gh-no-access' });
    auth = 'token'; tokenRepos.set(site.domain, repo);
    say(why, 'using ' + opts.account + ' (write access) over HTTPS');
  }
  try {
  // moving from another repo: its deploy key goes, so the site can no longer write there
  if (prev && prev.repo && prev.repo.toLowerCase() !== repo.toLowerCase() && prev.keyId) {
    const d = await gh(['api', '-X', 'DELETE', 'repos/' + prev.repo + '/keys/' + prev.keyId], prev.repo, { admin: true });
    say(d.err ? 'could not remove the deploy key from ' + prev.repo + ' — remove it on GitHub' : 'removed the site\'s deploy key from ' + prev.repo);
  }
  // local repo
  if (!hasGit) { await gitOk(site, ['init', '-q', '-b', BRANCH], 'git init'); say('initialised git in ' + dir); }
  // the old origin is someone else's project → keep it as "upstream"; our own previous repo just gets replaced
  const ownPrev = m && prev && prev.repo && (m[1] + '/' + m[2]).toLowerCase() === prev.repo.toLowerCase();
  if (m && !ownPrev && (m[1] + '/' + m[2]).toLowerCase() !== repo.toLowerCase()) {
    const up = await git(site, ['remote', 'get-url', 'upstream']);
    if (up.err) { await gitOk(site, ['remote', 'rename', 'origin', 'upstream'], 'renaming origin'); say('kept ' + m[1] + '/' + m[2] + ' as "upstream"'); }
    else await git(site, ['remote', 'remove', 'origin']);
  }
  const sshUrl = auth === 'token' ? 'https://github.com/' + repo + '.git' : 'git@github.com:' + repo + '.git';
  if ((await git(site, ['remote', 'get-url', 'origin'])).err) await gitOk(site, ['remote', 'add', 'origin', sshUrl], 'adding origin');
  else await gitOk(site, ['remote', 'set-url', 'origin', sshUrl], 'setting origin');
  await gitOk(site, ['config', 'user.name', os.hostname() + ' auto-sync'], 'git config');
  await gitOk(site, ['config', 'user.email', 'sys@synergybeam.com'], 'git config');
  await gitOk(site, ['config', 'core.sshCommand', 'ssh -i ~/' + KEY_FILE + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'], 'git config');
  // on main (a detached release checkout becomes main at that commit)
  const cur = (await git(site, ['branch', '--show-current'])).stdout.trim();
  if (cur !== BRANCH) { await gitOk(site, ['checkout', '-q', '-B', BRANCH], 'checking out ' + BRANCH); say('working branch ' + BRANCH); }
  ensureIgnore(site);
  // A shallow clone (e.g. a release checkout of an upstream project) cannot be pushed to a new repo:
  // its parent commits are missing. Push it as one snapshot commit of exactly the current code,
  // recording where it came from; "upstream" stays for following new releases.
  if ((await git(site, ['rev-parse', '--is-shallow-repository'])).stdout.trim() === 'true' && !(await git(site, ['rev-parse', '--verify', '-q', 'HEAD^'])).err) {
    const remote = (await gitOk(site, ['ls-remote', '--exit-code', 'origin'], 'checking the repo').catch(() => ''));
    if (!remote) {
      const base = await gitOk(site, ['log', '-1', '--format=%h %s'], 'log');
      const upUrl = (await git(site, ['remote', 'get-url', 'upstream'])).stdout.trim();
      const um = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(upUrl);
      await gitOk(site, ['add', '-A'], 'git add');
      await gitOk(site, ['checkout', '-q', '--orphan', 'rhc-snapshot'], 'snapshot branch');
      await gitOk(site, ['commit', '-q', '-m', 'Snapshot of ' + (um ? um[1] + '/' + um[2] : 'the deployed code') + ' at ' + base + ' as deployed on ' + os.hostname()], 'snapshot commit');
      await gitOk(site, ['branch', '-M', 'rhc-snapshot', BRANCH], 'renaming to ' + BRANCH);
      say('shallow clone: pushed as one snapshot commit', 'based on ' + base);
    }
  }
  let branch = BRANCH, switched = null, ecoChanged = false;
  if (mode) {
    say('downloading ' + repo + ' ' + head.branch + '…');
    const f = await git(site, ['fetch', '-q', 'origin', head.branch]);
    if (f.err) throw bad('could not fetch ' + repo, 424, (f.stderr || '').trim());
    if (mode === 'repo') {
      // keep the current code on a local branch, then take the repo's branch as it is
      await gitOk(site, ['add', '-A'], 'git add');
      if ((await git(site, ['status', '--porcelain'])).stdout.trim()) await gitOk(site, ['commit', '-q', '-m', 'Site code before switching to ' + repo], 'git commit');
      const backup = 'rhc-before-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
      if (!(await git(site, ['rev-parse', '--verify', '-q', 'HEAD'])).err) { await gitOk(site, ['branch', '-f', backup], 'backup branch'); say('previous code kept on the local branch ' + backup); }
      await gitOk(site, ['checkout', '-q', '-f', '-B', head.branch, 'origin/' + head.branch], 'checking out ' + repo);
      branch = head.branch;
      // the pm2 config is what runs the site: keep the panel's (port, logs, name) if the repo brings none —
      // pointed at the repo's own start script, since the placeholder app.js left with the old code
      if (!fs.existsSync(path.join(dir, 'ecosystem.config.js')) && !(await git(site, ['cat-file', '-e', backup + ':ecosystem.config.js'])).err) {
        let eco = (await git(site, ['show', backup + ':ecosystem.config.js'])).stdout;
        let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) {}
        if (!fs.existsSync(path.join(dir, 'app.js')) && pkg && pkg.scripts && pkg.scripts.start) eco = eco.replace(/script:\s*'app\.js',/, "script: 'npm',\n    args: 'start',");
        fs.writeFileSync(path.join(dir, 'ecosystem.config.js'), eco);
        try { const o = fs.statSync(dir); fs.chownSync(path.join(dir, 'ecosystem.config.js'), o.uid, o.gid); } catch (_) {}
        say('kept the site\'s ecosystem.config.js (the repo has none)' + (/script: 'npm'/.test(eco) ? ' — now runs `npm start` on the same port' : ''), 'committed to the repo on the next sync');
        ecoChanged = true;
      }
      say('the site now runs ' + repo + ' ' + head.branch + ' @ ' + head.sha.slice(0, 7), 'files only in the old code (and ignored data) were left in place if untracked');
      ensureIgnore(site);
      switched = (await gitOk(site, ['ls-files'], 'ls-files')).split('\n').filter(Boolean);
    } else {
      // the server's code must be a commit before it can go on top (a site without git has none yet)
      await secretCheck(site);
      await gitOk(site, ['add', '-A'], 'git add');
      if ((await git(site, ['status', '--porcelain'])).stdout.trim()) await gitOk(site, ['commit', '-q', '-m', 'Server code of ' + site.domain + ' on ' + os.hostname()], 'git commit');
      await gitOk(site, ['merge', '-q', '--allow-unrelated-histories', '-s', 'ours', '-m', 'Server code of ' + site.domain + ' on top of ' + repo, 'origin/' + head.branch], 'combining histories');
      if (head.branch !== BRANCH) { await gitOk(site, ['branch', '-M', head.branch], 'renaming to ' + head.branch); branch = head.branch; }
      say('server code committed on top of ' + repo + ' ' + head.branch + ' (its history kept, nothing rewritten)');
    }
  }
  setState(site.domain, { repo, manual: !!manual, branch, auth, account: opts.account, autoSync: prev ? prev.autoSync !== false : true, keyId, connected: new Date().toISOString(), last: null });
  say('first sync: committing the site\'s files and pushing to ' + repo + '…');
  const r = await sync(site, { first: true });
  if (r.behind) {
    // GitHub already has commits the server does not: combine right away (the server's commits go on
    // top of GitHub's, then install/build/restart if files changed, then push) — what Sync does.
    say('GitHub has ' + r.behind + ' commit(s) the server does not' + (r.ahead ? ', the server ' + r.ahead + ' GitHub does not' : '') + ' — combining them…');
    try { const u = await update(site, say); say(u.changed ? 'combined and pushed — server and GitHub are on the same code' : 'nothing to combine'); }
    catch (e) { say('could not combine them automatically: ' + e.message, e.detail ? String(e.detail).split('\n').slice(-4).join('\n') : ''); }
  } else say((r.ok ? '' : 'sync problem: ') + r.summary);
  if (switched) await installAndRestart(site, switched, say, { ecosystem: true });
  // HCL AppScan CodeSweep is on by default for every connected site (pull-request scan, lib/sites/codesweep.js)
  try {
    const cs = require('./codesweep'), b = await cs.overview().then((o) => o.sites.find((x) => x.domain === site.domain));
    if (!b || !b.enabled) { const r = await cs.enable(site); say('switched on HCL AppScan CodeSweep', r.push && r.push.summary); }
  } catch (e) { say('CodeSweep: not switched on', e.message); }
  return status(site);
  } finally { tokenRepos.delete(site.domain); }
}

// Stop syncing: the deploy key leaves the repo and origin is dropped. Files and git history stay.
async function disconnect(site, say) {
  say = say || (() => {});
  const st = state(site.domain);
  if (!st) throw bad(site.domain + ' is not connected to GitHub', 409);
  if (st.keyId) {
    const d = await gh(['api', '-X', 'DELETE', 'repos/' + st.repo + '/keys/' + st.keyId], st.repo, { admin: true });
    say(d.err ? 'could not remove the deploy key from ' + st.repo + ' — remove it on GitHub' : 'removed the site\'s deploy key from ' + st.repo);
  }
  const o = await git(site, ['remote', 'get-url', 'origin']);
  if (!o.err && o.stdout.toLowerCase().includes(st.repo.toLowerCase())) { await git(site, ['remote', 'remove', 'origin']); say('removed origin (' + st.repo + ') from the site\'s git'); }
  settings.del(stateKey(site.domain));
  say('disconnected — files and local git history kept');
  return status(site);
}

// ------------------------------------------------------------------ sync / update
async function sync(site, opts) {
  opts = opts || {};
  const st = state(site.domain);
  if (!st) throw bad(site.domain + ' is not connected to GitHub', 409);
  const out = { at: new Date().toISOString(), committed: false, pushed: false, behind: 0, ahead: 0, summary: '', ok: true };
  try {
    ensureIgnore(site);
    await secretCheck(site);
    const dirty = (await git(site, ['status', '--porcelain'])).stdout.trim();
    if (dirty) {
      await gitOk(site, ['add', '-A'], 'git add');
      await gitOk(site, ['commit', '-q', '-m', (opts.first ? 'Connect ' : 'auto: ') + site.domain + ' on ' + os.hostname() + ' ' + out.at.slice(0, 16).replace('T', ' ') + ' UTC'], 'git commit');
      out.committed = dirty.split('\n').length;
    }
    const f = await git(site, ['fetch', '-q', 'origin']);
    const remoteHas = !f.err && !(await git(site, ['rev-parse', '--verify', '-q', 'origin/' + st.branch])).err;
    if (remoteHas) {
      const c = (await gitOk(site, ['rev-list', '--left-right', '--count', st.branch + '...origin/' + st.branch], 'comparing with GitHub')).split(/\s+/).map(Number);
      out.ahead = c[0]; out.behind = c[1];
    } else out.ahead = Number((await git(site, ['rev-list', '--count', st.branch])).stdout.trim()) || 0;
    if (out.behind && out.ahead) { out.ok = false; out.summary = 'GitHub has ' + out.behind + ' commit(s) the server does not, and the server has ' + out.ahead + ' unpushed — Sync combines them (the server\'s on top of GitHub\'s) and pushes'; }
    else if (out.ahead) { await gitOk(site, ['push', '-q', '-u', 'origin', st.branch], 'git push'); out.pushed = out.ahead; out.ahead = 0; out.summary = 'pushed ' + out.pushed + ' commit(s) to ' + st.repo; }
    else out.summary = out.behind ? 'nothing to push · ' + out.behind + ' new commit(s) on GitHub — Update brings them in' : 'in sync with ' + st.repo;
  } catch (e) { out.ok = false; out.summary = e.message + (e.detail ? ': ' + e.detail : ''); }
  setState(site.domain, Object.assign({}, state(site.domain), { last: out }));
  return out;
}

// Commit just these paths (other local changes stay uncommitted, auto-sync or not) and push them
// when GitHub has nothing new; otherwise the commit waits for the next Sync / Update.
async function commitPaths(site, paths, message) {
  const st = state(site.domain);
  if (!st) throw bad(site.domain + ' is not connected to GitHub', 409);
  await gitOk(site, ['add', '-A', '--', ...paths], 'git add');
  const staged = await git(site, ['diff', '--cached', '--quiet', '--', ...paths]);
  let committed = false;
  if (staged.err) { await gitOk(site, ['commit', '-q', '-m', message, '--', ...paths], 'git commit'); committed = true; }
  const f = await git(site, ['fetch', '-q', 'origin']);
  if (f.err) return { committed, pushed: false, summary: (committed ? 'committed; ' : '') + 'could not reach GitHub — the next Sync pushes it' };
  const remoteHas = !(await git(site, ['rev-parse', '--verify', '-q', 'origin/' + st.branch])).err;
  const [ahead, behind] = remoteHas ? (await gitOk(site, ['rev-list', '--left-right', '--count', st.branch + '...origin/' + st.branch], 'comparing with GitHub')).split(/\s+/).map(Number) : [1, 0];
  if (behind) return { committed, pushed: false, summary: (committed ? 'committed; ' : '') + 'GitHub has ' + behind + ' new commit(s) — Sync on the GitHub tab pushes it' };
  if (!ahead) return { committed, pushed: false, summary: 'nothing to push' };
  await gitOk(site, ['push', '-q', '-u', 'origin', st.branch], 'git push');
  return { committed, pushed: true, summary: 'pushed ' + ahead + ' commit(s) to ' + st.repo };
}

// ---- lock-file conflicts
// The commonest conflict when combining is a lock file that both sides regenerated (Dependabot on
// GitHub, the nightly module auto-fix on the server). A lock file is generated, not written: take the
// server's version while the rebase replays, then rebuild it from the combined package.json in
// lock-only mode (nothing installed, no scripts run). Any other conflicting file stops the combine.
const LOCKS = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
const LOCK_CMD = {
  npm: 'npm install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps',
  pnpm: 'pnpm install --lockfile-only --ignore-scripts',
  yarn: '(yarn --version | grep -q "^1\\." && yarn install --ignore-scripts --non-interactive) || yarn install --mode update-lockfile',
  bun: 'bun install --lockfile-only --ignore-scripts',
};
const isLock = (f) => !!LOCKS[path.basename(f)];
const rebasing = (site) => ['rebase-merge', 'rebase-apply'].some((d) => fs.existsSync(path.join(docroot(site), '.git', d)));
async function siteSh(site, cwd, cmd, t) {
  return execP('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', 'cd ' + JSON.stringify(cwd) + ' && ' + cmd + ' 2>&1'], { timeout: t || 15 * 60_000 });
}
// Called while a rebase is stopped on conflicts. Returns { ok, locks: [files], conflicts: [non-lock files] }.
async function resolveLockConflicts(site, say) {
  const locks = new Set();
  for (let i = 0; i < 200 && rebasing(site); i++) {
    const conflicted = (await git(site, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const other = conflicted.filter((f) => !isLock(f));
    if (other.length) return { ok: false, locks: [...locks], conflicts: other };
    for (const f of conflicted) {
      // during a rebase "theirs" is the commit being replayed — the server's
      await gitOk(site, ['checkout', '--theirs', '--', f], 'taking the server\'s ' + f);
      await gitOk(site, ['add', '--', f], 'git add ' + f);
      if (!locks.has(f)) say('lock-file conflict in ' + f + ' — taking the server\'s version for now, rebuilt after combining');
      locks.add(f);
    }
    const c = await git(site, ['-c', 'core.editor=true', 'rebase', '--continue']);
    if (c.err && /nothing to commit|no changes|empty/i.test((c.stdout || '') + (c.stderr || ''))) await git(site, ['rebase', '--skip']);
    else if (c.err && !rebasing(site)) return { ok: false, locks: [...locks], conflicts: ['(rebase failed: ' + ((c.stderr || c.stdout || '').trim().split('\n').pop() || '?') + ')'] };
  }
  return rebasing(site) ? { ok: false, locks: [...locks], conflicts: ['(rebase did not finish)'] } : { ok: true, locks: [...locks] };
}
async function regenerateLocks(site, locks, say) {
  const dir = docroot(site);
  for (const f of locks) {
    const pm = LOCKS[path.basename(f)], cwd = path.join(dir, path.dirname(f));
    say('rebuilding ' + f + ' from the combined package.json (' + pm + ', lock only)…');
    const r = await siteSh(site, cwd, LOCK_CMD[pm]);
    if (r.err) { say('could not rebuild ' + f + ' — keeping the server\'s version', ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join('\n')); continue; }
  }
  if ((await git(site, ['status', '--porcelain', '--', ...locks])).stdout.trim()) {
    await gitOk(site, ['add', '--', ...locks], 'git add');
    await gitOk(site, ['commit', '-q', '-m', 'Lock file rebuilt after combining ' + site.domain + ' (server) with GitHub'], 'git commit');
    say('lock file rebuilt and committed');
  } else say('lock file already matches the combined package.json');
}

async function update(site, say) {
  say = say || (() => {});
  const st = state(site.domain);
  if (!st) throw bad(site.domain + ' is not connected to GitHub', 409);
  const before = (await gitOk(site, ['rev-parse', 'HEAD'], 'rev-parse'));
  const s1 = await sync(site);                         // local changes are committed (and pushed if possible) first
  if (s1.committed) say('committed ' + s1.committed + ' local change(s) first');
  const pull = await git(site, ['pull', '-q', '--rebase', 'origin', st.branch]);
  if (pull.err) {
    const res = rebasing(site) ? await resolveLockConflicts(site, say) : { ok: false, conflicts: [] };
    if (!res.ok) {
      if (rebasing(site)) await git(site, ['rebase', '--abort']);
      const what = res.conflicts && res.conflicts.length ? 'both GitHub and the server changed ' + res.conflicts.join(', ') + ' — combine them by hand' : 'pulling ' + st.branch + ' failed';
      throw bad(what + ' — nothing changed on the site', 409, ((pull.stderr || '') + (pull.stdout || '')).trim().split('\n').filter((l) => !/^hint:/.test(l)).slice(-8).join('\n'));
    }
    if (res.locks.length) await regenerateLocks(site, res.locks, say);
  }
  const after = await gitOk(site, ['rev-parse', 'HEAD'], 'rev-parse');
  if (before === after) { say('already up to date'); return { changed: false, steps: [] }; }
  const files = (await gitOk(site, ['diff', '--name-only', before, after], 'diff')).split('\n').filter(Boolean);
  say('pulled ' + st.branch + ': ' + files.length + ' file(s) changed', files.slice(0, 8).join(', ') + (files.length > 8 ? ', …' : ''));
  await installAndRestart(site, files, say, { ecosystem: files.includes('ecosystem.config.js') });
  await sync(site);
  return { changed: true, files };
}

async function status(site) {
  const st = state(site.domain);
  const dir = docroot(site);
  const out = { auth: st ? st.auth || 'key' : null, account: st ? st.account || null : null, defaultOwner: defaultOwner(), manual: st ? !!st.manual : false, connected: !!st, repo: st ? st.repo : null, url: st ? 'https://github.com/' + st.repo : null, branch: st ? st.branch : null, autoSync: st ? !!st.autoSync : false, last: st ? st.last : null, hasGit: fs.existsSync(path.join(dir, '.git')) };
  try { out.accounts = await accounts(); } catch (_) { out.accounts = []; }
  if (!out.hasGit) return out;
  const log = (await git(site, ['log', '-5', '--format=%h%x1f%s%x1f%an%x1f%cI'])).stdout.trim();
  out.commits = log ? log.split('\n').map((l) => { const [hash, subject, author, date] = l.split('\x1f'); return { hash, subject, author, date }; }) : [];
  out.dirty = (await git(site, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean).length;
  const up = await git(site, ['remote', 'get-url', 'upstream']);
  out.upstream = up.err ? null : up.stdout.trim();
  return out;
}
function setAutoSync(site, on) { const st = state(site.domain); if (!st) throw bad('not connected', 409); setState(site.domain, Object.assign({}, st, { autoSync: !!on })); return status(site); }

// Rebuild & restart from what is checked out: points a leftover placeholder pm2 config (script
// app.js, which no longer exists) at the app's own `npm start`, installs dependencies, builds when
// there is a build script, and starts the app from ecosystem.config.js.
async function rebuild(site, say) {
  say = say || (() => {});
  const dir = docroot(site), ecoF = path.join(dir, 'ecosystem.config.js');
  let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (_) {}
  if (fs.existsSync(ecoF) && !fs.existsSync(path.join(dir, 'app.js')) && pkg && pkg.scripts && pkg.scripts.start) {
    const eco = fs.readFileSync(ecoF, 'utf8');
    if (/script:\s*'app\.js',/.test(eco)) {
      fs.writeFileSync(ecoF, eco.replace(/script:\s*'app\.js',/, "script: 'npm',\n    args: 'start',"));
      say('ecosystem.config.js ran the removed placeholder app.js — now runs `npm start` on the same port');
    }
  }
  if (pkg && !fs.existsSync(path.join(dir, 'node_modules'))) say('node_modules is missing — installing');
  await installAndRestart(site, pkg ? ['package.json'] : [], say, { ecosystem: true });
  return status(site);
}

// Two-way: commit & push what changed on the server, and pull what is new on GitHub (then install,
// build when the app has a build step, restart). The Sync button and auto-sync both do this.
async function syncBoth(site, say) {
  say = say || (() => {});
  say('committing changes made on the server and checking GitHub…');
  const s1 = await sync(site);
  say(s1.summary);
  if (s1.behind) {
    say('pulling ' + s1.behind + ' new commit(s) from GitHub…');
    const u = await update(site, say);
    return Object.assign(await status(site), { pulled: s1.behind, changed: u.changed });
  }
  return Object.assign(await status(site), { pulled: 0, changed: false, result: s1 });
}

// every 15 min: sync every connected site with auto-sync on
let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    for (const site of store.list()) {
      const st = state(site.domain);
      if (!st || !st.autoSync) continue;
      const r = await syncBoth(site).then(() => state(site.domain).last || { ok: true }).catch((e) => ({ ok: false, summary: e.message + (e.detail ? ': ' + String(e.detail).split('\n').slice(-3).join(' ') : '') }));
      if (!r.ok) {
        const prev = st.last;
        if (!prev || prev.ok !== false || prev.summary !== r.summary)   // alert once per distinct problem
          require('../notify').send('⚠️ *GitHub sync* of `' + site.domain + '` needs attention\n' + r.summary, 'complete', { site: site.domain }).catch(() => {});
      }
    }
  } finally { running = false; }
}
function deployKey(domain) {
  const site = store.get(domain); if (!site) return '';
  try { return fs.readFileSync(path.join('/home', site.user, KEY_FILE), 'utf8'); } catch (_) { return ''; }
}

module.exports = { commitPaths, gh, parseRepo, rebuild, syncBoth, resetAccounts, connect, disconnect, sync, update, status, setAutoSync, tick, state, deployKey, defaultOwner, accounts };
