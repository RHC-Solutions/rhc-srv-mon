'use strict';
// Resource watchdog: CPU, memory and disk, every 15 s, from /proc only — so it keeps working while
// the box is thrashing (the 1-minute self-repair cycle does HTTP/Kuma checks, which is exactly what
// stalls then). On the Self-repair page.
//
// Prevention (every tick): dev tooling (VS Code server, Claude, npx/MCP, builds) gets
// oom_score_adj +500 and the panel -800, so if the kernel OOM killer has to pick, it picks a language
// server — not a site, not the panel (2026-11-14/15 it took dbus and the session instead).
//
// Memory pressure (MemAvailable < memAvailPct of RAM, or PSI memory some avg10 ≥ memPsi, two ticks in
// a row) climbs a ladder, one step per STEP_GAP while the pressure lasts:
//   1 helpers   kill language servers that respawn on demand (tsserver, typings installer, Copilot)
//   2 idle dev  kill remote Claude sessions (claude --print --sdk-url) and MCP servers idle ≥ idleDevMinutes
//   3 leaky app pm2 restart of the biggest site app above appMemMB
//   4 alert     top memory users, once per episode
// CPU ≥ cpuPct for cpuMinutes:
//   1 renice    dev tooling / builds using CPU → nice 19 + ionice idle (nothing is killed)
//   2 runaway   pm2 restart of a site app pinned ≥ 90 % of a core for cpuMinutes (once per 30 min per app)
//   3 alert     top CPU users, once per episode
// Disk: alert at diskWarnPct; at diskPct the self-repair cache cleanup runs (ooda.js) and this adds
// journal vacuum, truncating huge logs (keeps the last 20 MB), unused VS Code server builds, apt clean.
//
// Never touched: root processes, the panel, sshd, nginx, databases. Site apps only via pm2 restart.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execP } = require('./util');
const { settings } = require('./db');
const events = require('./events');

const TICK_MS = 15_000;
const STEP_GAP_MS = 30_000;          // wait between two ladder steps (let the kernel settle, re-measure)
const APP_RESTART_EVERY_MS = 30 * 60_000;
const DISK_EXTRA_EVERY_MS = 60 * 60_000;
const HZ = 100;                      // USER_HZ on Linux
const PAGE = 4096;

const DEFAULTS = {
  enabled: true,
  memAvailPct: 10, memPsi: 20,
  cpuPct: 90, cpuMinutes: 5,
  diskWarnPct: 85, diskPct: 90,
  appMemMB: 1536, idleDevMinutes: 30,
  steps: { oomPriority: true, helpers: true, idleDev: true, leakyApp: true, renice: true, runawayApp: true, diskExtra: true },
};
function config() {
  const c = settings.get('resguard.config', {}) || {};
  return Object.assign({}, DEFAULTS, c, { steps: Object.assign({}, DEFAULTS.steps, c.steps || {}) });
}
function setConfig(p) {
  const c = config();
  const num = (k, lo, hi) => { if (p[k] != null) { const v = Number(p[k]); if (!(v >= lo && v <= hi)) throw Object.assign(new Error(k + ' must be ' + lo + '–' + hi), { status: 400 }); c[k] = v; } };
  if (p.enabled != null) c.enabled = !!p.enabled;
  num('memAvailPct', 1, 50); num('memPsi', 1, 100); num('cpuPct', 50, 100); num('cpuMinutes', 1, 120);
  num('diskWarnPct', 50, 99); num('diskPct', 50, 99); num('appMemMB', 128, 65536); num('idleDevMinutes', 5, 1440);
  if (p.steps) for (const k of Object.keys(DEFAULTS.steps)) if (p.steps[k] != null) c.steps[k] = !!p.steps[k];
  settings.set('resguard.config', c);
  return c;
}

// ---- process classes (by command line; only non-root users are ever acted on)
const HELPER_RE = /typescript\/lib\/tsserver\.js|typescript\/lib\/typingsInstaller\.js|copilot-runtime|eslintServer|languageserver|language-server|pylance|pyright/i;
const MCP_RE = /mcp-pdf-server|@modelcontextprotocol\/server-|node_modules\/\.bin\/mcp\b|npm exec @modelcontextprotocol/;
const REMOTE_CLAUDE_RE = /\/claude\/versions\/[\d.]+ --print --sdk-url/;
const DEV_RE = /\.vscode-server\/|\/\.local\/share\/claude\/|\/\.local\/bin\/claude|native-binary\/claude|\/_npx\/|npm exec|tsserver|\bnpm (?:install|ci|run)|\bpnpm\b|next build|webpack|esbuild|\btsc\b|\bvite build/;
const PROTECT_RE = /sshd|nginx|mysqld|mariadbd|postgres|redis-server|\/opt\/sb-srv-mon\//;

// ---- sampling
function readFile(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }
function meminfo() {
  const t = readFile('/proc/meminfo') || '', g = (k) => { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t); return m ? Number(m[1]) * 1024 : 0; };
  const total = g('MemTotal'), avail = g('MemAvailable'), swapT = g('SwapTotal'), swapF = g('SwapFree');
  return { total, avail, availPct: total ? Math.round(avail / total * 1000) / 10 : 100, swapTotal: swapT, swapUsed: swapT - swapF };
}
function psi(kind) {
  const m = /some avg10=([\d.]+) avg60=([\d.]+)/.exec(readFile('/proc/pressure/' + kind) || '');
  return m ? { avg10: Number(m[1]), avg60: Number(m[2]) } : null;
}
let prevCpu = null;
function cpuTotal() {
  const f = (readFile('/proc/stat') || '').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = (f[3] || 0) + (f[4] || 0), total = f.reduce((a, b) => a + b, 0);
  let pct = null;
  if (prevCpu && total > prevCpu.total) pct = Math.round((1 - (idle - prevCpu.idle) / (total - prevCpu.total)) * 1000) / 10;
  prevCpu = { idle, total };
  return pct;
}
function disk() { try { const s = fs.statfsSync('/'); return { pct: Math.round((1 - s.bavail / s.blocks) * 100), freeBytes: s.bavail * s.bsize }; } catch (_) { return null; } }

const procPrev = new Map();   // pid → { ticks, at, start, idleSince, hotSince }
const userName = (() => { const cache = new Map(); return (uid) => { if (cache.has(uid)) return cache.get(uid); let n = String(uid); try { const l = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((x) => x.split(':')[2] === String(uid)); if (l) n = l.split(':')[0]; } catch (_) {} cache.set(uid, n); return n; }; })();
function processes(now) {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number); } catch (_) { return out; }
  const live = new Set();
  for (const pid of pids) {
    const st = readFile('/proc/' + pid + '/stat'); if (!st) continue;
    const cmd = (readFile('/proc/' + pid + '/cmdline') || '').split('\0').filter(Boolean).join(' ');
    if (!cmd) continue;                                   // kernel thread
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(f[1]), ticks = Number(f[11]) + Number(f[12]), start = Number(f[19]), rss = Number(f[21]) * PAGE;
    const um = /^Uid:\s+(\d+)/m.exec(readFile('/proc/' + pid + '/status') || ''); const uid = um ? Number(um[1]) : 0;
    live.add(pid);
    let p = procPrev.get(pid);
    if (!p || p.start !== start) p = { ticks, at: now, start, idleSince: now, hotSince: null, cpu: 0 };
    const dt = (now - p.at) / 1000;
    const cpu = dt > 0 ? Math.round((ticks - p.ticks) / HZ / dt * 1000) / 10 : 0;   // % of one core
    if (dt > 0) { p.cpu = cpu; if (cpu >= 1) p.idleSince = now; if (cpu >= 90) { if (!p.hotSince) p.hotSince = now; } else p.hotSince = null; }
    p.ticks = ticks; p.at = now;
    procPrev.set(pid, p);
    out.push({ pid, ppid, uid, user: userName(uid), rss, cpu: p.cpu, cmd: cmd.slice(0, 400), idleMs: now - p.idleSince, hotMs: p.hotSince ? now - p.hotSince : 0 });
  }
  for (const pid of [...procPrev.keys()]) if (!live.has(pid)) procPrev.delete(pid);
  return out;
}

// ---- helpers
const mb = (b) => Math.round(b / 1048576) + ' MB';
const short = (c) => c.replace(/\/home\/[^/]+\/\.vscode-server\/[^ ]*\/(?=[^/ ]+( |$))/g, '…/').slice(0, 110);
const own = new Set([process.pid, process.ppid]);
function actable(p) { return p.uid >= 1000 && !own.has(p.pid) && !PROTECT_RE.test(p.cmd); }
function kill(p) { try { process.kill(p.pid, 'SIGTERM'); setTimeout(() => { try { process.kill(p.pid, 0); process.kill(p.pid, 'SIGKILL'); } catch (_) {} }, 5000).unref(); return true; } catch (_) { return false; } }
function writeOom(pid, v) { try { const f = '/proc/' + pid + '/oom_score_adj'; if (Number(readFile(f)) !== v) fs.writeFileSync(f, String(v)); } catch (_) {} }
function topLines(list, key, n) {
  return list.slice().sort((a, b) => b[key] - a[key]).slice(0, n)
    .map((p) => '• ' + (key === 'rss' ? mb(p.rss) : p.cpu + '%') + ' ' + p.user + ' (' + p.pid + '): ' + short(p.cmd)).join('\n');
}
function siteApps() {
  const out = [];
  try {
    const c = require('./sites').getCache();
    for (const s of (c && c.sites) || []) for (const a of s.pm2 || []) if (a.pid && a.status === 'online') out.push({ domain: s.domain, name: a.name, user: a.pm2User, pid: a.pid, memory: a.memory || 0 });
  } catch (_) {}
  return out;
}
async function restartApp(app, why) {
  const site = require('./sites/store').get(app.domain);
  if (!site) return { ok: false, detail: 'site not found' };
  if (require('./sites/hold').get(app.domain)) return { ok: false, detail: 'site is held stopped' };
  try { if (require('./sites/overrides').repairMode(app.domain) === 'off') return { ok: false, detail: 'self-repair is off for this site' }; } catch (_) {}
  const r = await require('./sites/procs').act(site, 'restart', { app: app.name, user: app.user }).catch((e) => ({ ok: false, results: [{ output: e.message }] }));
  return { ok: !!r.ok, detail: 'pm2 restart ' + app.name + ' (' + app.domain + ') — ' + why + (r.ok ? '' : ': ' + ((r.results || [])[0] || {}).output) };
}

// ---- state
let state = { at: null, mem: null, psiMem: null, cpu: null, load: null, disk: null, mode: {}, top: { mem: [], cpu: [] }, error: null };
const ep = { mem: null, cpu: null, disk: null };  // current episodes: { since, step, lastStepAt, alerted, hits, clear }
const appRestarted = new Map();                  // "user/name" → ms
let lastDiskExtra = 0;
let actions = [];
try { actions = settings.get('resguard.log', []) || []; } catch (_) {}
function record(kind, text, level) {
  actions.unshift({ at: new Date().toISOString(), kind, text });
  actions = actions.slice(0, 100);
  try { settings.set('resguard.log', actions); } catch (_) {}
  events.emit('resguard.' + kind, { user: 'watchdog', level: level || 'warn', message: 'Resource watchdog: ' + text });
}
function tell(text) { try { require('./notify').send(text, 'complete').catch(() => {}); } catch (_) {} }

// One episode per resource: starts after `need` bad ticks, ends after 8 good ticks (2 min).
function episode(key, bad, need, now) {
  let e = ep[key];
  if (bad) {
    if (!e) e = ep[key] = { since: now, hits: 0, step: 0, lastStepAt: 0, alerted: false, clear: 0 };
    e.hits++; e.clear = 0;
    return e.hits >= need ? e : null;
  }
  if (e) { e.clear++; if (e.clear >= 8) { if (e.step || e.alerted) record(key, key + ' back to normal after ' + Math.round((now - e.since) / 60_000) + ' min', 'info'); ep[key] = null; } }
  return null;
}

async function memLadder(e, procs, c, mem, now) {
  if (now - e.lastStepAt < STEP_GAP_MS) return;
  const steps = c.steps;
  while (e.step < 4) {
    e.step++;
    if (e.step === 1 && steps.helpers) {
      const v = procs.filter((p) => actable(p) && HELPER_RE.test(p.cmd));
      if (!v.length) continue;
      const freed = v.reduce((n, p) => n + (kill(p) ? p.rss : 0), 0);
      record('mem', 'memory pressure (' + mem.availPct + '% available): killed ' + v.length + ' language server(s), ~' + mb(freed) + ' — they respawn when an editor needs them');
      e.lastStepAt = now; return;
    }
    if (e.step === 2 && steps.idleDev) {
      const idleMs = c.idleDevMinutes * 60_000;
      const v = procs.filter((p) => actable(p) && (REMOTE_CLAUDE_RE.test(p.cmd) || MCP_RE.test(p.cmd)) && p.idleMs >= idleMs);
      if (!v.length) continue;
      const freed = v.reduce((n, p) => n + (kill(p) ? p.rss : 0), 0);
      record('mem', 'memory pressure: stopped ' + v.length + ' idle dev process(es) (remote Claude sessions / MCP servers idle ≥ ' + c.idleDevMinutes + ' min), ~' + mb(freed) + '\n' + v.slice(0, 8).map((p) => '• ' + p.user + ': ' + short(p.cmd)).join('\n'));
      e.lastStepAt = now; return;
    }
    if (e.step === 3 && steps.leakyApp) {
      const limit = c.appMemMB * 1048576;
      const rssOf = new Map(procs.map((p) => [p.pid, p.rss]));
      const apps = siteApps().map((a) => Object.assign(a, { rss: rssOf.get(a.pid) || a.memory }))
        .filter((a) => a.rss > limit && now - (appRestarted.get(a.user + '/' + a.name) || 0) > APP_RESTART_EVERY_MS).sort((a, b) => b.rss - a.rss);
      if (!apps.length) continue;
      appRestarted.set(apps[0].user + '/' + apps[0].name, now);
      const r = await restartApp(apps[0], 'using ' + mb(apps[0].rss) + ' (limit ' + c.appMemMB + ' MB) under memory pressure');
      record('mem', r.detail, r.ok ? 'warn' : 'error');
      tell((r.ok ? '♻️' : '❌') + ' *Memory pressure* (' + mem.availPct + '% available): ' + r.detail);
      e.lastStepAt = now; return;
    }
    if (e.step === 4 && !e.alerted) {
      e.alerted = true;
      const text = 'still under memory pressure: ' + mem.availPct + '% available' + (mem.swapTotal ? ', swap ' + mb(mem.swapUsed) + ' used' : '') + ' — nothing more it may free on its own';
      record('mem', text, 'error');
      tell('🧠 *Memory pressure* — ' + text + '\nTop memory users:\n' + topLines(procs, 'rss', 10));
    }
  }
}

async function cpuLadder(e, procs, c, cpuPct, now) {
  if (now - e.lastStepAt < STEP_GAP_MS) return;
  const steps = c.steps;
  while (e.step < 3) {
    e.step++;
    if (e.step === 1 && steps.renice) {
      const v = procs.filter((p) => actable(p) && DEV_RE.test(p.cmd) && p.cpu >= 10);
      if (!v.length) continue;
      for (const p of v) { await execP('renice', ['-n', '19', '-p', String(p.pid)], { timeout: 5000 }); await execP('ionice', ['-c', '3', '-p', String(p.pid)], { timeout: 5000 }); }
      record('cpu', 'CPU ' + cpuPct + '% for ' + c.cpuMinutes + '+ min: lowered the priority of ' + v.length + ' dev/build process(es) (nice 19, idle I/O)\n' + v.slice(0, 8).map((p) => '• ' + p.cpu + '% ' + p.user + ': ' + short(p.cmd)).join('\n'));
      e.lastStepAt = now; return;
    }
    if (e.step === 2 && steps.runawayApp) {
      const hotMs = c.cpuMinutes * 60_000;
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      const apps = siteApps().map((a) => Object.assign(a, { p: byPid.get(a.pid) }))
        .filter((a) => a.p && a.p.hotMs >= hotMs && now - (appRestarted.get(a.user + '/' + a.name) || 0) > APP_RESTART_EVERY_MS).sort((a, b) => b.p.cpu - a.p.cpu);
      if (!apps.length) continue;
      appRestarted.set(apps[0].user + '/' + apps[0].name, now);
      const r = await restartApp(apps[0], 'pinned at ' + apps[0].p.cpu + '% CPU for ' + Math.round(apps[0].p.hotMs / 60_000) + ' min');
      record('cpu', r.detail, r.ok ? 'warn' : 'error');
      tell((r.ok ? '♻️' : '❌') + ' *Runaway CPU*: ' + r.detail);
      e.lastStepAt = now; return;
    }
    if (e.step === 3 && !e.alerted) {
      e.alerted = true;
      const text = 'CPU at ' + cpuPct + '% for ' + Math.round((now - e.since) / 60_000) + ' min (load ' + os.loadavg().map((x) => x.toFixed(1)).join(' ') + ', ' + os.cpus().length + ' cores)';
      record('cpu', text, 'error');
      tell('🔥 *High CPU* — ' + text + '\nTop CPU users:\n' + topLines(procs, 'cpu', 10));
    }
  }
}

// Extra disk space beyond the cache cleanup. Each step is regenerable or only old log content.
async function diskExtra(now) {
  if (now - lastDiskExtra < DISK_EXTRA_EVERY_MS) return null;
  lastDiskExtra = now;
  const before = disk(), done = [];
  const j = await execP('journalctl', ['--vacuum-size=300M'], { timeout: 120_000 });
  if (!j.err) done.push('journal vacuumed to 300 MB');
  // huge logs: keep the last 20 MB in place (truncate, so writers holding the file keep working)
  let logs = 0;
  const KEEP = 20 * 1048576, BIG = 500 * 1048576;
  const dirs = [];
  for (const u of fs.readdirSync('/home')) for (const d of ['.pm2/logs', 'logs/nodejs', 'logs/nginx', 'logs/php']) dirs.push(path.join('/home', u, d));
  dirs.push('/root/.pm2/logs');
  for (const d of dirs) {
    let names = []; try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      const f = path.join(d, n);
      try {
        const st = fs.lstatSync(f);
        if (!st.isFile() || st.size < BIG || !/\.log$/.test(n)) continue;
        const fd = fs.openSync(f, 'r+'); const buf = Buffer.alloc(KEEP);
        fs.readSync(fd, buf, 0, KEEP, st.size - KEEP); fs.ftruncateSync(fd, 0); fs.writeSync(fd, buf, 0, KEEP, 0); fs.closeSync(fd);
        logs++;
      } catch (_) {}
    }
  }
  if (logs) done.push(logs + ' log file(s) over 500 MB cut to their last 20 MB');
  // VS Code server builds no running process uses (keeps the newest per user)
  let builds = 0;
  const running = (() => { try { return fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map((x) => readFile('/proc/' + x + '/cmdline') || '').join('\n'); } catch (_) { return ''; } })();
  for (const u of fs.readdirSync('/home')) {
    const base = path.join('/home', u, '.vscode-server/cli/servers');
    let list = []; try { list = fs.readdirSync(base).filter((x) => /^Stable-[0-9a-f]+$/.test(x)).map((x) => ({ x, t: fs.statSync(path.join(base, x)).mtimeMs })).sort((a, b) => b.t - a.t); } catch (_) { continue; }
    for (const b of list.slice(1)) if (!running.includes(b.x)) { try { fs.rmSync(path.join(base, b.x), { recursive: true, force: true }); builds++; } catch (_) {} }
  }
  if (builds) done.push(builds + ' unused VS Code server build(s) removed');
  const a = await execP('apt-get', ['clean'], { timeout: 60_000 });
  if (!a.err) done.push('apt cache cleaned');
  const after = disk();
  const freed = before && after ? Math.max(0, after.freeBytes - before.freeBytes) : 0;
  const text = 'disk ' + (before ? before.pct : '?') + '% → ' + (after ? after.pct : '?') + '%: ' + done.join(', ') + ' (freed ' + mb(freed) + ')';
  record('disk', text);
  return text;
}

let running = false;
async function tick() {
  if (running) return state;
  running = true;
  try {
    const c = config(), now = Date.now();
    const mem = meminfo(), pm = psi('memory'), cpuPct = cpuTotal(), dk = disk();
    const procs = processes(now);
    // prevention: who the kernel OOM killer should take first
    if (c.enabled && c.steps.oomPriority) {
      writeOom(process.pid, -800);
      for (const p of procs) if (actable(p) && DEV_RE.test(p.cmd)) writeOom(p.pid, 500);
    }
    const memBad = mem.availPct < c.memAvailPct || (pm && pm.avg10 >= c.memPsi);
    const cpuBad = cpuPct != null && cpuPct >= c.cpuPct;
    const em = episode('mem', memBad, 2, now);
    const ec = episode('cpu', cpuBad, Math.ceil(c.cpuMinutes * 60_000 / TICK_MS), now);
    const ed = episode('disk', dk && dk.pct >= c.diskWarnPct, 2, now);
    if (c.enabled) {
      if (em) await memLadder(em, procs, c, mem, now);
      if (ec) await cpuLadder(ec, procs, c, cpuPct, now);
      if (ed && !ed.alerted) { ed.alerted = true; record('disk', 'root filesystem ' + dk.pct + '% full (' + mb(dk.freeBytes) + ' free)', 'error'); tell('💾 *Disk* — root filesystem ' + dk.pct + '% full, ' + mb(dk.freeBytes) + ' free' + (dk.pct >= c.diskPct ? '' : ' (cleanup starts at ' + c.diskPct + '%)')); }
      if (ed && dk.pct >= c.diskPct && c.steps.diskExtra) { const t = await diskExtra(now); if (t) tell('🧹 *Disk* — ' + t); }
    }
    const mode = { mem: ep.mem ? (ep.mem.hits >= 2 ? 'pressure' : 'watch') : 'ok', cpu: ep.cpu ? (ec ? 'high' : 'watch') : 'ok', disk: dk && dk.pct >= c.diskPct ? 'full' : ed ? 'warn' : 'ok' };
    state = { at: new Date().toISOString(), mem, psiMem: pm, psiCpu: psi('cpu'), cpu: cpuPct, load: os.loadavg(), cores: os.cpus().length, disk: dk, mode,
      episodes: { mem: ep.mem && { since: new Date(ep.mem.since).toISOString(), step: ep.mem.step }, cpu: ep.cpu && { since: new Date(ep.cpu.since).toISOString(), step: ep.cpu.step } },
      top: { mem: procs.slice().sort((a, b) => b.rss - a.rss).slice(0, 8).map((p) => ({ pid: p.pid, user: p.user, rss: p.rss, cpu: p.cpu, cmd: short(p.cmd) })),
        cpu: procs.slice().sort((a, b) => b.cpu - a.cpu).slice(0, 8).map((p) => ({ pid: p.pid, user: p.user, rss: p.rss, cpu: p.cpu, cmd: short(p.cmd) })) }, error: null };
  } catch (e) { state = Object.assign({}, state, { error: e.message }); }
  finally { running = false; }
  return state;
}

let timer = null;
function start() { if (!timer) { timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS); tick().catch(() => {}); } }
function stop() { if (timer) { clearInterval(timer); timer = null; } }
function status() { return { config: config(), tickSeconds: TICK_MS / 1000, state, log: actions.slice(0, 40) }; }

module.exports = { start, stop, tick, status, setConfig, config };
