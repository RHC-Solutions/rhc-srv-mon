'use strict';
// App Store → From GitHub: the repos of a GitHub account signed in on this server, what kind of app
// each one is, and which site already runs it. Deploying is a normal site creation with that repo
// (lib/sites/create.js → github.connect with mode 'repo'): the repo's code replaces the placeholder,
// dependencies are installed, the app is built when it has a build step, and started.
const { settings } = require('../db');
const github = require('./github');

const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const ACCT_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

async function api(account, p) {
  const r = await github.gh(['api', '--paginate', p], account);
  if (r.err) throw bad(((r.stderr || '') + (r.stdout || '')).trim().split('\n').pop() || 'GitHub API error', 424);
  const txt = (r.stdout || '').trim().replace(/\]\s*\[/g, ',');
  return txt ? JSON.parse(txt) : [];
}
// repo (lower) -> domains connected to it
function deployed() {
  const m = new Map();
  for (const [d, st] of Object.entries(settings.list('site.github:'))) if (st && st.repo) { const k = String(st.repo).toLowerCase(); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
  return m;
}
const cache = new Map();   // account -> { at, list }
async function repos(account, fresh) {
  if (!ACCT_RE.test(String(account || ''))) throw bad('pick a GitHub account');
  if (!(await github.accounts()).some((a) => a.toLowerCase() === String(account).toLowerCase())) throw bad(account + ' is not signed in on this server — Sign in with GitHub first', 404);
  const hit = cache.get(account);
  let list = hit && !fresh && Date.now() - hit.at < 5 * 60_000 ? hit.list : null;
  if (!list) {
    list = (await api(account, 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member')).map((r) => ({
      repo: r.full_name, name: r.name, owner: r.owner && r.owner.login, private: !!r.private, archived: !!r.archived, fork: !!r.fork,
      description: r.description || '', language: r.language || null, pushed: r.pushed_at, branch: r.default_branch, url: r.html_url,
      canPush: !!(r.permissions && r.permissions.push), admin: !!(r.permissions && r.permissions.admin), empty: r.size === 0,
    }));
    cache.set(account, { at: Date.now(), list });
  }
  const dep = deployed();
  return list.map((r) => Object.assign({}, r, { sites: dep.get(r.repo.toLowerCase()) || [] }));
}

// What kind of app: from the files at the repo's root (and package.json).
async function detect(account, repo) {
  if (!github.parseRepo(repo)) throw bad('not a repo');
  repo = github.parseRepo(repo);
  const r = await github.gh(['api', 'repos/' + repo + '/contents'], account);
  if (r.err) throw bad('cannot read ' + repo + ': ' + ((r.stderr || '').trim().split('\n').pop() || 'GitHub API error'), 424);
  let files = []; try { files = JSON.parse(r.stdout).map((f) => f.name); } catch (_) {}
  const has = (f) => files.includes(f);
  const out = { repo, files: files.slice(0, 60), type: null, why: '', framework: null, build: false, start: false, suggestDomain: /\.[a-z]{2,}$/i.test(repo.split('/')[1]) ? repo.split('/')[1].toLowerCase() : null };
  if (has('package.json')) {
    let pkg = {};
    const p = await github.gh(['api', 'repos/' + repo + '/contents/package.json', '--jq', '.content'], account);
    try { pkg = JSON.parse(Buffer.from((p.stdout || '').replace(/\s/g, ''), 'base64').toString('utf8')); } catch (_) {}
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    const sc = pkg.scripts || {};
    out.framework = deps.next ? 'Next.js' : deps.nuxt ? 'Nuxt' : deps['@sveltejs/kit'] ? 'SvelteKit' : deps['@remix-run/node'] ? 'Remix' : deps.astro ? 'Astro' : deps.express ? 'Express' : deps.fastify ? 'Fastify' : deps.vite ? 'Vite' : deps.react ? 'React' : null;
    out.build = !!sc.build; out.start = !!sc.start;
    // a pure front-end build (Vite/React without a server) would be static, but `npm start` / a
    // server framework means a Node.js app behind the proxy
    out.type = 'nodejs';
    out.why = 'package.json' + (out.framework ? ' · ' + out.framework : '') + (sc.start ? ' · npm start' : '') + (sc.build ? ' · npm run build' : '');
    if (!sc.start && (deps.vite || deps.astro) && !deps.express && !deps.fastify) out.note = 'no start script: a front-end build — it needs a start script (e.g. a static server) to run as a Node.js site';
  } else if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile')) {
    out.type = 'python'; out.why = ['requirements.txt', 'pyproject.toml', 'Pipfile'].filter(has).join(' · ');
  } else if (has('composer.json') || has('index.php') || has('wp-config-sample.php') || has('artisan')) {
    out.type = 'php'; out.why = ['composer.json', 'index.php', 'artisan', 'wp-config-sample.php'].filter(has).join(' · ');
    out.framework = has('artisan') ? 'Laravel' : has('wp-config-sample.php') ? 'WordPress' : null;
  } else if (has('index.html')) {
    out.type = 'static'; out.why = 'index.html';
  } else {
    out.type = 'static'; out.why = 'nothing recognisable at the root — pick the type'; out.unsure = true;
  }
  return out;
}

module.exports = { repos, detect };
