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

// Starts a login (or returns the one in progress) and resolves once the code is known (≤ 15 s).
function start(onDone) {
  if (job && !job.done) return waitCode();
  job = { startedAt: new Date().toISOString(), code: null, url: null, done: false, ok: false, account: null, error: null, out: '' };
  const j = job;
  const child = spawn('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'ssh', '--skip-ssh-key', '--web', '--scopes', SCOPES],
    { env: Object.assign({}, process.env, { HOME: '/root', BROWSER: 'true', GH_BROWSER: 'true', NO_COLOR: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (!j.ok && !j.error) j.error = (j.out.trim().split('\n').filter((l) => !/clipboard/i.test(l)).pop() || 'gh exited with ' + code).slice(0, 300);
    try { if (onDone) onDone(view()); } catch (_) {}
  });
  return waitCode();
}
async function waitCode() {
  for (let i = 0; i < 30 && job && !job.code && !job.done; i++) await new Promise((r) => setTimeout(r, 500));
  return view();
}

module.exports = { start, view, claim, use };
