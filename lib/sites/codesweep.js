'use strict';
// HCL AppScan CodeSweep on the site's GitHub repo: .github/workflows/codesweep.yml in the site's
// working copy, committed and pushed on its own (lib/sites/github.js commitPaths). CodeSweep is a
// pull-request scanner — it reports on the code a PR changes (annotations + a check run); pushes
// straight to main are not scanned. The panel-side scanner (lib/codescan.js) covers those.
// Files go through the file manager helper, which runs as the site user.
const files = require('./files');
const github = require('./github');
const store = require('./store');

const WF = '.github/workflows/codesweep.yml';
const MARK = '# managed by sb-srv-mon';
const ACTION = 'HCL-TECH-SOFTWARE/appscan-codesweep-action@v2.1';
const YAML = MARK + ' (Sites › GitHub › CodeSweep) — switching it off there removes this file.\n'
  + '# HCL AppScan CodeSweep: scans the code each pull request changes; findings show as annotations\n'
  + '# on the PR and in its "HCL AppScan CodeSweep" check run.\n'
  + 'name: "HCL AppScan CodeSweep"\n'
  + 'on:\n  pull_request:\n    types: [opened, synchronize]\n'
  + 'permissions:\n  contents: read\n  checks: write\n  statuses: write\n  pull-requests: write\n'
  + 'jobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n'
  + '      - name: Checkout\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n'
  + '      - name: Run AppScan CodeSweep\n        uses: ' + ACTION + '\n        env:\n          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n';

const rel = (site, p) => '/htdocs/' + site.domain + (p ? '/' + p : '');
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });

async function readWf(site) {
  try { return (await files.op(site, { op: 'read', path: rel(site, WF) })).content; }
  catch (e) { if (/no such file/i.test(e.message)) return null; throw e; }
}

// Cheap (no GitHub call): for the overview of every site.
async function brief(site) {
  const st = github.state(site.domain);
  const wf = st ? await readWf(site).catch(() => null) : null;
  return { domain: site.domain, connected: !!st, repo: st ? st.repo : null, enabled: wf != null, managed: wf != null && wf.includes(MARK) };
}

async function status(site) {
  const b = await brief(site);
  b.runs = [];
  if (b.enabled && b.repo) {
    const r = await github.gh(['run', 'list', '--repo', b.repo, '--workflow', 'codesweep.yml', '--limit', '5', '--json', 'status,conclusion,displayTitle,url,createdAt,event,headBranch'], b.repo);
    if (r.err) b.runsError = /could not find any workflows|HTTP 404/i.test((r.stderr || '') + (r.stdout || '')) ? 'not on GitHub yet — it arrives with the next push' : ((r.stderr || r.err.message || '').trim().split('\n').pop() || 'gh run list failed').slice(0, 300);
    else { try { b.runs = JSON.parse(r.stdout || '[]'); } catch (_) {} }
  }
  return b;
}

async function ensureDir(site, dir) {   // mkdir -p, as the site user
  let cur = rel(site);
  for (const part of dir.split('/')) {
    try { await files.op(site, { op: 'mkdir', path: cur, name: part }); } catch (e) { if (!/exist/i.test(e.message)) throw e; }
    cur += '/' + part;
  }
}

async function enable(site) {
  if (!github.state(site.domain)) throw bad(site.domain + ' is not connected to GitHub — connect it on the GitHub tab first', 409);
  const cur = await readWf(site);
  if (cur != null && !cur.includes(MARK)) throw bad(WF + ' already exists and was not written by the panel — left as it is', 409);
  await ensureDir(site, '.github/workflows');
  await files.op(site, { op: 'write', path: rel(site, WF), content: YAML });
  const push = await github.commitPaths(site, [WF], 'Add HCL AppScan CodeSweep (pull request security scan)');
  return Object.assign(await brief(site), { push });
}

async function disable(site) {
  const cur = await readWf(site);
  if (cur == null) return Object.assign(await brief(site), { push: { summary: 'was not enabled' } });
  if (!cur.includes(MARK)) throw bad(WF + ' was not written by the panel — remove it in the repo yourself', 409);
  await files.op(site, { op: 'delete', paths: [rel(site, WF)] });
  const push = github.state(site.domain) ? await github.commitPaths(site, [WF], 'Remove HCL AppScan CodeSweep workflow') : { summary: 'removed locally' };
  return Object.assign(await brief(site), { push });
}

async function overview() {
  const out = [];
  for (const s of store.list()) out.push(await brief(s).catch((e) => ({ domain: s.domain, error: e.message })));
  return { sites: out, action: ACTION };
}

// on: true → enable on every connected site that does not have it; false → remove the panel's file everywhere.
async function setAll(on) {
  const results = [];
  for (const s of store.list()) {
    const b = await brief(s).catch(() => null);
    if (!b || !b.connected || b.enabled === on) continue;
    try { const r = on ? await enable(s) : await disable(s); results.push({ domain: s.domain, ok: true, summary: r.push.summary }); }
    catch (e) { results.push({ domain: s.domain, ok: false, summary: e.message }); }
  }
  return { results };
}

module.exports = { status, enable, disable, overview, setAll, WF };
