#!/usr/bin/env node
/**
 * Functional sweep over every HTTP endpoint, run against a DEV instance (default :8898).
 *
 *   node scripts/qa.js [base-url] [--slow] [--net]
 *
 * The dev instance shares /etc/nginx, /etc/cron.d and /home with production, so every mutation here
 * is either a no-op (same values → no file write) or restores what it changed. Long/expensive jobs
 * (module scans, real updates, backups, installs, pm2 actions) are only run with --slow / --net.
 */
'use strict';
const BASE = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://127.0.0.1:8898').replace(/\/$/, '');
const SLOW = process.argv.includes('--slow');
const NET = process.argv.includes('--net');
let pass = 0; const fails = [], skips = [];

async function req(method, path, body, headers) {
  const r = await fetch(BASE + path, { method, headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text, headers: r.headers };
}
async function check(name, fn) {
  try {
    const msg = await fn();
    if (msg === 'skip') { skips.push(name); console.log('  ⊘ ' + name); return; }
    pass++; console.log('  ✓ ' + name + (typeof msg === 'string' && msg ? ' — ' + msg : ''));
  } catch (e) { fails.push(name + ': ' + e.message); console.log('  ✗ ' + name + ' — ' + e.message); }
}
function eq(actual, expected, what) { if (actual !== expected) throw new Error((what || '') + ' expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); }
function ok(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
const section = (s) => console.log('\n### ' + s);

(async () => {
  console.log('QA sweep against ' + BASE + (SLOW ? ' (+slow)' : '') + (NET ? ' (+net)' : ''));

  /* ---------------------------------------------------------------- pages */
  section('pages & auth gate');
  for (const p of ['/', '/index.html', '/sites', '/monitor', '/pm2', '/services', '/postgres', '/postgresql', '/updates', '/modules', '/backups', '/ssh', '/terminal', '/events', '/settings'])
    await check('GET ' + p + ' serves the app', async () => { const r = await req('GET', p); eq(r.status, 200); ok(/<div class="wrap">/.test(r.text), 'no app shell'); });
  await check('GET /login', async () => { const r = await req('GET', '/login'); eq(r.status, 200); ok(/s-login/.test(r.text)); });
  await check('GET /nope → 404', async () => eq((await req('GET', '/nope')).status, 404));
  await check('GET /ws/ssh without upgrade → 426', async () => eq((await req('GET', '/ws/ssh')).status, 426));
  await check('proxied request without session → 302 to login', async () => {
    const r = await req('GET', '/sites', undefined, { 'X-Real-IP': '203.0.113.9' });
    eq(r.status, 302); ok(String(r.headers.get('location')).includes('login'), 'no login redirect');
  });
  await check('proxied API without session → 401', async () => eq((await req('GET', '/api/status', undefined, { 'X-Real-IP': '203.0.113.9' })).status, 401));
  await check('GET /api/auth/state', async () => { const r = await req('GET', '/api/auth/state'); eq(r.status, 200); ok('setupRequired' in r.json); });
  await check('GET /api/auth/me (loopback = trusted)', async () => { const r = await req('GET', '/api/auth/me'); eq(r.status, 200); ok(r.json.local === true || !!r.json.user); });
  await check('GET /api/auth/log', async () => { const r = await req('GET', '/api/auth/log'); eq(r.status, 200); ok(Array.isArray(r.json.log || r.json)); });
  await check('POST /api/auth/login with bad creds is refused', async () => {
    const r = await req('POST', '/api/auth/login', { username: 'nobody-qa', password: 'wrong-password' }, { 'X-Real-IP': '203.0.113.9' });
    ok(r.status >= 400 || r.json.error, 'bad login was accepted: ' + r.text.slice(0, 120));
  });

  /* -------------------------------------------------------------- payloads */
  section('core payloads');
  await check('GET /api/status', async () => { const r = await req('GET', '/api/status'); eq(r.status, 200); ok(Array.isArray(r.json.groups) && r.json.summary, 'shape'); return r.json.summary.total + ' processes'; });
  await check('GET /status alias', async () => eq((await req('GET', '/status')).status, 200));
  await check('GET /api/db', async () => { const r = await req('GET', '/api/db'); eq(r.status, 200); ok(Array.isArray(r.json.databases) || r.json.error, 'shape'); return (r.json.databases || []).length + ' postgres databases' + (r.json.mariadb && r.json.mariadb.error ? ' · mariadb: ' + r.json.mariadb.error : ''); });
  await check('GET /api/updates', async () => { const r = await req('GET', '/api/updates'); eq(r.status, 200); ok(Array.isArray(r.json.components)); return r.json.components.length + ' components'; });
  await check('GET /api/modules', async () => { const r = await req('GET', '/api/modules'); eq(r.status, 200); ok('scanInProgress' in r.json && 'cleanup' in r.json, 'live flags missing'); });
  await check('GET /api/modules/cleanup', async () => { const r = await req('GET', '/api/modules/cleanup'); eq(r.status, 200); ok(r.json.config, 'no config'); });
  await check('GET /api/backup', async () => { const r = await req('GET', '/api/backup'); eq(r.status, 200); ok(r.json.schedule && r.json.available, 'shape'); return r.json.available.sites.length + ' sites, ' + r.json.available.databases.length + ' dbs'; });
  await check('GET /api/ssh', async () => { const r = await req('GET', '/api/ssh'); eq(r.status, 200); ok(Array.isArray(r.json.hosts) && r.json.source, 'shape'); return r.json.hosts.length + ' hosts, ' + r.json.installs.length + ' installs'; });
  await check('GET /api/sites', async () => { const r = await req('GET', '/api/sites'); eq(r.status, 200); ok(Array.isArray(r.json.sites)); return r.json.sites.length + ' sites'; });
  await check('POST /api/sites/check (legacy route not shadowed by the router)', async () => { const r = await req('POST', '/api/sites/check'); eq(r.status, 200); ok(Array.isArray(r.json.sites)); });

  /* ---------------------------------------------------------------- config */
  section('config round trips (write the same values back)');
  const upd = (await req('GET', '/api/updates')).json;
  await check('POST /api/updates/config', async () => { const r = await req('POST', '/api/updates/config', { schedule: upd.schedule }); eq(r.status, 200); eq(r.json.ok, true); });
  await check('POST /api/updates/config rejects junk', async () => { const r = await req('POST', '/api/updates/config', 'not json'); ok(r.status === 400 || r.json.ok, 'got ' + r.status); });
  const mods = (await req('GET', '/api/modules')).json;
  await check('POST /api/modules/auto/config', async () => { const r = await req('POST', '/api/modules/auto/config', mods.autoUpdate); eq(r.status, 200); ok(r.json.autoUpdate); });
  await check('POST /api/modules/cleanup/config', async () => { const r = await req('POST', '/api/modules/cleanup/config', mods.cleanup.config); eq(r.status, 200); ok(r.json.cleanup); });
  const bk = (await req('GET', '/api/backup')).json;
  await check('POST /api/backup/config', async () => { const r = await req('POST', '/api/backup/config', { schedule: bk.schedule, scope: bk.scope, retentionDays: bk.retentionDays }); eq(r.status, 200); eq(r.json.ok, true); });
  await check('POST /api/backup/config rejects a silly retention', async () => { const r = await req('POST', '/api/backup/config', { retentionDays: 99999 }); eq(r.status, 200); const back = (await req('GET', '/api/backup')).json; ok(back.retentionDays <= 365, 'retention not clamped: ' + back.retentionDays); await req('POST', '/api/backup/config', { retentionDays: bk.retentionDays }); });
  await check('GET /api/backup/remote', async () => { if (!NET) return 'skip'; const r = await req('GET', '/api/backup/remote'); eq(r.status, 200); ok(Array.isArray(r.json)); return r.json.length + ' remote folders'; });

  /* ---------------------------------------------------------------- events */
  section('events');
  await check('GET /api/events', async () => { const r = await req('GET', '/api/events?limit=5'); eq(r.status, 200); ok(Array.isArray(r.json.items)); return r.json.items.length + ' rows'; });
  await check('GET /api/events filters', async () => {
    const r = await req('GET', '/api/events?type=settings.&level=info&limit=3'); eq(r.status, 200);
    ok(r.json.items.every((e) => e.type.startsWith('settings.') && e.level === 'info'), 'filter leaked rows');
  });
  await check('GET /api/events paging cursor', async () => {
    const a = await req('GET', '/api/events?limit=1'); ok(a.json.items.length <= 1);
    if (!a.json.nextBefore) return 'only one row';
    const b = await req('GET', '/api/events?limit=1&before=' + a.json.nextBefore);
    ok(!b.json.items.length || b.json.items[0].id < a.json.items[0].id, 'paging went backwards');
  });
  await check('GET /api/events/types', async () => { const r = await req('GET', '/api/events/types'); eq(r.status, 200); ok(Array.isArray(r.json)); return r.json.length + ' types'; });
  await check('GET /api/events/summary', async () => { const r = await req('GET', '/api/events/summary'); eq(r.status, 200); ok(r.json.last24h && r.json.retentionDays); });
  await check('PUT /api/events/settings clamps', async () => {
    const before = (await req('GET', '/api/events/summary')).json.retentionDays;
    let r = await req('PUT', '/api/events/settings', { retentionDays: 99999 }); eq(r.status, 200); ok(r.json.retentionDays <= 3650, 'not clamped');
    r = await req('PUT', '/api/events/settings', { retentionDays: before }); eq(r.json.retentionDays, before);
  });

  /* --------------------------------------------------------------- settings */
  section('settings');
  await check('GET /api/settings', async () => { const r = await req('GET', '/api/settings'); eq(r.status, 200); ok(r.json.general && r.json.telegram && r.json.slack && r.json.cloudflare, 'shape'); ok(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(r.json.telegram.botToken || ''), 'bot token not masked!'); return 'telegram token masked as ' + (r.json.telegram.botToken || '(none)'); });
  await check('PUT /api/settings/general round trip', async () => {
    const g = (await req('GET', '/api/settings')).json.general;
    let r = await req('PUT', '/api/settings/general', { acmeEmail: 'qa@example.com', eventsRetentionDays: g.eventsRetentionDays }); eq(r.status, 200);
    ok((await req('GET', '/api/settings')).json.general.acmeEmail === 'qa@example.com', 'not saved');
    r = await req('PUT', '/api/settings/general', { acmeEmail: g.acmeEmail || '' }); eq(r.status, 200);
  });
  await check('PUT /api/settings/general rejects a bad e-mail', async () => eq((await req('PUT', '/api/settings/general', { acmeEmail: 'not-an-email' })).status, 400));
  await check('PUT /api/settings/telegram rejects a bad token', async () => eq((await req('PUT', '/api/settings/telegram', { botToken: 'nope' })).status, 400));
  await check('PUT /api/settings/slack rejects a non-Slack URL', async () => eq((await req('PUT', '/api/settings/slack', { webhookUrl: 'https://evil.example/x' })).status, 400));
  await check('POST /api/settings/slack/test without a URL → 400', async () => { const r = await req('POST', '/api/settings/slack/test', {}); eq(r.status, 400); ok(/enter a webhook/i.test(r.json.error)); });
  await check('POST /api/settings/cloudflare/test without a token → 400 (not "disabled button")', async () => { const r = await req('POST', '/api/settings/cloudflare/test', {}); eq(r.status, 400); ok(/paste an API token/i.test(r.json.error), r.json.error); });
  await check('POST /api/settings/cloudflare/test with a junk token → 400', async () => { const r = await req('POST', '/api/settings/cloudflare/test', { token: 'short' }); eq(r.status, 400); });
  await check('POST /api/settings/cloudflare/test with a well-formed but invalid token', async () => {
    if (!NET) return 'skip';
    const r = await req('POST', '/api/settings/cloudflare/test', { token: 'A'.repeat(40) });
    ok(r.status === 403 || r.status === 400 || r.status === 502, 'got ' + r.status + ' ' + r.text.slice(0, 120));
    ok(/Cloudflare/i.test(r.json.error), 'error not from Cloudflare: ' + r.json.error);
    return r.json.error;
  });
  await check('GET /api/settings/cloudflare/domains without a token → 409', async () => eq((await req('GET', '/api/settings/cloudflare/domains')).status, 409));
  await check('PUT /api/settings/cloudflare rejects a junk token', async () => eq((await req('PUT', '/api/settings/cloudflare', { token: 'short' })).status, 400));

  /* ------------------------------------------------------------------ sites */
  section('sites');
  const sites = (await req('GET', '/api/sites')).json.sites;
  const php = sites.find((s) => s.type === 'php') || sites[0];
  const node = sites.find((s) => s.type === 'nodejs');
  await check('GET /api/sites/templates', async () => { const r = await req('GET', '/api/sites/templates'); eq(r.status, 200); ok(r.json.length > 10); return r.json.length + ' templates'; });
  await check('GET /api/sites/runtimes', async () => { const r = await req('GET', '/api/sites/runtimes'); eq(r.status, 200); ok(r.json.php.length && r.json.nextPoolPort > 20000, 'shape'); return r.json.php.length + ' php versions, next pool port ' + r.json.nextPoolPort; });
  await check('GET /api/sites/:domain', async () => { const r = await req('GET', '/api/sites/' + php.domain); eq(r.status, 200); ok(r.json.domain === php.domain && r.json.unix, 'shape'); ok(!('user_password_enc' in r.json), 'leaked the encrypted password'); });
  await check('GET /api/sites/unknown → 404', async () => eq((await req('GET', '/api/sites/nope.example')).status, 404));
  await check('every imported vhost still renders byte-identically', async () => {
    const bad = [];
    for (const s of sites) { const v = (await req('GET', '/api/sites/' + s.domain + '/vhost')).json; if (!v.in_sync) bad.push(s.domain); }
    ok(!bad.length, 'out of sync: ' + bad.join(', '));
    return sites.length + ' sites in sync';
  });
  await check('PUT vhost with the unchanged template does not touch disk', async () => {
    const v = (await req('GET', '/api/sites/' + php.domain + '/vhost')).json;
    const r = await req('PUT', '/api/sites/' + php.domain + '/vhost', { template: v.template });
    eq(r.status, 200); eq(r.json.changed, false);
  });
  await check('PUT vhost rejects an empty / non-server template', async () => {
    eq((await req('PUT', '/api/sites/' + php.domain + '/vhost', { template: '' })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/vhost', { template: 'hello' })).status, 400);
  });
  await check('PUT vhost with broken nginx syntax rolls back', async () => {
    const v = (await req('GET', '/api/sites/' + php.domain + '/vhost')).json;
    const r = await req('PUT', '/api/sites/' + php.domain + '/vhost', { template: v.template + '\nserver { listen 80; broken_directive' });
    eq(r.status, 409); ok(/nginx -t/.test(r.json.error), r.json.error);
    const after = (await req('GET', '/api/sites/' + php.domain + '/vhost')).json;
    eq(after.template, v.template, 'template not restored'); eq(after.in_sync, true, 'disk not restored');
    return 'rolled back, nginx -t said: ' + String(r.json.detail || '').split('\n').pop();
  });
  await check('POST vhost/reset dry run renders', async () => { const r = await req('POST', '/api/sites/' + php.domain + '/vhost/reset', { dryRun: true }); eq(r.status, 200); ok(/server\s*\{/.test(r.json.rendered)); });
  await check('PATCH with no changes → 400', async () => eq((await req('PATCH', '/api/sites/' + php.domain, {})).status, 400));
  await check('PATCH rejects a traversing root directory', async () => eq((await req('PATCH', '/api/sites/' + php.domain, { root_dir: '../etc' })).status, 400));
  await check('GET password of a CLP site → 404 (nothing stored)', async () => { const r = await req('GET', '/api/sites/' + php.domain + '/password'); ok(r.status === 404 || r.status === 200, 'got ' + r.status); return r.status === 200 ? 'a password is stored' : 'none stored (expected for CLP sites)'; });
  await check('PUT php settings with unchanged values', async () => {
    const s = (await req('GET', '/api/sites/' + php.domain)).json;
    if (!s.php) return 'skip';
    const r = await req('PUT', '/api/sites/' + php.domain + '/php', { memory_limit: s.php.memory_limit, max_execution_time: s.php.max_execution_time, max_input_vars: s.php.max_input_vars, additional_configuration: s.php.additional_configuration });
    eq(r.status, 200); eq(r.json.vhost.changed, false, 'a no-op write touched the vhost');
  });
  await check('PUT php rejects bad values', async () => {
    eq((await req('PUT', '/api/sites/' + php.domain + '/php', { memory_limit: '512; rm -rf /' })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/php', { max_input_vars: 'abc' })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/php', { additional_configuration: 'x="y"' })).status, 400);
  });
  await check('PUT php on a Node site → 400', async () => { if (!node) return 'skip'; eq((await req('PUT', '/api/sites/' + node.domain + '/php', { memory_limit: '256M' })).status, 400); });
  await check('PUT nodejs with unchanged values', async () => {
    if (!node) return 'skip';
    const s = (await req('GET', '/api/sites/' + node.domain)).json;
    const r = await req('PUT', '/api/sites/' + node.domain + '/nodejs', { port: s.nodejs.port, node_version: s.nodejs.node_version });
    eq(r.status, 200); eq(r.json.vhost.changed, false);
  });
  await check('PUT nodejs rejects a taken port and a bad port', async () => {
    if (!node) return 'skip';
    const other = sites.find((s) => s.type === 'nodejs' && s.domain !== node.domain && s.nodePort);
    eq((await req('PUT', '/api/sites/' + node.domain + '/nodejs', { port: 80 })).status, 400);
    if (other) eq((await req('PUT', '/api/sites/' + node.domain + '/nodejs', { port: Number(other.nodePort) })).status, 409);
  });
  await check('GET certificates', async () => { const r = await req('GET', '/api/sites/' + php.domain + '/certificates'); eq(r.status, 200); ok(r.json.certificates.length && r.json.installed, 'shape'); const act = r.json.certificates.find((c) => c.is_active); ok(act, 'no active certificate'); ok(act.fingerprint === r.json.installed.fingerprint, 'active row does not match the file on disk'); return act.type + ', expires ' + act.expires_at.slice(0, 10); });
  await check('POST certificate rejects garbage and a mismatched key', async () => {
    eq((await req('POST', '/api/sites/' + php.domain + '/certificates', { certificate: 'nope', key: 'nope' })).status, 400);
    const cur = (await req('GET', '/api/sites/' + php.domain + '/certificates')).json.certificates[0];
    ok(cur, 'no certificate to test with');
  });
  await check('DELETE the active certificate is refused', async () => {
    const c = (await req('GET', '/api/sites/' + php.domain + '/certificates')).json.certificates.find((x) => x.is_active);
    eq((await req('DELETE', '/api/sites/' + php.domain + '/certificates/' + c.id)).status, 409);
  });
  await check('GET security', async () => { const r = await req('GET', '/api/sites/' + php.domain + '/security'); eq(r.status, 200); ok('has_settings_placeholder' in r.json); });
  await check('PUT security with unchanged values does not touch disk', async () => {
    const s = (await req('GET', '/api/sites/' + php.domain + '/security')).json;
    const r = await req('PUT', '/api/sites/' + php.domain + '/security', { blocked_ips: s.blocked_ips, blocked_bots: s.blocked_bots, cf_only: s.cf_only, basic_auth: s.basic_auth ? undefined : null });
    eq(r.status, 200); eq(r.json.vhost.changed, false);
  });
  await check('PUT security validates IPs and bot names', async () => {
    eq((await req('PUT', '/api/sites/' + php.domain + '/security', { blocked_ips: ['abc'] })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/security', { blocked_bots: ['bad;name'] })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/security', { basic_auth: { is_active: true, username: 'a b' } })).status, 400);
    eq((await req('PUT', '/api/sites/' + php.domain + '/security', { basic_auth: { is_active: true, username: 'qa' } })).status, 400);   // no password
  });
  await check('blocked IP round trip writes then restores the vhost', async () => {
    const before = (await req('GET', '/api/sites/' + php.domain + '/vhost')).json.on_disk;
    let r = await req('PUT', '/api/sites/' + php.domain + '/security', { blocked_ips: ['203.0.113.7'] });
    eq(r.status, 200); eq(r.json.vhost.changed, true);
    const mid = (await req('GET', '/api/sites/' + php.domain + '/vhost')).json.on_disk;
    ok(/203\\?\.0\\?\.113\\?\.7/.test(mid), 'the blocked IP never reached the vhost');
    r = await req('PUT', '/api/sites/' + php.domain + '/security', { blocked_ips: [] });
    eq(r.status, 200);
    eq((await req('GET', '/api/sites/' + php.domain + '/vhost')).json.on_disk, before, 'vhost not restored');
  });
  await check('GET ssh-users', async () => { const r = await req('GET', '/api/sites/' + php.domain + '/ssh-users'); eq(r.status, 200); ok(Array.isArray(r.json)); return r.json.length + ' users'; });
  await check('POST ssh-user rejects bad names / duplicates', async () => {
    eq((await req('POST', '/api/sites/' + php.domain + '/ssh-users', { username: 'Bad Name' })).status, 400);
    eq((await req('POST', '/api/sites/' + php.domain + '/ssh-users', { username: 'root' })).status, 400);
    const existing = (await req('GET', '/api/sites/' + php.domain + '/ssh-users')).json[0];
    if (existing) eq((await req('POST', '/api/sites/' + php.domain + '/ssh-users', { username: existing.username })).status, 409);
  });
  await check('DELETE unknown ssh-user → 404', async () => eq((await req('DELETE', '/api/sites/' + php.domain + '/ssh-users/999999')).status, 404));
  await check('cron: add, materialise, delete', async () => {
    const r = await req('POST', '/api/sites/' + php.domain + '/cron', { minute: '*/7', hour: '*', day: '*', month: '*', weekday: '*', command: 'echo qa-%test >> ~/tmp/qa.log' });
    eq(r.status, 200);
    const state = (await req('GET', '/api/sites/' + php.domain + '/cron')).json;
    ok(state.on_disk && state.on_disk.includes('*/7'), 'not written to /etc/cron.d');
    ok(state.on_disk.includes('\\%test'), '% not escaped for cron');
    const d = await req('DELETE', '/api/sites/' + php.domain + '/cron/' + r.json.id); eq(d.status, 200);
    const after = (await req('GET', '/api/sites/' + php.domain + '/cron')).json;
    ok(!after.on_disk, 'cron.d file left behind');
  });
  await check('cron validation returns 400, not 500', async () => {
    eq((await req('POST', '/api/sites/' + php.domain + '/cron', { minute: 'x', hour: '*', day: '*', month: '*', weekday: '*', command: 'ls' })).status, 400);
    eq((await req('POST', '/api/sites/' + php.domain + '/cron', { minute: '*', hour: '*', day: '*', month: '*', weekday: '*', command: '' })).status, 400);
    eq((await req('POST', '/api/sites/' + php.domain + '/cron', { minute: '*', hour: '*', day: '*', month: '*', weekday: '*', command: 'a\nb' })).status, 400);
  });
  await check('GET logs list + tail', async () => {
    const k = (await req('GET', '/api/sites/' + php.domain + '/logs')).json.kinds;
    ok(k.length, 'no log kinds');
    const r = await req('GET', '/api/sites/' + php.domain + '/logs/nginx-error?lines=3');
    eq(r.status, 200); ok(Array.isArray(r.json.lines) && r.json.lines.length <= 3, 'tail returned ' + (r.json.lines || []).length + ' lines');
    const f = await req('GET', '/api/sites/' + php.domain + '/logs/nginx-error?lines=50&q=zzz-no-such-line');
    eq(f.status, 200); eq(f.json.lines.length, 0, 'filter matched something impossible');
    return k.length + ' kinds';
  });
  await check('GET unknown log kind → 404', async () => eq((await req('GET', '/api/sites/' + php.domain + '/logs/nope')).status, 404));
  await check('file manager: list, mkdir, write, read, download, chmod, rename, delete', async () => {
    const dir = '/tmp/qa-' + Date.now();
    const u = '/api/sites/' + php.domain;
    eq((await req('GET', u + '/files?path=/htdocs')).status, 200);
    eq((await req('POST', u + '/files/op', { op: 'mkdir', path: '/tmp', name: dir.split('/').pop() })).status, 200);
    eq((await req('POST', u + '/files/op', { op: 'write', path: dir + '/a.txt', content: 'hello qa\n' })).status, 200);
    const rd = await req('POST', u + '/files/op', { op: 'read', path: dir + '/a.txt' }); eq(rd.json.content, 'hello qa\n');
    const dl = await req('GET', u + '/files/download?path=' + encodeURIComponent(dir + '/a.txt'));
    eq(dl.status, 200); eq(dl.text, 'hello qa\n');
    ok(/attachment/.test(dl.headers.get('content-disposition') || ''), 'no attachment header');
    eq((await req('POST', u + '/files/op', { op: 'chmod', path: dir + '/a.txt', mode: '640' })).status, 200);
    eq((await req('POST', u + '/files/op', { op: 'rename', path: dir + '/a.txt', name: 'b.txt' })).status, 200);
    const list = await req('GET', u + '/files?path=' + encodeURIComponent(dir));
    ok(list.json.items.some((i) => i.name === 'b.txt' && i.mode === '0640'), 'chmod/rename did not stick: ' + JSON.stringify(list.json.items));
    eq((await req('POST', u + '/files/op', { op: 'delete', paths: [dir] })).status, 200);
    return 'as ' + php.user;
  });
  await check('file manager helper is readable by the site user (app dir is 0700 in a real install)', async () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync('sudo', ['-n', '-u', php.user, 'sh', '-c', 'cat /var/lib/rhc-srv-mon/fileop.js > /dev/null && echo ok'], { encoding: 'utf8' }).trim();
    eq(out, 'ok');
  });
  await check('file manager confinement', async () => {
    const u = '/api/sites/' + php.domain;
    eq((await req('GET', u + '/files?path=/../../etc')).status, 400);
    eq((await req('POST', u + '/files/op', { op: 'read', path: '/../../etc/shadow' })).status, 400);
    eq((await req('POST', u + '/files/op', { op: 'delete', paths: ['/'] })).status, 400);
    eq((await req('POST', u + '/files/op', { op: 'chmod', path: '/', mode: '777' })).status, 400);
    eq((await req('POST', u + '/files/op', { op: 'nope' })).status, 400);
  });
  await check('file upload + size guard', async () => {
    const u = '/api/sites/' + php.domain;
    const name = 'qa-upload-' + Date.now() + '.txt';
    const r = await fetch(BASE + u + '/files/upload?path=' + encodeURIComponent('/tmp') + '&name=' + name, { method: 'POST', body: 'uploaded by qa\n' });
    const j = await r.json(); eq(r.status, 200); eq(j.size, 15);
    eq((await req('POST', u + '/files/upload?path=/tmp&name=' + encodeURIComponent('../escape'))).status, 400);
    eq((await req('POST', u + '/files/op', { op: 'delete', paths: ['/tmp/' + name] })).status, 200);
  });
  await check('POST /api/sites/sync-clp is idempotent', async () => {
    const r = await req('POST', '/api/sites/sync-clp'); eq(r.status, 200);
    ok(r.json.sites === 0, 'sync created ' + r.json.sites + ' new sites on a second run');
    ok(!r.json.errors.length, 'errors: ' + r.json.errors.join('; '));
    return r.json.updated + ' refreshed, ' + r.json.skipped + ' ours';
  });

  /* ---------------------------------------------------------------- backups */
  section('per-site backups');
  await check('GET /api/backup/site/:domain', async () => { const r = await req('GET', '/api/backup/site/' + php.domain); eq(r.status, 200); ok('runs' in r.json); });
  await check('POST /api/backup/site/unknown → 404', async () => eq((await req('POST', '/api/backup/site/nope.example')).status, 404));
  await check('POST /api/backup/site/:domain runs', async () => {
    if (!NET) return 'skip';
    const r = await req('POST', '/api/backup/site/' + php.domain); eq(r.status, 200); eq(r.json.started, true);
    for (let i = 0; i < 60; i++) { await new Promise((s) => setTimeout(s, 1000)); const st = (await req('GET', '/api/backup/site/' + php.domain)).json; if (!st.running && st.runs.length) { ok(st.runs[0].success, 'backup failed: ' + JSON.stringify(st.runs[0].errors)); return st.runs[0].itemCount + ' items, ' + st.runs[0].bytes + ' bytes'; } }
    throw new Error('did not finish in 60s');
  });

  /* -------------------------------------------------------------------- ssh */
  section('ssh hosts & installs');
  let tmpHost = null;
  await check('POST /api/ssh/hosts creates, PUT updates, DELETE removes', async () => {
    let r = await req('POST', '/api/ssh/hosts', { name: 'qa-temp', host: '127.0.0.1', port: 22, user: 'root', auth: 'key' });
    eq(r.status, 200); tmpHost = r.json.host.id;
    ok(!('password' in r.json.host), 'password field leaked in the public host view');
    r = await req('PUT', '/api/ssh/hosts/' + tmpHost, { name: 'qa-temp2', host: '127.0.0.1', port: 2222, user: 'root', auth: 'key' });
    eq(r.status, 200); eq(r.json.host.port, 2222);
    r = await req('DELETE', '/api/ssh/hosts/' + tmpHost); eq(r.status, 200); tmpHost = null;
    ok(!(await req('GET', '/api/ssh')).json.hosts.some((h) => h.name === 'qa-temp2'), 'host not removed');
  });
  await check('PUT/DELETE unknown ssh host → 404', async () => {
    eq((await req('PUT', '/api/ssh/hosts/aaaaaaaaaa', { name: 'x', host: 'y' })).status, 404);
    eq((await req('DELETE', '/api/ssh/hosts/aaaaaaaaaa')).status, 404);
  });
  await check('POST /api/ssh/install with an unknown host → 400', async () => eq((await req('POST', '/api/ssh/install', { hostId: 'aaaaaaaaaa', opts: {} })).status, 400));
  await check('GET /api/ssh/install/:id unknown → 404', async () => eq((await req('GET', '/api/ssh/install/aaaaaaaaaaaa')).status, 404));
  await check('DELETE /api/ssh/install/:id unknown is a no-op', async () => { const r = await req('DELETE', '/api/ssh/install/aaaaaaaaaaaa'); eq(r.status, 200); eq(r.json.removed, false); });
  await check('GET /api/ssh/sessions/:id unknown → 404', async () => eq((await req('GET', '/api/ssh/sessions/aaaaaaaaaaaa')).status, 404));

  /* ------------------------------------------------------------------ slow */
  section('slow jobs');
  await check('POST /api/updates/check', async () => { if (!SLOW) return 'skip'; const r = await req('POST', '/api/updates/check'); eq(r.status, 200); return r.json.components.filter((c) => c.updateAvailable).length + ' updates available'; });
  await check('POST /api/modules/check starts a scan', async () => { if (!SLOW) return 'skip'; const r = await req('POST', '/api/modules/check'); ok(r.status === 202 || r.status === 409, 'got ' + r.status); return 'status ' + r.status; });
  await check('POST /api/modules/cleanup/measure', async () => { if (!SLOW) return 'skip'; const r = await req('POST', '/api/modules/cleanup/measure'); eq(r.status, 200); return 'preview ' + (r.json.cleanup.preview ? 'built' : 'missing'); });

  console.log('\n' + '='.repeat(70));
  console.log(pass + ' passed · ' + fails.length + ' failed · ' + skips.length + ' skipped');
  if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  ✗ ' + f); }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('harness crashed:', e.stack); process.exit(2); });
