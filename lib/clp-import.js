'use strict';
// One-way sync from CloudPanel's SQLite into our tables while both panels coexist.
// - sites still owned by CLP (managed_by='clp') are refreshed on every run; rows we manage are left alone
// - certificates: every CLP row is imported, but the *active* one is whichever matches the
//   fingerprint of /etc/nginx/ssl-certificates/<domain>.crt (CLP's default flag is unreliable)
// - vhost templates (the 31 global ones) are upserted with source='clp'
// - database_server: MariaDB admin credentials via `clpctl db:show:master-credentials`
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cloudpanel = require('./cloudpanel');
const store = require('./sites/store');
const secrets = require('./secrets');
const ssl = require('./sites/ssl');
const vhost = require('./sites/vhost');
const events = require('./events');

const TYPE_BY_TEMPLATE_NAME = { Nodejs: 'nodejs', Static: 'static', ReverseProxy: 'reverse-proxy', Python: 'python' };
const CERT_TYPE = { 1: 'self_signed', 2: 'letsencrypt', 3: 'custom' };   // CLP certificate.type

function templateType(row) {
  if (TYPE_BY_TEMPLATE_NAME[row.name]) return TYPE_BY_TEMPLATE_NAME[row.name];
  return row.php_version ? 'php' : 'php';
}

function run(opts) {
  opts = opts || {};
  const result = { sites: 0, updated: 0, skipped: 0, templates: 0, certificates: 0, sshUsers: 0, cronJobs: 0, dbServer: false, errors: [] };
  if (!cloudpanel.exists()) { result.errors.push('CloudPanel database not found'); return result; }
  cloudpanel.withDb((clp) => {
    // templates
    for (const t of clp.prepare('SELECT * FROM vhost_template').all()) {
      store.templates.upsert({ name: t.name, type: templateType(t), php_version: t.php_version || null, root_dir: t.root_directory || null, template: t.template, varnish_settings: t.varnish_cache_settings || null, source: 'clp' });
      result.templates++;
    }
    // sites
    const phpBySite = Object.fromEntries(clp.prepare('SELECT * FROM php_settings').all().map((r) => [r.site_id, r]));
    const nodeBySite = Object.fromEntries(clp.prepare('SELECT * FROM nodejs_settings').all().map((r) => [r.site_id, r]));
    const pyBySite = Object.fromEntries(clp.prepare('SELECT * FROM python_settings').all().map((r) => [r.site_id, r]));
    const basicAuthById = Object.fromEntries(clp.prepare('SELECT * FROM basic_auth').all().map((r) => [r.id, r]));
    for (const s of clp.prepare('SELECT * FROM site ORDER BY domain_name').all()) {
      try {
        const existing = store.get(s.domain_name);
        if (existing && existing.managed_by === 'rhc') { result.skipped++; continue; }
        const rec = {
          domain: s.domain_name, type: s.type, user: s.user, root_dir: s.root_directory, application: s.application || null,
          vhost_template: s.vhost_template, varnish_cache: !!s.varnish_cache, cf_only: !!s.allow_traffic_from_cloudflare_only,
          pagespeed_enabled: !!s.page_speed_enabled, pagespeed_settings: s.page_speed_settings || null, reverse_proxy_url: s.reverse_proxy_url || null,
          ssh_keys: s.ssh_keys || null, managed_by: 'clp', clp_id: s.id, created_at: s.created_at ? new Date(s.created_at + 'Z').toISOString() : undefined,
        };
        // CLP stores the site-user password encrypted with its own APP_SECRET — not portable; ours stays null until regenerated here.
        const php = phpBySite[s.id], node = nodeBySite[s.id], py = pyBySite[s.id];
        if (php) rec.php = { php_version: php.php_version, pool_port: php.pool_port, memory_limit: php.memory_limit, max_execution_time: php.max_execution_time, max_input_time: php.max_input_time, max_input_vars: php.max_input_vars, post_max_size: php.post_max_size, upload_max_filesize: php.upload_max_file_size };
        if (node) rec.nodejs = { node_version: node.nodejs_version, port: node.port, runtime: 'nvm' };
        if (py) rec.python = { python_version: py.python_version, port: py.port };
        let site;
        if (existing) { site = store.update(existing.id, rec); if (rec.php) store.setPhp(site.id, rec.php); if (rec.nodejs) store.setNodejs(site.id, rec.nodejs); if (rec.python) store.setPython(site.id, rec.python); result.updated++; }
        else { site = store.insert(rec); result.sites++; }
        // attachments (replace wholesale — CLP is the owner while managed_by='clp')
        const ba = s.basic_auth_id ? basicAuthById[s.basic_auth_id] : null;
        if (ba) store.basicAuth.set(site.id, { is_active: !!ba.is_active, username: ba.user_name, password_enc: null, allowed_ips: ba.whitelisted_ips ? String(ba.whitelisted_ips).split(',').map((x) => x.trim()).filter(Boolean) : [] });
        else store.basicAuth.remove(site.id);
        store.blockedIps.set(site.id, clp.prepare('SELECT ip FROM blocked_ip WHERE site_id = ?').all(s.id).map((r) => r.ip));
        store.blockedBots.set(site.id, clp.prepare('SELECT name FROM blocked_bot WHERE site_id = ?').all(s.id).map((r) => r.name));
        for (const u of clp.prepare('SELECT * FROM ssh_user WHERE site_id = ?').all(s.id)) {
          if (!store.sshUsers.get(u.user_name)) { store.sshUsers.insert({ site_id: site.id, username: u.user_name, ssh_keys: u.ssh_keys || null, created_at: u.created_at ? new Date(u.created_at + 'Z').toISOString() : undefined }); result.sshUsers++; }
          else store.sshUsers.update(store.sshUsers.get(u.user_name).id, { ssh_keys: u.ssh_keys || null });
        }
        for (const u of clp.prepare('SELECT * FROM ftp_user WHERE site_id = ?').all(s.id)) {
          if (!store.ftpUsers.get(u.user_name)) store.ftpUsers.insert({ site_id: site.id, username: u.user_name, home: u.home_directory });
        }
        store.cronJobs.clear(site.id);
        for (const j of clp.prepare('SELECT * FROM cron_job WHERE site_id = ?').all(s.id)) { store.cronJobs.insert({ site_id: site.id, minute: j.minute, hour: j.hour, day: j.day, month: j.month, weekday: j.weekday, command: j.command }); result.cronJobs++; }
        // The file nginx serves is the truth (CLP's stored copy loses blank lines and misses hand edits):
        // re-template it so our render() reproduces it byte for byte and Settings edits still apply.
        const disk = vhost.readCurrentFile(site.domain);
        if (disk !== null) {
          const full = store.getById(site.id);
          const rt = vhost.retemplate(disk, full);
          const patch = { vhost_template: rt.template, cf_only: rt.cf_only, vhost_source: rt.placeholders.length ? 'template' : 'disk' };
          if (rt.php) store.setPhp(site.id, rt.php);
          site = store.update(site.id, patch);
          if (vhost.render(site) !== disk) result.errors.push(site.domain + ': re-templated vhost does not reproduce the file on disk');
        }
        // certificates
        const onDisk = ssl.readInstalled(site.domain);
        let activeSet = false;
        for (const c of clp.prepare('SELECT * FROM certificate WHERE site_id = ? ORDER BY id').all(s.id)) {
          const info = ssl.inspect(c.certificate);
          if (!info) continue;
          const type = info.issuer && /CloudFlare Origin/i.test(info.issuer) ? 'cloudflare_origin' : (CERT_TYPE[c.type] || 'custom');
          const isActive = !!(onDisk && onDisk.fingerprint === info.fingerprint);
          let row = store.certs.byFingerprint(site.id, info.fingerprint);
          if (!row) {
            store.certs.insert({ site_id: site.id, type, subject: info.subject, sans: info.sans, issuer: info.issuer, expires_at: info.expires_at,
              private_key_enc: c.private_key ? secrets.encrypt(c.private_key) : null, certificate: c.certificate, chain: c.certificate_chain || null, fingerprint: info.fingerprint, is_active: 0,
              created_at: c.created_at ? new Date(c.created_at + 'Z').toISOString() : undefined });
            row = store.certs.byFingerprint(site.id, info.fingerprint);
            result.certificates++;
          }
          if (isActive && row) { store.certs.setActive(site.id, row.id); activeSet = true; }
        }
        // on-disk cert unknown to CLP (hand-installed): record it so the SSL tab shows the truth
        if (!activeSet && onDisk) {
          let row = store.certs.byFingerprint(site.id, onDisk.fingerprint);
          if (!row) {
            store.certs.insert({ site_id: site.id, type: onDisk.issuer && /CloudFlare Origin/i.test(onDisk.issuer) ? 'cloudflare_origin' : 'custom', subject: onDisk.subject, sans: onDisk.sans, issuer: onDisk.issuer,
              expires_at: onDisk.expires_at, private_key_enc: onDisk.key ? secrets.encrypt(onDisk.key) : null, certificate: onDisk.certificate, chain: onDisk.chain, fingerprint: onDisk.fingerprint, is_active: 0 });
            row = store.certs.byFingerprint(site.id, onDisk.fingerprint);
            result.certificates++;
          }
          store.certs.setActive(site.id, row.id);
        }
      } catch (e) { result.errors.push(s.domain_name + ': ' + e.message); }
    }
    // MariaDB admin credentials
    const srv = clp.prepare("SELECT * FROM database_server WHERE is_active = 1 ORDER BY is_default DESC").get();
    if (srv && !opts.skipDbServer) {
      let password = null;
      try {
        const out = execFileSync('clpctl', ['db:show:master-credentials'], { encoding: 'utf8', timeout: 20_000 });
        const m = out.match(/Password:\s*(\S+)/i); if (m) password = m[1];
      } catch (e) { result.errors.push('clpctl db:show:master-credentials: ' + e.message.split('\n')[0]); }
      store.dbServers.upsert({ engine: String(srv.engine || 'mariadb').toLowerCase().includes('maria') ? 'mariadb' : 'mysql', host: srv.host, port: srv.port, admin_user: srv.user_name, admin_password_enc: password ? secrets.encrypt(password) : null, is_default: true });
      result.dbServer = !!password;
    }
    return null;
  }, null);
  if (!store.dbServers.byEngine('postgres')) store.dbServers.upsert({ engine: 'postgres', host: '/var/run/postgresql', port: 5432, admin_user: 'postgres', is_default: true });
  events.emit('sites.import', { user: opts.actor ? opts.actor.user : 'system', ip: opts.actor ? opts.actor.ip : null, level: result.errors.length ? 'warn' : 'info',
    message: 'CloudPanel sync: ' + result.sites + ' new, ' + result.updated + ' refreshed, ' + result.skipped + ' ours, ' + result.templates + ' templates' + (result.errors.length ? ', ' + result.errors.length + ' error(s)' : ''), data: result });
  return result;
}

module.exports = { run };
