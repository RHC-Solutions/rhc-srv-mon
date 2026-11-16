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

const bad = (msg, status) => Object.assign(new Error(msg), { status: status || 400 });
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
  if (!validUsername(user)) throw bad('invalid user name');
  if (getent(user)) throw bad('unix user ' + user + ' already exists', 409);
  await run('useradd', ['-m', '-k', SKEL_SITE, '-s', '/bin/bash', '-d', '/home/' + user, user]);
  if (password) await setPassword(user, password);
  await resetPermissions(user);
}
async function setPassword(user, password) {
  if (!validUsername(user)) throw bad('invalid user name');
  if (!getent(user)) throw bad('unknown unix user ' + user, 404);
  if (/[\n:]/.test(password)) throw bad('password contains an illegal character');
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
// Give everything under `dir` that is not owned by `user` back to it (user:primary group). Used wherever
// files can arrive with someone else's owner: copies/restores/moves from another server keep that
// server's numeric uids, an admin ran git or npm as root, etc.
//   - never follows symlinks (find -P; chown -h changes the link itself);
//   - skips regular files with more than one hard link: shared pnpm-store inodes (chowning them steals
//     them from every other project) — and a planted hard link to a system file can never be taken over.
//     opts.all chowns those too; only for trees the panel itself just unpacked (cluster move).
//   - files of the site's own SSH users (primary group = the site's group) are NOT misowned: those users
//     run the site's apps under their own pm2, and taking their files away broke every site that keeps
//     private files (data/, *.key, a 700 build dir) or rewrites its own files (copyFile/chmod need the
//     owner) — 2026-11-16: rhcsolutions.com lost package.json, eurotrip2026 its db.key, hh.maison its
//     build. Only the docroot itself and .git are always the site user's (git's dubious-ownership check);
//   - afterwards everything gets group rw (dirs +x), so git as the site user and the apps as its SSH
//     users can both read and write the whole tree.
// Returns { fixed, before } — files that were misowned, and how many still are afterwards.
function groupMembers(ent) {
  try {
    return fs.readFileSync('/etc/passwd', 'utf8').split('\n').map((l) => l.split(':'))
      .filter((f) => f.length > 3 && Number(f[3]) === ent.gid && Number(f[2]) !== ent.uid).map((f) => f[2]);
  } catch (_) { return []; }
}
async function fixOwnership(user, dir, opts) {
  opts = opts || {};
  const ent = getent(user);
  if (!ent || !validUsername(user)) throw bad('unknown site user ' + user, 424);
  if (!fs.existsSync(dir)) return { fixed: 0, before: 0 };
  const sel = opts.all ? [] : ['(', '-type', 'd', '-o', '-type', 'l', '-o', '-links', '1', ')'];
  const uid = String(ent.uid), gitDir = path.join(dir, '.git');
  const others = ['-not', '-uid', uid, ...groupMembers(ent).flatMap((u) => ['-not', '-uid', u])];
  // three find runs: the docroot itself and .git (anything not the site user's), the rest (anything
  // owned by neither the site user nor one of its SSH users)
  const sets = [[dir, '-maxdepth', '0', '-not', '-uid', uid], [dir, '-path', gitDir, '-prune', '-o', ...sel, ...others]];
  if (fs.existsSync(gitDir)) sets.push([gitDir, ...sel, '-not', '-uid', uid]);
  const count = async () => {
    let n = 0;
    for (const s of sets) n += (await execP('find', [...s, '-printf', '.'], { timeout: 10 * 60_000, maxBuffer: 256 * 1024 * 1024 })).stdout.length;
    return n;
  };
  const before = await count();
  let err = '';
  if (before) {
    for (const s of sets) err += (await execP('find', [...s, '-exec', 'chown', '-h', ent.uid + ':' + ent.gid, '{}', '+'], { timeout: 30 * 60_000 })).stderr || '';
  }
  // group rw everywhere (never through a symlink, never on a shared pnpm-store inode)
  await execP('find', [dir, '(', '-type', 'd', '-o', '-type', 'f', '-links', '1', ')', '-not', '-perm', '-g=rw', '-exec', 'chmod', 'g+rwX', '{}', '+'], { timeout: 30 * 60_000 });
  await execP('find', [dir, '-type', 'd', '-not', '-perm', '-g=x', '-exec', 'chmod', 'g+x', '{}', '+'], { timeout: 30 * 60_000 });
  if (!before) return { fixed: 0, before: 0 };
  const after = await count();
  if (after && after === before) throw Object.assign(bad('could not change the owner of ' + dir + ' to ' + user, 500), { detail: err.slice(0, 800) });
  return { fixed: before - after, before, remaining: after };
}
// Cheap check (two stat calls) whether a checkout looks owned by `user`.
function ownedBy(user, dir) {
  const ent = getent(user); if (!ent) return false;
  try {
    if (fs.lstatSync(dir).uid !== ent.uid) return false;
    const g = path.join(dir, '.git');
    return !fs.existsSync(g) || fs.lstatSync(g).uid === ent.uid;
  } catch (_) { return true; }   // missing dir: nothing to fix, let the caller report it
}

// ~/.ssh/authorized_keys for a site or ssh user; refuses to write through a symlink (a user could plant one).
function writeAuthorizedKeys(user, keys) {
  const ent = getent(user); if (!ent) throw bad('unknown unix user ' + user, 404);
  const dir = path.join(ent.home, '.ssh'), file = path.join(dir, 'authorized_keys');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw bad('.ssh is a symlink — refusing', 409);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw bad('authorized_keys is a symlink — refusing', 409);
  const lines = String(keys || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (const l of lines) if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256))(@openssh\.com)?\s+[A-Za-z0-9+/=]+/.test(l) && !l.startsWith('#')) throw bad('not an SSH public key: ' + l.slice(0, 40));
  fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  fs.chownSync(dir, ent.uid, ent.gid); fs.chownSync(file, ent.uid, ent.gid); fs.chmodSync(dir, 0o700); fs.chmodSync(file, 0o600);
}

// SSH user: own uid, primary group = site group, skel, symlinks into the site home, site home → 750.
async function createSshUser(site, username, password, keys) {
  if (!validUsername(username)) throw bad('invalid user name');
  if (getent(username)) throw bad('unix user ' + username + ' already exists', 409);
  if (!getent(site.user)) throw bad('site user ' + site.user + ' does not exist', 409);
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
    await writeSudoers(username, site.user);
  } catch (e) {
    removeSudoers(username);
    // undo the useradd so a retry does not hit "already exists" for an account the panel does not know
    await execP('userdel', ['-r', username], { timeout: 60_000 });
    throw e;
  }
}
// sudo for SSH users: each one may run anything AS ITS SITE USER (sudo -u <site-user> …), without a
// password — the npm/pm2/artisan commands that need the app owner's uid. Not root: one leaked site
// login must not become the whole server. One drop-in per user, checked by visudo before it is
// installed; syncSudoers() (boot) adds missing rules and removes those of deleted users.
const SUDOERS_DIR = '/etc/sudoers.d';
const SUDO_PREFIX = 'rhc-ssh-';
const sudoFile = (u) => path.join(SUDOERS_DIR, SUDO_PREFIX + u);   // user names have no '.', which sudo would skip
async function writeSudoers(username, siteUser) {
  if (!validUsername(username) || !validUsername(siteUser)) throw bad('invalid user name');
  const body = '# managed by sb-srv-mon: SSH user ' + username + ' may act as its site user\n' + username + ' ALL=(' + siteUser + ') NOPASSWD: ALL\n';
  const file = sudoFile(username);
  try { if (fs.readFileSync(file, 'utf8') === body) return false; } catch (_) {}
  const tmp = path.join(SUDOERS_DIR, '.' + SUDO_PREFIX + username + '.tmp');   // dot: sudo ignores it while unchecked
  fs.writeFileSync(tmp, body, { mode: 0o440 });
  const r = await execP('visudo', ['-cqf', tmp], { timeout: 20_000 });
  if (r.err) { try { fs.unlinkSync(tmp); } catch (_) {} throw new Error('sudoers rule for ' + username + ' rejected by visudo: ' + (r.stderr || r.stdout).trim()); }
  fs.renameSync(tmp, file);
  return true;
}
function removeSudoers(username) { try { fs.unlinkSync(sudoFile(username)); return true; } catch (_) { return false; } }
async function syncSudoers() {
  const want = new Map();
  for (const u of store.sshUsers.all()) { const s = store.getById(u.site_id); if (s && getent(u.username) && validUsername(u.username)) want.set(u.username, s.user); }
  const out = { added: [], removed: [] };
  for (const [u, site] of want) { try { if (await writeSudoers(u, site)) out.added.push(u); } catch (e) { console.error('sudoers:', e.message); } }
  let files = []; try { files = fs.readdirSync(SUDOERS_DIR); } catch (_) {}
  for (const f of files) if (f.startsWith(SUDO_PREFIX) && !want.has(f.slice(SUDO_PREFIX.length)) && removeSudoers(f.slice(SUDO_PREFIX.length))) out.removed.push(f.slice(SUDO_PREFIX.length));
  if (out.added.length || out.removed.length) console.log('sudoers: added ' + (out.added.join(', ') || '-') + '; removed ' + (out.removed.join(', ') || '-'));
  return out;
}

// FTP user: no home dir, /bin/false, site group + ftp-user (proftpd DefaultRoot chroot).
async function createFtpUser(site, username, home, password) {
  if (!validUsername(username)) throw bad('invalid user name');
  if (getent(username)) throw bad('unix user ' + username + ' already exists', 409);
  const real = fs.realpathSync(home);
  if (!real.startsWith('/home/' + site.user + '/')) throw bad('home must be inside /home/' + site.user);
  try { await run('getent', ['group', 'ftp-user']); } catch (_) { await run('groupadd', ['ftp-user']); }
  await run('useradd', ['-M', '-s', '/bin/false', '-d', real, '-g', site.user, '-G', 'ftp-user', username]);
  if (password) await setPassword(username, password);
}

// The only path that ever runs userdel. Refuses anything the panel does not own or that looks like a system account.
async function deleteUnixUser(username, opts) {
  opts = opts || {};
  const ent = getent(username);
  if (!ent) return { removed: false, reason: 'no such unix user' };
  if (!validUsername(username) || DENY.has(username)) throw bad('refusing to delete ' + username, 409);
  if (!store.knownUnixUsers().has(username)) throw bad('refusing to delete ' + username + ': not a user managed by this panel', 409);
  if (ent.uid < 1000) throw bad('refusing to delete ' + username + ': system uid ' + ent.uid, 409);
  if (!ent.home.startsWith('/home/')) throw bad('refusing to delete ' + username + ': home ' + ent.home + ' is outside /home', 409);
  // stop everything the user runs (pm2 daemons, node apps, lingering shells), then remove the account
  await execP('pkill', ['-TERM', '-u', username]);
  await new Promise((r) => setTimeout(r, 1500));
  await execP('pkill', ['-KILL', '-u', username]);
  await execP('loginctl', ['terminate-user', username]);
  const args = opts.keepHome ? [username] : ['-r', username];
  removeSudoers(username);
  const r = await execP('userdel', args, { timeout: 5 * 60_000 });
  if (r.err && getent(username)) throw new Error('userdel failed: ' + (r.stderr || r.err.message).trim());
  // userdel keeps the user's own group while it still has members (the site group lists www-data),
  // and a group left behind makes the next useradd of that name fail. Remove it when it is the
  // user's own group and no remaining account has it as its primary group.
  let groupRemoved = false;
  const grp = await execP('getent', ['group', username]);
  if (!grp.err && grp.stdout.trim()) {
    const gid = grp.stdout.trim().split(':')[2];
    const primaries = (await execP('getent', ['passwd'])).stdout.split('\n').filter((l) => l.split(':')[3] === gid);
    if (gid === String(ent.gid) && !primaries.length) groupRemoved = !(await execP('groupdel', [username])).err;
  }
  return { removed: true, home: ent.home, keptHome: !!opts.keepHome, groupRemoved };
}

module.exports = { validUsername, getent, groupOf, createSiteUser, setPassword, resetPermissions, fixOwnership, ownedBy, writeAuthorizedKeys, createSshUser, createFtpUser, deleteUnixUser, syncSudoers, SKEL_SITE, SKEL_SSH };
