'use strict';
// "Sign in with GitHub" from the panel: GitHub's device flow through `gh auth login --web`.
//
// The server's gh (HOME=/root) can hold several GitHub accounts; lib/sites/github.js picks, per repo,
// the account that can actually see it. Adding an account used to need a root shell. Here the panel
// starts the login, shows the one-time code and https://github.com/login/device, and gh finishes on
// its own once the code is approved in the browser — no token is ever typed into the panel.
// Only one login runs at a time; an unapproved one is stopped after 15 minutes.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execP } = require('../util');

const SCOPES = 'repo,read:org,admin:public_key';
const TIMEOUT_MS = 15 * 60_000;
let job = null;   // { startedAt, code, url, done, ok, account, error, out }

// Every GitHub connect needs a sign-in approved in the browser just before it: a successful login
// mints a one-time ticket naming the approved account; POST …/github/connect requires one (claim) and
// the connection is pinned to that account. Valid 20 minutes, until a connect with it succeeds (use).
const TICKET_MS = 20 * 60_000;
const tickets = new Map();   // id -> { account, at }
function claim(id) {
  const now = Date.now();
  for (const [k, t] of tickets) if (now - t.at > TICKET_MS) tickets.delete(k);
  const t = tickets.get(String(id || ''));
  return t ? t.account : null;
}
function use(id) { tickets.delete(String(id || '')); }

function view() {
  if (!job) return { running: false };
  return { running: !job.done, startedAt: job.startedAt, code: job.code, url: job.url, done: job.done, ok: job.ok, account: job.account, error: job.error, ticket: job.ticket || null };
}

// gh 2.40+ is needed: several accounts per host (`gh auth token --user`), `gh auth status` naming
// "account X", and the login flags below. Distro packages are often far older (Ubuntu 22.04: 2.4), and
// an old gh answers the login with "unknown flag" + its usage text. So: missing or older → install the
// current release from GitHub (official .deb, Debian/Ubuntu) before the first login.
const GH_MIN = [2, 40, 0];
const ENV = () => { const e = Object.assign({}, process.env, { HOME: '/root', BROWSER: 'true', GH_BROWSER: 'true', NO_COLOR: '1', GH_PROMPT_DISABLED: '1' }); delete e.GH_TOKEN; delete e.GITHUB_TOKEN; return e; };
// [major, minor, patch]; null = gh is not installed; 'unknown' = installed but it would not say
// (then nothing is installed over it — the login runs and reports gh's own error).
async function ghVersion() {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-ver-'));   // --version must not depend on root's gh config
  const r = await execP('gh', ['--version'], { timeout: 15_000, env: Object.assign({}, process.env, { GH_CONFIG_DIR: cfg, NO_COLOR: '1' }) });
  try { fs.rmSync(cfg, { recursive: true, force: true }); } catch (_) {}
  if (r.err && r.err.code === 'ENOENT') return null;
  const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec((r.stdout || '') + (r.stderr || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : 'unknown';
}
const older = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
let preparing = null;
async function ensureGh() {
  const v = await ghVersion();
  if (v === 'unknown') return 'unknown';
  if (v && older(v, GH_MIN) >= 0) return v.join('.');
  const have = v ? 'gh ' + v.join('.') : 'gh is not installed';
  const arch = (await execP('dpkg', ['--print-architecture'], { timeout: 10_000 })).stdout.trim();
  if (!arch) throw Object.assign(new Error(have + ' — GitHub sign-in needs gh ' + GH_MIN.join('.') + ' or newer; install it from https://cli.github.com'), { status: 424 });
  const rel = await fetch('https://api.github.com/repos/cli/cli/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sb-srv-mon' }, signal: AbortSignal.timeout(30_000) }).then((r) => r.json());
  const asset = (rel.assets || []).find((a) => a.name === 'gh_' + String(rel.tag_name || '').replace(/^v/, '') + '_linux_' + arch + '.deb');
  if (!asset) throw Object.assign(new Error(have + ' — no gh release package for ' + arch + '; install gh ' + GH_MIN.join('.') + '+ from https://cli.github.com'), { status: 424 });
  const deb = path.join(os.tmpdir(), asset.name);
  const buf = Buffer.from(await (await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180_000) })).arrayBuffer());
  fs.writeFileSync(deb, buf);
  const r = await execP('dpkg', ['-i', deb], { timeout: 180_000, env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' }) });
  try { fs.unlinkSync(deb); } catch (_) {}
  const now = await ghVersion();
  if (r.err || !Array.isArray(now) || older(now, GH_MIN) < 0) throw Object.assign(new Error('updating gh failed (' + have + ')'), { status: 500, detail: (r.stderr || r.stdout || '').slice(-800) });
  console.log('gh updated: ' + have + ' → ' + now.join('.'));
  return now.join('.');
}
// gh's own complaint, not the last line of the usage text it prints after it.
function ghError(out, code) {
  const lines = out.split('\n').map((l) => l.trim()).filter((l) => l && !/clipboard/i.test(l));
  const hit = lines.find((l) => /unknown (flag|command)|^error|failed|not supported|invalid|denied|expired|GH_TOKEN|already logged/i.test(l));
  const usage = lines.findIndex((l) => /^Usage:/.test(l));
  return (hit || (usage > 0 ? lines[usage - 1] : lines.pop()) || 'gh exited with ' + code).slice(0, 300);
}

// Starts a login (or returns the one in progress) and resolves once the code is known.
async function start(onDone) {
  if (job && !job.done) return waitCode();
  if (!preparing) preparing = ensureGh().finally(() => { preparing = null; });
  let ver;
  try { ver = await preparing; }
  catch (e) { job = { startedAt: new Date().toISOString(), done: true, ok: false, error: e.message, out: '' }; return view(); }
  if (job && !job.done) return waitCode();
  job = { startedAt: new Date().toISOString(), code: null, url: null, done: false, ok: false, account: null, error: null, out: '', gh: ver };
  const j = job;
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--web', '--scopes', SCOPES],
    { env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => { j.error = 'not approved within 15 minutes — start again'; try { child.kill('SIGTERM'); } catch (_) {} }, TIMEOUT_MS);
  const onData = (d) => {
    j.out += d.toString();
    const c = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(j.out); if (c) j.code = c[1];
    const u = /(https:\/\/github\.com\/login\/device\S*)/.exec(j.out); if (u) j.url = u[1];
    const a = /Logged in as (\S+)/.exec(j.out); if (a) j.account = a[1];
  };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.on('error', (e) => { j.error = e.message; });
  child.on('close', (code) => {
    clearTimeout(timer);
    j.done = true; j.ok = code === 0;
    if (j.ok && !j.account) { const a = /account (\S+)/.exec(j.out); if (a) j.account = a[1]; }
    if (j.ok && j.account) { j.ticket = crypto.randomBytes(18).toString('hex'); tickets.set(j.ticket, { account: j.account, at: Date.now() }); }
    else if (j.ok) { j.ok = false; j.error = 'signed in, but gh did not say which account — try again'; }
    if (!j.ok && !j.error) j.error = ghError(j.out, code) + ' (gh ' + ver + ')';
    try { if (onDone) onDone(view()); } catch (_) {}
  });
  return waitCode();
}
async function waitCode() {
  for (let i = 0; i < 30 && job && !job.code && !job.done; i++) await new Promise((r) => setTimeout(r, 500));
  return view();
}

module.exports = { start, view, claim, use };
