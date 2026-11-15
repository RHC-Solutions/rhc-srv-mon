'use strict';
// Claude Code Remote Control for every site: `claude remote-control` running as the site user in the
// site's folder, so the site shows up by name (its folder = its domain) in claude.ai/code and the
// Claude mobile app, ready to work on — always on, restarted when it stops.
//
//   on/off   shared default (Settings → Sites & apps: claudeRemote, default on) and per site
//            (site → Settings: on | off | default).
//   runs as  a systemd unit per site, sb-claude-rc-<domain>.service, User=<site user>,
//            WorkingDirectory=<docroot>, Restart=always. The panel marks the docroot trusted in the
//            user's ~/.claude.json (the one-time "trust this folder" prompt) — the user's own folder.
//   sign-in  Remote Control needs the site user signed in to claude.ai (once per user). The panel runs
//            `claude auth login` as the user: shows the link, takes the code pasted back, done.
//   ensure   every 5 min (and on any change): unit enabled+running where it should run, stopped and
//            disabled where not (off, not installed, not signed in).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execP } = require('../util');
const { settings } = require('../db');
const store = require('./store');
const users = require('./users');

const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const key = (d) => 'site.claude-rc:' + String(d).toLowerCase();
const unitName = (domain) => 'sb-claude-rc-' + String(domain).toLowerCase().replace(/[^a-z0-9.-]/g, '-') + '.service';
const unitFile = (domain) => '/etc/systemd/system/' + unitName(domain);
const docroot = (site) => '/home/' + site.user + '/htdocs/' + (site.root_dir || site.domain);
// Who runs it: the site user if signed in to claude.ai, else the first of the site's SSH users that
// is (they share the site's group and work in its folder — often the one already using Claude Code).
async function runner(site, fresh) {
  const cands = [site.user, ...store.sshUsers.list(site.id).map((u) => u.username)].filter((u, i, a) => u && a.indexOf(u) === i && users.getent(u));
  const seen = [];
  for (const u of cands) { const a = await auth(u, fresh); seen.push(Object.assign({ user: u }, a)); if (a.installed && a.loggedIn) return { user: u, auth: a, candidates: seen }; }
  return { user: null, auth: null, candidates: seen };
}

function sharedDefault() { const d = require('./overrides').sharedDefaults(); return d.claudeRemote !== false; }
// 'on' | 'off' | 'default'
function mode(domain) { const c = settings.get(key(domain), null); return c && ['on', 'off'].includes(c.mode) ? c.mode : 'default'; }
function enabled(domain) { const m = mode(domain); return m === 'default' ? sharedDefault() : m === 'on'; }
function setMode(domain, m) {
  if (!['on', 'off', 'default'].includes(m)) throw bad('mode must be on, off or default');
  settings.set(key(domain), { mode: m });
}

// signed-in state of a user, cached 5 min (claude auth status takes a second)
const authCache = new Map();
async function auth(user, fresh) {
  const hit = authCache.get(user);
  if (hit && !fresh && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const r = await execP('sudo', ['-n', '-H', '-u', user, 'bash', '-lc', '~/.local/bin/claude auth status --json 2>/dev/null'], { timeout: 30_000 });
  let v = { installed: !(r.err && /No such file|not found/.test((r.stderr || '') + (r.stdout || ''))), loggedIn: false, email: null };
  try { const j = JSON.parse(r.stdout); v = { installed: true, loggedIn: !!j.loggedIn, email: j.email || null, org: j.orgName || null, method: j.authMethod || null }; } catch (_) {}
  authCache.set(user, { at: Date.now(), v });
  return v;
}

// mark the docroot trusted for the site user (what the first interactive `claude` there would ask)
function trust(site, user) {
  const ent = users.getent(user || site.user); if (!ent) return;
  const f = path.join(ent.home, '.claude.json');
  let j = {}; try { if (fs.lstatSync(f).isSymbolicLink()) return; j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  const dir = docroot(site);
  j.projects = j.projects || {};
  // Remote Control being switched on for the site (panel setting) is the admin's answer to the
  // one-time "Enable Remote Control? (y/n)" — which a service without a terminal cannot answer.
  if (j.projects[dir] && j.projects[dir].hasTrustDialogAccepted && j.remoteDialogSeen) return;
  j.remoteDialogSeen = true;
  j.projects[dir] = Object.assign({}, j.projects[dir], { hasTrustDialogAccepted: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2), { mode: 0o600 });
  try { fs.chownSync(f, ent.uid, ent.gid); } catch (_) {}
}

function unitText(site, user) {
  const ent = users.getent(user);
  return '# Managed by sb-srv-mon (lib/sites/claudeRemote.js) — Site → Settings → Claude Code Remote Control\n'
    + '[Unit]\nDescription=Claude Code Remote Control for ' + site.domain + ' (sb-srv-mon)\nAfter=network-online.target\nWants=network-online.target\n\n'
    + '[Service]\nUser=' + user + '\nGroup=' + (users.groupOf(ent.gid) || user) + '\nWorkingDirectory=' + docroot(site) + '\nUMask=0007\n'
    + 'Environment=HOME=' + ent.home + '\nEnvironment=PATH=' + ent.home + '/.local/bin:/usr/local/bin:/usr/bin:/bin\n'
    + 'ExecStart=' + ent.home + '/.local/bin/claude remote-control --name ' + site.domain + ' --spawn same-dir\n'
    + 'StandardInput=null\nRestart=always\nRestartSec=60\n\n[Install]\nWantedBy=multi-user.target\n';
}
const sysd = (args) => execP('systemctl', args, { timeout: 60_000 });
async function unitState(domain) {
  const r = await execP('systemctl', ['show', unitName(domain), '-p', 'ActiveState,SubState,UnitFileState,ActiveEnterTimestamp'], { timeout: 10_000 });
  const o = {}; for (const l of String(r.stdout || '').split('\n')) { const i = l.indexOf('='); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); }
  return { active: o.ActiveState === 'active', state: (o.ActiveState || '?') + '/' + (o.SubState || '?'), enabled: o.UnitFileState === 'enabled', since: o.ActiveEnterTimestamp || null, exists: fs.existsSync(unitFile(domain)) };
}

// Bring one site to what it should be. → { running, why }
async function ensure(site) {
  const want = enabled(site.domain);
  const docOk = fs.existsSync(docroot(site));
  const rn = want && docOk ? await runner(site) : null;
  const run = !!(rn && rn.user);
  if (run) {
    trust(site, rn.user);
    const txt = unitText(site, rn.user);
    let cur = null; try { cur = fs.readFileSync(unitFile(site.domain), 'utf8'); } catch (_) {}
    if (cur !== txt) { fs.writeFileSync(unitFile(site.domain), txt); await sysd(['daemon-reload']); if (cur) await sysd(['restart', unitName(site.domain)]); }
    const st = await unitState(site.domain);
    if (!st.enabled || !st.active) await sysd(['enable', '--now', unitName(site.domain)]);
    return { running: true };
  }
  if (fs.existsSync(unitFile(site.domain))) { await sysd(['disable', '--now', unitName(site.domain)]); }
  return { running: false, why: !want ? 'off' : !docOk ? 'no site folder' : 'no account of the site is signed in to claude.ai (' + ((rn && rn.candidates) || []).map((c) => c.user + (c.installed ? '' : ' — Claude Code not installed')).join(', ') + ')' };
}
let ensuring = false;
async function ensureAll() {
  if (ensuring) return; ensuring = true;
  try { for (const s of store.list()) { try { await ensure(s); } catch (e) { console.error('claude remote ' + s.domain + ':', e.message); } } }
  finally { ensuring = false; }
}
// a deleted site: its unit goes too
async function removeSite(domain) {
  if (fs.existsSync(unitFile(domain))) { await sysd(['disable', '--now', unitName(domain)]); try { fs.unlinkSync(unitFile(domain)); } catch (_) {} await sysd(['daemon-reload']); }
  settings.del(key(domain));
}

// The claude.ai environment link Remote Control printed (newest), from the unit's journal.
async function envUrl(domain) {
  const r = await execP('journalctl', ['-u', unitName(domain), '-n', '400', '-o', 'cat', '--no-pager'], { timeout: 15_000 });
  const all = [...String(r.stdout || '').matchAll(/https:\/\/claude\.ai\/code\?environment=env_[A-Za-z0-9]+/g)];
  return all.length ? all[all.length - 1][0] : null;
}
// last lines the unit wrote (why it fails, when it does) — ANSI/cursor codes stripped
async function lastLog(domain, n) {
  const r = await execP('journalctl', ['-u', unitName(domain), '-n', String(n || 12), '-o', 'cat', '--no-pager'], { timeout: 15_000 });
  return String(r.stdout || '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-(n || 12));
}
async function status(site) {
  const rn = await runner(site);
  const a = rn.auth || (rn.candidates[0] || { installed: false, loggedIn: false });
  const st = await unitState(site.domain);
  return { mode: mode(site.domain), sharedDefault: sharedDefault(), enabled: enabled(site.domain), user: rn.user || site.user, siteUser: site.user, accounts: rn.candidates, folder: docroot(site),
    installed: rn.candidates.some((c) => c.installed), loggedIn: !!rn.user, email: a.email || null, org: a.org || null, unit: unitName(site.domain), running: st.active, state: st.state, since: st.since,
    url: st.active ? await envUrl(site.domain) : null, log: st.exists && !st.active ? await lastLog(site.domain, 12) : [], login: loginView(site.user) };
}

// ---- sign-in: `claude auth login` as the site user; link out, code in
const logins = new Map();   // user -> { child, url, out, done, ok, error, at }
function loginView(user) { const l = logins.get(user); return l ? { running: !l.done, url: l.url, done: l.done, ok: l.ok, error: l.error } : null; }
async function loginStart(site) {
  const user = site.user;
  const cur = logins.get(user);
  if (cur && !cur.done && Date.now() - cur.at < 10 * 60_000) return loginView(user);
  if (cur && !cur.done) { try { cur.child.kill('SIGTERM'); } catch (_) {} }
  const child = spawn('sudo', ['-n', '-H', '-u', user, 'bash', '-lc', 'cd ~ && BROWSER=true ~/.local/bin/claude auth login --claudeai'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const l = { child, url: null, out: '', done: false, ok: false, error: null, at: Date.now() };
  logins.set(user, l);
  const onData = (d) => { l.out += d.toString(); const m = /(https:\/\/\S*oauth\/authorize\S+)/.exec(l.out); if (m) l.url = m[1]; };
  child.stdout.on('data', onData); child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => { if (!l.done) { l.error = 'not finished within 10 minutes — start again'; try { child.kill('SIGTERM'); } catch (_) {} } }, 10 * 60_000);
  child.on('close', async () => {
    clearTimeout(timer); l.done = true;
    const a = await auth(user, true).catch(() => null);
    l.ok = !!(a && a.loggedIn);
    if (!l.ok && !l.error) l.error = (l.out.trim().split('\n').filter((x) => x && !/oauth\/authorize|Opening browser|Paste code/i.test(x)).pop() || 'sign-in did not complete').slice(0, 300);
    if (l.ok) { for (const s of store.list()) ensure(s).catch(() => {}); }
  });
  for (let i = 0; i < 30 && !l.url && !l.done; i++) await new Promise((r) => setTimeout(r, 300));
  return loginView(user);
}
async function loginCode(site, code) {
  const l = logins.get(site.user);
  if (!l || l.done) throw bad('no sign-in is waiting for a code — start it again', 409);
  const c = String(code || '').trim();
  if (!c || c.length > 2000 || /\s/.test(c)) throw bad('paste the code exactly as claude.ai shows it');
  l.child.stdin.write(c + '\n');
  for (let i = 0; i < 60 && !l.done; i++) await new Promise((r) => setTimeout(r, 500));
  return loginView(site.user);
}

module.exports = { status, ensure, ensureAll, setMode, mode, enabled, removeSite, loginStart, loginCode, unitName };
