'use strict';
// Dependabot on the GitHub tab: open security alerts and Dependabot pull requests of a connected
// site's repo, merging those pull requests (then Sync brings them to the server), and "Fix security
// alerts" — updates on the server what the package manager's audit can fix, rebuilds, restarts,
// health-checks, rolls back on failure, then pushes (modules.runSecurityFix).
//
// Reading alerts needs the token scope security_events (asked for at Sign in with GitHub since
// 2026-11-15); an account signed in before that gets "sign in again".
// Every 6 h the alerts of every connected site are refreshed; new critical/high ones are notified once.
const path = require('path');
const { settings } = require('../db');
const store = require('./store');
const github = require('./github');

const SEV = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };
const cacheKey = (d) => 'site.github.alerts:' + String(d).toLowerCase();
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });

function repoOf(site) {
  const st = github.state(site.domain);
  if (!st || !st.repo) throw bad(site.domain + ' is not connected to GitHub', 409);
  return st.repo;
}
async function api(repo, pathAndQuery, extra) {
  const r = await github.gh(['api', '--paginate', ...(extra || []), pathAndQuery], repo);
  if (r.err) {
    const msg = ((r.stderr || '') + (r.stdout || '')).trim();
    const e = bad(msg.split('\n').pop() || 'GitHub API error', 424, msg.slice(-800));
    if (/security_events|Resource not accessible|HTTP 403/i.test(msg)) e.code = 'gh-scope';
    if (/disabled for this repository|HTTP 404/i.test(msg) && /dependabot/.test(pathAndQuery)) e.code = 'alerts-disabled';
    throw e;
  }
  // --paginate concatenates JSON arrays: "][" between pages
  const txt = (r.stdout || '').trim().replace(/\]\s*\[/g, ',');
  return txt ? JSON.parse(txt) : [];
}

async function alerts(site) {
  const repo = repoOf(site);
  const out = { repo, at: new Date().toISOString(), alerts: [], prs: [], counts: { critical: 0, high: 0, moderate: 0, low: 0, total: 0 }, alertsError: null, prsError: null };
  try {
    const list = await api(repo, 'repos/' + repo + '/dependabot/alerts?state=open&per_page=100');
    out.alerts = list.map((a) => ({
      number: a.number, url: a.html_url,
      severity: (a.security_advisory && a.security_advisory.severity) || (a.security_vulnerability && a.security_vulnerability.severity) || 'low',
      package: a.dependency && a.dependency.package && a.dependency.package.name,
      ecosystem: a.dependency && a.dependency.package && a.dependency.package.ecosystem,
      manifest: a.dependency && a.dependency.manifest_path,
      scope: a.dependency && a.dependency.scope,
      vulnerable: a.security_vulnerability && a.security_vulnerability.vulnerable_version_range,
      patched: a.security_vulnerability && a.security_vulnerability.first_patched_version && a.security_vulnerability.first_patched_version.identifier,
      summary: a.security_advisory && a.security_advisory.summary,
      ghsa: a.security_advisory && a.security_advisory.ghsa_id,
      created: a.created_at,
    })).sort((x, y) => (SEV[y.severity] || 0) - (SEV[x.severity] || 0) || String(x.package).localeCompare(String(y.package)));
    for (const a of out.alerts) { const k = a.severity === 'medium' ? 'moderate' : a.severity; out.counts[k] = (out.counts[k] || 0) + 1; out.counts.total++; }
  } catch (e) {
    out.alertsError = e.code === 'gh-scope' ? 'the GitHub account cannot read security alerts yet — Sign in with GitHub again to allow it (adds the security_events permission)'
      : e.code === 'alerts-disabled' ? 'Dependabot alerts are off for this repo (GitHub → Settings → Code security)' : e.message;
    out.alertsErrorCode = e.code || null;
  }
  try {
    const prs = await api(repo, 'repos/' + repo + '/pulls?state=open&per_page=100');
    out.prs = prs.filter((p) => p.user && /^dependabot(\[bot\])?$/i.test(p.user.login)).map((p) => ({
      number: p.number, title: p.title, url: p.html_url, created: p.created_at, branch: p.head && p.head.ref,
      security: /security/i.test((p.labels || []).map((l) => l.name).join(' ') + ' ' + (p.body || '').slice(0, 400)),
    }));
  } catch (e) { out.prsError = e.message; }
  const prev = settings.get(cacheKey(site.domain), null);
  settings.set(cacheKey(site.domain), { at: out.at, repo, counts: out.counts, prs: out.prs.length, error: out.alertsError, seen: prev && prev.seen ? prev.seen : [] });
  return out;
}
function cached(domain) { return settings.get(cacheKey(domain), null); }

// Merge one Dependabot pull request on GitHub (squash), then Sync pulls it onto the server.
async function mergePr(site, number, say) {
  const repo = repoOf(site);
  say('merging #' + number + ' on GitHub…');
  const r = await github.gh(['api', '-X', 'PUT', 'repos/' + repo + '/pulls/' + Number(number) + '/merge', '-f', 'merge_method=squash'], repo);
  if (r.err) {
    let why = ''; try { why = JSON.parse(r.stdout || '{}').message || ''; } catch (_) {}
    throw bad('could not merge #' + number + (why ? ': ' + why : ''), 424, (r.stderr || '').trim());
  }
  say('merged #' + number);
}
async function mergeAll(site, say) {
  const a = await alerts(site);
  if (!a.prs.length) { say('no open Dependabot pull requests'); return { merged: 0, failed: [] }; }
  const failed = []; let merged = 0;
  for (const p of a.prs) {
    try { await mergePr(site, p.number, say); merged++; }
    catch (e) { failed.push('#' + p.number + ' ' + p.title + ': ' + e.message); say('skipped #' + p.number + ' — ' + e.message); }
  }
  return { merged, failed };
}

// Fix on the server: every npm/pnpm project the alerts point at (or the docroot when the alerts
// cannot be read), audit fix + rebuild + restart + health check + rollback, then commit & push.
async function fix(site, say, actor) {
  const modules = require('../modules');
  const dir = path.join('/home', site.user, 'htdocs', site.domain);
  let list = null;
  try { list = (await alerts(site)).alerts; } catch (_) {}
  const dirs = new Set();
  for (const a of list || []) if (/^(npm|pnpm)$/i.test(a.ecosystem || '') || /package(-lock)?\.json|pnpm-lock|yarn\.lock/.test(a.manifest || '')) dirs.add(path.join(dir, path.dirname(a.manifest || 'package.json')));
  if (!dirs.size) dirs.add(dir);
  say('syncing first, so the fix starts from GitHub\'s latest…');
  try { await github.syncBoth(site, say); } catch (e) { say('sync before the fix failed — fixing what is on the server', e.message); }
  const results = [];
  for (const d of dirs) {
    if (!require('fs').existsSync(path.join(d, 'package.json'))) { say('skipped ' + d.replace(dir, '.') + ' — no package.json on the server'); continue; }
    say('fixing ' + (d.replace(dir, '') || '/') + ' — audit fix within the allowed versions, then build/restart/health check…');
    const r = await modules.runSecurityFix(d, site.user, actor, { packages: (list || []).filter((a) => path.join(dir, path.dirname(a.manifest || 'package.json')) === d).map((a) => a.package) });
    const cnt = (c) => c ? (c.critical + c.high) + ' critical/high, ' + c.total + ' total' : '?';
    say((r.success ? (r.changed ? '✔ updated' : '· nothing to fix within the allowed versions') : '✖ ' + (r.error || 'failed')) + ' — vulnerabilities before: ' + cnt(r.before) + ' · after: ' + cnt(r.after));
    results.push(r);
  }
  if (results.some((r) => r.changed && r.success)) {
    say('pushing the fix to GitHub…');
    const s = await github.sync(site);
    say(s.summary);
    say('GitHub re-checks the alerts within a few minutes; what is left needs a major version update by hand');
  }
  return { results };
}

// every 6 h: refresh alerts of connected sites; notify new critical/high once
async function tick() {
  for (const site of store.list()) {
    if (!github.state(site.domain)) continue;
    let a; try { a = await alerts(site); } catch (_) { continue; }
    if (!a.alerts.length) continue;
    const c = cached(site.domain) || {};
    const seen = new Set(c.seen || []);
    const fresh = a.alerts.filter((x) => (SEV[x.severity] || 0) >= 3 && !seen.has(x.ghsa + ':' + x.manifest));
    if (fresh.length) {
      require('../notify').send('🛡 *Security alerts* for `' + site.domain + '` (' + a.repo + ')\n' + fresh.slice(0, 8).map((x) => '• ' + x.severity + ' · ' + x.package + (x.patched ? ' → ' + x.patched : '') + ' — ' + (x.summary || '')).join('\n')
        + (fresh.length > 8 ? '\n… and ' + (fresh.length - 8) + ' more' : '') + '\nGitHub tab → Fix security alerts', 'complete', { site: site.domain }).catch(() => {});
      for (const x of fresh) seen.add(x.ghsa + ':' + x.manifest);
      settings.set(cacheKey(site.domain), Object.assign({}, cached(site.domain), { seen: [...seen].slice(-2000) }));
    }
  }
}

module.exports = { alerts, cached, mergePr, mergeAll, fix, tick };
