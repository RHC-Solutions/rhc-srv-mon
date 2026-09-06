'use strict';
// Unix accounts for sites: the site user (owner of /home/<user>), SSH users (own uid, site group,
// symlinked htdocs/logs/backups) and FTP users (no home, /bin/false, group ftp-user). Commands are
// the ones CloudPanel runs; deletion is guarded so this panel can only ever remove accounts it knows.
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('../config');
const { execP, execIn, USER_NAME_RE } = require('../util');
const store = require('./store');

const SKEL_SITE = path.join(APP_ROOT, 'resources', 'skel', 'site-user');
const SKEL_SSH = path.join(APP_ROOT, 'resources', 'skel', 'ssh-user');
const DENY = new Set(['root', 'clp', 'odin', 'mysql', 'postgres', 'www-data', 'nobody', 'proftpd', 'redis', 'varnish', 'memcache', 'sshd', 'systemd-network', 'messagebus']);

function validUsername(u) { return USER_NAME_RE.test(String(u || '')) && !DENY.has(u); }

function getent(user) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[0] === user);
    if (!line) return null;
    const f = line.split(':');
    return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), home: f[5], shell: f[6] };
  } catch (_) { return null; }
}
function groupOf(gid) {
  try { const line = fs.readFileSync('/etc/group', 'utf8').split('\n').find((l) => Number(l.split(':')[2]) === gid); return line ? line.split(':')[0] : null; } catch (_) { return null; }
}
async function run(cmd, args, opts) {
  const r = await execP(cmd, args, Object.assign({ timeout: 60_000 }, opts));
  if (r.err) throw new Error(cmd + ' ' + args.slice(0, 2).join(' ') + ' failed: ' + (r.stderr || r.stdout || r.err.message).trim().split('\n').pop());
  return r;
}

// useradd -m -k <skel> -s /bin/bash -d /home/<user> [-g <group>]; password via chpasswd (never on argv).
async function createSiteUser(user, password) {
  if (!validUsername(user)) throw new Error('invalid user name');
  if (getent(user)) throw new Error('unix user ' + user + ' already exists');
  await run('useradd', ['-m', '-k', SKEL_SITE, '-s', '/bin/bash', '-d', '/home/' + user, user]);
  if (password) await setPassword(user, password);
  await resetPermissions(user);
}
async function setPassword(user, password) {
  if (!validUsername(user)) throw new Error('invalid user name');
  if (!getent(user)) throw new Error('unknown unix user ' + user);
  if (/[\n:]/.test(password)) throw new Error('password contains an illegal character');
  const r = await execIn('chpasswd', [], user + ':' + password + '\n', { timeout: 20_000 });
  if (r.err) throw new Error('chpasswd failed: ' + (r.stderr || r.err.message).trim());
}
// CLP's resetPermissions: everything <user>:<user>, dirs+files 770, .ssh 700/600; home stays 750 if SSH users exist.
async function resetPermissions(user) {
  const home = '/home/' + user;
  if (!fs.existsSync(home)) return;
  await run('chown', ['-R', user + ':' + user, home], { timeout: 10 * 60_000 });
  await run('bash', ['-c', `find ${JSON.stringify(home)} -mindepth 1 -type d -exec chmod 770 {} + ; find ${JSON.stringify(home)} -type f -exec chmod 770 {} +`], { timeout: 10 * 60_000 });
  if (fs.existsSync(home + '/.ssh')) await run('bash', ['-c', `chmod 700 ${JSON.stringify(home + '/.ssh')}; find ${JSON.stringify(home + '/.ssh')} -type f -exec chmod 600 {} +`]);
  const hasSsh = store.byUser(user) ? store.sshUsers.list(store.byUser(user).id).length > 0 : false;
  fs.chmodSync(home, hasSsh ? 0o750 : 0o770);
}
// ~/.ssh/authorized_keys for a site or ssh user; refuses to write through a symlink (a user could plant one).
function writeAuthorizedKeys(user, keys) {
  const ent = getent(user); if (!ent) throw new Error('unknown unix user ' + user);
  const dir = path.join(ent.home, '.ssh'), file = path.join(dir, 'authorized_keys');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('.ssh is a symlink — refusing');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('authorized_keys is a symlink — refusing');
  const lines = String(keys || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256))(@openssh\.com)?\s+[A-Za-z0-9+/=]+/.test(l) && !l.startsWith('#')) throw new Error('not an SSH public key: ' + l.slice(0, 40));
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  fs.chownSync(dir, ent.uid, ent.gid); fs.chownSync(file, ent.uid, ent.gid); fs.chmodSync(dir, 0o700); fs.chmodSync(file, 0o600);
}

// SSH user: own uid, primary group = site group, skel, symlinks into the site home, site home → 750.
async function createSshUser(site, username, password, keys) {
  if (!validUsername(username)) throw new Error('invalid user name');
  if (getent(username)) throw new Error('unix user ' + username + ' already exists');
  if (!getent(site.user)) throw new Error('site user ' + site.user + ' does not exist');
  await run('useradd', ['-m', '-k', SKEL_SSH, '-s', '/bin/bash', '-d', '/home/' + username, '-g', site.user, username]);
  try {
    if (password) await setPassword(username, password);
    fs.chmodSync('/home/' + site.user, 0o750);
    await run('bash', ['-c', `chmod 700 ${JSON.stringify('/home/' + username + '/.ssh')}; find ${JSON.stringify('/home/' + username + '/.ssh')} -type f -exec chmod 600 {} +`]);
    const ent = getent(username);
    for (const d of ['htdocs', 'logs', 'backups']) {
      const link = '/home/' + username + '/' + d;
      try { fs.rmSync(link, { recursive: true, force: true }); } catch (_) {}
      fs.symlinkSync('/home/' + site.user + '/' + d, link);
      fs.lchownSync(link, ent.uid, ent.gid);
    }
    if (keys) writeAuthorizedKeys(username, keys);
  } catch (e) {
    // undo the useradd so a retry does not hit "already exists" for an account the panel does not know
    await execP('userdel', ['-r', username], { timeout: 60_000 });
    throw e;
  }
}
// FTP user: no home dir, /bin/false, site group + ftp-user (proftpd DefaultRoot chroot).
async function createFtpUser(site, username, home, password) {
  if (!validUsername(username)) throw new Error('invalid user name');
  if (getent(username)) throw new Error('unix user ' + username + ' already exists');
  const real = fs.realpathSync(home);
  if (!real.startsWith('/home/' + site.user + '/')) throw new Error('home must be inside /home/' + site.user);
  try { await run('getent', ['group', 'ftp-user']); } catch (_) { await run('groupadd', ['ftp-user']); }
  await run('useradd', ['-M', '-s', '/bin/false', '-d', real, '-g', site.user, '-G', 'ftp-user', username]);
  if (password) await setPassword(username, password);
}

// The only path that ever runs userdel. Refuses anything the panel does not own or that looks like a system account.
async function deleteUnixUser(username, opts) {
  opts = opts || {};
  const ent = getent(username);
  if (!ent) return { removed: false, reason: 'no such unix user' };
  if (!validUsername(username) || DENY.has(username)) throw new Error('refusing to delete ' + username);
  if (!store.knownUnixUsers().has(username)) throw new Error('refusing to delete ' + username + ': not a user managed by this panel');
  if (ent.uid < 1000) throw new Error('refusing to delete ' + username + ': system uid ' + ent.uid);
  if (!ent.home.startsWith('/home/')) throw new Error('refusing to delete ' + username + ': home ' + ent.home + ' is outside /home');
  // stop everything the user runs (pm2 daemons, node apps, lingering shells), then remove the account
  await execP('pkill', ['-TERM', '-u', username]);
  await new Promise((r) => setTimeout(r, 1500));
  await execP('pkill', ['-KILL', '-u', username]);
  await execP('loginctl', ['terminate-user', username]);
  const args = opts.keepHome ? [username] : ['-r', username];
  const r = await execP('userdel', args, { timeout: 5 * 60_000 });
  if (r.err && getent(username)) throw new Error('userdel failed: ' + (r.stderr || r.err.message).trim());
  return { removed: true, home: ent.home, keptHome: !!opts.keepHome };
}

module.exports = { validUsername, getent, groupOf, createSiteUser, setPassword, resetPermissions, writeAuthorizedKeys, createSshUser, createFtpUser, deleteUnixUser, SKEL_SITE, SKEL_SSH };
