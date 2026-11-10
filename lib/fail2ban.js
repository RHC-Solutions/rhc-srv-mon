'use strict';
// fail2ban management (left menu → Firewall): the service, every jail (running, configured but
// broken, or available to switch on), jail settings, how bans are enforced, and the recent log.
//
// The panel never edits jail.conf / jail.local (jail.local holds the admin ignoreip, written by
// Settings → Whitelist). Its own choices go to ONE file that fail2ban reads last:
//   /etc/fail2ban/jail.d/zz-sb-srv-mon.local      (jail.conf → jail.d/*.conf → jail.local → jail.d/*.local)
// rendered from kv `fail2ban.panel`. A change is written, tested with `fail2ban-client -t`, and
// applied with `fail2ban-client reload`; if the test shows an error the config did not already
// have, or a jail switched on does not come up, the previous file is put back and reloaded.
//
// What "configured" means comes from `fail2ban-client -d` — fail2ban's own resolved view of all those
// files — not from parsing them here. Jails it lists as broken (missing filter, missing log file)
// are skipped by fail2ban at start without a word; the panel shows them and offers to switch them off.
const fs = require('fs');
const net = require('net');
const { settings } = require('./db');
const { execP } = require('./util');

const DIR = process.env.SB_F2B_DIR || '/etc/fail2ban';   // override: tests against a copy
const PANEL_FILE = DIR + '/jail.d/zz-sb-srv-mon.local';
const LOG = '/var/log/fail2ban.log';
const KEY = 'fail2ban.panel';
const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const TIME_RE = /^(-1|\d{1,9}(s|m|h|d|w|mo|y)?)$/;
// banaction choices → [banaction, banaction_allports]
const BANACTIONS = { ufw: ['ufw', 'ufw'], nftables: ['nftables', 'nftables[type=allports]'], 'iptables': ['iptables-multiport', 'iptables-allports'] };
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const f2b = (args, t) => execP('fail2ban-client', (process.env.SB_F2B_DIR ? ['-c', DIR] : []).concat(args), { timeout: t || 30_000 });

// The panel's choices: kv, or — when kv has none (restored backup, fresh panel on an old server) —
// read back from the panel's own file, so the next change does not silently drop what it says.
function panel() {
  const kv = settings.get(KEY, null);
  if (kv && typeof kv === 'object') return Object.assign({ banaction: null, jails: {} }, kv);
  const p = { banaction: null, jails: {} };
  let txt = ''; try { txt = fs.readFileSync(PANEL_FILE, 'utf8'); } catch (_) { return p; }
  let sec = null;
  for (const raw of txt.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const s = /^\[([^\]]+)\]$/.exec(l); if (s) { sec = s[1]; continue; }
    const m = /^(\w+)\s*=\s*(.*)$/.exec(l); if (!m || !sec) continue;
    if (sec === 'DEFAULT') { if (m[1] === 'banaction') p.banaction = (Object.entries(BANACTIONS).find(([, [a]]) => a === m[2]) || [])[0] || null; continue; }
    if (!NAME_RE.test(sec)) continue;
    const j = p.jails[sec] = p.jails[sec] || {};
    if (m[1] === 'enabled') j.enabled = /^true$/i.test(m[2]);
    else if (['bantime', 'findtime', 'maxretry'].includes(m[1])) j[m[1]] = m[2];
  }
  return p;
}

// ------------------------------------------------------------------ reading
// fail2ban's resolved configuration: which jails would start, with what. `-d` tolerates missing log
// files; `-t` reports them (and every other error) — both read files only.
async function resolved() {
  const d = await f2b(['-d']);
  const jails = {};
  const val = (s) => { s = s.trim(); return /^'.*'$/.test(s) ? s.slice(1, -1) : s; };
  for (const line of d.stdout.split('\n')) {
    let m = /^\['add', '([^']+)', '([^']+)'\]$/.exec(line);
    if (m) { jails[m[1]] = { name: m[1], backend: m[2], actions: [], logpaths: [] }; continue; }
    m = /^\['set', '([^']+)', '(bantime|findtime|maxretry|addaction|addlogpath|journalmatch)', (.*)\]$/.exec(line);
    if (!m || !jails[m[1]]) continue;
    const j = jails[m[1]];
    if (m[2] === 'addaction') j.actions.push(val(m[3]));
    else if (m[2] === 'addlogpath') j.logpaths.push(val(m[3].split(', ')[0]));
    else j[m[2]] = val(m[3]);
  }
  return jails;
}
async function test() {
  const t = await f2b(['-t']);
  const out = (t.stdout + '\n' + t.stderr);
  const errors = out.split('\n').filter((l) => /\bERROR\b/.test(l)).map((l) => l.replace(/^.*?\]:\s*ERROR\s*/, '').trim()).filter((l) => l && !/test configuration failed/.test(l));
  const broken = {};
  // group the reasons under the jail they belong to ("Unable to read the filter 'x'" precedes "Errors in jail 'x'.")
  let pending = [];
  for (const e of errors) {
    const m = /^Errors in jail '([^']+)'/.exec(e);
    if (m) { broken[m[1]] = pending.length ? pending : ['error in the jail definition']; pending = []; } else pending.push(e);
  }
  const lognot = out.match(/Have not found any log file for (\S+) jail/g) || [];
  for (const l of lognot) { const j = /for (\S+) jail/.exec(l)[1]; (broken[j] = broken[j] || []).push('no log file found'); }
  return { ok: /OK: configuration test is successful/.test(out) && !errors.length, errors, broken, other: pending };
}
// Every jail defined anywhere (jail.conf alone has ~90): the ones that could be switched on.
function definedJails() {
  const files = [DIR + '/jail.conf'];
  for (const sub of ['jail.d']) { try { for (const f of fs.readdirSync(DIR + '/' + sub).sort()) if (/\.(conf|local)$/.test(f)) files.push(DIR + '/' + sub + '/' + f); } catch (_) {} }
  files.push(DIR + '/jail.local');
  const names = new Set();
  for (const f of files) { let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; } for (const m of t.matchAll(/^\[([^\]]+)\]\s*$/gm)) names.add(m[1].trim()); }
  for (const n of ['DEFAULT', 'INCLUDES', 'Definition', 'Init']) names.delete(n);
  const filters = new Set(); try { for (const f of fs.readdirSync(DIR + '/filter.d')) filters.add(f.replace(/\.(conf|local)$/, '')); } catch (_) {}
  return [...names].sort().map((n) => ({ name: n, filter: filters.has(n.replace(/-.*$/, '')) || filters.has(n) }));
}
function defaultBanaction() {
  // the effective [DEFAULT] banaction, last file wins, in fail2ban's read order
  const files = [DIR + '/jail.conf'];
  const d = (suf) => { try { return fs.readdirSync(DIR + '/jail.d').filter((f) => f.endsWith(suf)).sort().map((f) => DIR + '/jail.d/' + f); } catch (_) { return []; } };
  files.push(...d('.conf'), DIR + '/jail.local', ...d('.local'));
  let v = null;
  for (const f of files) {
    let t = ''; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const sec = /^\[DEFAULT\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(t);
    const m = sec && /^\s*banaction\s*=\s*(.+)$/m.exec(sec[1]);
    if (m) v = m[1].trim();
  }
  return v;
}
async function running() {
  const st = await f2b(['status']);
  if (st.err) return { up: false, error: (st.stderr || st.err.message).trim(), jails: [] };
  const names = ((/Jail list:\s*(.*)$/m.exec(st.stdout) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const jails = [];
  for (const j of names) {
    const s = (await f2b(['status', j])).stdout;
    const num = (k) => Number((new RegExp(k + ':\\s*(\\d+)').exec(s) || [])[1] || 0);
    jails.push({ name: j, currentlyFailed: num('Currently failed'), totalFailed: num('Total failed'), currentlyBanned: num('Currently banned'), totalBanned: num('Total banned'),
      banned: ((/Banned IP list:\s*(.*)$/m.exec(s) || [])[1] || '').split(/\s+/).filter(Boolean) });
  }
  return { up: true, jails };
}
function logTail(n) {
  try {
    const fd = fs.openSync(LOG, 'r'); const size = fs.fstatSync(fd).size, len = Math.min(size, 256 * 1024), b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
    return b.toString('utf8').split('\n').filter((l) => /\b(NOTICE|WARNING|ERROR)\b/.test(l) && !/Found\s/.test(l) || /\] (Ban|Unban|Restore Ban) /.test(l)).slice(-(n || 80))
      .map((l) => { const m = /^(\S+ \S+?)(?:,\d+)?\s+fail2ban\.(\S+)\s+\[\d+\]:\s+(\w+)\s+(.*)$/.exec(l); return m ? { at: m[1], src: m[2], level: m[3], text: m[4] } : { text: l }; });
  } catch (_) { return []; }
}

async function status() {
  const v = await f2b(['version']);
  if (v.err && /ENOENT/.test(String(v.err.code || v.err.message))) return { installed: false };
  const [run, conf, t] = await Promise.all([running(), resolved(), test()]);
  const p = panel();
  const ba = defaultBanaction();
  const runningNames = new Set(run.jails.map((j) => j.name));
  const jails = [];
  for (const j of run.jails) jails.push(Object.assign({ state: 'running' }, conf[j.name] || { name: j.name }, j, { panel: p.jails[j.name] || null }));
  for (const [n, c] of Object.entries(conf)) if (!runningNames.has(n)) jails.push(Object.assign({ state: run.up ? 'not running' : 'stopped', banned: [] }, c, { panel: p.jails[n] || null }));
  for (const [n, why] of Object.entries(t.broken)) if (!jails.some((j) => j.name === n)) jails.push({ name: n, state: 'broken', why, banned: [], actions: [], logpaths: [], panel: p.jails[n] || null });
  for (const j of jails) if (t.broken[j.name] && j.state !== 'broken') { j.why = t.broken[j.name]; }
  const ufwActive = await execP('/usr/sbin/ufw', ['status'], { timeout: 15_000 }).then((r) => /Status: active/.test(r.stdout)).catch(() => false);
  const warnings = [];
  const usesUfw = jails.some((j) => j.state === 'running' && (j.actions || []).some((a) => /^ufw/.test(a)));
  if (usesUfw && !ufwActive) warnings.push('Bans are enforced through ufw, and ufw is off — banned IPs are not actually blocked. Switch ufw on, or enforce bans with nftables.');
  const brokenOn = jails.filter((j) => j.state === 'broken');
  if (brokenOn.length) warnings.push('Switched on but broken, so fail2ban skips them: ' + brokenOn.map((j) => j.name + ' (' + (j.why || []).join('; ') + ')').join(', ') + '.');
  return {
    installed: true, version: (v.stdout || '').trim().split('\n').pop(), up: run.up, error: run.error || null,
    banaction: ba, banactionChoice: Object.entries(BANACTIONS).find(([, [a]]) => a === ba)?.[0] || null, panelBanaction: p.banaction,
    jails, available: definedJails().filter((d) => !jails.some((j) => j.name === d.name)), test: { ok: t.ok, errors: t.errors },
    warnings, ufwActive, file: PANEL_FILE, log: logTail(60),
  };
}

// ------------------------------------------------------------------ writing
function render(p) {
  const out = ['# Managed by sb-srv-mon (left menu → Firewall → fail2ban). Edits here are overwritten.', '# Read after jail.local — what is set here wins.', ''];
  if (p.banaction && BANACTIONS[p.banaction]) out.push('[DEFAULT]', 'banaction = ' + BANACTIONS[p.banaction][0], 'banaction_allports = ' + BANACTIONS[p.banaction][1], '');
  for (const [n, j] of Object.entries(p.jails).sort()) {
    const lines = [];
    if (j.enabled != null) lines.push('enabled = ' + (j.enabled ? 'true' : 'false'));
    for (const k of ['bantime', 'findtime', 'maxretry']) if (j[k] != null && j[k] !== '') lines.push(k + ' = ' + j[k]);
    if (lines.length) out.push('[' + n + ']', ...lines, '');
  }
  return out.join('\n');
}
let busy = false;
async function apply(next, opts) {
  if (busy) throw bad('another fail2ban change is still being applied', 409);
  busy = true;
  const prevTxt = fs.existsSync(PANEL_FILE) ? fs.readFileSync(PANEL_FILE, 'utf8') : null;
  const prevKv = settings.get(KEY, null);
  const restore = async () => {
    if (prevTxt == null) { try { fs.unlinkSync(PANEL_FILE); } catch (_) {} } else fs.writeFileSync(PANEL_FILE, prevTxt, { mode: 0o644 });
    settings.set(KEY, prevKv);   // null stays null: panel() then reads the (restored) file back
    await f2b(['reload'], 120_000);
  };
  try {
    const before = await test();
    fs.writeFileSync(PANEL_FILE, render(next), { mode: 0o644 });
    const after = await test();
    const fresh = after.errors.filter((e) => !before.errors.includes(e));
    const nowBroken = (opts.mustRun || []).filter((n) => after.broken[n]);
    if (fresh.length || nowBroken.length) {
      await restore();
      throw bad('fail2ban rejected the change — nothing changed', 422, (nowBroken.map((n) => n + ': ' + after.broken[n].join('; ')).concat(fresh)).join('\n'));
    }
    settings.set(KEY, next);
    const r = await f2b(opts.restart ? ['reload', '--restart'] : ['reload'], 120_000);
    const run = await running();
    const missing = (opts.mustRun || []).filter((n) => !run.jails.some((j) => j.name === n));
    if (r.err || !run.up || missing.length) {
      const detail = (r.stderr || r.stdout || '').trim() + (missing.length ? '\nnot running after reload: ' + missing.join(', ') : '') + '\n' + logTail(8).map((l) => l.text).join('\n');
      await restore();
      throw bad('fail2ban did not take the change — previous configuration restored', 500, detail.trim());
    }
    return { ok: true };
  } finally { busy = false; }
}
async function setJail(name, b) {
  if (!NAME_RE.test(name || '')) throw bad('invalid jail name');
  const known = definedJails().some((d) => d.name === name) || Object.keys(await resolved()).includes(name);
  if (!known) throw bad('no jail called ' + name + ' is defined in ' + DIR);
  const p = panel(); const j = Object.assign({}, p.jails[name] || {});
  if (b.enabled != null) j.enabled = !!b.enabled;
  for (const k of ['bantime', 'findtime']) if (b[k] != null) { const v = String(b[k]).trim(); if (v && !TIME_RE.test(v)) throw bad(k + ': seconds or e.g. 10m, 1h, 1d, 1w (bantime -1 = forever)'); if (k === 'findtime' && v === '-1') throw bad('findtime cannot be -1'); j[k] = v || null; }
  if (b.maxretry != null) { const v = String(b.maxretry).trim(); if (v && !(/^\d{1,3}$/.test(v) && Number(v) >= 1)) throw bad('maxretry: 1–999'); j.maxretry = v || null; }
  const next = Object.assign({}, p, { jails: Object.assign({}, p.jails, { [name]: j }) });
  await apply(next, { mustRun: j.enabled === false ? [] : (b.enabled ? [name] : []) });
  return { ok: true };
}
// One click for "switched on but broken": switch every broken jail off in a single tested change.
async function disableBroken() {
  const names = Object.keys((await test()).broken || {}).filter((n) => NAME_RE.test(n));
  if (!names.length) return { ok: true, names };
  const p = panel(), jails = Object.assign({}, p.jails);
  for (const n of names) jails[n] = Object.assign({}, jails[n] || {}, { enabled: false });
  await apply(Object.assign({}, p, { jails }), {});
  return { ok: true, names };
}
async function resetJail(name) {
  if (!NAME_RE.test(name || '')) throw bad('invalid jail name');
  const p = panel(); if (!p.jails[name]) return { ok: true };
  const jails = Object.assign({}, p.jails); delete jails[name];
  await apply(Object.assign({}, p, { jails }), {});
  return { ok: true };
}
async function setBanaction(choice) {
  if (choice != null && !BANACTIONS[choice]) throw bad('ban with ' + Object.keys(BANACTIONS).join(', ') + ', or null to leave it to jail.local');
  if (choice === 'ufw') {
    const st = await execP('/usr/sbin/ufw', ['status'], { timeout: 15_000 });
    if (!/Status: active/.test(st.stdout)) throw bad('ufw is off — bans through ufw would not block anything. Switch ufw on first, or choose nftables.');
  }
  const p = panel();
  const running0 = (await running()).jails.map((j) => j.name);
  await apply(Object.assign({}, p, { banaction: choice || null }), { restart: true, mustRun: running0 });
  return { ok: true };
}
async function service(action) {
  if (action === 'restart' || action === 'start') { const r = await execP('systemctl', [action, 'fail2ban'], { timeout: 120_000 }); if (r.err) throw bad('systemctl ' + action + ' fail2ban failed', 500, (r.stderr || '').trim()); return { ok: true }; }
  if (action === 'reload') { const r = await f2b(['reload'], 120_000); if (r.err) throw bad('fail2ban reload failed', 500, (r.stderr || r.stdout).trim()); return { ok: true }; }
  if (action === 'unban-all') { const r = await f2b(['unban', '--all']); if (r.err) throw bad('unban --all failed', 500, (r.stderr || r.stdout).trim()); return { ok: true, output: r.stdout.trim() }; }
  throw bad('action must be restart, reload or unban-all');
}
async function ban(jail, ip) {
  if (!NAME_RE.test(jail || '') || !net.isIP(ip)) throw bad('jail and IP needed');
  if (require('./whitelist').covers(require('./whitelist').get().ips, ip)) throw bad(ip + ' is an admin IP (Settings → Whitelist) — fail2ban ignores it anyway');
  const r = await f2b(['set', jail, 'banip', ip]); if (r.err) throw bad('fail2ban refused', 424, (r.stderr || r.stdout).trim()); return { ok: true };
}
async function unban(jail, ip) {
  if (!NAME_RE.test(jail || '') || !net.isIP(ip)) throw bad('jail and IP needed');
  const r = await f2b(['set', jail, 'unbanip', ip]); if (r.err) throw bad('fail2ban refused', 424, (r.stderr || r.stdout).trim()); return { ok: true };
}

module.exports = { status, resolved, test, definedJails, setJail, disableBroken, resetJail, setBanaction, service, ban, unban, render, BANACTIONS, PANEL_FILE };
