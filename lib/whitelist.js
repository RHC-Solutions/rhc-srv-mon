'use strict';
// Admin IP whitelist (Settings → Whitelist): ONE list, applied everywhere it matters.
//
//   sshd    /etc/ssh/sshd_config.d/10-allowusers.conf  AllowUsers <user>@<ip> for the admin users
//           (root, odin, …) AND every site's SSH users — so SSH is reachable only from these IPs
//           /etc/ssh/sshd_config.d/90-root-password-admin-ips.conf  root may use a password from them
//   ufw     22/tcp ALLOW from each IP (comment "ssh allowlist"); rules no longer listed are removed
//   fail2ban ignoreip in /etc/fail2ban/jail.local — never banned; the panel's isAdminIp() reads it too
//
// Before this, the three were edited by hand and had drifted (fail2ban knew none of the IPs). The
// first read seeds the list from the existing sshd file, so nothing changes until someone edits it.
// sshd changes are validated with `sshd -t` and rolled back on failure; the list can never be
// emptied, and the address the change is made from cannot be removed (no locking yourself out).
const fs = require('fs');
const net = require('net');
const { settings, open } = require('./db');
const { execP } = require('./util');

const ALLOW_FILE = '/etc/ssh/sshd_config.d/10-allowusers.conf';
const ROOTPW_FILE = '/etc/ssh/sshd_config.d/90-root-password-admin-ips.conf';
const JAIL = '/etc/fail2ban/jail.local';
const KEY = 'admin.whitelist';
const UFW_COMMENT = 'ssh allowlist';
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });

function validEntry(x) {
  const [ip, len, extra] = String(x).split('/');
  if (extra !== undefined) return false;
  const v = net.isIP(ip);
  if (!v) return false;
  if (len === undefined) return true;
  const n = Number(len);
  return /^\d{1,3}$/.test(len) && n >= (v === 4 ? 8 : 16) && n <= (v === 4 ? 32 : 128);
}

// Seed from what sshd enforces today.
function seed() {
  let txt = ''; try { txt = fs.readFileSync(ALLOW_FILE, 'utf8'); } catch (_) {}
  const ips = [], admins = [];
  for (const m of txt.matchAll(/([a-z_][a-z0-9_-]*)@([0-9a-fA-F:.\/]+)/g)) {
    if (!admins.includes(m[1])) admins.push(m[1]);
    if (!ips.some((e) => e.ip === m[2]) && validEntry(m[2])) ips.push({ ip: m[2], label: '' });
  }
  return { ips, adminUsers: admins.length ? admins : ['root'] };
}
function get() {
  const v = settings.get(KEY, null);
  if (v && Array.isArray(v.ips)) return { ips: v.ips, adminUsers: v.adminUsers || ['root'] };
  return seed();
}

// Every unix user that serves a site over SSH: the site's own user and its extra SSH users.
function siteSshUsers() {
  const out = [];
  try { for (const r of open().prepare('SELECT user FROM sites ORDER BY id').all()) out.push(r.user); } catch (_) {}
  try { for (const r of open().prepare('SELECT username FROM ssh_users ORDER BY id').all()) out.push(r.username); } catch (_) {}
  return [...new Set(out)];
}

function renderAllow(wl) {
  const users = [...new Set([...wl.adminUsers, ...siteSshUsers()])];
  const pairs = [];
  for (const u of users) for (const e of wl.ips) pairs.push(u + '@' + e.ip);
  return '# Managed by rhc-srv-mon — edit in the panel: Settings → Whitelist. Manual edits are overwritten.\n'
    + '# SSH only for these users, and only from the admin IPs. Admin users: ' + wl.adminUsers.join(', ') + '; site users: ' + (siteSshUsers().join(', ') || 'none') + '\n'
    + 'AllowUsers ' + pairs.join(' ') + '\n';
}
function renderRootPw(wl, current) {
  const body = (current && /^\s*Match User root Address [^\n]*\n([\s\S]*)$/m.exec(current)) ? /^\s*Match User root Address [^\n]*\n([\s\S]*)$/m.exec(current)[1] : '    PermitRootLogin yes\n    PasswordAuthentication yes\n';
  return '# Managed by rhc-srv-mon (Settings → Whitelist): root may use a password, but only from the admin IPs.\n'
    + 'Match User root Address ' + wl.ips.map((e) => e.ip).join(',') + '\n' + body;
}

async function applySshd(wl, say) {
  const old = {}; for (const f of [ALLOW_FILE, ROOTPW_FILE]) { try { old[f] = fs.readFileSync(f, 'utf8'); } catch (_) { old[f] = null; } }
  const next = { [ALLOW_FILE]: renderAllow(wl), [ROOTPW_FILE]: renderRootPw(wl, old[ROOTPW_FILE]) };
  if (old[ALLOW_FILE] === next[ALLOW_FILE] && old[ROOTPW_FILE] === next[ROOTPW_FILE]) { say('sshd already up to date'); return; }
  for (const f of Object.keys(next)) fs.writeFileSync(f, next[f], { mode: 0o644 });
  const t = await execP('sshd', ['-t'], { timeout: 20_000 });
  if (t.err) {
    for (const f of Object.keys(old)) { if (old[f] == null) { try { fs.unlinkSync(f); } catch (_) {} } else fs.writeFileSync(f, old[f], { mode: 0o644 }); }
    throw bad('sshd rejected the new configuration — nothing changed', 500, (t.stderr || t.err.message).trim());
  }
  const r = await execP('systemctl', ['reload', 'ssh'], { timeout: 30_000 });
  if (r.err) throw bad('could not reload sshd', 500, r.stderr);
  say('sshd: AllowUsers for ' + [...new Set([...wl.adminUsers, ...siteSshUsers()])].join(', ') + ' from ' + wl.ips.length + ' IPs; reloaded');
}

async function applyUfw(wl, say) {
  const st = await execP('ufw', ['status', 'numbered'], { timeout: 20_000 });
  if (st.err || !/Status: active/.test(st.stdout)) { say('ufw not active — skipped'); return; }
  const rules = [];
  for (const line of st.stdout.split('\n')) {
    const m = /^\[\s*(\d+)\]\s+22\/tcp\s+ALLOW IN\s+(\S+)\s+#\s*(.*)$/.exec(line.trim());
    if (m && m[3].trim() === UFW_COMMENT) rules.push({ num: Number(m[1]), ip: m[2] });
  }
  const want = wl.ips.map((e) => e.ip);
  const add = want.filter((ip) => !rules.some((r) => r.ip === ip));
  const del = rules.filter((r) => !want.includes(r.ip)).sort((a, b) => b.num - a.num);   // highest number first: numbers shift on delete
  for (const ip of add) {
    const r = await execP('ufw', ['allow', 'from', ip, 'to', 'any', 'port', '22', 'proto', 'tcp', 'comment', UFW_COMMENT], { timeout: 30_000 });
    if (r.err) throw bad('ufw refused ' + ip, 500, r.stderr || r.stdout);
  }
  for (const r of del) {
    const x = await execP('ufw', ['--force', 'delete', String(r.num)], { timeout: 30_000 });
    if (x.err) throw bad('ufw could not delete the rule for ' + r.ip, 500, x.stderr || x.stdout);
  }
  say('ufw 22/tcp: ' + (add.length ? 'added ' + add.join(', ') : 'nothing to add') + (del.length ? ', removed ' + del.map((r) => r.ip).join(', ') : ''));
}

async function applyFail2ban(wl, say) {
  let txt; try { txt = fs.readFileSync(JAIL, 'utf8'); } catch (_) { say('no ' + JAIL + ' — skipped'); return; }
  const line = 'ignoreip = 127.0.0.1/8 ::1 ' + wl.ips.map((e) => e.ip).join(' ');
  const next = /^\s*ignoreip\s*=.*$/m.test(txt) ? txt.replace(/^\s*ignoreip\s*=.*$/m, line) : txt.replace(/^\[DEFAULT\]\s*$/m, '[DEFAULT]\n' + line);
  if (next === txt) { say('fail2ban already up to date'); return; }
  fs.writeFileSync(JAIL, next);
  const r = await execP('fail2ban-client', ['reload'], { timeout: 60_000 });
  say('fail2ban: never bans the admin IPs' + (r.err ? ' (reload failed: ' + (r.stderr || '').trim() + ')' : '; reloaded'));
}

async function apply(say) {
  say = say || (() => {});
  const wl = get();
  if (!wl.ips.length) throw bad('the whitelist is empty — refusing to lock SSH for everyone');
  await applySshd(wl, say);
  await applyUfw(wl, say);
  await applyFail2ban(wl, say);
  return wl;
}

// Replace the list. fromIp: the address of whoever is saving (null = on the box itself).
async function save(input, fromIp) {
  const cur = get();
  const ips = [];
  for (const e of (input && input.ips) || []) {
    const ip = String((e && e.ip) || e || '').trim();
    if (!ip) continue;
    if (!validEntry(ip)) throw bad('"' + ip + '" is not an IP address or CIDR range');
    if (ips.some((x) => x.ip === ip)) continue;
    ips.push({ ip, label: String((e && e.label) || '').trim().slice(0, 60) });
  }
  if (!ips.length) throw bad('keep at least one IP — an empty whitelist would lock SSH for everyone');
  if (ips.length > 100) throw bad('at most 100 entries');
  if (fromIp && !covers(ips, fromIp) && covers(cur.ips, fromIp)) throw bad('you are connected from ' + fromIp + ' — removing it would lock you out; remove it from another whitelisted address');
  const next = { ips, adminUsers: cur.adminUsers };
  settings.set(KEY, next);
  const steps = []; await apply((s) => steps.push(s));
  return { whitelist: next, steps };
}

function covers(list, ip) {
  ip = String(ip || '').replace(/^::ffff:/i, '');
  for (const e of list) {
    const [base, len] = e.ip.split('/');
    if (len === undefined) { if (base === ip) return true; continue; }
    if (net.isIPv4(base) && net.isIPv4(ip)) {
      const n = (s) => s.split('.').reduce((a, b) => a * 256 + Number(b), 0);
      const L = Number(len);
      if (Math.floor(n(ip) / 2 ** (32 - L)) === Math.floor(n(base) / 2 ** (32 - L))) return true;
    }
  }
  return false;
}

// SSH access for a site user: a generated key pair (private key kept encrypted for the Vault, public
// key in authorized_keys), plus the AllowUsers entry from the whitelisted IPs. Idempotent.
async function enableSiteSsh(site, say) {
  say = say || (() => {});
  const secrets = require('./secrets'), store = require('./sites/store'), users = require('./sites/users');
  const kvKey = 'site.sshkey:' + site.domain;
  let rec = settings.get(kvKey, null);
  if (!rec) {
    const os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rhc-sshkey-'));
    const f = path.join(dir, 'key');
    try {
      const r = await execP('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', site.user + '@' + site.domain, '-f', f], { timeout: 30_000 });
      if (r.err) throw bad('ssh-keygen failed', 500, r.stderr);
      rec = { private_enc: secrets.encrypt(fs.readFileSync(f, 'utf8')), public: fs.readFileSync(f + '.pub', 'utf8').trim(), created: new Date().toISOString() };
    } finally { for (const x of [f, f + '.pub']) { try { fs.unlinkSync(x); } catch (_) {} } try { fs.rmdirSync(dir); } catch (_) {} }
    settings.set(kvKey, rec);
    say('generated an SSH key pair for ' + site.user, rec.public.split(' ').slice(0, 2).join(' ').slice(0, 40) + '…');
  }
  const fresh = store.get(site.domain) || site;
  const keys = String(fresh.ssh_keys || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!keys.includes(rec.public)) {
    keys.push(rec.public);
    users.writeAuthorizedKeys(fresh.user, keys.join('\n') + '\n');
    store.update(fresh.id, { ssh_keys: keys.join('\n') });
    say('installed the key in ~' + fresh.user + '/.ssh/authorized_keys');
  }
  await apply(say);
  return { user: fresh.user, publicKey: rec.public };
}
function siteKey(domain) {
  const rec = settings.get('site.sshkey:' + domain, null);
  if (!rec) return null;
  try { return { private: require('./secrets').decrypt(rec.private_enc), public: rec.public }; } catch (_) { return null; }
}

module.exports = { get, save, apply, covers, validEntry, enableSiteSsh, siteKey, siteSshUsers, renderAllow, renderRootPw, seed };
