'use strict';
// GitHub per site (site → GitHub tab).
//
//   connect   the site's code gets its own private repo — <default owner>/<domain>, the default owner
//             being Settings → Sites & apps (roman-synergybeam), unless a repo was set by hand on the
//             site's GitHub tab (any owner/name; connecting again moves the site there) — a deploy key of its own (write access to that repo only, key in
//             ~/.ssh/github_deploy of the site user, private half in the Vault), origin → that repo.
//             A clone of someone else's project (Kuma = louislam/uptime-kuma) keeps it as "upstream".
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
const BRANCH = 'main';
const KEY_FILE = '.ssh/github_deploy';
const stateKey = (d) => 'site.github:' + String(d).toLowerCase();
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const docroot = (site) => path.join('/home', site.user, 'htdocs', site.domain);
const IGNORE_BLOCK = ['# --- managed by rhc-srv-mon: never commit data, secrets or build output ---',
  '/data/', 'logs/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.pyc', '*.db', '*.db-*', '*.sqlite', '*.sqlite3', '*.sqlite-*', '*.key', '*.pem', '.env', '.env.*', '!.env.example', '# --- end rhc-srv-mon ---'];
const SECRETISH = /(^|\/)(data\/|\.env($|\.(?!example$))|[^/]*\.(key|pem|db|sqlite3?)$|id_(rsa|ed25519|ecdsa)$)/;

const state = (domain) => settings.get(stateKey(domain), null);
const setState = (domain, s) => settings.set(stateKey(domain), s);

// Run git in the site's docroot as the site user, with its deploy key.
function git(site, args, opts) {
  const keyPath = path.join('/home', site.user, KEY_FILE);
  return execP('sudo', ['-n', '-H', '-u', site.user, 'env', 'GIT_SSH_COMMAND=ssh -i ' + keyPath + ' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes',
    'GIT_TERMINAL_PROMPT=0', 'git', '-C', docroot(site), ...args], Object.assign({ timeout: 5 * 60_000 }, opts || {}));
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
async function gh(args, owner) {
  const tok = owner ? await tokenFor(owner) : null;
  return execP('gh', args, { timeout: 60_000, env: Object.assign({}, process.env, { HOME: '/root' }, tok ? { GH_TOKEN: tok } : {}) });
}
const ownerOf = (repo) => String(repo).split('/')[0];

function ensureIgnore(site) {
  const f = path.join(docroot(site), '.gitignore');
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (_) {}
  const start = txt.indexOf(IGNORE_BLOCK[0]), end = txt.indexOf(IGNORE_BLOCK[IGNORE_BLOCK.length - 1]);
  const block = IGNORE_BLOCK.join('\n');
  const next = start >= 0 && end > start ? txt.slice(0, start) + block + txt.slice(end + IGNORE_BLOCK[IGNORE_BLOCK.length - 1].length)
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

async function ensureDeployKey(site, repo) {
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
  const keys = await gh(['api', 'repos/' + repo + '/keys'], ownerOf(repo));
  if (keys.err) throw bad('cannot read the deploy keys of ' + repo, 424, keys.stderr);
  const have = JSON.parse(keys.stdout || '[]').find((k) => String(k.key).split(' ').slice(0, 2).join(' ') === pub.split(' ').slice(0, 2).join(' '));
  if (have) return have.id;
  const add = await gh(['api', '-X', 'POST', 'repos/' + repo + '/keys', '-f', 'title=' + os.hostname() + ' · ' + site.domain, '-f', 'key=' + pub, '-F', 'read_only=false'], ownerOf(repo));
  if (add.err) throw bad('could not add the deploy key to ' + repo, 424, add.stderr);
  return JSON.parse(add.stdout).id;
}

// ------------------------------------------------------------------ connect
// opts.repo: "owner/name" set by hand on the GitHub tab; otherwise <default owner>/<domain>.
async function connect(site, say, opts) {
  say = say || (() => {}); opts = opts || {};
  const dir = docroot(site);
  if (!fs.existsSync(dir)) throw bad('no docroot ' + dir, 404);
  const hasGit = fs.existsSync(path.join(dir, '.git'));
  let origin = '';
  if (hasGit) origin = (await git(site, ['remote', 'get-url', 'origin'])).stdout.trim();
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(origin);
  const prev = state(site.domain);
  const manual = opts.repo ? String(opts.repo).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : (prev && prev.manual ? prev.repo : null);
  if (manual && !REPO_RE.test(manual)) throw bad('repository must look like owner/name');
  const def = defaultOwner();
  const repo = manual || (m && m[1].toLowerCase() === def.toLowerCase() ? def + '/' + m[2] : def + '/' + site.domain);
  // repo
  const view = await gh(['repo', 'view', repo, '--json', 'name'], ownerOf(repo));
  if (view.err) {
    const c = await gh(['repo', 'create', repo, '--private', '--description', site.domain + ' — served by ' + os.hostname() + ' (rhc-srv-mon)'], ownerOf(repo));
    if (c.err) throw bad('could not create ' + repo, 424, c.stderr);
    say('created the private repo ' + repo);
  } else say('using the repo ' + repo);
  const keyId = await ensureDeployKey(site, repo);
  say('deploy key with write access to ' + repo + ' only', '~' + site.user + '/' + KEY_FILE);
  // moving from another repo: its deploy key goes, so the site can no longer write there
  if (prev && prev.repo && prev.repo.toLowerCase() !== repo.toLowerCase() && prev.keyId) {
    const d = await gh(['api', '-X', 'DELETE', 'repos/' + prev.repo + '/keys/' + prev.keyId], ownerOf(prev.repo));
    say(d.err ? 'could not remove the deploy key from ' + prev.repo + ' — remove it on GitHub' : 'removed the site\'s deploy key from ' + prev.repo);
  }
  // local repo
  if (!hasGit) { await gitOk(site, ['init', '-q', '-b', BRANCH], 'git init'); say('initialised git in ' + dir); }
  if (m && (m[1] + '/' + m[2]).toLowerCase() !== repo.toLowerCase()) {
    const up = await git(site, ['remote', 'get-url', 'upstream']);
    if (up.err) { await gitOk(site, ['remote', 'rename', 'origin', 'upstream'], 'renaming origin'); say('kept ' + m[1] + '/' + m[2] + ' as "upstream"'); }
    else await git(site, ['remote', 'remove', 'origin']);
  }
  const sshUrl = 'git@github.com:' + repo + '.git';
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
  setState(site.domain, { repo, manual: !!manual, branch: BRANCH, autoSync: prev ? prev.autoSync !== false : true, keyId, connected: new Date().toISOString(), last: null });
  const r = await sync(site, { first: true });
  say(r.summary);
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
    if (out.behind && out.ahead) { out.ok = false; out.summary = 'GitHub has ' + out.behind + ' commit(s) the server does not, and the server has ' + out.ahead + ' unpushed — press Update to combine them (rebase), then it syncs again'; }
    else if (out.ahead) { await gitOk(site, ['push', '-q', '-u', 'origin', st.branch], 'git push'); out.pushed = out.ahead; out.ahead = 0; out.summary = 'pushed ' + out.pushed + ' commit(s) to ' + st.repo; }
    else out.summary = out.behind ? 'nothing to push · ' + out.behind + ' new commit(s) on GitHub — Update brings them in' : 'in sync with ' + st.repo;
  } catch (e) { out.ok = false; out.summary = e.message + (e.detail ? ': ' + e.detail : ''); }
  setState(site.domain, Object.assign({}, state(site.domain), { last: out }));
  return out;
}

async function update(site, say) {
  say = say || (() => {});
  const st = state(site.domain);
  if (!st) throw bad(site.domain + ' is not connected to GitHub', 409);
  const before = (await gitOk(site, ['rev-parse', 'HEAD'], 'rev-parse'));
  const s1 = await sync(site);                         // local changes are committed (and pushed if possible) first
  if (s1.committed) say('committed ' + s1.committed + ' local change(s) first');
  const pull = await git(site, ['pull', '-q', '--rebase', 'origin', st.branch]);
  if (pull.err) { await git(site, ['rebase', '--abort']); throw bad('pulling ' + st.branch + ' failed — nothing changed on the site', 409, ((pull.stderr || '') + (pull.stdout || '')).trim().split('\n').slice(-8).join('\n')); }
  const after = await gitOk(site, ['rev-parse', 'HEAD'], 'rev-parse');
  if (before === after) { say('already up to date'); return { changed: false, steps: [] }; }
  const files = (await gitOk(site, ['diff', '--name-only', before, after], 'diff')).split('\n').filter(Boolean);
  say('pulled ' + st.branch + ': ' + files.length + ' file(s) changed', files.slice(0, 8).join(', ') + (files.length > 8 ? ', …' : ''));
  // dependencies, when their manifest changed
  const asUser = (cmd) => execP('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', 'cd ' + JSON.stringify(docroot(site)) + ' && ' + cmd], { timeout: 15 * 60_000 });
  if (files.includes('requirements.txt') && fs.existsSync(path.join(docroot(site), '.venv'))) { const r = await asUser('.venv/bin/pip install -q -r requirements.txt'); say(r.err ? 'pip install FAILED' : 'installed Python requirements', r.err ? (r.stderr || '').slice(-400) : ''); }
  if (files.some((f) => f === 'package.json' || f === 'package-lock.json') && fs.existsSync(path.join(docroot(site), 'package.json'))) { const r = await asUser(fs.existsSync(path.join(docroot(site), 'package-lock.json')) ? 'npm ci --omit=dev' : 'npm install --omit=dev'); say(r.err ? 'npm install FAILED' : 'installed npm dependencies', r.err ? (r.stderr || '').slice(-400) : ''); }
  // restart the site's apps
  const a = await require('./procs').act(site, 'restart', {});
  say(a.ok ? 'restarted the site\'s apps' : 'restart reported a problem', (a.results || []).map((x) => x.app + ': ' + (x.ok ? 'ok' : x.error || 'failed')).join(', '));
  await sync(site);
  return { changed: true, files };
}

async function status(site) {
  const st = state(site.domain);
  const dir = docroot(site);
  const out = { defaultOwner: defaultOwner(), manual: st ? !!st.manual : false, connected: !!st, repo: st ? st.repo : null, url: st ? 'https://github.com/' + st.repo : null, branch: st ? st.branch : null, autoSync: st ? !!st.autoSync : false, last: st ? st.last : null, hasGit: fs.existsSync(path.join(dir, '.git')) };
  if (!out.hasGit) return out;
  const log = (await git(site, ['log', '-5', '--format=%h%x1f%s%x1f%an%x1f%cI'])).stdout.trim();
  out.commits = log ? log.split('\n').map((l) => { const [hash, subject, author, date] = l.split('\x1f'); return { hash, subject, author, date }; }) : [];
  out.dirty = (await git(site, ['status', '--porcelain'])).stdout.split('\n').filter(Boolean).length;
  const up = await git(site, ['remote', 'get-url', 'upstream']);
  out.upstream = up.err ? null : up.stdout.trim();
  return out;
}
function setAutoSync(site, on) { const st = state(site.domain); if (!st) throw bad('not connected', 409); setState(site.domain, Object.assign({}, st, { autoSync: !!on })); return status(site); }

// every 15 min: sync every connected site with auto-sync on
let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    for (const site of store.list()) {
      const st = state(site.domain);
      if (!st || !st.autoSync) continue;
      const r = await sync(site).catch((e) => ({ ok: false, summary: e.message }));
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

module.exports = { connect, sync, update, status, setAutoSync, tick, state, deployKey, defaultOwner, accounts };
