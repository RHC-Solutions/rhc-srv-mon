#!/usr/bin/env node
'use strict';
// sbctl — command line for the SB SRV Manager panel (run as root on the server).
//
//   panel:  status | start | stop | restart | logs | check
//   login:  users | passwd <user> | 2fa-reset <user> | logout <user>|--all
//   sites:  sites | site <domain> [status|start|stop|restart|logs]
//
// Install once:  ln -s /opt/sb-srv-mon/bin/sbctl.js /usr/local/bin/sbctl
//
// Login changes are written to auth.json; the running panel watches that file and reloads it
// (lib/auth.js loadAuth({watch})). Site start/stop goes through the same code as the panel's
// buttons (lib/sites/procs.js) and sets/clears the same "held stopped" flag, so self-repair leaves
// a site stopped here alone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PM2_NAME = 'sb-srv-mon';
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')));
const args = argv.filter((a) => !a.startsWith('-'));
const optN = (() => { const i = argv.findIndex((a) => a === '-n' || a === '--lines'); const n = i >= 0 ? parseInt(argv[i + 1], 10) : NaN; if (i >= 0) args.splice(args.indexOf(argv[i + 1]), 1); return n > 0 ? n : 60; })();
const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? '\x1b[' + code + 'm' + s + '\x1b[0m' : String(s));
const green = (s) => c('32', s), red = (s) => c('31', s), yellow = (s) => c('33', s), dim = (s) => c('2', s), bold = (s) => c('1', s);
function die(msg, code) { console.error(red('✗ ') + msg); process.exit(code == null ? 1 : code); }
function done(code) { process.exit(code || 0); }   // lib modules may leave timers behind

const HELP = `${bold('sbctl')} — SB SRV Manager from the command line (run as root)

${bold('Panel')}
  sbctl status                 is the panel running, where it listens, pm2 state
  sbctl start | stop           start / stop the panel (stop asks first; -y skips)
  sbctl restart [--force]      check the code, then restart (--force skips the check)
  sbctl logs [-f] [-n 60]      panel log (-f follows)
  sbctl check                  syntax-check the code and the UI without restarting

${bold('Login')}
  sbctl users                  panel login users, 2FA state, open sessions
  sbctl passwd <user>          set a new password (logs the user out everywhere; --keep-sessions)
  sbctl 2fa-reset <user>       new authenticator secret — prints it to add in the app
  sbctl logout <user>|--all    end web sessions

${bold('Sites')}
  sbctl sites                  every site with its apps' state
  sbctl site <domain>          apps of one site (status)
  sbctl site <domain> start|stop|restart
                               like the panel buttons — stop holds the site stopped
                               (self-repair leaves it alone) until a start/restart
  sbctl site <domain> logs [-n 60]   pm2 logs of its apps + nginx error log
`;

function needRoot() { if (process.getuid && process.getuid() !== 0) die('run as root:  sudo sbctl ' + argv.join(' ')); }
function run(cmd, a, o) { return spawnSync(cmd, a, Object.assign({ encoding: 'utf8', cwd: '/root' }, o || {})); }

/* ------------------------------------------------------------------ panel */
function pm2Panel() {
  const r = run('pm2', ['jlist']);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).find((p) => p.name === PM2_NAME) || null; } catch (_) { return null; }
}
function ago(ms) { const s = Math.round(ms / 1000); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : s < 172800 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; }
async function probe() {
  const { PORT, HOST } = require(path.join(ROOT, 'lib/config'));
  const http = require('http');
  return new Promise((res) => {
    const rq = http.get({ host: HOST, port: PORT, path: '/api/auth/state', timeout: 3000 }, (r) => { r.resume(); res({ ok: true, code: r.statusCode, url: 'http://' + HOST + ':' + PORT }); });
    rq.on('timeout', () => { rq.destroy(); res({ ok: false, url: 'http://' + HOST + ':' + PORT, why: 'timeout' }); });
    rq.on('error', (e) => res({ ok: false, url: 'http://' + HOST + ':' + PORT, why: e.code || e.message }));
  });
}
async function cmdStatus() {
  const p = pm2Panel();
  if (process.getuid && process.getuid() !== 0) console.log(dim('● pm2 state needs root (sudo sbctl status)'));
  else if (!p) console.log(red('●') + ' panel is not in pm2 (' + PM2_NAME + ') — start it with: sbctl start');
  else {
    const e = p.pm2_env || {}, on = e.status === 'online';
    console.log((on ? green('●') : red('●')) + ' ' + bold(PM2_NAME) + '  ' + (on ? green(e.status) : red(e.status))
      + (on ? '  up ' + ago(Date.now() - e.pm_uptime) : '') + '  pid ' + (p.pid || '-') + '  restarts ' + (e.restart_time || 0)
      + '  mem ' + Math.round(((p.monit || {}).memory || 0) / 1048576) + ' MB');
  }
  const h = await probe();
  console.log((h.ok ? green('●') : red('●')) + ' ' + h.url + '  ' + (h.ok ? 'answering (HTTP ' + h.code + ')' : red('not answering: ' + h.why)));
  try { const g = run('git', ['-C', ROOT, 'log', '-1', '--format=%h %cr — %s']); if (g.status === 0) console.log(dim('  code: ' + g.stdout.trim())); } catch (_) {}
  return h.ok ? 0 : 1;
}

function check() { return require(path.join(ROOT, 'lib/selfcheck')).check(); }
function cmdCheck() {
  const r = check();
  if (r.bad.length) { console.log(red('✗ ') + r.bad.length + ' problem(s) in ' + r.files + ' files:'); for (const b of r.bad) console.log('  ' + b); return 1; }
  console.log(green('✓ ') + r.files + ' files compile, UI page builds');
  return 0;
}
async function waitUp(sec) {
  for (let i = 0; i < sec; i++) { await new Promise((r) => setTimeout(r, 1000)); const h = await probe(); if (h.ok) return true; }
  return false;
}
async function cmdStart() {
  needRoot();
  const p = pm2Panel();
  if (p && (p.pm2_env || {}).status === 'online') { console.log('already running'); return cmdStatus(); }
  const r = p ? run('pm2', ['start', PM2_NAME]) : run('pm2', ['start', path.join(ROOT, 'server.js'), '--name', PM2_NAME, '--cwd', '/root']);
  if (r.status !== 0) die('pm2 start failed:\n' + (r.stdout + r.stderr).trim());
  if (!p) run('pm2', ['save']);
  console.log((await waitUp(15)) ? green('✓ started') : yellow('! started, but it is not answering yet — sbctl logs'));
  return cmdStatus();
}
async function cmdStop() {
  needRoot();
  if (!flags.has('-y') && !flags.has('--yes') && !(await confirm('Stop the panel? The web UI, self-repair, backups and alerts stop with it. [y/N] '))) return 1;
  const r = run('pm2', ['stop', PM2_NAME]);
  if (r.status !== 0) die('pm2 stop failed:\n' + (r.stdout + r.stderr).trim());
  console.log(green('✓ stopped') + dim('  (sbctl start brings it back)'));
  return 0;
}
async function cmdRestart() {
  needRoot();
  if (!flags.has('--force')) {
    const r = check();
    if (r.bad.length) { console.log(red('✗ not restarting — the running panel stays up. Problems:')); for (const b of r.bad) console.log('  ' + b); console.log(dim('  (sbctl restart --force restarts anyway)')); return 1; }
    console.log(green('✓ ') + 'code check passed (' + r.files + ' files)');
  }
  if (!pm2Panel()) return cmdStart();
  const r = run('pm2', ['restart', PM2_NAME, '--update-env']);
  if (r.status !== 0) die('pm2 restart failed:\n' + (r.stdout + r.stderr).trim());
  if (await waitUp(20)) { console.log(green('✓ restarted')); return cmdStatus(); }
  console.log(red('✗ restarted, but it is not answering after 20s. Last log lines:'));
  const l = run('pm2', ['logs', PM2_NAME, '--nostream', '--lines', '30']); console.log((l.stdout || '') + (l.stderr || ''));
  return 1;
}
function cmdLogs() {
  const a = ['logs', PM2_NAME, '--lines', String(optN)];
  if (!flags.has('-f') && !flags.has('--follow')) a.push('--nostream');
  const r = spawnSync('pm2', a, { stdio: 'inherit', cwd: '/root' });
  return r.status || 0;
}

/* ------------------------------------------------------------------ login */
function prompt(q, hidden) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {   // piped input (scripts): one line per prompt
      process.stdout.write(q + '\n');
      pipedLines().then((lines) => resolve(lines.length ? lines.shift() : ''));
      return;
    }
    process.stdout.write(q);
    const stdin = process.stdin; let val = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch) => {
      for (const k of ch) {
        if (k === '\r' || k === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); process.stdout.write('\n'); return resolve(val); }
        if (k === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        if (k === '\u007f' || k === '\b') { if (val) { val = val.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } continue; }
        val += k; if (!hidden) process.stdout.write(k);
      }
    };
    stdin.on('data', on);
  });
}
let piped = null;
function pipedLines() {
  if (!piped) piped = new Promise((res) => { let buf = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { buf += d; }); process.stdin.on('end', () => res(buf.split('\n').map((l) => l.replace(/\r$/, '')))); });
  return piped;
}
async function confirm(q) { return /^y(es)?$/i.test((await prompt(q)).trim()); }

function authLib() { return require(path.join(ROOT, 'lib/auth')); }
function readAuth() {
  const { AUTH_FILE } = authLib();
  try { const d = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); d.users = d.users || []; d.sessions = d.sessions || {}; d.log = d.log || []; return d; }
  catch (e) { die('cannot read ' + AUTH_FILE + ': ' + e.message); }
}
function writeAuth(d) {
  const { AUTH_FILE } = authLib();
  d.log = d.log.slice(-200);
  fs.writeFileSync(AUTH_FILE + '.tmp', JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(AUTH_FILE + '.tmp', AUTH_FILE);
  fs.chmodSync(AUTH_FILE, 0o600);
}
// Apply a change to auth.json and make sure it sticks: the panel reloads the file within a second,
// but a login landing in that second makes it write its old copy back — so re-check, and re-apply.
async function changeAuth(mutate, sticks) {
  for (let i = 0; i < 3; i++) {
    const d = readAuth(); mutate(d); writeAuth(d);
    await new Promise((r) => setTimeout(r, 2500));
    if (sticks(readAuth())) return true;
  }
  return false;
}
function findUser(d, name) {
  const u = d.users.find((x) => x.username.toLowerCase() === String(name || '').toLowerCase());
  if (!u) die('no panel user "' + name + '" — users: ' + (d.users.map((x) => x.username).join(', ') || '(none — open the panel to create the first one)'));
  return u;
}
function logEntry(ev, user) { return { t: new Date().toISOString(), ev, ip: 'cli', ua: 'sbctl (' + (process.env.SUDO_USER || process.env.USER || 'root') + ')', user }; }
async function alert(text, ev, user) {
  try {
    require(path.join(ROOT, 'lib/events')).emit('auth.' + ev, { user, ip: 'cli', level: 'warn', message: text + ' (sbctl)', data: { by: process.env.SUDO_USER || 'root' } });
    await Promise.race([require(path.join(ROOT, 'lib/notify')).send('*🔐 ' + text + '*\nuser: `' + user + '`\nvia: sbctl on the server (' + (process.env.SUDO_USER || 'root') + ')', 'auth'), new Promise((r) => setTimeout(r, 8000))]);
  } catch (_) {}
}
function cmdUsers() {
  needRoot();
  const d = readAuth(), now = Date.now();
  if (!d.users.length) { console.log('no panel users yet — open the panel to create the first admin'); return 0; }
  for (const u of d.users) {
    const ss = Object.values(d.sessions).filter((s) => s && s.user === u.username && s.expires > now);
    const last = ss.reduce((m, s) => Math.max(m, s.seen || s.created || 0), 0);
    console.log(bold(u.username.padEnd(20)) + (u.totpSecret ? green('2FA on') : red('2FA off')) + '   ' + ss.length + ' session(s)' + (last ? dim('   last seen ' + ago(now - last) + ' ago') : '') + dim('   created ' + String(u.created || '?').slice(0, 10)));
  }
  return 0;
}
async function cmdPasswd(name) {
  needRoot();
  if (!name) die('usage: sbctl passwd <user>');
  const { pwHash, pwPolicy } = authLib();
  const user = findUser(readAuth(), name).username;
  const p1 = await prompt('New password for ' + user + ': ', true);
  const bad = pwPolicy(p1); if (bad) die(bad);
  const p2 = await prompt('Again: ', true);
  if (p1 !== p2) die('passwords do not match — nothing changed');
  const h = pwHash(p1), keep = flags.has('--keep-sessions');
  let ended = 0;
  const ok = await changeAuth((d) => {
    Object.assign(findUser(d, user), h);
    if (!keep) for (const [k, s] of Object.entries(d.sessions)) if (s && s.user === user) { delete d.sessions[k]; ended++; }
    d.log.push(logEntry('password_change', user));
  }, (d) => findUser(d, user).hash === h.hash);
  if (!ok) die('the panel kept overwriting auth.json — stop it (sbctl stop -y), run this again, then sbctl start');
  console.log(green('✓ ') + 'password changed for ' + user + (keep ? '' : ' — logged out of ' + ended + ' session(s)'));
  await alert('Password changed', 'password_change', user);
  return 0;
}
async function cmd2fa(name) {
  needRoot();
  if (!name) die('usage: sbctl 2fa-reset <user>');
  const { b32encode, totpUri } = authLib();
  const user = findUser(readAuth(), name).username;
  if (!flags.has('-y') && !(await confirm('Replace the authenticator of ' + user + '? The old one stops working. [y/N] '))) return 1;
  const secret = b32encode(crypto.randomBytes(20));
  const ok = await changeAuth((d) => { const u = findUser(d, user); u.totpSecret = secret; u.totpLast = null; delete u.totpPendingSecret; d.log.push(logEntry('mfa_reset', user)); },
    (d) => findUser(d, user).totpSecret === secret);
  if (!ok) die('the panel kept overwriting auth.json — stop it (sbctl stop -y), run this again, then sbctl start');
  console.log(green('✓ ') + 'new authenticator for ' + bold(user) + '. In the authenticator app choose "enter a setup key":\n');
  console.log('  key:     ' + bold(secret.replace(/(.{4})/g, '$1 ').trim()));
  console.log('  type:    time-based, 6 digits, 30 s\n');
  console.log(dim('  or paste into a QR generator / app that takes a link:\n  ' + totpUri(user, secret)));
  await alert('Authenticator reset', 'mfa_reset', user);
  return 0;
}
async function cmdLogout(name) {
  needRoot();
  const all = flags.has('--all');
  if (!name && !all) die('usage: sbctl logout <user> | --all');
  const user = all ? null : findUser(readAuth(), name).username;
  let n = 0;
  const ok = await changeAuth((d) => { n = 0; for (const [k, s] of Object.entries(d.sessions)) if (all || (s && s.user === user)) { delete d.sessions[k]; n++; } },
    (d) => !Object.values(d.sessions).some((s) => all || (s && s.user === user)));
  if (!ok) die('the panel kept overwriting auth.json — stop it (sbctl stop -y), run this again, then sbctl start');
  console.log(green('✓ ') + 'ended ' + n + ' session(s)' + (user ? ' of ' + user : ''));
  return 0;
}

/* ------------------------------------------------------------------ sites */
function siteLibs() {
  return { store: require(path.join(ROOT, 'lib/sites/store')), procs: require(path.join(ROOT, 'lib/sites/procs')), hold: require(path.join(ROOT, 'lib/sites/hold')), events: require(path.join(ROOT, 'lib/events')) };
}
const stCol = (s) => (s === 'online' ? green(s) : /stopp/.test(s) ? yellow(s) : red(s));
function procLine(p) {
  return '  ' + stCol(p.status).padEnd(tty ? 20 : 11) + ' ' + p.name.padEnd(28) + dim(' user ' + p.pm2User + (p.uptime_ms ? '  up ' + ago(p.uptime_ms) : '') + '  ↺ ' + (p.restarts || 0) + (p.memory ? '  ' + Math.round(p.memory / 1048576) + ' MB' : ''));
}
async function cmdSites() {
  needRoot();
  const { store, procs, hold } = siteLibs();
  const sites = store.list();
  for (const s of sites) {
    let ps = []; try { ps = (await procs.list(s, { live: true })).processes || []; } catch (_) {}
    const on = ps.filter((p) => p.status === 'online').length, held = hold.get(s.domain);
    const state = held ? yellow('stopped (held by ' + held.by + ')') : !ps.length ? dim('no node apps') : on === ps.length ? green(on + '/' + ps.length + ' online') : red(on + '/' + ps.length + ' online');
    console.log(bold(s.domain.padEnd(36)) + ' ' + String(s.type || '').padEnd(8) + ' ' + state + dim('   ' + s.user));
  }
  console.log(dim(sites.length + ' sites'));
  return 0;
}
async function cmdSite(domain, action) {
  needRoot();
  const { store, procs, hold, events } = siteLibs();
  if (!domain) die('usage: sbctl site <domain> [status|start|stop|restart|logs]');
  const site = store.get(domain) || store.get(domain.replace(/^www\./, ''));
  if (!site) die('no site ' + domain + ' — sbctl sites lists them');
  action = action || 'status';
  if (action === 'status') {
    const held = hold.get(site.domain);
    console.log(bold(site.domain) + dim('  ' + site.type + ', user ' + site.user) + (held ? '  ' + yellow('held stopped by ' + held.by + ' since ' + held.at.slice(0, 16).replace('T', ' ')) : ''));
    const ps = (await procs.list(site, { live: true })).processes || [];
    if (!ps.length) console.log(dim('  no pm2 apps'));
    for (const p of ps) console.log(procLine(p));
    return 0;
  }
  if (action === 'logs') {
    const homes = procs.pm2HomesFor(site);
    for (const h of homes) {
      console.log(bold('— pm2 (' + h.user + ')'));
      spawnSync('sudo', ['-n', '-H', '-u', h.user, 'env', 'PM2_HOME=' + h.pm2_home, 'pm2', 'logs', '--nostream', '--lines', String(optN)], { stdio: 'inherit', cwd: '/home/' + h.user });
    }
    const ng = '/home/' + site.user + '/logs/nginx/error.log';
    if (fs.existsSync(ng)) { console.log(bold('— nginx error.log')); spawnSync('tail', ['-n', String(optN), ng], { stdio: 'inherit' }); }
    return 0;
  }
  if (!['start', 'stop', 'restart'].includes(action)) die('unknown action "' + action + '" — status, start, stop, restart, logs');
  const before = await procs.list(site, { live: true });
  const r = await procs.act(site, action);
  const failed = r.results.filter((x) => !x.ok && !x.skipped);
  const by = 'cli:' + (process.env.SUDO_USER || 'root');
  if (!failed.length) {
    if (action === 'stop') hold.set(site.domain, by); else hold.clear(site.domain);
  }
  events.emit('site.pm2.' + action, { user: by, site: site.domain, level: failed.length ? 'error' : 'info', message: 'pm2 ' + action + ' ' + site.domain + ' (sbctl)' + (failed.length ? ' failed' : ''), data: { results: r.results.map((x) => ({ user: x.user, ok: x.ok, output: String(x.output || '').slice(0, 400) })) } });
  for (const x of r.results) console.log((x.ok ? green('✓ ') : x.skipped ? dim('- ') : red('✗ ')) + x.user + (x.output && (!x.ok || x.skipped) ? ': ' + String(x.output).trim().split('\n').slice(-4).join('\n    ') : ''));
  if (failed.length) return 1;
  if (action === 'stop') { console.log(yellow('held stopped') + dim(' — self-repair and the hold guard keep it down until sbctl site ' + site.domain + ' start')); return 0; }
  // A start that "worked" can still crash a second later — look again like the panel does.
  process.stdout.write(dim('checking the apps stay up… '));
  const h = await procs.health(site, { delayMs: 5000, before: before.processes });
  if (h && h.crashed && h.crashed.length) { console.log(red('✗ crashing')); console.log('  ' + procs.describeCrash(h).split('\n').join('\n  ')); return 1; }
  console.log(green('ok'));
  for (const p of (await procs.list(site, { live: true })).processes || []) console.log(procLine(p));
  return 0;
}

/* ------------------------------------------------------------------ main */
(async () => {
  const [cmd, a1, a2] = args;
  const map = {
    status: cmdStatus, start: cmdStart, stop: cmdStop, restart: cmdRestart, logs: cmdLogs, check: cmdCheck,
    users: cmdUsers, passwd: () => cmdPasswd(a1), password: () => cmdPasswd(a1), '2fa-reset': () => cmd2fa(a1), logout: () => cmdLogout(a1),
    sites: cmdSites, site: () => cmdSite(a1, a2),
  };
  if (!cmd || cmd === 'help' || flags.has('-h') || flags.has('--help')) { console.log(HELP); return done(0); }
  if (!map[cmd]) { console.error(red('unknown command: ' + cmd) + '\n'); console.log(HELP); return done(2); }
  try { done(await map[cmd]()); } catch (e) { die(e.message); }
})();
