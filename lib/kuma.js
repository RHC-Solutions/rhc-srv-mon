'use strict';
// Uptime Kuma → Monitor page. Kuma watches everything on this host (kuma-sync adds every running
// service, listening port and public tunnel hostname, and runs right after a site is created), so
// its monitor list is the host's full inventory. The panel reads Kuma's Prometheus /metrics with an
// API key (kv kuma.apiKey, encrypted) and shows status, response time and uptime per monitor.
//
// Kuma rate-limits its API to 60 requests a minute, so the result is cached server-side and shared
// by every viewer; a refresh happens at most every TTL.
const { settings } = require('./db');
const secrets = require('./secrets');
const { execP } = require('./util');

// Kuma's base URL: local by default; kv kuma.url points the panel at a Kuma on another host
// (web01 reads dns01's Kuma — then kuma-sync is that host's job, not ours).
const LOCAL = 'http://127.0.0.1:3001';
const kumaUrl = () => String(settings.get('kuma.url', '') || '').replace(/\/+$/, '') || LOCAL;
const TTL = 30_000;
const STATUS = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };
let cache = null, cacheAt = 0, running = null;

function apiKey() {
  const v = settings.get('kuma.apiKey', null);
  if (!v) return null;
  try { return secrets.isEncrypted(v) ? secrets.decrypt(v) : v; } catch (_) { return null; }
}
const publicUrl = () => String(settings.get('kuma.publicUrl', '') || '').replace(/\/+$/, '') || null;

// Prometheus text format: name{label="v",...} value
function parse(text) {
  const byId = new Map();
  const get = (labels) => {
    const id = Number(labels.monitor_id);
    if (!byId.has(id)) byId.set(id, { id, name: labels.monitor_name, type: labels.monitor_type, url: labels.monitor_url || '', hostname: labels.monitor_hostname || '', port: labels.monitor_port || '' });
    return byId.get(id);
  };
  for (const line of text.split('\n')) {
    const m = /^(monitor_[a-z_]+)\{(.*)\}\s+(\S+)$/.exec(line);
    if (!m) continue;
    const labels = {};
    for (const p of m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[p[1]] = p[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c));
    if (!labels.monitor_id) continue;
    const mon = get(labels), v = Number(m[3]);
    if (!Number.isFinite(v)) continue;
    if (m[1] === 'monitor_status') mon.status = STATUS[v] || 'unknown';
    else if (m[1] === 'monitor_response_time') mon.responseMs = v >= 0 ? Math.round(v) : null;
    else if (m[1] === 'monitor_uptime_ratio' && labels.window === '1d') mon.uptime24h = v;
    else if (m[1] === 'monitor_uptime_ratio' && labels.window === '30d') mon.uptime30d = v;
    else if (m[1] === 'monitor_cert_days_remaining') mon.certDays = v;
  }
  return [...byId.values()].filter((m) => m.type !== 'group' && m.status);
}

// Which section of the Monitor page a monitor belongs to — kuma-sync's naming: "public · <host>",
// "<host> · <unit>" (service), "<host> · <proc> :<port>" (port); anything else was added by hand.
function sectionOf(m) {
  if (/^public · /.test(m.name)) return 'public';
  if (m.type === 'system-service' || m.type === 'systemd') return 'services';
  if (/ :\d+$/.test(m.name)) return 'ports';
  return 'other';
}

async function collect() {
  const key = apiKey();
  const out = { configured: !!key, url: kumaUrl(), publicUrl: publicUrl(), monitors: [], error: null, generated_at: new Date().toISOString() };
  if (!key) { out.error = 'no Kuma API key stored (kv kuma.apiKey)'; return out; }
  try {
    const r = await fetch(kumaUrl() + '/metrics', { headers: { Authorization: 'Basic ' + Buffer.from(':' + key).toString('base64') }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401) throw new Error('Kuma refused the API key (deleted or deactivated in Kuma → Settings → API Keys?)');
    if (!r.ok) throw new Error('Kuma /metrics: HTTP ' + r.status);
    out.monitors = parse(await r.text()).map((m) => Object.assign(m, { section: sectionOf(m), link: out.publicUrl ? out.publicUrl + '/dashboard/' + m.id : null }))
      .sort((a, b) => a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
  } catch (e) { out.error = e.name === 'TimeoutError' ? 'Uptime Kuma did not answer' : e.message; }
  const n = (s) => out.monitors.filter((m) => m.status === s).length;
  out.summary = { total: out.monitors.length, up: n('up'), down: n('down'), pending: n('pending'), maintenance: n('maintenance') };
  return out;
}

async function get(force) {
  if (force || !cache || Date.now() - cacheAt > TTL) {
    if (!running) running = collect().then((c) => { cache = c; cacheAt = Date.now(); }).finally(() => { running = null; });
    await running;
  }
  return cache;
}

// Run kuma-sync now (instead of waiting for its 10-minute timer) — after a site was created, so the
// site, its service and its public hostname are monitored at once. Fire and forget.
function syncSoon() {
  if (kumaUrl() !== LOCAL) return; // remote Kuma: its own host runs kuma-sync
  execP('systemctl', ['start', '--no-block', 'kuma-sync.service'], { timeout: 15_000 })
    .then(() => { setTimeout(() => { cacheAt = 0; }, 30_000); })
    .catch(() => {});
}

module.exports = { get, syncSoon, parse };
