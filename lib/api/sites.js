'use strict';
// Sites API (router-based). Every mutation claims the site for this panel (managed_by='rhc'),
// re-renders/writes the vhost where the change affects it, and emits an event.
const os = require('os');
const router = require('../http');
const { httpError, readJson, actorOf } = router;
const events = require('../events');
const store = require('../sites/store');
const vhost = require('../sites/vhost');
const users = require('../sites/users');
const php = require('../sites/php');
const ssl = require('../sites/ssl');
const cron = require('../sites/cron');
const logs = require('../sites/logs');
const files = require('../sites/files');
const procs = require('../sites/procs');
const nodever = require('../sites/nodever');
const siteCf = require('../sites/cloudflare');
const secrets = require('../secrets');
const health = require('../sites');
const clpImport = require('../clp-import');

const perm = (p) => ({ perm: 'sites.' + p });

function siteOf(ctx) {
  const s = store.get(ctx.params.domain);
  if (!s) throw httpError(404, 'unknown site ' + ctx.params.domain);
  return s;
}
function publicIp() {
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal && !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(i.address)) return i.address;
  for (const list of Object.values(os.networkInterfaces())) for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return null;
}
function emit(type, ctx, site, message, extra) {
  events.emit(type, Object.assign({ req: ctx.req, site: site ? site.domain : undefined, message }, extra || {}));
}
// Render + write the vhost; on nginx -t failure the previous file is restored and a 409 carries the output.
async function applyVhost(site, ctx, what) {
  const content = vhost.render(site);
  const r = await vhost.writeWithRollback(site, content);
  if (!r.ok) {
    if (r.test && r.test.ok) {   // config is valid but systemctl reload failed: the new file stays, tell the truth
      emit('sites.vhost.write', ctx, site, 'vhost written (' + what + ') but nginx reload failed', { level: 'error', data: { reload: r.reload && r.reload.output } });
      throw httpError(502, 'vhost written, but "systemctl reload nginx" failed — check the nginx service', { detail: r.reload && r.reload.output });
    }
    emit('sites.vhost.write', ctx, site, 'nginx rejected the vhost (' + what + ') — rolled back', { level: 'error', data: { test: r.test && r.test.output } });
    throw httpError(409, 'nginx -t failed — previous vhost restored', { detail: r.test && r.test.output });
  }
  return r;
}
function claimAnd(site, ctx, type, message, extra) { store.claim(site.id); emit(type, ctx, site, message, extra); }
function fullView(site) {
  const v = store.publicView(site);
  const active = store.certs.active(site.id);
  v.certificate = active ? { id: active.id, type: active.type, subject: active.subject, sans: JSON.parse(active.sans || '[]'), issuer: active.issuer, expires_at: active.expires_at } : null;
  v.counts = { ssh_users: store.sshUsers.list(site.id).length, cron_jobs: store.cronJobs.list(site.id).length, databases: store.databases.list(site.id).length, blocked_ips: store.blockedIps.list(site.id).length, blocked_bots: store.blockedBots.list(site.id).length };
  v.basic_auth = (() => { const b = store.basicAuth.get(site.id); return b ? { is_active: b.is_active, username: b.username } : null; })();
  v.unix = users.getent(site.user);
  v.ip = publicIp();
  v.docroot = '/home/' + site.user + '/htdocs/' + site.root_dir;
  v.vhost_placeholders = (site.vhost_template.match(/\{\{\s*\w+\s*\}\}/g) || []).map((p) => p.replace(/[{}\s]/g, ''));
  const h = (health.getCache() || { sites: [] }).sites.find((x) => x.domain === site.domain);
  if (v.nodejs) v.nodejs.actual = nodever.actual(site);
  v.health = h ? { status: h.status, statusLabel: h.statusLabel, httpUp: h.httpUp, portUp: h.portUp, disk: h.disk, pm2: h.pm2,
    originStatus: h.originStatus, originError: h.originError, appStatus: h.appStatus, appError: h.appError, cfOnly: h.cfOnly, statusReason: h.statusReason } : null;
  return v;
}

/* ---- collection ---- */
router.add('POST', '/api/sites/sync-clp', perm('write'), (ctx) => clpImport.run({ actor: actorOf(ctx.req) }));
router.add('GET', '/api/sites/templates', perm('read'), () => store.templates.list());
// ?user= adds that site user's nvm builds to the node list (nvm is per-home, so it has to be asked for).
router.add('GET', '/api/sites/runtimes', perm('read'), (ctx) => ({
  php: php.listVersions(), nextPoolPort: php.nextPoolPort(), usedPorts: [...store.usedPorts()].sort((a, b) => a - b),
  node: { system: process.version, available: nodever.available(ctx.query.get('user') || null) }, ip: publicIp(),
}));
router.add('GET', '/api/sites/:domain', perm('read'), (ctx) => fullView(siteOf(ctx)));

/* ---- settings ---- */
router.add('PATCH', '/api/sites/:domain', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const patch = {};
  if (b.root_dir != null) {
    const rd = String(b.root_dir).trim().replace(/^\/+|\/+$/g, '');
    if (!rd || rd.split('/').some((p) => p === '..' || !p)) throw httpError(400, 'invalid root directory');
    patch.root_dir = rd;
  }
  if (b.cf_only != null) patch.cf_only = !!b.cf_only;
  if (b.reverse_proxy_url != null) { const u = String(b.reverse_proxy_url).trim(); if (u && !/^https?:\/\/[^\s"';]+$/.test(u)) throw httpError(400, 'invalid reverse proxy URL'); patch.reverse_proxy_url = u || null; }
  if (!Object.keys(patch).length) throw httpError(400, 'nothing to change');
  if (patch.root_dir && patch.root_dir !== site.root_dir) {
    const ent = users.getent(site.user);
    const dir = '/home/' + site.user + '/htdocs/' + patch.root_dir;
    if (ent && !require('fs').existsSync(dir)) { require('fs').mkdirSync(dir, { recursive: true, mode: 0o770 }); try { require('fs').chownSync(dir, ent.uid, ent.gid); } catch (_) {} }
  }
  const next = store.update(site.id, patch);
  const r = await applyVhost(next, ctx, 'settings').catch((e) => { store.update(site.id, { root_dir: site.root_dir, cf_only: site.cf_only, reverse_proxy_url: site.reverse_proxy_url }); throw e; });
  claimAnd(next, ctx, 'sites.settings', 'Site settings changed: ' + Object.keys(patch).join(', '), { data: patch });
  return { ok: true, site: fullView(store.getById(site.id)), vhost: { changed: r.changed } };
});

// site user password: generate (or set) + reveal
router.add('POST', '/api/sites/:domain/password', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const pw = b.password ? String(b.password) : secrets.generatePassword(20);
  if (pw.length < 12) throw httpError(400, 'password must be at least 12 characters');
  await users.setPassword(site.user, pw);
  store.update(site.id, { user_password_enc: secrets.encrypt(pw) });
  claimAnd(site, ctx, 'sites.password', 'Site user password ' + (b.password ? 'set' : 'regenerated') + ' for ' + site.user, { target: site.user });
  return { ok: true, password: pw };
});
router.add('GET', '/api/sites/:domain/password', perm('write'), (ctx) => {
  const site = siteOf(ctx);
  const pw = store.password(site);
  if (pw == null) throw httpError(404, 'no password stored for this site user — generate a new one');
  emit('sites.password.reveal', ctx, site, 'Site user password revealed', { target: site.user });
  return { password: pw };
});
router.add('PUT', '/api/sites/:domain/ssh-keys', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const keys = String(b.ssh_keys || '');
  users.writeAuthorizedKeys(site.user, keys);
  store.update(site.id, { ssh_keys: keys });
  claimAnd(site, ctx, 'sites.ssh-keys', 'authorized_keys updated for ' + site.user + ' (' + keys.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length + ' keys)', { target: site.user });
  return { ok: true };
});

/* ---- vhost ---- */
router.add('GET', '/api/sites/:domain/vhost', perm('read'), (ctx) => {
  const site = siteOf(ctx);
  const disk = vhost.readCurrentFile(site.domain);
  const rendered = vhost.render(site);
  return { template: site.vhost_template, rendered, on_disk: disk, in_sync: disk === rendered, source: site.vhost_source, file: vhost.confPath(site.domain),
    placeholders: (site.vhost_template.match(/\{\{\s*\w+\s*\}\}/g) || []).map((p) => p.replace(/[{}\s]/g, '')) };
});
router.add('PUT', '/api/sites/:domain/vhost', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req, 1024 * 1024);
  const tpl = String(b.template || '');
  if (!tpl.trim()) throw httpError(400, 'empty template');
  if (!/server\s*\{/.test(tpl)) throw httpError(400, 'template has no server block');
  const prevTpl = site.vhost_template;
  const next = store.update(site.id, { vhost_template: tpl });
  const r = await applyVhost(next, ctx, 'vhost editor').catch((e) => { store.update(site.id, { vhost_template: prevTpl }); throw e; });
  if (r.changed) claimAnd(next, ctx, 'sites.vhost.save', 'Vhost saved', { data: { backup: r.backup } });
  else emit('sites.vhost.save', ctx, next, 'Vhost saved (no change on disk)');
  return { ok: true, changed: r.changed, test: r.test && r.test.output, rendered: vhost.render(next) };
});
router.add('POST', '/api/sites/:domain/vhost/reset', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const name = b.template || site.application || ({ nodejs: 'Nodejs', static: 'Static', 'reverse-proxy': 'ReverseProxy', python: 'Python' }[site.type]) || 'Generic';
  const t = store.templates.get(name);
  if (!t) throw httpError(404, 'unknown template ' + name);
  const tpl = vhost.materialize(t.template, site);
  if (b.dryRun) return { template: tpl, rendered: vhost.render(site, tpl) };
  const prevTpl = site.vhost_template;
  const next = store.update(site.id, { vhost_template: tpl, vhost_source: 'template', application: name });
  const r = await applyVhost(next, ctx, 'template reset').catch((e) => { store.update(site.id, { vhost_template: prevTpl, vhost_source: site.vhost_source, application: site.application }); throw e; });
  claimAnd(next, ctx, 'sites.vhost.reset', 'Vhost reset to template ' + name, { level: 'warn', data: { changed: r.changed, backup: r.backup } });
  return { ok: true, changed: r.changed, template: tpl };
});

/* ---- runtime: php / nodejs ---- */
router.add('PUT', '/api/sites/:domain/php', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  if (site.type !== 'php' || !site.php) throw httpError(400, 'not a PHP site');
  const b = await readJson(ctx.req);
  const p = Object.assign({}, site.php);
  for (const k of ['memory_limit', 'post_max_size', 'upload_max_filesize']) if (b[k] != null) { if (!/^\d+[KMG]?$/i.test(String(b[k]).trim())) throw httpError(400, 'invalid ' + k); p[k] = String(b[k]).trim(); }
  for (const k of ['max_execution_time', 'max_input_time', 'max_input_vars']) if (b[k] != null) { if (!/^\d+$/.test(String(b[k]).trim())) throw httpError(400, 'invalid ' + k); p[k] = String(b[k]).trim(); }
  if (b.additional_configuration != null) { const a = String(b.additional_configuration).trim(); if (/["\\]/.test(a)) throw httpError(400, 'additional configuration must not contain quotes or backslashes'); p.additional_configuration = a; }
  let fpm = null;
  if (b.php_version != null && String(b.php_version) !== site.php.php_version) {
    const ver = String(b.php_version);
    if (!php.listVersions().includes(ver)) throw httpError(400, 'PHP ' + ver + ' is not installed');
    const from = php.findPoolVersion(site.domain) || site.php.php_version;
    fpm = await php.switchVersion(site.domain, site.user, site.php.pool_port, from, ver).catch((e) => { throw httpError(409, e.message); });
    p.php_version = ver;
  }
  const prevTpl = site.vhost_template;
  store.setPhp(site.id, p);
  const next = store.getById(site.id);
  if (!vhost.hasPlaceholder(next.vhost_template, 'php_settings')) {
    // literal PHP_VALUE block (imported site whose block could not be re-templated): patch it in place
    store.update(site.id, { vhost_template: vhost.patchLiteralPhpValue(next.vhost_template, next) });
  }
  const r = await applyVhost(store.getById(site.id), ctx, 'php settings').catch(async (e) => {
    store.setPhp(site.id, site.php); store.update(site.id, { vhost_template: prevTpl });
    if (fpm) { try { await php.switchVersion(site.domain, site.user, site.php.pool_port, p.php_version, site.php.php_version); } catch (_) {} }
    throw e;
  });
  claimAnd(next, ctx, 'sites.php', 'PHP settings changed' + (fpm ? ' (now PHP ' + p.php_version + ')' : ''), { data: { php: p, fpm } });
  return { ok: true, php: store.getById(site.id).php, vhost: { changed: r.changed }, fpm };
});
router.add('PUT', '/api/sites/:domain/nodejs', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  if (site.type !== 'nodejs' || !site.nodejs) throw httpError(400, 'not a Node.js site');
  const b = await readJson(ctx.req);
  const n = Object.assign({}, site.nodejs);
  if (b.port != null) {
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, 'port must be 1024–65535');
    if (port !== site.nodejs.port && store.usedPorts().has(port)) throw httpError(409, 'port ' + port + ' is used by another site');
    n.port = port;
  }
  let nvmOut = null;
  if (b.node_version != null && String(b.node_version) !== site.nodejs.node_version) {
    const ver = String(b.node_version).trim();
    if (!/^\d{1,2}(\.\d+){0,2}$/.test(ver)) throw httpError(400, 'invalid Node.js version');
    n.node_version = ver;
    if (b.install !== false && require('fs').existsSync('/home/' + site.user + '/.nvm/nvm.sh')) {
      const r = await require('../util').execP('sudo', ['-u', site.user, 'bash', '-lc', '. ~/.nvm/nvm.sh && nvm install ' + ver + ' && nvm alias default ' + ver], { timeout: 5 * 60_000 });
      nvmOut = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-5).join('\n');
      if (r.err) throw httpError(409, 'nvm install failed', { detail: nvmOut });
    }
  }
  store.setNodejs(site.id, n);
  let next = store.getById(site.id);
  if (n.port !== site.nodejs.port && !vhost.hasPlaceholder(next.vhost_template, 'app_port')) {
    next = store.update(site.id, { vhost_template: vhost.patchLiteralPort(next.vhost_template, 'node', n.port) });
  }
  const r = await applyVhost(next, ctx, 'node settings').catch((e) => { store.setNodejs(site.id, site.nodejs); store.update(site.id, { vhost_template: site.vhost_template }); throw e; });
  claimAnd(next, ctx, 'sites.nodejs', 'Node.js settings changed (v' + n.node_version + ', port ' + n.port + ')', { data: { nodejs: n, nvm: nvmOut } });
  return { ok: true, nodejs: n, vhost: { changed: r.changed }, nvm: nvmOut };
});

/* ---- certificates ---- */
router.add('GET', '/api/sites/:domain/certificates', perm('read'), (ctx) => {
  const site = siteOf(ctx);
  const disk = ssl.readInstalled(site.domain);
  return { certificates: store.certs.list(site.id), installed: disk ? { subject: disk.subject, issuer: disk.issuer, expires_at: disk.expires_at, sans: disk.sans, fingerprint: disk.fingerprint } : null };
});
router.add('POST', '/api/sites/:domain/certificates', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req, 1024 * 1024);
  let cert, key, chain = null, type;
  if (b.self_signed) {
    const g = await ssl.selfSigned(site.domain, ssl.defaultSans(site.domain));
    cert = g.certificate; key = g.key; type = 'self_signed';
  } else {
    cert = String(b.certificate || ''); key = String(b.key || ''); chain = b.chain ? String(b.chain) : null;
    // a bundle pasted into the certificate box: first block is the leaf, the rest the chain
    const parts = ssl.splitChain(cert);
    if (parts.length > 1 && !chain) { cert = parts[0]; chain = parts.slice(1).join('\n'); }
    if (!ssl.inspect(cert)) throw httpError(400, 'certificate is not a valid PEM certificate');
    if (!ssl.keyMatches(cert, key)) throw httpError(400, 'private key does not match the certificate');
    const info = ssl.inspect(cert);
    type = /CloudFlare Origin/i.test(info.issuer) ? 'cloudflare_origin' : /Let's Encrypt/i.test(info.issuer) ? 'letsencrypt' : info.self_signed ? 'self_signed' : 'custom';
  }
  const info = ssl.inspect(cert);
  let row = store.certs.byFingerprint(site.id, info.fingerprint);
  if (row && !row.private_key_enc && key) store.certs.setKey(row.id, secrets.encrypt(key));
  let id = row ? row.id : store.certs.insert({ site_id: site.id, type, subject: info.subject, sans: info.sans, issuer: info.issuer, expires_at: info.expires_at, private_key_enc: secrets.encrypt(key), certificate: cert, chain, fingerprint: info.fingerprint, is_active: 0 });
  let activated = false;
  if (b.activate !== false) { await activate(site, id, ctx); activated = true; }
  claimAnd(site, ctx, 'sites.certificate.add', 'Certificate added (' + type + ', ' + info.subject + ', expires ' + info.expires_at.slice(0, 10) + ')' + (activated ? ' and activated' : ''), { data: { id, type, sans: info.sans } });
  return { ok: true, id, activated, certificate: store.certs.list(site.id).find((c) => c.id === id) };
});
async function activate(site, id, ctx) {
  const c = store.certs.get(id);
  if (!c || c.site_id !== site.id) throw httpError(404, 'unknown certificate');
  if (!c.private_key_enc) throw httpError(409, 'no private key stored for this certificate');
  const key = secrets.decrypt(c.private_key_enc);
  const prev = ssl.readInstalled(site.domain);
  ssl.install(site.domain, c.certificate, c.chain, key);
  const t = await vhost.nginxTest();
  if (!t.ok) { if (prev && prev.key) ssl.install(site.domain, prev.certificate, prev.chain, prev.key); throw httpError(409, 'nginx rejected the certificate — previous one restored', { detail: t.output }); }
  await vhost.reloadNginx();
  store.certs.setActive(site.id, id);
}
router.add('POST', '/api/sites/:domain/certificates/:id/activate', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  await activate(site, Number(ctx.params.id), ctx);
  const c = store.certs.get(Number(ctx.params.id));
  claimAnd(site, ctx, 'sites.certificate.activate', 'Certificate activated (' + c.type + ', expires ' + String(c.expires_at).slice(0, 10) + ')', { data: { id: c.id } });
  return { ok: true };
});
router.add('DELETE', '/api/sites/:domain/certificates/:id', perm('write'), (ctx) => {
  const site = siteOf(ctx);
  const c = store.certs.get(Number(ctx.params.id));
  if (!c || c.site_id !== site.id) throw httpError(404, 'unknown certificate');
  if (c.is_active) throw httpError(409, 'cannot delete the active certificate');
  store.certs.remove(c.id);
  emit('sites.certificate.delete', ctx, site, 'Certificate removed (' + c.type + ')', { level: 'warn' });
  return { ok: true };
});

/* ---- security ---- */
router.add('GET', '/api/sites/:domain/security', perm('read'), (ctx) => {
  const site = siteOf(ctx);
  const ba = store.basicAuth.get(site.id);
  return { basic_auth: ba ? { is_active: ba.is_active, username: ba.username, allowed_ips: ba.allowed_ips, has_password: !!ba.password_enc } : null,
    blocked_ips: store.blockedIps.list(site.id), blocked_bots: store.blockedBots.list(site.id), cf_only: site.cf_only,
    has_settings_placeholder: vhost.hasPlaceholder(site.vhost_template, 'settings'), preview: vhost.settingsBlock(site) };
});
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^(?=.*:)[0-9a-f:]+(\/\d{1,3})?$/i;
router.add('PUT', '/api/sites/:domain/security', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const before = { ba: store.basicAuth.get(site.id), ips: store.blockedIps.list(site.id), bots: store.blockedBots.list(site.id), cf: site.cf_only, tpl: site.vhost_template };
  try {
    if (b.basic_auth !== undefined) {
      if (b.basic_auth === null || b.basic_auth.is_active === false && !b.basic_auth.username) store.basicAuth.remove(site.id);
      else {
        const cur = before.ba || {};
        const username = String(b.basic_auth.username || cur.username || '').trim();
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw httpError(400, 'invalid basic-auth user name');
        const password_enc = b.basic_auth.password ? secrets.encrypt(String(b.basic_auth.password)) : cur.password_enc || null;
        if (!password_enc) throw httpError(400, 'basic-auth password required');
        const allowed = (b.basic_auth.allowed_ips || cur.allowed_ips || []).map((x) => String(x).trim()).filter(Boolean);
        for (const ip of allowed) if (!IP_RE.test(ip)) throw httpError(400, 'invalid IP ' + ip);
        store.basicAuth.set(site.id, { is_active: b.basic_auth.is_active !== false, username, password_enc, allowed_ips: allowed });
      }
    }
    if (Array.isArray(b.blocked_ips)) { const ips = [...new Set(b.blocked_ips.map((x) => String(x).trim()).filter(Boolean))]; for (const ip of ips) if (!IP_RE.test(ip)) throw httpError(400, 'invalid IP ' + ip); store.blockedIps.set(site.id, ips); }
    if (Array.isArray(b.blocked_bots)) { const bots = [...new Set(b.blocked_bots.map((x) => String(x).trim()).filter(Boolean))]; for (const bot of bots) if (!/^[A-Za-z0-9 ._\-\/]{1,64}$/.test(bot)) throw httpError(400, 'invalid bot name ' + bot); store.blockedBots.set(site.id, bots); }
    let patch = {};
    if (b.cf_only != null) patch.cf_only = !!b.cf_only;
    let site2 = Object.keys(patch).length ? store.update(site.id, patch) : store.getById(site.id);
    if (b.insert_settings_placeholder && !vhost.hasPlaceholder(site2.vhost_template, 'settings')) {
      // put {{settings}} where CLP has it: right after the .well-known block, before the global include
      const tpl = site2.vhost_template.replace(/(location ~ \/\.well-known \{[\s\S]*?\n  \}\n)/, '$1\n  {{settings}}\n');
      if (!vhost.hasPlaceholder(tpl, 'settings')) throw httpError(409, 'could not find a place for {{settings}} — add it in the vhost editor');
      site2 = store.update(site.id, { vhost_template: tpl });
    }
    await vhost.writeBasicAuthFile(site2);
    const r = await applyVhost(site2, ctx, 'security');
    claimAnd(site2, ctx, 'sites.security', 'Security settings changed (' + Object.keys(b).filter((k) => k !== 'insert_settings_placeholder').join(', ') + ')', { data: { blocked_ips: store.blockedIps.list(site.id).length, blocked_bots: store.blockedBots.list(site.id).length, cf_only: site2.cf_only, basic_auth: !!(store.basicAuth.get(site.id) || {}).is_active } });
    return { ok: true, vhost: { changed: r.changed }, has_settings_placeholder: vhost.hasPlaceholder(site2.vhost_template, 'settings') };
  } catch (e) {
    // roll the DB back to what it was so UI and disk agree
    if (before.ba) store.basicAuth.set(site.id, before.ba); else store.basicAuth.remove(site.id);
    store.blockedIps.set(site.id, before.ips); store.blockedBots.set(site.id, before.bots);
    store.update(site.id, { cf_only: before.cf, vhost_template: before.tpl });
    try { await vhost.writeBasicAuthFile(store.getById(site.id)); } catch (_) {}
    throw e;
  }
});

/* ---- ssh users ---- */
router.add('GET', '/api/sites/:domain/ssh-users', perm('read'), (ctx) => { const site = siteOf(ctx); return store.sshUsers.list(site.id).map((u) => Object.assign(u, { unix: users.getent(u.username) })); });
router.add('POST', '/api/sites/:domain/ssh-users', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const username = String(b.username || '').trim();
  if (!users.validUsername(username)) throw httpError(400, 'invalid user name (lowercase letters, digits, _ -, max 32)');
  if (store.knownUnixUsers().has(username) || users.getent(username)) throw httpError(409, 'user ' + username + ' already exists');
  const pw = b.password ? String(b.password) : secrets.generatePassword(20);
  if (pw.length < 12) throw httpError(400, 'password must be at least 12 characters');
  await users.createSshUser(site, username, pw, b.ssh_keys || '');
  const id = store.sshUsers.insert({ site_id: site.id, username, ssh_keys: b.ssh_keys || null, password_enc: secrets.encrypt(pw) });
  claimAnd(site, ctx, 'sites.ssh-user.add', 'SSH user added: ' + username, { target: username });
  return { ok: true, id, username, password: pw };
});
router.add('PUT', '/api/sites/:domain/ssh-users/:id', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const u = store.sshUsers.list(site.id).find((x) => x.id === Number(ctx.params.id));
  if (!u) throw httpError(404, 'unknown ssh user');
  const b = await readJson(ctx.req);
  const out = { ok: true };
  if (b.ssh_keys != null) { users.writeAuthorizedKeys(u.username, String(b.ssh_keys)); store.sshUsers.update(u.id, { ssh_keys: String(b.ssh_keys) }); }
  if (b.password !== undefined) { const pw = b.password ? String(b.password) : secrets.generatePassword(20); if (pw.length < 12) throw httpError(400, 'password must be at least 12 characters'); await users.setPassword(u.username, pw); store.sshUsers.update(u.id, { password_enc: secrets.encrypt(pw) }); out.password = pw; }
  claimAnd(site, ctx, 'sites.ssh-user.update', 'SSH user updated: ' + u.username + (b.password !== undefined ? ' (password)' : '') + (b.ssh_keys != null ? ' (keys)' : ''), { target: u.username });
  return out;
});
router.add('GET', '/api/sites/:domain/ssh-users/:id/password', perm('write'), (ctx) => {
  const site = siteOf(ctx);
  const u = store.sshUsers.get((store.sshUsers.list(site.id).find((x) => x.id === Number(ctx.params.id)) || {}).username);
  if (!u) throw httpError(404, 'unknown ssh user');
  if (!u.password_enc) throw httpError(404, 'no password stored — set a new one');
  emit('sites.password.reveal', ctx, site, 'SSH user password revealed: ' + u.username, { target: u.username });
  return { password: secrets.decrypt(u.password_enc) };
});
router.add('DELETE', '/api/sites/:domain/ssh-users/:id', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const u = store.sshUsers.list(site.id).find((x) => x.id === Number(ctx.params.id));
  if (!u) throw httpError(404, 'unknown ssh user');
  const r = await users.deleteUnixUser(u.username, { keepHome: !!ctx.query.get('keepHome') });
  store.sshUsers.remove(u.id);
  if (!store.sshUsers.list(site.id).length) { try { require('fs').chmodSync('/home/' + site.user, 0o770); } catch (_) {} }
  claimAnd(site, ctx, 'sites.ssh-user.delete', 'SSH user deleted: ' + u.username + (r.keptHome ? ' (home kept)' : ''), { target: u.username, level: 'warn' });
  return { ok: true, removed: r };
});

/* ---- cron ---- */
router.add('GET', '/api/sites/:domain/cron', perm('read'), (ctx) => { const site = siteOf(ctx); return { jobs: store.cronJobs.list(site.id), file: cron.fileFor(site.user), on_disk: cron.readFile(site.user), presets: Object.keys(cron.PRESETS) }; });
router.add('POST', '/api/sites/:domain/cron', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const j = cron.validate(await readJson(ctx.req));
  const id = store.cronJobs.insert(Object.assign({ site_id: site.id }, j));
  cron.writeFor(site);
  claimAnd(site, ctx, 'sites.cron.add', 'Cron job added: ' + [j.minute, j.hour, j.day, j.month, j.weekday].join(' ') + ' ' + j.command.slice(0, 80), { data: j });
  return { ok: true, id, jobs: store.cronJobs.list(site.id) };
});
router.add('PUT', '/api/sites/:domain/cron/:id', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const cur = store.cronJobs.get(Number(ctx.params.id));
  if (!cur || cur.site_id !== site.id) throw httpError(404, 'unknown cron job');
  const j = cron.validate(await readJson(ctx.req));
  store.cronJobs.update(cur.id, j);
  cron.writeFor(site);
  claimAnd(site, ctx, 'sites.cron.update', 'Cron job updated: ' + j.command.slice(0, 80), { data: j });
  return { ok: true, jobs: store.cronJobs.list(site.id) };
});
router.add('DELETE', '/api/sites/:domain/cron/:id', perm('write'), (ctx) => {
  const site = siteOf(ctx);
  const cur = store.cronJobs.get(Number(ctx.params.id));
  if (!cur || cur.site_id !== site.id) throw httpError(404, 'unknown cron job');
  store.cronJobs.remove(cur.id);
  cron.writeFor(site);
  claimAnd(site, ctx, 'sites.cron.delete', 'Cron job deleted: ' + cur.command.slice(0, 80), { level: 'warn' });
  return { ok: true, jobs: store.cronJobs.list(site.id) };
});

/* ---- files ---- */
const UPLOAD_MAX = 2 * 1024 * 1024 * 1024;
router.add('GET', '/api/sites/:domain/files', perm('read'), (ctx) => files.op(siteOf(ctx), { op: 'list', path: ctx.query.get('path') || '/' }));
router.add('POST', '/api/sites/:domain/files/op', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req, 3 * 1024 * 1024);
  if (!['list', 'stat', 'mkdir', 'touch', 'rename', 'move', 'delete', 'chmod', 'read', 'write', 'extract'].includes(b.op)) throw httpError(400, 'unknown op');
  const r = await files.op(site, b);
  if (!['list', 'stat', 'read'].includes(b.op)) claimAnd(site, ctx, 'sites.files.' + b.op, 'Files: ' + b.op + ' ' + (b.path || (b.paths || []).join(', ')) + (b.name ? ' → ' + b.name : ''), { data: { op: b.op, path: b.path, paths: b.paths, name: b.name, to: b.to, mode: b.mode } });
  return r;
});
router.add('POST', '/api/sites/:domain/files/upload', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const dir = ctx.query.get('path') || '/', name = ctx.query.get('name');
  if (!name || /[\/\0]/.test(name) || name === '.' || name === '..') throw httpError(400, 'invalid file name');
  const r = await files.upload(site, dir.replace(/\/+$/, '') + '/' + name, ctx.req, UPLOAD_MAX);
  claimAnd(site, ctx, 'sites.files.upload', 'Uploaded ' + r.path + ' (' + r.size + ' bytes)', { data: r });
  return r;
});
router.add('GET', '/api/sites/:domain/files/download', perm('read'), (ctx) => {
  const site = siteOf(ctx);
  const p = ctx.query.get('path');
  if (!p) throw httpError(400, 'path required');
  return files.download(site, p, ctx.res);
});

/* ---- logs ---- */
/* --------------------------------------------------------------- cloudflare */
// Per site, because the panel's domains live in several Cloudflare accounts and an account-owned
// token cannot cross that boundary. No site token → the account-wide one from Settings is used.
router.add('GET', '/api/sites/:domain/cloudflare', perm('read'), (ctx) => siteCf.status(siteOf(ctx), publicIp()));
router.add('PUT', '/api/sites/:domain/cloudflare', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const r = await siteCf.connect(site, b.token);
  emit('site.cloudflare.connect', ctx, site, 'Cloudflare token connected for ' + site.domain + ' (zone ' + r.zone.name + (r.account ? ', account ' + r.account.name : '') + ')');
  return r;
});
router.add('DELETE', '/api/sites/:domain/cloudflare', perm('write'), (ctx) => {
  const site = siteOf(ctx);
  const r = siteCf.disconnect(site);
  emit('site.cloudflare.disconnect', ctx, site, 'Cloudflare token removed for ' + site.domain, { level: 'warn' });
  return r;
});
router.add('POST', '/api/sites/:domain/cloudflare/point-here', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const ip = publicIp();
  if (!ip) throw httpError(409, 'this server has no public IPv4 address to point at');
  const r = await siteCf.pointHere(site, ip, { proxied: b.proxied });
  emit('site.cloudflare.dns', ctx, site, 'DNS for ' + site.domain + ' pointed at ' + ip + ' · ' + r.changes.map((c) => c.action).join(', '), { data: r });
  return r;
});
router.add('POST', '/api/sites/:domain/cloudflare/records/:id/proxy', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const b = await readJson(ctx.req);
  const r = await siteCf.setProxied(site, ctx.params.id, b.proxied);
  emit('site.cloudflare.dns', ctx, site, (b.proxied ? 'Proxy enabled' : 'Proxy disabled') + ' for a DNS record of ' + site.domain);
  return r;
});

/* --------------------------------------------------------------- processes */
router.add('GET', '/api/sites/:domain/processes', perm('read'), (ctx) => procs.list(siteOf(ctx)));
// start | stop | restart | reload | resurrect. Without ?app= the action covers the whole site, and
// start/restart resurrect a daemon that is down instead of failing with "process not found".
router.add('POST', '/api/sites/:domain/processes/:action', perm('write'), async (ctx) => {
  const site = siteOf(ctx);
  const app = ctx.query.get('app') || null, user = ctx.query.get('user') || null;
  const r = await procs.act(site, ctx.params.action, { app, user });
  const failed = r.results.filter((x) => !x.ok && !x.skipped);
  emit('site.pm2.' + ctx.params.action, ctx, site, 'pm2 ' + ctx.params.action + ' ' + (app || 'all') + ' · ' + site.domain + (failed.length ? ' failed' : ''),
    { level: failed.length ? 'error' : 'info', data: { results: r.results.map((x) => ({ user: x.user, ok: x.ok, command: x.command, output: (x.output || '').slice(0, 500) })) } });
  return r;
});

router.add('GET', '/api/sites/:domain/logs', perm('read'), (ctx) => ({ kinds: logs.kinds(siteOf(ctx)) }));
router.add('GET', '/api/sites/:domain/logs/:kind', perm('read'), (ctx) => logs.read(siteOf(ctx), ctx.params.kind + (ctx.query.get('name') ? '/' + ctx.query.get('name') : ''), ctx.query.get('lines'), ctx.query.get('q')));
