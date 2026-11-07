'use strict';
// Security (left menu → Security): IP intelligence, fail2ban, and block rules by IP / range / ASN /
// country.
//
//   intel      ipinfo.io (country, city, ASN + owner, hostname) and AbuseIPDB (abuse confidence,
//              reports, usage type); cached. Keys in Settings → Security (encrypted, also in the Vault).
//   fail2ban   jails and their bans, ban/unban by hand; new bans can be reported to AbuseIPDB.
//   rules      enforced in two places:
//                host       nftables table "inet sbsrvman" (its own, ufw untouched): drop from the
//                           block sets — countries expand to their ranges (ipdeny.com), ASNs to their
//                           announced prefixes (RIPEstat). Admin IPs (whitelist), Cloudflare's edge and
//                           loopback are accepted first: a rule can never lock out an admin or the sites.
//                           Persisted in /etc/sb-srv-mon/blocklist.nft, loaded at boot by sb-blocklist.service.
//                cloudflare account-level IP Access Rules (block), covering every domain of the account —
//                           the only place web visitors can be blocked, since they arrive via Cloudflare.
//                           Needs the token permission Account → Account Firewall Access Rules → Edit.
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { settings } = require('./db');
const secrets = require('./secrets');
const { execP } = require('./util');

const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });
const enc = (v) => (v ? secrets.encrypt(v) : null);
const dec = (v) => { try { return v ? secrets.decrypt(v) : ''; } catch (_) { return ''; } };
const NFT = '/usr/sbin/nft';
const NFT_FILE = '/etc/sb-srv-mon/blocklist.nft';
const UNIT = '/etc/systemd/system/sb-blocklist.service';

// ------------------------------------------------------------------ config
function config() { const c = settings.get('security.config', {}) || {}; return { ipinfoToken: dec(c.ipinfo_enc), abuseKey: dec(c.abuse_enc), reportBans: !!c.reportBans }; }
function configView() { const c = config(); return { hasIpinfo: !!c.ipinfoToken, hasAbuse: !!c.abuseKey, reportBans: c.reportBans }; }
function saveConfig(b) {
  const c = settings.get('security.config', {}) || {};
  if (b.ipinfoToken != null) c.ipinfo_enc = b.ipinfoToken ? enc(String(b.ipinfoToken).trim()) : null;
  if (b.abuseKey != null) c.abuse_enc = b.abuseKey ? enc(String(b.abuseKey).trim()) : null;
  if (b.reportBans != null) c.reportBans = !!b.reportBans;
  settings.set('security.config', c);
  return configView();
}

// ------------------------------------------------------------------ intel
const intelCache = new Map();
async function intel(ip, opts) {
  ip = String(ip || '').trim();
  if (!net.isIP(ip)) throw bad('not an IP address');
  const hit = intelCache.get(ip);
  if (hit && Date.now() - hit.at < 6 * 3600_000 && !(opts && opts.fresh)) return hit.v;
  const c = config();
  const out = { ip, country: null, city: null, region: null, asn: null, org: null, hostname: null, abuse: null, errors: [] };
  try {
    const r = await fetch('https://ipinfo.io/' + ip + '/json' + (c.ipinfoToken ? '?token=' + encodeURIComponent(c.ipinfoToken) : ''), { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (j.error) out.errors.push('ipinfo: ' + (j.error.message || j.error.title || 'error'));
    out.country = j.country || null; out.city = j.city || null; out.region = j.region || null; out.hostname = j.hostname || null;
    const m = /^AS(\d+)\s*(.*)$/.exec(j.org || '');
    if (m) { out.asn = 'AS' + m[1]; out.org = m[2]; } else out.org = j.org || null;
    if (j.bogon) out.bogon = true;
  } catch (e) { out.errors.push('ipinfo: ' + e.message); }
  if (c.abuseKey) {
    try {
      const r = await fetch('https://api.abuseipdb.com/api/v2/check?maxAgeInDays=90&ipAddress=' + encodeURIComponent(ip), { headers: { Key: c.abuseKey, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.data) out.abuse = { score: j.data.abuseConfidenceScore, reports: j.data.totalReports, usage: j.data.usageType, isp: j.data.isp, lastReported: j.data.lastReportedAt, tor: j.data.isTor };
      else out.errors.push('AbuseIPDB: ' + ((j.errors && j.errors[0] && j.errors[0].detail) || 'error'));
    } catch (e) { out.errors.push('AbuseIPDB: ' + e.message); }
  }
  intelCache.set(ip, { at: Date.now(), v: out });
  return out;
}
async function reportAbuse(ip, comment, categories) {
  const c = config(); if (!c.abuseKey) return { ok: false, error: 'no AbuseIPDB key' };
  try {
    const body = new URLSearchParams({ ip, categories: (categories || [18, 22]).join(','), comment: String(comment || '').slice(0, 1000) });
    const r = await fetch('https://api.abuseipdb.com/api/v2/report', { method: 'POST', headers: { Key: c.abuseKey, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    return j.data ? { ok: true, score: j.data.abuseConfidenceScore } : { ok: false, error: (j.errors && j.errors[0] && j.errors[0].detail) || 'HTTP ' + r.status };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ------------------------------------------------------------------ fail2ban
const f2b = (args) => execP('fail2ban-client', args, { timeout: 20_000 });
async function fail2ban() {
  const st = await f2b(['status']);
  if (st.err) return { installed: false, error: (st.stderr || st.err.message).trim(), jails: [] };
  const names = ((/Jail list:\s*(.*)$/m.exec(st.stdout) || [])[1] || '').split(',').map((x) => x.trim()).filter(Boolean);
  const jails = [];
  for (const j of names) {
    const s = (await f2b(['status', j])).stdout;
    const num = (k) => Number((new RegExp(k + ':\\s*(\\d+)').exec(s) || [])[1] || 0);
    const banned = ((/Banned IP list:\s*(.*)$/m.exec(s) || [])[1] || '').split(/\s+/).filter(Boolean);
    jails.push({ name: j, currentlyFailed: num('Currently failed'), totalFailed: num('Total failed'), currentlyBanned: num('Currently banned'), totalBanned: num('Total banned'), banned });
  }
  return { installed: true, jails };
}
async function ban(jail, ip) { if (!net.isIP(ip)) throw bad('not an IP'); const r = await f2b(['set', jail, 'banip', ip]); if (r.err) throw bad('fail2ban refused', 424, r.stderr || r.stdout); return { ok: true }; }
async function unban(jail, ip) { if (!net.isIP(ip)) throw bad('not an IP'); const r = await f2b(['set', jail, 'unbanip', ip]); if (r.err) throw bad('fail2ban refused', 424, r.stderr || r.stdout); return { ok: true }; }
// Report bans that appeared since the last look (every few minutes, when enabled).
async function reportNewBans() {
  if (!config().reportBans) return;
  const seen = new Set(settings.get('security.reported', []) || []);
  const f = await fail2ban(); if (!f.installed) return;
  const admin = require('./whitelist').get().ips;
  for (const j of f.jails) for (const ip of j.banned) {
    if (seen.has(ip) || require('./whitelist').covers(admin, ip)) continue;
    const r = await reportAbuse(ip, 'fail2ban ' + j.name + ': repeated failed logins on ' + require('os').hostname(), j.name.includes('ssh') ? [18, 22] : [18, 21]);
    if (r.ok || /already reported|once every 15 minutes/i.test(r.error || '')) seen.add(ip);
  }
  settings.set('security.reported', [...seen].slice(-5000));
}

// ------------------------------------------------------------------ rules
const rules = () => settings.get('security.rules', []) || [];
const saveRules = (l) => settings.set('security.rules', l);
const TYPES = ['ip', 'range', 'asn', 'country'];
function normalize(type, value) {
  const v = String(value || '').trim();
  if (type === 'ip') { if (!net.isIP(v)) throw bad('not an IP address'); return v; }
  if (type === 'range') { const [a, l] = v.split('/'); const k = net.isIP(a); if (!k || !/^\d{1,3}$/.test(l || '') || Number(l) > (k === 4 ? 32 : 128) || Number(l) < (k === 4 ? 8 : 16)) throw bad('range like 203.0.113.0/24 (IPv4 /8–/32, IPv6 /16–/128)'); return a + '/' + l; }
  if (type === 'asn') { const m = /^(?:AS)?(\d{1,10})$/i.exec(v); if (!m) throw bad('ASN like AS13335'); return 'AS' + m[1]; }
  if (type === 'country') { if (!/^[A-Za-z]{2}$/.test(v)) throw bad('two-letter country code like CN'); return v.toUpperCase(); }
  throw bad('type must be ' + TYPES.join(', '));
}
async function prefixesOf(rule) {
  if (rule.type === 'ip') return [rule.value.includes(':') ? rule.value + '/128' : rule.value + '/32'];
  if (rule.type === 'range') return [rule.value];
  if (rule.type === 'asn') {
    const r = await fetch('https://stat.ripe.net/data/announced-prefixes/data.json?resource=' + rule.value, { signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    return ((j.data && j.data.prefixes) || []).map((p) => p.prefix).filter(Boolean);
  }
  if (rule.type === 'country') {
    const cc = rule.value.toLowerCase(), out = [];
    for (const u of ['https://www.ipdeny.com/ipblocks/data/aggregated/' + cc + '-aggregated.zone', 'https://www.ipdeny.com/ipv6/ipaddresses/aggregated/' + cc + '-aggregated.zone']) {
      try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (r.ok) out.push(...(await r.text()).split('\n').map((x) => x.trim()).filter((x) => /^[0-9a-fA-F:.]+\/\d+$/.test(x))); } catch (_) {}
    }
    if (!out.length) throw bad('no IP ranges found for country ' + rule.value);
    return out;
  }
  return [];
}

// Build the nftables table from all host-scoped rules and load it atomically.
async function applyHost(opts) {
  opts = opts || {};
  const hostRules = (opts.rules || rules()).filter((r) => r.scope.includes('host'));
  const b4 = new Set(), b6 = new Set(), cache = settings.get('security.prefixCache', {}) || {};
  for (const r of hostRules) {
    let p = cache[r.id];
    if (!p || Date.now() - p.at > 7 * 86400_000) { try { p = { at: Date.now(), list: await prefixesOf(r) }; cache[r.id] = p; } catch (e) { if (!p) throw e; } }
    for (const x of p.list) (x.includes(':') ? b6 : b4).add(x);
    r.prefixes = p.list.length;
  }
  settings.set('security.prefixCache', Object.fromEntries(Object.entries(cache).filter(([k]) => hostRules.some((r) => r.id === k))));
  const allow4 = ['127.0.0.0/8'], allow6 = ['::1/128'];
  for (const e of require('./whitelist').get().ips) (e.ip.includes(':') ? allow6 : allow4).push(e.ip.includes('/') ? e.ip : e.ip + (e.ip.includes(':') ? '/128' : '/32'));
  const cf4 = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'];
  const cf6 = ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32'];
  allow4.push(...cf4); allow6.push(...cf6);
  const set = (name, type, items) => '  set ' + name + ' { type ' + type + '; flags interval; auto-merge;' + (items.length ? ' elements = { ' + items.join(', ') + ' }' : '') + ' }\n';
  const txt = '#!/usr/sbin/nft -f\n# Managed by sb-srv-mon (Security → Block rules). Regenerated on every change.\n'
    + 'table inet sbsrvman\ndelete table inet sbsrvman\ntable inet sbsrvman {\n'
    + set('allow4', 'ipv4_addr', allow4) + set('allow6', 'ipv6_addr', allow6) + set('block4', 'ipv4_addr', [...b4]) + set('block6', 'ipv6_addr', [...b6])
    + '  chain input {\n    type filter hook input priority -10; policy accept;\n    iif "lo" accept\n    ip saddr @allow4 accept\n    ip6 saddr @allow6 accept\n'
    + '    ip saddr @block4 counter drop\n    ip6 saddr @block6 counter drop\n  }\n}\n';
  if (opts.checkOnly) {                       // validate only (tests): nothing written to /etc, nothing loaded
    const t = require('path').join(require('os').tmpdir(), 'sb-blocklist-check-' + process.pid + '.nft');
    fs.writeFileSync(t, txt, { mode: 0o600 });
    const c = await execP(NFT, ['-c', '-f', t], { timeout: 120_000 });
    try { fs.unlinkSync(t); } catch (_) {}
    return { ok: !c.err, error: c.err ? (c.stderr || '').slice(0, 800) : null, block4: b4.size, block6: b6.size, bytes: txt.length };
  }
  fs.mkdirSync('/etc/sb-srv-mon', { recursive: true });
  const tmp = NFT_FILE + '.new';
  fs.writeFileSync(tmp, txt, { mode: 0o600 });
  const chk = await execP(NFT, ['-c', '-f', tmp], { timeout: 60_000 });
  if (chk.err) throw bad('nftables rejected the block list — nothing changed', 500, (chk.stderr || '').slice(0, 1500));
  fs.renameSync(tmp, NFT_FILE);
  const ld = await execP(NFT, ['-f', NFT_FILE], { timeout: 60_000 });
  if (ld.err) throw bad('loading the block list failed', 500, ld.stderr);
  if (!fs.existsSync(UNIT)) {
    fs.writeFileSync(UNIT, '[Unit]\nDescription=sb-srv-mon block list (nftables table inet sbsrvman)\nAfter=network-pre.target\nBefore=network.target\n\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=' + NFT + ' -f ' + NFT_FILE + '\n\n[Install]\nWantedBy=multi-user.target\n');
    await execP('systemctl', ['daemon-reload'], { timeout: 30_000 }); await execP('systemctl', ['enable', 'sb-blocklist.service'], { timeout: 30_000 });
  }
  return { block4: b4.size, block6: b6.size };
}

// Cloudflare account-level IP Access Rules (one per rule; country/ASN natively).
async function cfAccount() { const cf = require('./cloudflare'); const z = await cf.zones(); if (!z.length || !z[0].account) throw bad('no Cloudflare account'); return { cf, acct: z[0].account.id }; }
async function applyCloudflare(rule) {
  const { cf, acct } = await cfAccount();
  const target = { ip: rule.value.includes(':') ? 'ip6' : 'ip', range: 'ip_range', asn: 'asn', country: 'country' }[rule.type];
  const r = await cf.api('/accounts/' + acct + '/firewall/access_rules/rules', { method: 'POST', body: { mode: 'block', configuration: { target, value: rule.value }, notes: 'sb-srv-mon: ' + (rule.note || rule.value) } });
  return r.result.id;
}
async function removeCloudflare(rule) { if (!rule.cfId) return; const { cf, acct } = await cfAccount(); await cf.api('/accounts/' + acct + '/firewall/access_rules/rules/' + rule.cfId, { method: 'DELETE' }); }

async function addRule(b, actor) {
  const type = String(b.type || ''); if (!TYPES.includes(type)) throw bad('type must be ' + TYPES.join(', '));
  const value = normalize(type, b.value);
  const scope = (Array.isArray(b.scope) && b.scope.length ? b.scope : ['host', 'cloudflare']).filter((s) => s === 'host' || s === 'cloudflare');
  if (!scope.length) throw bad('pick where to block: this server and/or Cloudflare');
  if ((type === 'ip' || type === 'range') && require('./whitelist').covers(require('./whitelist').get().ips, value.split('/')[0])) throw bad(value + ' is an admin (whitelisted) address — not blocking it');
  if (rules().some((r) => r.type === type && r.value === value)) throw bad('that rule exists already');
  const rule = { id: crypto.randomBytes(6).toString('hex'), type, value, note: String(b.note || '').slice(0, 120), scope, created: new Date().toISOString(), by: actor || null, status: {} };
  saveRules([...rules(), rule]);
  const status = {};
  if (scope.includes('host')) { try { const h = await applyHost(); status.host = 'enforced (' + h.block4 + ' IPv4 / ' + h.block6 + ' IPv6 ranges in total)'; } catch (e) { status.host = 'FAILED: ' + e.message; } }
  if (scope.includes('cloudflare')) { try { rule.cfId = await applyCloudflare(rule); status.cloudflare = 'block rule on the whole Cloudflare account'; } catch (e) { status.cloudflare = 'not applied: ' + e.message + (/Authentication/i.test(e.message) ? ' — the Cloudflare token needs Account → Account Firewall Access Rules → Edit' : ''); } }
  rule.status = status;
  saveRules(rules().map((r) => (r.id === rule.id ? Object.assign(r, { cfId: rule.cfId || null, status, prefixes: r.prefixes }) : r)));
  return rule;
}
async function removeRule(id) {
  const r = rules().find((x) => x.id === id); if (!r) throw bad('no such rule', 404);
  const out = {};
  if (r.cfId) { try { await removeCloudflare(r); out.cloudflare = 'removed'; } catch (e) { out.cloudflare = 'could not remove at Cloudflare: ' + e.message; } }
  saveRules(rules().filter((x) => x.id !== id));
  if (r.scope.includes('host')) { try { await applyHost(); out.host = 'removed'; } catch (e) { out.host = e.message; } }
  return out;
}
async function hostCounters() {
  const r = await execP(NFT, ['list', 'table', 'inet', 'sbsrvman'], { timeout: 20_000 });
  if (r.err) return null;
  const c = [...r.stdout.matchAll(/counter packets (\d+) bytes (\d+) drop/g)].map((m) => Number(m[1]));
  return { droppedPackets: c.reduce((a, b) => a + b, 0) };
}

module.exports = { config, configView, saveConfig, intel, reportAbuse, fail2ban, ban, unban, reportNewBans, rules, addRule, removeRule, applyHost, hostCounters, TYPES };
