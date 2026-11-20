'use strict';
// Code scan per site (Security › Code scan, site › Security): what is in the site's code, on the server.
//   Semgrep CE   static analysis with the registry ruleset p/default (JS/TS, Python, PHP, …)
//   npm audit    known-vulnerable npm packages, per package-lock.json (pnpm audit for pnpm-lock.yaml)
//   pip-audit    known-vulnerable Python packages — the site's .venv (pinned freeze), else requirements.txt
// Everything runs AS THE SITE USER in /home/<user>/htdocs/<domain> (read-only use of its code), one site
// at a time (Semgrep is memory-hungry). Results kept in settings kv `codescan:<domain>`.
// Schedule (kv codescan.schedule, Security › Code scan): every site at a set time, daily or on chosen
// weekdays; when the round is done a detailed report goes to Telegram and e-mail (lib/codescan-report.js). Scanners are installed from App Store › Tools › Code scanners (/opt/codescan).
// Complements CodeSweep (lib/sites/codesweep.js), which only sees pull requests on GitHub.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { settings } = require('./db');
const store = require('./sites/store');

const SEMGREP = '/usr/local/bin/semgrep', PIP_AUDIT = '/usr/local/bin/pip-audit';
// pnpm the way the GitHub deploy finds it: on PATH, else corepack, else npx
const COREPACK = '/usr/lib/node_modules/corepack/dist/corepack.js';
const PNPM = '$(command -v pnpm >/dev/null 2>&1 && echo pnpm || { [ -f ' + COREPACK + ' ] && echo "env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 node ' + COREPACK + ' pnpm" || echo "npx --yes pnpm@latest"; })';
const KEY = (d) => 'codescan:' + String(d).toLowerCase();
const DAY = 24 * 3600_000;
const SKIP_DIRS = ['node_modules', '.next', '.nuxt', 'dist', 'build', '.venv', 'venv', 'data', 'logs', '.git', 'vendor', 'coverage', '.cache', 'tmp'];
const docroot = (site) => path.join('/home', site.user, 'htdocs', site.domain);

// as the site user, login shell (nvm on PATH), full stdout back (JSON can be large)
function asUser(site, cwd, cmd, timeout) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', 'cd ' + JSON.stringify(cwd) + ' && ' + cmd],
      { timeout: timeout || 10 * 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ err, code: err ? (err.killed ? 'timeout' : err.code) : 0, stdout: stdout || '', stderr: (stderr || '').slice(-4000) }));
  });
}
const lastLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

// directories (relative) holding one of `names`, a few levels down, not inside dependency/build dirs
function findDirs(root, names, depth) {
  const out = [];
  const walk = (dir, d) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    if (ents.some((e) => e.isFile() && names.includes(e.name))) out.push(dir);
    if (d >= depth) return;
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.includes(e.name)) walk(path.join(dir, e.name), d + 1);
  };
  walk(root, 0);
  return out;
}

const SEV = { ERROR: 'high', WARNING: 'medium', INFO: 'low' };
async function semgrep(site, dir) {
  if (!fs.existsSync(SEMGREP)) return { skipped: 'Semgrep is not installed — App Store › Tools › Code scanners' };
  const ex = SKIP_DIRS.map((d) => '--exclude ' + d).join(' ') + " --exclude '*.min.js' --exclude '*.map'";
  const r = await asUser(site, dir, SEMGREP + ' scan --config p/default --metrics off --json --quiet --disable-version-check --jobs 1 --max-memory 1500 --timeout 20 --max-target-bytes 500000 ' + ex + ' . 2>/dev/null', 20 * 60_000);
  let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
  if (!j) return { error: r.code === 'timeout' ? 'Semgrep took longer than 20 min — stopped' : 'Semgrep failed: ' + (lastLine(r.stderr) || 'exit ' + r.code).slice(0, 300) };
  const findings = (j.results || []).map((x) => ({
    rule: x.check_id, severity: SEV[(x.extra && x.extra.severity) || ''] || 'low', path: x.path, line: x.start && x.start.line,
    message: String((x.extra && x.extra.message) || '').replace(/\s+/g, ' ').slice(0, 400),
    cwe: [].concat((x.extra && x.extra.metadata && x.extra.metadata.cwe) || []).slice(0, 2).join(', ') || null,
    url: (x.extra && x.extra.metadata && (x.extra.metadata.source || x.extra.metadata.shortlink)) || null,
  }));
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || String(a.path).localeCompare(b.path));
  return { findings: findings.slice(0, 300), total: findings.length, errors: (j.errors || []).length };
}

async function npmAudit(site, root) {
  const out = [];
  for (const dir of findDirs(root, ['package-lock.json', 'pnpm-lock.yaml'], 3)) {
    const rel = path.relative(root, dir) || '.';
    const pnpm = !fs.existsSync(path.join(dir, 'package-lock.json'));
    const r = await asUser(site, dir, pnpm ? PNPM + ' audit --json 2>/dev/null' : 'npm audit --json 2>/dev/null', 5 * 60_000);
    let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
    if (!j) { out.push({ dir: rel, tool: pnpm ? 'pnpm' : 'npm', error: ((pnpm ? 'pnpm' : 'npm') + ' audit failed: ' + (lastLine(r.stderr) || 'exit ' + r.code)).slice(0, 300) }); continue; }
    const vulns = [];
    if (pnpm) {
      for (const a of Object.values(j.advisories || {})) vulns.push({ name: a.module_name, severity: a.severity, title: a.title, url: a.url, fix: a.patched_versions || null });
    } else {
      for (const [name, v] of Object.entries(j.vulnerabilities || {})) {
        const via = (v.via || []).find((x) => typeof x === 'object');
        vulns.push({ name, severity: v.severity, title: via ? via.title : 'via ' + (v.via || []).join(', '), url: via ? via.url : null, fix: v.fixAvailable ? (v.fixAvailable === true ? 'npm audit fix' : 'major: ' + v.fixAvailable.name + '@' + v.fixAvailable.version) : null });
      }
    }
    const rank = { critical: 0, high: 1, moderate: 2, medium: 2, low: 3, info: 4 };
    vulns.sort((a, b) => (rank[a.severity] ?? 5) - (rank[b.severity] ?? 5));
    out.push({ dir: rel, tool: pnpm ? 'pnpm' : 'npm', vulns: vulns.slice(0, 200), total: vulns.length });
  }
  return out;
}

async function pipAudit(site, root) {
  if (!fs.existsSync(PIP_AUDIT)) return [];
  const out = [];
  const venvs = ['.venv', 'venv'].map((v) => path.join(root, v)).filter((v) => fs.existsSync(path.join(v, 'bin', 'python')));
  const targets = venvs.length ? venvs.map((v) => ({ dir: root, venv: v })) : findDirs(root, ['requirements.txt'], 2).map((d) => ({ dir: d }));
  for (const t of targets) {
    const rel = t.venv ? path.relative(root, t.venv) : path.join(path.relative(root, t.dir) || '.', 'requirements.txt');
    const cmd = t.venv
      ? PIP_AUDIT + ' -r <(' + JSON.stringify(path.join(t.venv, 'bin', 'python')) + ' -m pip freeze --exclude-editable 2>/dev/null) --no-deps --disable-pip --format json --progress-spinner off 2>/dev/null'
      : PIP_AUDIT + ' -r requirements.txt --format json --progress-spinner off 2>/dev/null';
    const r = await asUser(site, t.dir, cmd, 10 * 60_000);
    let j = null; try { j = JSON.parse(r.stdout); } catch (_) {}
    if (!j) { out.push({ dir: rel, tool: 'pip-audit', error: ('pip-audit failed: ' + (lastLine(r.stderr) || 'exit ' + r.code)).slice(0, 300) }); continue; }
    const vulns = [];
    for (const d of j.dependencies || []) for (const v of d.vulns || []) vulns.push({ name: d.name + ' ' + d.version, severity: 'high', id: v.id, title: (v.aliases || []).concat(v.id).filter(Boolean).slice(0, 2).join(' / ') + (v.description ? ' — ' + v.description.slice(0, 160) : ''), url: 'https://osv.dev/vulnerability/' + encodeURIComponent(v.id), fix: (v.fix_versions || []).length ? '≥ ' + v.fix_versions[0] : null });
    out.push({ dir: rel, tool: 'pip-audit', vulns: vulns.slice(0, 200), total: vulns.length, unrated: true });
  }
  return out;
}

function counts(res) {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of (res.semgrep && res.semgrep.findings) || []) c[f.severity]++;
  for (const a of [].concat(res.npm || [], res.pip || [])) for (const v of a.vulns || []) {
    const s = v.severity === 'moderate' ? 'medium' : v.severity === 'info' ? 'low' : v.severity;
    if (c[s] != null) c[s]++;
  }
  return c;
}

// ---- queue: one scan at a time
const queue = []; let running = null;
const get = (domain) => settings.get(KEY(domain), null);

// the round in progress (a scheduled or "scan all" run): which sites, and their results before it
let round = null;
async function scanSite(site, by) {
  const root = docroot(site);
  const res = { domain: site.domain, at: new Date().toISOString(), by: by || 'schedule' };
  const t0 = Date.now();
  if (!fs.existsSync(root)) { res.error = root + ' does not exist'; }
  else {
    running.step = 'Semgrep'; res.semgrep = await semgrep(site, root).catch((e) => ({ error: e.message }));
    running.step = 'npm audit'; res.npm = await npmAudit(site, root).catch((e) => [{ dir: '.', error: e.message }]);
    running.step = 'pip-audit'; res.pip = await pipAudit(site, root).catch((e) => [{ dir: '.', error: e.message }]);
  }
  res.duration_ms = Date.now() - t0;
  res.counts = counts(res);
  const prev = get(site.domain);
  if (round && round.domains.includes(site.domain) && !(site.domain in round.prev)) round.prev[site.domain] = prev ? { counts: prev.counts, at: prev.at } : null;
  settings.set(KEY(site.domain), res);
  const c = res.counts, bad = c.critical + c.high;
  const was = prev && prev.counts ? prev.counts.critical + prev.counts.high : 0;
  try {
    require('./events').emit('codescan.done', { user: by || 'system', site: site.domain, target: site.domain, level: res.error ? 'error' : bad > was ? 'warn' : 'info',
      message: 'Code scan ' + site.domain + ': ' + (res.error || (c.critical + ' critical, ' + c.high + ' high, ' + c.medium + ' medium, ' + c.low + ' low' + (bad > was ? ' — ' + (bad - was) + ' more critical/high than last scan' : ''))) });
  } catch (_) {}
  return res;
}

async function drain() {
  if (running) return;
  while (queue.length) {
    const { domain, by } = queue.shift();
    const site = store.list().find((s) => s.domain === domain);
    if (!site) continue;
    running = { domain, by, started: new Date().toISOString(), step: 'starting' };
    try { await scanSite(site, by); } catch (e) { console.error('codescan', domain, e.message); }
    running = null;
    if (round && round.domains.includes(domain)) round.done.push(domain);
  }
  if (round && round.domains.every((d) => round.done.includes(d) || !store.list().some((s) => s.domain === d))) {
    const r = round; round = null;
    if (r.report) await sendReport(r.domains, { by: r.by, prev: r.prev }).catch((e) => console.error('codescan report:', e.message));
  }
}
// opts.report: send the report when every site in this batch is scanned (scheduled rounds, "scan all")
function enqueue(domains, by, opts) {
  const added = [];
  if (opts && opts.report && !round) round = { domains: domains.slice(), done: [], prev: {}, by, report: true, started: new Date().toISOString() };
  for (const d of domains) if (!(running && running.domain === d) && !queue.some((q) => q.domain === d)) { queue.push({ domain: d, by }); added.push(d); }
  drain().catch(() => {});
  return { queued: added, running, queue: queue.map((q) => q.domain) };
}

const brief = (r) => r ? { at: r.at, counts: r.counts, error: r.error || null, duration_ms: r.duration_ms,
  semgrep: r.semgrep ? (r.semgrep.skipped || r.semgrep.error || (r.semgrep.total + ' finding(s)')) : null } : null;
function overview() {
  return { schedule: scheduleView(), round: round ? { domains: round.domains.length, done: round.done.length, started: round.started } : null, installed: { semgrep: fs.existsSync(SEMGREP), pipAudit: fs.existsSync(PIP_AUDIT) }, running, queue: queue.map((q) => q.domain),
    sites: store.list().map((s) => ({ domain: s.domain, type: s.type, last: brief(get(s.domain)) })) };
}
function siteResult(domain) {
  return { installed: { semgrep: fs.existsSync(SEMGREP), pipAudit: fs.existsSync(PIP_AUDIT) }, result: get(domain), running: running && running.domain === domain ? running : null, queued: queue.some((q) => q.domain === domain) };
}

// ---- schedule + report
const SCHED_KEY = 'codescan.schedule', REPORT_KEY = 'codescan.lastReport';
const SCHED_DEFAULT = { enabled: true, time: '06:00', days: [0, 1, 2, 3, 4, 5, 6], report: { telegram: true, email: true } };
function schedule() {
  const s = Object.assign({}, SCHED_DEFAULT, settings.get(SCHED_KEY, {}) || {});
  s.report = Object.assign({}, SCHED_DEFAULT.report, s.report || {});
  return s;
}
function saveSchedule(b) {
  const cur = schedule(), n = Object.assign({}, cur);
  if (b.enabled !== undefined) n.enabled = !!b.enabled;
  if (b.time !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.time))) throw Object.assign(new Error('time must be HH:MM (24h)'), { status: 400 }); n.time = String(b.time); }
  if (b.days !== undefined) {
    const d = [...new Set([].concat(b.days).map(Number))].filter((x) => Number.isInteger(x) && x >= 0 && x <= 6).sort();
    if (!d.length) throw Object.assign(new Error('pick at least one day'), { status: 400 });
    n.days = d;
  }
  if (b.report) n.report = { telegram: b.report.telegram !== undefined ? !!b.report.telegram : cur.report.telegram, email: b.report.email !== undefined ? !!b.report.email : cur.report.email };
  settings.set(SCHED_KEY, { enabled: n.enabled, time: n.time, days: n.days, report: n.report, lastRun: cur.lastRun || null });
  return scheduleView();
}
// the next run as an ISO time (server-local clock), for the UI
function nextRun(s) {
  if (!s.enabled) return null;
  const [hh, mm] = s.time.split(':').map(Number), now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hh, mm);
    if (d > now && s.days.includes(d.getDay())) return d.toISOString();
  }
  return null;
}
function scheduleView() { const s = schedule(); return Object.assign({}, s, { next: nextRun(s), lastReport: settings.get(REPORT_KEY, null), tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); }

async function sendReport(domains, meta) {
  const rep = require('./codescan-report');
  const sites = store.list().filter((s) => !domains || domains.includes(s.domain)).map((s) => ({ domain: s.domain, result: get(s.domain), prev: meta && meta.prev ? meta.prev[s.domain] : null }));
  let sweep = null; try { sweep = await require('./sites/codesweep').reportData(); } catch (e) { console.error('codesweep report data:', e.message); }
  const built = rep.build(sites, { by: meta && meta.by === 'schedule' ? 'scheduled' : meta && meta.by ? 'by ' + meta.by : null }, sweep);
  const sent = await rep.send(built, schedule().report);
  const rec = { at: new Date().toISOString(), subject: built.subject, sites: sites.length, sent };
  settings.set(REPORT_KEY, rec);
  const ok = Object.values(sent).filter((x) => x && x.ok).length, failed = Object.entries(sent).filter(([, x]) => x && !x.ok && !x.skipped).map(([k, x]) => k + ': ' + x.error);
  try { require('./events').emit('codescan.report', { user: (meta && meta.by) || 'system', target: 'code scan', level: failed.length ? 'error' : 'info', message: 'Code scan report: ' + built.subject.replace(/^\[[^\]]*\] /, '') + ' — sent to ' + (Object.entries(sent).filter(([, x]) => x && x.ok).map(([k]) => k).join(' + ') || 'no channel') + (failed.length ? '; failed: ' + failed.join('; ') : '') }); } catch (_) {}
  return Object.assign(rec, { ok: ok > 0 });
}

// every minute: is it the scheduled time on a scheduled day, and has today's round not run yet?
function start() {
  const tick = () => {
    const s = schedule(); if (!s.enabled) return;
    const now = new Date(), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    const today = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
    if (hm !== s.time || !s.days.includes(now.getDay()) || s.lastRun === today) return;
    settings.set(SCHED_KEY, Object.assign({}, settings.get(SCHED_KEY, {}) || {}, { lastRun: today }));
    enqueue(store.list().map((x) => x.domain), 'schedule', { report: true });
  };
  setInterval(tick, 60_000).unref();
}

module.exports = { overview, siteResult, enqueue, start, schedule, saveSchedule, scheduleView, sendReport };
