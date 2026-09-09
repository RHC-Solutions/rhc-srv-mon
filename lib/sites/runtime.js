'use strict';
// The Node.js runtime a site needs before its app can run: an interpreter of its own, pm2, and a
// systemd unit that keeps pm2 alive when nobody is logged in.
//
// Two things this host taught us the hard way:
//   * `site_nodejs.node_version` used to be pure bookkeeping — every app ran the system node while
//     the record claimed otherwise. Creation now installs the version it records, under the site
//     user's own nvm, which is the layout the CloudPanel-era sites on this box already use.
//   * pm2 started from an SSH session lives in that session's systemd scope and dies with it, which
//     is how closing a session took sites down on 2026-09-06. `loginctl enable-linger` plus the
//     pm2-<user> unit is what makes a site survive both logout and reboot.
//
// Every step here is best-effort and reports what it did. A site whose nvm download failed is still
// a working site on the system node, and unwinding an otherwise-good creation over it would be a
// worse outcome than saying plainly that the runtime step did not finish.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NVM_VERSION = 'v0.40.1';
const NVM_INSTALL = 'https://raw.githubusercontent.com/nvm-sh/nvm/' + NVM_VERSION + '/install.sh';
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const strip = (s) => String(s || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const tail = (s, n) => strip(s).trim().split('\n').slice(-(n || 4)).join('\n').slice(0, 2000);

function run(argv, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: opts.timeout || 120_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ ok: !err, output: tail((stdout || '') + (stderr || ''), opts.lines) }));
  });
}
// Anything that must run as the site user: login shell so ~/.nvm is on PATH, cwd in its own home
// (pm2 spawns the app from its cwd, and the panel's /root cwd would make that spawn EACCES).
function asUser(user, script, opts) {
  if (!USER_RE.test(user)) throw Object.assign(new Error('invalid unix user'), { status: 400 });
  return run(['sudo', '-n', '-H', '-u', user, 'bash', '-lc', 'cd ~ && ' + script], opts);
}

const nvmDir = (user) => '/home/' + user + '/.nvm';
const nvmSh = (user) => nvmDir(user) + '/nvm.sh';
const withNvm = (script) => '. ~/.nvm/nvm.sh >/dev/null 2>&1 || true; ' + script;

// The interpreter nvm actually put on disk for a requested major ("26" -> /home/u/.nvm/…/v26.8.1/bin).
function nvmBinDir(user, version) {
  const dir = nvmDir(user) + '/versions/node';
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const want = String(version || '').replace(/^v/, '').split('.')[0];
  const match = names.filter((n) => /^v\d+\./.test(n) && (!want || n.slice(1).split('.')[0] === want))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const pick = match.length ? match[match.length - 1] : null;
  return pick ? path.join(dir, pick, 'bin') : null;
}

// nvm itself. PROFILE=/dev/null keeps the installer out of the dotfiles — the wiring below is ours,
// and a second copy appended by the installer would double-source on every login.
async function installNvm(user) {
  if (fs.existsSync(nvmSh(user))) return { ok: true, output: 'already installed', skipped: true };
  return asUser(user, 'export PROFILE=/dev/null NVM_DIR="$HOME/.nvm"; curl -fsSL ' + NVM_INSTALL + ' | bash', { timeout: 180_000 });
}
// So an operator who SSHes in as the site user just has node and pm2 on PATH.
function wireProfile(user) {
  const rc = '/home/' + user + '/.bashrc';
  const marker = '# >>> rhc-srv-mon node runtime >>>';
  let cur = ''; try { cur = fs.readFileSync(rc, 'utf8'); } catch (_) {}
  if (cur.includes(marker)) return { ok: true, output: 'already wired', skipped: true };
  const block = '\n' + marker + '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\nexport PM2_HOME="$HOME/.pm2"\n# <<< rhc-srv-mon node runtime <<<\n';
  try {
    fs.appendFileSync(rc, block);
    const st = fs.statSync('/home/' + user);
    fs.chownSync(rc, st.uid, st.gid);
    return { ok: true, output: 'added nvm + PM2_HOME to .bashrc' };
  } catch (e) { return { ok: false, output: e.message }; }
}
async function installNode(user, version) {
  const v = String(version || '').trim();
  if (!/^\d{1,2}(\.\d+){0,2}$/.test(v)) return { ok: false, output: 'invalid node version "' + v + '"' };
  return asUser(user, withNvm('nvm install ' + v + ' && nvm alias default ' + v + ' && node -v'), { timeout: 10 * 60_000 });
}
async function installPm2(user) {
  return asUser(user, withNvm('npm install -g pm2 && pm2 -v'), { timeout: 10 * 60_000 });
}
// Without linger, the user's processes are torn down when their last session ends — the failure
// mode that took sites down on 2026-09-06.
async function enableLinger(user) {
  if (!USER_RE.test(user)) throw Object.assign(new Error('invalid unix user'), { status: 400 });
  return run(['loginctl', 'enable-linger', user], { timeout: 30_000 });
}
// `pm2 startup` writes a system unit; run as root it needs to be told whose, and given a PATH that
// contains the site's own node, or the unit starts pm2 under an interpreter the site does not use.
//
// The unit is Type=forking with PIDFile=$PM2_HOME/pm2.pid, which means systemd must be the thing
// that starts the daemon. If the daemon a login session already spawned is still up, `pm2 resurrect`
// simply talks to it and exits without forking, no pid file appears, and systemd fails the start as
// a protocol error. So the session daemon is killed first and systemd told to bring up its own —
// which is the state we actually want anyway: a daemon owned by systemd rather than by a session
// that ends when someone closes a terminal.
async function pm2Startup(user, version) {
  const bin = nvmBinDir(user, version);
  if (!bin) return { ok: false, output: 'no nvm interpreter to point the unit at' };
  const pm2 = path.join(bin, 'pm2');
  if (!fs.existsSync(pm2)) return { ok: false, output: 'pm2 is not installed under ' + bin };
  const r = await run(['env', 'PATH=' + bin + ':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    pm2, 'startup', 'systemd', '-u', user, '--hp', '/home/' + user], { timeout: 120_000 });
  if (!r.ok) return r;
  await asUser(user, withNvm('pm2 kill'), { timeout: 60_000 }).catch(() => null);
  await run(['systemctl', 'reset-failed', 'pm2-' + user], { timeout: 30_000 }).catch(() => null);
  const en = await run(['systemctl', 'enable', '--now', 'pm2-' + user], { timeout: 120_000 });
  if (!en.ok) return { ok: false, output: (r.output + '\n' + en.output).trim() };
  const act = await run(['systemctl', 'is-active', 'pm2-' + user], { timeout: 30_000 });
  return { ok: act.output.trim() === 'active', output: 'pm2-' + user + '.service is ' + act.output.trim() };
}

// A placeholder the operator is meant to replace, but that answers on the assigned port right away —
// otherwise a freshly created site 502s and there is no way to tell "not written yet" from "broken".
function appJs(site, port) {
  return `// Placeholder app created with the site — replace it with your own.
// pm2 runs this from ecosystem.config.js; PORT is the port nginx proxies to.
const http = require('http');

const port = Number(process.env.PORT) || ${port};
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h1>${site.domain}</h1><p>Node ' + process.version + ' on port ' + port + '.</p>\\n');
}).listen(port, '127.0.0.1', () => console.log('${site.domain} listening on 127.0.0.1:' + port));
`;
}
function ecosystem(site, port, docroot) {
  return `// pm2 process definition for ${site.domain}. \`pm2 start ecosystem.config.js\` from this directory.
module.exports = {
  apps: [{
    name: ${JSON.stringify(site.domain)},
    script: 'app.js',
    cwd: ${JSON.stringify(docroot)},
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '512M',
    env: { NODE_ENV: 'production', PORT: ${port} },
    out_file: ${JSON.stringify('/home/' + site.user + '/logs/nodejs/out.log')},
    error_file: ${JSON.stringify('/home/' + site.user + '/logs/nodejs/error.log')},
  }],
};
`;
}
// Never clobber an app that is already there: a re-run of provisioning on an existing site must not
// overwrite the operator's code with the placeholder.
function seedFiles(site, port) {
  const docroot = path.join('/home', site.user, 'htdocs', site.domain);
  const logs = path.join('/home', site.user, 'logs', 'nodejs');
  const wrote = [];
  let uid = 0, gid = 0;
  try { const st = fs.statSync('/home/' + site.user); uid = st.uid; gid = st.gid; } catch (_) {}
  // chmod after mkdir/write: the mode argument is masked by the umask, chmod is not.
  try { fs.mkdirSync(logs, { recursive: true, mode: 0o750 }); fs.chmodSync(logs, 0o750); fs.chownSync(logs, uid, gid); } catch (_) {}
  for (const [name, body] of [['app.js', appJs(site, port)], ['ecosystem.config.js', ecosystem(site, port, docroot)]]) {
    const f = path.join(docroot, name);
    if (fs.existsSync(f)) continue;
    try { fs.writeFileSync(f, body, { mode: 0o640 }); fs.chmodSync(f, 0o640); fs.chownSync(f, uid, gid); wrote.push(name); } catch (_) {}
  }
  return { ok: true, output: wrote.length ? 'wrote ' + wrote.join(' and ') : 'left the existing app in place', wrote };
}
async function startApp(site) {
  const docroot = path.join('/home', site.user, 'htdocs', site.domain);
  return asUser(site.user, withNvm('cd ' + JSON.stringify(docroot) + ' && pm2 start ecosystem.config.js --update-env && pm2 save'), { timeout: 120_000 });
}

// Everything a new Node.js site needs, in order. `say` records a step the same way createSite does.
async function provisionNode(site, port, say) {
  const steps = [];
  const step = async (name, fn) => {
    let r; try { r = await fn(); } catch (e) { r = { ok: false, output: e.message }; }
    steps.push({ name, ok: !!r.ok, skipped: !!r.skipped, output: r.output });
    say('runtime: ' + name + (r.ok ? '' : ' — FAILED'), r.output);
    return r;
  };
  const nvm = await step('installed nvm ' + NVM_VERSION, () => installNvm(site.user));
  if (!nvm.ok) return { ok: false, steps };
  await step('wired nvm into the login shell', () => wireProfile(site.user));
  const node = await step('installed Node.js ' + site.nodejs.node_version, () => installNode(site.user, site.nodejs.node_version));
  if (!node.ok) return { ok: false, steps };
  const pm2 = await step('installed pm2', () => installPm2(site.user));
  if (!pm2.ok) return { ok: false, steps };
  await step('enabled linger so pm2 survives logout', () => enableLinger(site.user));
  // Seed and start before the unit is installed: `pm2 save` has to have written dump.pm2, or the
  // systemd-owned daemon comes up with nothing to resurrect.
  await step('seeded app.js and ecosystem.config.js', async () => seedFiles(site, port));
  await step('started the app under pm2', () => startApp(site));
  await step('handed pm2 to the pm2-' + site.user + ' systemd unit', () => pm2Startup(site.user, site.nodejs.node_version));
  return { ok: steps.every((s) => s.ok), steps };
}

module.exports = { provisionNode, installNvm, installNode, installPm2, enableLinger, pm2Startup, wireProfile, seedFiles, startApp, nvmBinDir, NVM_VERSION };
