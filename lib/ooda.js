'use strict';
// Self-repair as an OODA loop, once a minute (left menu → Self-repair):
//
//   Observe  Uptime Kuma (every service, port and public hostname kuma-sync put there), the panel's
//            own site health, failed systemd units, root filesystem usage.
//   Orient   turn what is red into incidents with a concrete target: a systemd unit, a site's pm2
//            apps, a tunnel unit, nginx, the disk. Something red only once is not an incident yet —
//            it has to be seen in two consecutive cycles (Kuma itself retries before it reports).
//   Decide   pick the repair from a fixed playbook, unless: self-repair is off (globally or for the
//            site), the site was stopped on purpose (hold), the target is on the never-touch list,
//            or the target already had MAX_ATTEMPTS repairs in the last hour (then: one alert, give up
//            until it recovers or the hour has passed). Back-off between attempts: 0, 5, 15 minutes.
//   Act      run it, re-check after a settle delay, log the outcome (Events + this page) and tell the
//            site's notification channels (shared, or the site's own override).
//
// Everything in the playbook is a restart/reload/cleanup — no action deletes data, rolls anything
// back or changes configuration.
const fs = require('fs');
const os = require('os');
const { execP } = require('./util');
const { settings } = require('./db');
const events = require('./events');

const CYCLE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 5 * 60_000, 15 * 60_000];
const SETTLE_MS = 20_000;
const DISK_PCT = 90;
// Never restarted by the loop: the panel itself (pm2), the login/session plumbing, the kernel-ish bits.
const NEVER = [/^sb-srv-mon/, /^rhc-srv-mon/, /^pm2-root/, /^systemd-/, /^dbus/, /^user@/, /^getty@/, /^serial-getty@/, /^networking/, /^ssh(d)?$/, /^cloudflared-update$/];

let state = { lastCycle: null, durationMs: null, observe: {}, incidents: [], running: false, error: null };
const seen = new Map();      // incident key → { first, last, count }
const attempts = new Map();  // incident key → [timestamps]
let alertedGaveUp = new Set();
let log = [];                // recent decisions/actions (newest first), mirrored to kv
try { log = settings.get('ooda.log', []) || []; } catch (_) {}

const config = () => Object.assign({ enabled: true }, settings.get('ooda.config', {}) || {});
function setConfig(p) { const c = config(); if (p.enabled != null) c.enabled = !!p.enabled; settings.set('ooda.config', c); return c; }
function remember(entry) {
  log.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  log = log.slice(0, 200);
  try { settings.set('ooda.log', log); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unitOk = (u) => /^[A-Za-z0-9@._:-]+$/.test(u);

async function unitState(unit) {
  const out = (await execP('systemctl', ['show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'TriggeredBy', '-p', 'Type'], { timeout: 10_000 })).stdout;
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
}

// ------------------------------------------------------------------ observe
async function observe() {
  const obs = { kuma: null, sites: [], failedUnits: [], disk: null, errors: [] };
  try { obs.kuma = await require('./kuma').get(); } catch (e) { obs.errors.push('kuma: ' + e.message); }
  try { obs.sites = (require('./sites').getCache() || { sites: [] }).sites || []; } catch (e) { obs.errors.push('sites: ' + e.message); }
  try {
    const out = (await execP('systemctl', ['list-units', '--type=service', '--state=failed', '--no-legend', '--plain'], { timeout: 15_000 })).stdout;
    obs.failedUnits = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => u && u.endsWith('.service'));
  } catch (e) { obs.errors.push('systemd: ' + e.message); }
  try { const s = fs.statfsSync('/'); obs.disk = { pct: Math.round((1 - s.bavail / s.blocks) * 100), freeBytes: s.bavail * s.bsize }; } catch (e) { obs.errors.push('disk: ' + e.message); }
  return obs;
}

// ------------------------------------------------------------------ orient
// Incident: { key, kind, target, site?, evidence }
async function orient(obs) {
  const out = []; const add = (i) => { if (!out.some((x) => x.key === i.key)) out.push(i); };
  const host = os.hostname();
  const sitesByApp = new Map();
  for (const s of obs.sites) for (const p of s.pm2 || []) sitesByApp.set(p.name, s.domain);
  // panel site health: a site that is down/degraded and the panel can control
  for (const s of obs.sites) {
    if (s.heldStopped || s.status === 'stopped' || !s.canControl) continue;
    if (s.status === 'down' || s.status === 'degraded') add({ key: 'site:' + s.domain, kind: 'site', target: s.domain, site: s.domain, evidence: (s.statusLabel || s.status) + (s.statusReason ? ' — ' + s.statusReason : '') });
  }
  // Kuma
  const tunnels = (() => { try { return require('./sites/tunnels').get().tunnels || []; } catch (_) { return []; } })();
  for (const m of (obs.kuma && obs.kuma.monitors) || []) {
    if (m.status !== 'down') continue;
    const ev = 'Kuma: ' + m.name + ' is down';
    if (m.section === 'services') {
      const unit = m.name.replace(new RegExp('^' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' · '), '') + '.service';
      add({ key: 'unit:' + unit, kind: 'unit', target: unit, evidence: ev });
    } else if (m.section === 'ports') {
      const proc = (/ · (.+) :\d+$/.exec(m.name) || [])[1];
      if (!proc) continue;
      if (sitesByApp.has(proc)) add({ key: 'site:' + sitesByApp.get(proc), kind: 'site', target: sitesByApp.get(proc), site: sitesByApp.get(proc), evidence: ev });
      else add({ key: 'unit:' + proc + '.service', kind: 'unit', target: proc + '.service', evidence: ev });
    } else if (m.section === 'public') {
      const hostName = String(m.name).replace(/^public · /, '').toLowerCase();
      const t = tunnels.find((x) => (x.routes || []).some((r) => String(r.hostname).toLowerCase() === hostName));
      if (t) {
        const route = t.routes.find((r) => String(r.hostname).toLowerCase() === hostName);
        if (!t.active || t.status === 'down' || t.status === 'inactive') add({ key: 'unit:' + t.unit + '.service', kind: 'unit', target: t.unit + '.service', evidence: ev + ' (its tunnel ' + t.unit + ' is ' + (t.active ? t.status : 'not running') + ')' });
        else if (route && route.local === 0) {
          const site = obs.sites.find((s) => s.domain === hostName || 'www.' + s.domain === hostName);
          if (site) add({ key: 'site:' + site.domain, kind: 'site', target: site.domain, site: site.domain, evidence: ev + ' (origin ' + route.service + ' does not answer)' });
          else if (/^https?:\/\/127\.0\.0\.1:(80|443|8890)\b/.test(route.service)) add({ key: 'nginx', kind: 'nginx', target: 'nginx', evidence: ev + ' (nginx origin ' + route.service + ' does not answer)' });
        }
      }
    }
  }
  // failed systemd units (not timer jobs)
  for (const u of obs.failedUnits) add({ key: 'unit:' + u, kind: 'unit', target: u, evidence: 'systemd: ' + u + ' failed' });
  // disk
  if (obs.disk && obs.disk.pct >= DISK_PCT) add({ key: 'disk', kind: 'disk', target: '/', evidence: 'root filesystem ' + obs.disk.pct + '% full' });
  return out;
}

// ------------------------------------------------------------------ decide
async function decide(inc, now) {
  const c = config();
  if (!c.enabled) return { act: false, why: 'self-repair is turned off' };
  const s = seen.get(inc.key);
  if (!s || s.count < 2) return { act: false, why: 'seen once — confirming next cycle' };
  if (inc.site) {
    const ov = require('./sites/overrides');
    if (ov.repairMode(inc.site) === 'off') return { act: false, why: 'self-repair is off for this site' };
    if (require('./sites/hold').get(inc.site)) return { act: false, why: 'site was stopped on purpose' };
  }
  if (inc.kind === 'unit') {
    const name = inc.target.replace(/\.service$/, '');
    if (!unitOk(inc.target) || NEVER.some((r) => r.test(name))) return { act: false, why: 'on the never-touch list' };
    const st = await unitState(inc.target);
    if (st.LoadState !== 'loaded') return { act: false, why: 'no such systemd unit (' + (st.LoadState || '?') + ')' };
    if (/\.timer/.test(st.TriggeredBy || '') || st.Type === 'oneshot') return { act: false, why: 'timer job / oneshot — not a long-running service' };
    if (st.ActiveState === 'active' && st.SubState === 'running') return { act: false, why: 'unit is running — the problem is elsewhere (watching)' };
  }
  const list = (attempts.get(inc.key) || []).filter((t) => now - t < 3600_000);
  attempts.set(inc.key, list);
  if (list.length >= MAX_ATTEMPTS) return { act: false, why: MAX_ATTEMPTS + ' repairs in the last hour did not hold — giving up for now', gaveUp: true };
  const wait = BACKOFF_MS[list.length] || BACKOFF_MS[BACKOFF_MS.length - 1];
  if (list.length && now - list[list.length - 1] < wait) return { act: false, why: 'backing off (attempt ' + (list.length + 1) + ' due in ' + Math.ceil((wait - (now - list[list.length - 1])) / 60_000) + ' min)' };
  const action = { unit: 'restart ' + inc.target, site: 'restart the apps of ' + inc.target, nginx: 'nginx -t, then reload (restart if not running)', disk: 'run the cache cleanup' }[inc.kind];
  return action ? { act: true, action } : { act: false, why: 'no playbook entry' };
}

// ------------------------------------------------------------------ act
async function act(inc) {
  const r = { ok: false, detail: '' };
  try {
    if (inc.kind === 'unit') {
      await execP('systemctl', ['reset-failed', inc.target], { timeout: 15_000 });
      const x = await execP('systemctl', ['restart', inc.target], { timeout: 90_000 });
      if (x.err) { r.detail = (x.stderr || x.err.message).trim().split('\n').pop(); return r; }
      await sleep(SETTLE_MS);
      const st = await unitState(inc.target);
      r.ok = st.ActiveState === 'active'; r.detail = 'now ' + st.ActiveState + '/' + st.SubState;
    } else if (inc.kind === 'site') {
      const store = require('./sites/store'), procs = require('./sites/procs');
      const site = store.get(inc.target);
      if (!site) { r.detail = 'site not found'; return r; }
      const a = await procs.act(site, 'restart', {});
      await sleep(SETTLE_MS);
      const fresh = await require('./sites').refreshSite(inc.target).catch(() => null);
      const s = fresh && (fresh.sites ? fresh.sites.find((x) => x.domain === inc.target) : fresh);
      r.ok = !!(a && a.ok) && !!(s && s.status === 'online');
      r.detail = s ? 'site is ' + (s.statusLabel || s.status) + (s.statusReason ? ' — ' + s.statusReason : '') : (a && a.ok ? 'apps restarted' : 'restart failed');
    } else if (inc.kind === 'nginx') {
      const t = await execP('nginx', ['-t'], { timeout: 20_000 });
      if (t.err) { r.detail = 'nginx -t fails — config error, not restarting: ' + (t.stderr || '').trim().split('\n').slice(-2).join(' '); return r; }
      const st = await unitState('nginx.service');
      const x = await execP('systemctl', [st.ActiveState === 'active' ? 'reload' : 'restart', 'nginx'], { timeout: 60_000 });
      r.ok = !x.err; r.detail = (st.ActiveState === 'active' ? 'reloaded' : 'restarted') + (x.err ? ' — failed: ' + (x.stderr || '').trim() : '');
    } else if (inc.kind === 'disk') {
      const e = await require('./modules').runCleanup('ooda', {}, 'self-repair');
      r.ok = !!(e && !e.skipped); r.detail = e && e.skipped ? 'cleanup skipped: ' + e.reason : 'freed ' + Math.round(((e && e.freedBytes) || 0) / 1048576) + ' MB';
    }
  } catch (e) { r.detail = e.message; }
  return r;
}

function tell(inc, text) {
  try { require('./notify').send(text, 'complete', { site: inc.site }).catch(() => {}); } catch (_) {}
}

// ------------------------------------------------------------------ the loop
async function cycle() {
  if (state.running) return state;
  state.running = true;
  const t0 = Date.now();
  try {
    const obs = await observe();
    const incidents = await orient(obs);
    const now = Date.now();
    // bookkeeping: what is red now, for how many cycles
    const keys = new Set(incidents.map((i) => i.key));
    for (const k of [...seen.keys()]) if (!keys.has(k)) {
      const prev = seen.get(k); seen.delete(k);
      if ((attempts.get(k) || []).length || alertedGaveUp.has(k)) remember({ key: k, phase: 'resolved', text: 'recovered' + (prev ? ' after ' + Math.round((now - prev.first) / 60_000) + ' min' : '') });
      alertedGaveUp.delete(k); attempts.delete(k);
    }
    for (const i of incidents) { const s = seen.get(i.key) || { first: now, count: 0 }; s.count++; s.last = now; seen.set(i.key, s); }
    const rows = [];
    for (const inc of incidents) {
      const d = await decide(inc, now);
      const row = Object.assign({}, inc, { since: new Date(seen.get(inc.key).first).toISOString(), cycles: seen.get(inc.key).count, decision: d.act ? d.action : d.why, acting: d.act });
      rows.push(row);
      if (d.gaveUp && !alertedGaveUp.has(inc.key)) {
        alertedGaveUp.add(inc.key);
        remember({ key: inc.key, phase: 'gave-up', target: inc.target, text: d.why, evidence: inc.evidence });
        events.emit('ooda.gaveup', { user: 'self-repair', site: inc.site, target: inc.target, level: 'error', message: 'Self-repair gave up on ' + inc.target + ': ' + d.why });
        tell(inc, '🛑 *Self-repair gave up* on `' + inc.target + '`\n' + inc.evidence + '\n' + d.why + ' — needs a human.');
      }
      if (!d.act) continue;
      (attempts.get(inc.key) || attempts.set(inc.key, []).get(inc.key)).push(now);
      const n = attempts.get(inc.key).length;
      const res = await act(inc);
      row.result = res;
      remember({ key: inc.key, phase: res.ok ? 'fixed' : 'failed', target: inc.target, site: inc.site || null, action: d.action, attempt: n, evidence: inc.evidence, text: res.detail });
      events.emit('ooda.repair', { user: 'self-repair', site: inc.site, target: inc.target, level: res.ok ? 'warn' : 'error',
        message: (res.ok ? 'Self-repair fixed ' : 'Self-repair failed on ') + inc.target + ' (' + d.action + ', attempt ' + n + '): ' + res.detail, data: { evidence: inc.evidence } });
      tell(inc, (res.ok ? '🛠 *Self-repair fixed* `' : '⚠️ *Self-repair attempt ' + n + '/' + MAX_ATTEMPTS + ' failed* on `') + inc.target + '`\n' + inc.evidence + '\nAction: ' + d.action + '\nResult: ' + res.detail);
    }
    state = { lastCycle: new Date().toISOString(), durationMs: Date.now() - t0, running: false, error: null,
      observe: { kumaMonitors: obs.kuma ? (obs.kuma.monitors || []).length : null, kumaDown: obs.kuma ? (obs.kuma.monitors || []).filter((m) => m.status === 'down').length : null, kumaError: obs.kuma && obs.kuma.error,
        sites: obs.sites.length, sitesDown: obs.sites.filter((s) => s.status === 'down' || s.status === 'degraded').length, failedUnits: obs.failedUnits, disk: obs.disk, errors: obs.errors },
      incidents: rows };
  } catch (e) {
    state = Object.assign({}, state, { running: false, error: e.message, lastCycle: new Date().toISOString() });
  }
  return state;
}

let timer = null;
function start() { if (!timer) { timer = setInterval(() => { cycle().catch(() => {}); }, CYCLE_MS); setTimeout(() => cycle().catch(() => {}), 45_000); } }
function status() { return { config: config(), cycleSeconds: CYCLE_MS / 1000, maxAttempts: MAX_ATTEMPTS, diskPct: DISK_PCT, state, log: log.slice(0, 60) }; }

module.exports = { start, cycle, status, setConfig, orient, decide };
