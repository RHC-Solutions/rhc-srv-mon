'use strict';
// Firewall (left menu → Firewall): ufw on this server — state, default policies, logging, rules —
// and which public ports the rules leave open.
//
// Guard rails (a firewall is the one setting that can shut the operator out):
//   - the admin SSH rules (comment "ssh allowlist", Settings → Whitelist) are not editable here, and
//     are (re)added before ufw is switched on — enabling can never cut the admins off SSH;
//   - a deny/reject/limit rule may not cover an admin IP; one from a specific source goes to the top
//     (it has to beat the allows), one from anywhere goes to the bottom (the allows keep winning);
//   - outgoing traffic cannot be set to deny/reject: the panel and every site are reached through
//     Cloudflare tunnels, which are outgoing connections.
// The panel needs no inbound port at all, so nothing here can make the panel itself unreachable.
//
// Rules are read with `ufw show added` (works whether ufw is on or off) and deleted by their own
// spec, not by number — numbers shift after every delete, a spec does not.
const fs = require('fs');
const net = require('net');
const { execP } = require('./util');

const UFW = '/usr/sbin/ufw';
const SSH_COMMENT = 'ssh allowlist';
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const ufw = (args) => execP(UFW, args, { timeout: 60_000 });

function installed() { return fs.existsSync(UFW); }

// Single-quote aware split ("comment 'a b'" stays one token, without the quotes).
function tokens(s) {
  const out = []; let cur = '', q = false, has = false;
  for (const ch of String(s)) {
    if (ch === "'") { q = !q; has = true; continue; }
    if (!q && /\s/.test(ch)) { if (has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}
function parseSpec(spec) {
  const t = tokens(spec);
  const r = { spec, action: t[0], dir: 'in', from: 'any', to: 'any', port: '', proto: '', app: '', comment: '' };
  let i = 1;
  if (t[i] === 'in' || t[i] === 'out') r.dir = t[i++];
  if (t[i] === 'on') { r.iface = t[i + 1]; i += 2; }
  if (t[i] === 'log' || t[i] === 'log-all') i++;
  if (t[i] && t[i] !== 'from' && t[i] !== 'to' && t[i] !== 'proto' && t[i] !== 'comment') {
    const [p, pr] = t[i].split('/'); if (/^[\d:,]+$/.test(p)) { r.port = p; r.proto = pr || ''; } else r.app = t[i];
    i++;
  }
  for (; i < t.length; i++) {
    const k = t[i], v = t[i + 1];
    if (k === 'from') { r.from = v; i++; } else if (k === 'to') { r.to = v; i++; }
    else if (k === 'port') { r.port = v; i++; } else if (k === 'proto') { r.proto = v; i++; }
    else if (k === 'app') { r.app = v; i++; } else if (k === 'comment') { r.comment = v; i++; }
  }
  r.managed = r.comment === SSH_COMMENT;
  return r;
}

async function rules() {
  const r = await ufw(['show', 'added']);
  if (r.err) throw bad('ufw show added failed', 500, (r.stderr || r.stdout).trim());
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ufw ')).map((l) => parseSpec(l.slice(4)));
}

function defaultsFile() {
  const out = { incoming: null, outgoing: null, routed: null, ipv6: null };
  try {
    const t = fs.readFileSync('/etc/default/ufw', 'utf8');
    const g = (k) => ((new RegExp('^' + k + '="?([A-Z]+)"?', 'm').exec(t) || [])[1] || '').toLowerCase() || null;
    const map = { drop: 'deny', accept: 'allow', reject: 'reject' };
    out.incoming = map[g('DEFAULT_INPUT_POLICY')] || null; out.outgoing = map[g('DEFAULT_OUTPUT_POLICY')] || null; out.routed = map[g('DEFAULT_FORWARD_POLICY')] || null;
    out.ipv6 = g('IPV6') === 'yes';
  } catch (_) {}
  return out;
}

// Listening sockets reachable from outside (not bound to loopback), with the owning process.
async function publicPorts() {
  const r = await execP('ss', ['-H', '-ltnup'], { timeout: 15_000 });
  const seen = new Map();
  for (const line of r.stdout.split('\n')) {
    const c = line.trim().split(/\s+/); if (c.length < 5) continue;
    const proto = c[0], local = c[4];
    const i = local.lastIndexOf(':'); const addr = local.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, ''); const port = Number(local.slice(i + 1));
    if (!port || /^127\.|^::1$/.test(addr)) continue;
    if (proto === 'udp' && /^(68|546|5353|323)$/.test(String(port))) continue;   // DHCP/mDNS/chrony client sockets
    const proc = (/users:\(\("([^"]+)"/.exec(line) || [])[1] || '';
    const key = proto + '/' + port;
    const e = seen.get(key) || { proto, port, addrs: [], proc };
    if (!e.addrs.includes(addr)) e.addrs.push(addr);
    if (!e.proc) e.proc = proc;
    seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}
const portIn = (spec, port) => String(spec).split(',').some((p) => { const [a, b] = p.split(':').map(Number); return b ? port >= a && port <= b : port === a; });
const APP_PORTS = { OpenSSH: [22], 'Nginx Full': [80, 443], 'Nginx HTTP': [80], 'Nginx HTTPS': [443], 'WWW Full': [80, 443] };
// What the rules mean for one listening port (first matching rule wins, as in ufw).
function exposure(p, list, st) {
  if (!st.active) return { state: 'open', why: 'firewall is off' };
  for (const r of list) {
    if (r.dir !== 'in' || r.iface) continue;
    const ports = r.app ? APP_PORTS[r.app] : null;
    const matches = r.app ? !!(ports && ports.includes(p.port)) : r.port ? portIn(r.port, p.port) && (!r.proto || r.proto === p.proto) : true;
    if (!matches) continue;
    if (r.from === 'any') {
      if (r.action === 'allow') return { state: 'open', why: 'allow ' + (r.port || r.app || 'all') + ' from anywhere' };
      if (r.action === 'limit') return { state: 'limited', why: 'rate-limited from anywhere' };
      return { state: 'blocked', why: r.action + ' from anywhere' };
    }
    // a source-specific rule only decides for that source; keep looking for the general case
    if (r.action === 'allow') { const rest = exposure(p, list.slice(list.indexOf(r) + 1), st); return rest.state === 'open' ? rest : { state: 'restricted', why: 'only from listed sources' + (r.comment ? ' (' + r.comment + ')' : '') }; }
  }
  return st.defaults.incoming === 'allow' ? { state: 'open', why: 'default incoming policy is allow' } : { state: 'blocked', why: 'no rule — default ' + (st.defaults.incoming || 'deny') };
}

async function status() {
  if (!installed()) return { installed: false };
  const v = await ufw(['status', 'verbose']);
  const out = v.stdout || '';
  const st = { installed: true, active: /Status: active/.test(out), logging: ((/^Logging:\s*(.+)$/m.exec(out) || [])[1] || '').trim() || null, defaults: defaultsFile(), error: v.err ? (v.stderr || v.stdout).trim() : null };
  if (!st.logging) { try { const c = fs.readFileSync('/etc/ufw/ufw.conf', 'utf8'); st.logging = ((/^LOGLEVEL=(\w+)/m.exec(c) || [])[1] || 'off'); } catch (_) {} }
  const m = /^Default:\s*(\w+) \(incoming\),\s*(\w+) \(outgoing\),\s*(\w+|disabled) \(routed\)/m.exec(out);
  if (m) Object.assign(st.defaults, { incoming: m[1], outgoing: m[2], routed: m[3] });
  const u = await execP('systemctl', ['show', 'ufw', '-p', 'UnitFileState', '-p', 'ActiveState'], { timeout: 10_000 });
  st.bootEnabled = /UnitFileState=enabled/.test(u.stdout);
  st.unitActive = /ActiveState=active/.test(u.stdout);
  st.rules = await rules().catch((e) => { st.error = e.message; return []; });
  const admin = require('./whitelist').get().ips;
  st.adminIps = admin.map((e) => e.ip);
  st.adminSshCovered = admin.every((e) => st.rules.some((r) => r.action === 'allow' && r.from === e.ip && (r.port === '22' || r.app === 'OpenSSH'))) || st.rules.some((r) => r.action === 'allow' && r.from === 'any' && (r.port === '22' || r.app === 'OpenSSH'));
  st.ports = (await publicPorts().catch(() => [])).map((p) => Object.assign(p, exposure(p, st.rules, st)));
  return st;
}

// ------------------------------------------------------------------ changes
const PORT_RE = /^\d{1,5}(?::\d{1,5})?$/;
const COMMENT_RE = /^[\w .:,@()\/+-]{0,60}$/;
function containsAdmin(from) {
  if (!from || from === 'any') return false;
  const wl = require('./whitelist'); const admin = wl.get().ips;
  // either way round: the rule's range holds an admin address, or an admin range holds the rule's
  return admin.some((e) => e.ip === from || wl.covers([{ ip: from }], e.ip.split('/')[0]) || wl.covers([e], from.split('/')[0]));
}
async function addRule(b) {
  const action = String(b.action || '');
  if (!['allow', 'deny', 'reject', 'limit'].includes(action)) throw bad('action must be allow, deny, reject or limit');
  const port = String(b.port || '').trim(), proto = String(b.proto || 'any'), from = String(b.from || '').trim() || 'any', comment = String(b.comment || '').trim();
  if (port && (!PORT_RE.test(port) || port.split(':').some((p) => Number(p) < 1 || Number(p) > 65535))) throw bad('port like 8080 or a range like 6000:6010');
  if (port.includes(':') && proto === 'any') throw bad('a port range needs tcp or udp');
  if (!['any', 'tcp', 'udp'].includes(proto)) throw bad('protocol must be any, tcp or udp');
  if (from !== 'any' && !require('./whitelist').validEntry(from)) throw bad('source must be an IP or a range like 203.0.113.0/24 (empty = anywhere)');
  if (!port && from === 'any') throw bad('give a port, a source, or both — a rule for every port from anywhere would ' + (action === 'allow' ? 'switch the firewall off' : 'block everything'));
  if (!COMMENT_RE.test(comment)) throw bad('note: letters, digits and . : , @ ( ) / + - only, at most 60');
  if (comment === SSH_COMMENT) throw bad('"' + SSH_COMMENT + '" is reserved for Settings → Whitelist');
  if (action === 'limit' && (!port || proto === 'udp')) throw bad('limit needs a tcp port');
  if (action !== 'allow' && containsAdmin(from)) throw bad(from + ' overlaps an admin IP (Settings → Whitelist) — refusing to block it');
  const spec = [action, 'from', from, 'to', 'any'];
  if (port) spec.push('port', port);
  if (proto !== 'any') spec.push('proto', proto);
  const list = await rules();
  const dup = list.find((r) => r.action === action && r.from === from && r.port === port && (r.proto || 'any') === proto);
  if (dup) throw bad('that rule exists already');
  // a deny for one source must come before the allows to have any effect
  const top = action !== 'allow' && action !== 'limit' && from !== 'any' && list.length;
  const args = (top ? ['insert', '1'] : []).concat(spec, ['comment', comment || 'panel']);
  const r = await ufw(args);
  if (r.err || /ERROR/i.test(r.stdout)) throw bad('ufw refused the rule', 500, (r.stderr || r.stdout).trim());
  return { ok: true, spec: 'ufw ' + args.join(' '), output: r.stdout.trim() };
}
async function deleteRule(spec) {
  const list = await rules();
  const r = list.find((x) => x.spec === spec);
  if (!r) throw bad('that rule is no longer there — reload the page', 409);
  if (r.managed) throw bad('admin SSH rules are managed in Settings → Whitelist');
  // delete by spec without the comment (ufw matches on the rule itself); retry with it if needed
  const t = tokens(spec); const ci = t.indexOf('comment'); const bare = ci >= 0 ? t.slice(0, ci).concat(t.slice(ci + 2)) : t;
  let x = await ufw(['--force', 'delete'].concat(bare));
  if (x.err || /Could not delete/i.test(x.stdout)) x = await ufw(['--force', 'delete'].concat(t));
  if (x.err || /Could not delete|ERROR/i.test(x.stdout)) throw bad('ufw could not delete the rule', 500, (x.stderr || x.stdout).trim());
  return { ok: true, output: x.stdout.trim() };
}

// Access to one listening port, as one choice (left menu → Firewall → Public ports → Access):
//   open     allow from anywhere          limit    rate-limited from anywhere (tcp)
//   admin    only the admin IPs (Settings → Whitelist), everyone else denied
//   blocked  deny from anywhere           default  no rule of its own — the default policy decides
// The port's own rules (exactly this port, any source, not the managed "ssh allowlist" ones) are
// replaced; ranges and app profiles ("Nginx Full") are left alone, and when one of those decides
// first the result says so instead of pretending the change took.
const PORT_MODES = ['open', 'limit', 'admin', 'blocked', 'default'];
async function setPortAccess(b) {
  const port = Number(b.port), proto = String(b.proto || ''), mode = String(b.mode || '');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('invalid port');
  if (!['tcp', 'udp'].includes(proto)) throw bad('protocol must be tcp or udp');
  if (!PORT_MODES.includes(mode)) throw bad('access must be one of ' + PORT_MODES.join(', '));
  if (mode === 'limit' && proto !== 'tcp') throw bad('rate-limiting works on tcp ports only');
  const admin = require('./whitelist').get().ips;
  if (mode === 'admin' && !admin.length) throw bad('the admin whitelist is empty — add your IP in Settings → Whitelist first');
  let list = await rules();
  if (port === 22 && mode !== 'open' && mode !== 'limit') {
    const covered = admin.length && admin.every((e) => list.some((r) => r.managed && r.from === e.ip));
    if (!covered) throw bad('closing SSH needs the admin SSH rules in place first — save Settings → Whitelist (with your IP) once, then try again');
  }
  const own = list.filter((r) => r.dir === 'in' && !r.iface && !r.managed && !r.app && r.port === String(port) && (!r.proto || r.proto === proto));
  const removed = [];
  for (const r of own) { await deleteRule(r.spec); removed.push(r.spec); }
  list = await rules();
  // Put the new rules where they decide: before the first rule from anywhere that already matches
  // this port (an app profile or a range), but never above the managed admin SSH rules.
  const pseudo = { port, proto };
  const decides = list.findIndex((r) => r.dir === 'in' && !r.iface && r.from === 'any' && (r.app ? (APP_PORTS[r.app] || []).includes(port) : r.port ? portIn(r.port, port) && (!r.proto || r.proto === proto) : false));
  const lastManaged = list.reduce((m, r, i) => (r.managed ? i : m), -1);
  let pos = decides >= 0 ? Math.max(decides, lastManaged + 1) : -1;   // 0-based; -1 = append
  const added = [];
  const put = async (action, from, comment) => {
    const spec = [action, 'from', from, 'to', 'any', 'port', String(port), 'proto', proto];
    const args = (pos >= 0 && pos < list.length ? ['insert', String(pos + 1)] : []).concat(spec, ['comment', comment]);
    const r = await ufw(args);
    if (r.err || /ERROR|Invalid/i.test(r.stdout)) throw bad('ufw refused: ' + spec.join(' ') + (removed.length ? ' (the old rules of this port were already removed)' : ''), 500, (r.stderr || r.stdout).trim());
    added.push(spec.join(' '));
    if (pos >= 0) { pos++; list.splice(pos - 1, 0, {}); }
  };
  if (mode === 'open') await put('allow', 'any', 'panel: open');
  else if (mode === 'limit') await put('limit', 'any', 'panel: rate-limited');
  else if (mode === 'admin') { for (const e of admin) await put('allow', e.ip, 'panel: admin only'); await put('deny', 'any', 'panel: admin only'); }
  else if (mode === 'blocked') await put('deny', 'any', 'panel: blocked');
  const st = await status();
  const now = (st.ports || []).find((p) => p.port === port && p.proto === proto) || Object.assign(pseudo, exposure(pseudo, st.rules, st));
  const want = { open: 'open', limit: 'limited', admin: 'restricted', blocked: 'blocked' }[mode];
  const note = !st.active ? 'ufw is off — this takes effect when it is switched on'
    : want && now.state !== want ? 'another rule decides first: ' + now.why : null;
  return { ok: true, port, proto, mode, removed, added, state: now.state, why: now.why, note };
}

async function enable() {
  const wl = require('./whitelist').get();
  const list = await rules();
  const say = [];
  const sshAnywhere = list.some((r) => r.action === 'allow' && r.from === 'any' && (r.port === '22' || r.app === 'OpenSSH'));
  if (!wl.ips.length && !sshAnywhere) throw bad('the admin whitelist is empty and no rule allows SSH — switching ufw on would lock everyone out of SSH');
  // admin SSH first, always
  for (const e of wl.ips) {
    if (list.some((r) => r.action === 'allow' && r.from === e.ip && r.port === '22')) continue;
    const r = await ufw(['allow', 'from', e.ip, 'to', 'any', 'port', '22', 'proto', 'tcp', 'comment', SSH_COMMENT]);
    if (r.err) throw bad('could not add the SSH rule for ' + e.ip + ' — not switching ufw on', 500, (r.stderr || r.stdout).trim());
    say.push('added SSH for admin ' + e.ip);
  }
  const r = await ufw(['--force', 'enable']);
  if (r.err) throw bad('ufw enable failed', 500, (r.stderr || r.stdout).trim());
  await execP('systemctl', ['enable', 'ufw'], { timeout: 20_000 });
  const st = await status();
  if (!st.active) throw bad('ufw did not come up', 500, r.stdout);
  say.push('ufw is on and loads at boot');
  return { ok: true, log: say };
}
async function disable() {
  const r = await ufw(['--force', 'disable']);
  if (r.err) throw bad('ufw disable failed', 500, (r.stderr || r.stdout).trim());
  return { ok: true };
}
async function setDefault(dir, policy) {
  if (!['incoming', 'outgoing', 'routed'].includes(dir)) throw bad('direction must be incoming, outgoing or routed');
  if (!['allow', 'deny', 'reject'].includes(policy)) throw bad('policy must be allow, deny or reject');
  if (dir === 'outgoing' && policy !== 'allow') throw bad('outgoing must stay allow — the panel and every site are reached through Cloudflare tunnels, which are outgoing connections');
  const r = await ufw(['default', policy, dir]);
  if (r.err) throw bad('ufw refused', 500, (r.stderr || r.stdout).trim());
  return { ok: true };
}
async function setLogging(level) {
  if (!['off', 'low', 'medium', 'high'].includes(level)) throw bad('logging must be off, low, medium or high');
  const r = await ufw(['logging', level]);
  if (r.err) throw bad('ufw refused', 500, (r.stderr || r.stdout).trim());
  return { ok: true };
}

module.exports = { status, rules, addRule, deleteRule, setPortAccess, PORT_MODES, enable, disable, setDefault, setLogging, parseSpec, tokens, exposure, SSH_COMMENT, installed };
