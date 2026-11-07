'use strict';
// Moving a site to another cluster member (Cluster → Move).
//
//   1 preflight  the target checks: domain/user free, app port free, site type supported, disk space
//   2 bundle     source: manifest (site row, every site_id-keyed row, per-site kv, certificate, cron,
//                SSH users, tunnel token; encrypted values decrypted so the target re-encrypts them
//                with ITS key) + tar of the site user's home (and its SSH users' homes) without logs,
//                caches, virtualenvs and pm2 runtime state; PostgreSQL/MariaDB dumped into the home
//                first. The bundle is AES-256-GCM encrypted with the pair key, then cut into 40 MB
//                chunks (Cloudflare's request size limit) and uploaded.
//   3 import     target, as a background job: create the site through the normal create path (same
//                domain, user, password, port; no new tunnel/repo/db), unpack the home, restore rows,
//                kv, certificate, cron, SSH users, databases; rebuild the runtime (pm2, venv) and
//                start the apps; check the app answers.
//   4 cutover    target installs and starts the site's tunnel (same tunnel, same token: DNS does not
//                change); once Cloudflare sees it healthy on the target, the source stops its tunnel,
//                stops the site and puts it on hold — kept, not deleted ("moved to <peer>").
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execP } = require('./util');
const { settings, open } = require('./db');
const secrets = require('./secrets');
const cluster = require('./cluster');
const events = require('./events');

const STAGE = '/var/tmp/rhc-cluster';
const CHUNK = 40 * 1024 * 1024;
const bad = cluster.bad;
const KV_PER_SITE = ['site.overrides:', 'site.sshkey:', 'site.github:', 'tunnel.site:'];
const HOME_EXCLUDES = ['./logs/*', './.cache', './.npm', './.nvm', './.local/share/pnpm', './.venv', './htdocs/*/.venv', './htdocs/*/venv', './.pm2/logs', './.pm2/pids', './.pm2/*.sock', './.pm2/*.pid', './tmp/*'];
const jobs = new Map();          // transfer id → { state, steps, error, … } (both sides)

// ---- encrypted values travel as { __plain: "…" } and are re-encrypted by the receiver
function plainify(v) {
  if (typeof v === 'string' && secrets.isEncrypted(v)) { try { return { __plain: secrets.decrypt(v) }; } catch (_) { return null; } }
  if (Array.isArray(v)) return v.map(plainify);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = plainify(x); return o; }
  return v;
}
function reencrypt(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '__plain' in v) return v.__plain == null ? null : secrets.encrypt(v.__plain);
  if (Array.isArray(v)) return v.map(reencrypt);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = reencrypt(x); return o; }
  return v;
}
const siteTables = () => open().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  .filter((t) => t !== 'sites' && open().prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all().some((c) => c.name === 'site_id'));

// ------------------------------------------------------------------ source: manifest + bundle
async function manifest(site) {
  const store = require('./sites/store');
  const row = open().prepare('SELECT * FROM sites WHERE id = ?').get(site.id);
  const tables = {};
  for (const t of siteTables()) tables[t] = open().prepare('SELECT * FROM ' + JSON.stringify(t) + ' WHERE site_id = ?').all(site.id).map((r) => { const o = Object.assign({}, r); delete o.id; delete o.site_id; return o; });
  const kv = {};
  for (const p of KV_PER_SITE) { const v = settings.get(p + site.domain, null); if (v != null) kv[p + site.domain] = v; }
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
  const tunnel = settings.get('tunnel.site:' + site.domain, null);
  let dbList = [];
  try { dbList = (await require('./sites/dbs').list(site)).filter((d) => d.engine !== 'sqlite').map((d) => ({ id: d.id, engine: d.engine, name: d.name })); } catch (_) {}
  const sshUsers = (tables.ssh_users || []).map((u) => u.username);
  const port = site.nodejs ? site.nodejs.port : site.python ? site.python.port : null;
  return plainify({
    v: 1, from: { id: cluster.self().id, name: cluster.self().name }, at: new Date().toISOString(),
    domain: site.domain, user: site.user, type: site.type, port, row, tables, kv, sshUsers, databases: dbList,
    cert: { crt: read('/etc/nginx/ssl-certificates/' + site.domain + '.crt'), key: read('/etc/nginx/ssl-certificates/' + site.domain + '.key') },
    tunnel: tunnel ? { rec: tunnel, token: tunnel.tokenFile ? read(tunnel.tokenFile) : null, unit: tunnel.unit, unitFile: tunnel.unit ? read('/etc/systemd/system/' + tunnel.unit + '.service') : null } : null,
    homes: [site.user, ...sshUsers],
  });
}

function aesEncrypt(key, buf) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
}
function aesDecrypt(key, buf) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(buf.length - 16), d = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(key).digest(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
}

async function buildBundle(site, id, say) {
  const dir = path.join(STAGE, id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const m = await manifest(site);
  // PostgreSQL / MariaDB: dump into the home, so the dump travels with the files
  for (const d of m.databases) {
    try { const r = await require('./sites/dbs').exportDb(site, d.id); d.dump = r && r.file; say('dumped ' + d.engine + ' database ' + d.name, d.dump); }
    catch (e) { throw bad('could not dump database ' + d.name + ': ' + e.message); }
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m), { mode: 0o600 });
  const tarFile = path.join(dir, 'homes.tar.gz');
  const args = ['-czf', tarFile, '--one-file-system'];
  for (const x of HOME_EXCLUDES) args.push('--exclude=' + x);
  args.push('-C', '/home', ...m.homes.filter((h) => fs.existsSync('/home/' + h)));
  const t = await execP('tar', args, { timeout: 60 * 60_000 });
  if (t.err && !fs.existsSync(tarFile)) throw bad('tar failed', 500, t.stderr);
  const size = fs.statSync(tarFile).size;
  say('packed ' + m.homes.map((h) => '/home/' + h).join(', '), Math.round(size / 1048576) + ' MB');
  return { dir, manifest: m, tarFile, size };
}

// ------------------------------------------------------------------ source: orchestrate
// Moves run one after another (each bundles a whole home); when the last queued move to a temporary
// partner has finished, the pairing is forgotten on both sides.
let queue = Promise.resolve();
const pending = new Map();      // peer id → moves still queued/running
function startMove(domain, peerId, actor) {
  const p0 = cluster.peer(peerId);
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, role: 'source', domain, peer: { id: p0.id, name: p0.name }, state: 'queued', steps: [], started: new Date().toISOString() };
  jobs.set(id, job);
  pending.set(peerId, (pending.get(peerId) || 0) + 1);
  queue = queue.then(() => runMove(job, actor)).catch(() => {}).finally(() => {
    const left = (pending.get(peerId) || 1) - 1; pending.set(peerId, left);
    if (left <= 0) { pending.delete(peerId); const pp = cluster.peers().find((x) => x.id === peerId); if (pp && pp.temp) cluster.forget(peerId, true).then(() => job.steps.push({ at: new Date().toISOString(), text: 'transfer finished — the connection to ' + p0.name + ' was closed on both sides' })); }
  });
  return job;
}
async function runMove(job, actor) {
  const domain = job.domain, peerId = job.peer.id;
  job.state = 'running';
  const store = require('./sites/store');
  const id = job.id;
  const say = (a, d) => { job.steps.push({ at: new Date().toISOString(), text: d ? a + ' — ' + d : a }); };
  {
    let b = null, p = null;
    try {
      const site = store.get(domain); if (!site) throw bad('unknown site ' + domain, 404);
      p = cluster.peer(peerId);
      if (!settings.get('tunnel.site:' + domain, null)) throw bad(domain + ' is not published through its own Cloudflare tunnel — a move switches traffic by moving the tunnel, so publish it first (or move it by hand)', 409);
      const ph = (phase, pct, detail) => { job.phase = phase; job.progress = Math.round(pct); job.detail = detail || null; };
      ph('preflight', 2, 'checking ' + p.name);
      say('preflight on ' + p.name);
      const m0 = await manifest(site);
      const pf = await cluster.call(p, 'POST', '/api/cluster/peer/preflight', { domain, user: site.user, type: site.type, port: m0.port, homes: m0.homes, bytesHint: 0 });
      if (!pf.ok) throw bad(p.name + ' cannot take ' + domain + ': ' + pf.problems.join('; '), 409);
      ph('pack', 6, 'dumping databases and packing the site');
      b = await buildBundle(site, id, say);
      ph('pack', 22, 'encrypting the bundle');
      const key = cluster.dec(p.key_enc);
      const payload = aesEncrypt(key, Buffer.concat([Buffer.from(JSON.stringify(b.manifest) + '\n\u0000'), fs.readFileSync(b.tarFile)]));
      const n = Math.ceil(payload.length / CHUNK);
      const mb = (x) => Math.round(x / 1048576);
      for (let i = 0; i < n; i++) {
        ph('upload', 25 + (i / n) * 45, 'chunk ' + (i + 1) + ' of ' + n + ' (' + mb(Math.min((i + 1) * CHUNK, payload.length)) + ' of ' + mb(payload.length) + ' MB)');
        await cluster.call(p, 'POST', '/api/cluster/peer/upload/' + id + '/' + i, payload.subarray(i * CHUNK, (i + 1) * CHUNK), { timeout: 10 * 60_000 });
      }
      say('uploaded the encrypted bundle to ' + p.name, n + ' chunk(s), ' + Math.round(payload.length / 1048576) + ' MB');
      await cluster.call(p, 'POST', '/api/cluster/peer/import/' + id, { chunks: n, sha256: crypto.createHash('sha256').update(payload).digest('hex') });
      // wait for the import on the target
      let r = null;
      ph('import', 70, p.name + ' is unpacking');
      for (let i = 0; i < 720; i++) {
        await new Promise((x) => setTimeout(x, 2500));
        r = await cluster.call(p, 'GET', '/api/cluster/peer/job/' + id).catch(() => null);
        if (r) { job.remote = { phase: r.phase, steps: (r.steps || []).slice(-6) }; ph('import', 70 + Math.min(22, (r.steps || []).length * 2), p.name + ': ' + (((r.steps || []).slice(-1)[0] || {}).text || 'working')); }
        if (r && r.state !== 'running') break;
      }
      for (const s of (r && r.steps) || []) say(p.name + ': ' + s.text);
      if (!r || r.state !== 'imported') throw bad('import on ' + p.name + ' did not finish: ' + ((r && r.error) || 'timeout'), 424);
      // cutover: start the tunnel there, then stop it here
      ph('cutover', 93, p.name + ' starts the tunnel');
      const c = await cluster.call(p, 'POST', '/api/cluster/peer/cutover/' + id, {}, { timeout: 180_000 });
      say(p.name + ' runs the tunnel', c.detail || '');
      ph('cutover', 97, 'stopping the copy here');
      await localRetire(site, p, say);
      ph('done', 100, 'running on ' + p.name);
      job.state = 'done';
      events.emit('cluster.move', { user: actor || 'system', site: domain, level: 'warn', message: domain + ' moved to ' + p.name, data: { steps: job.steps } });
    } catch (e) {
      job.state = 'failed'; job.error = e.message + (e.detail ? ': ' + e.detail : '');
      say('FAILED: ' + job.error + ' — the site keeps running here');
      events.emit('cluster.move', { user: actor || 'system', site: domain, level: 'error', message: 'Moving ' + domain + ' to ' + (p ? p.name : '?') + ' failed: ' + e.message });
    } finally {
      job.finished = new Date().toISOString();
      if (b) { try { fs.rmSync(b.dir, { recursive: true, force: true }); } catch (_) {} }
    }
  }
}

// After the target took over: stop the tunnel and the site here, keep everything else.
async function localRetire(site, p, say) {
  const t = settings.get('tunnel.site:' + site.domain, null);
  if (t && t.unit) {
    await execP('systemctl', ['disable', '--now', t.unit], { timeout: 60_000 });
    say('stopped and disabled ' + t.unit + ' here');
  }
  const procs = require('./sites/procs');
  try { await procs.act(site, 'stop', {}); } catch (_) {}
  try { require('./sites/hold').set(site.domain, { by: 'cluster move → ' + p.name, at: new Date().toISOString() }); } catch (_) {}
  settings.set('site.movedTo:' + site.domain, { peer: p.id, name: p.name, at: new Date().toISOString() });
  say('stopped ' + site.domain + ' here and put it on hold — the copy stays until you delete the site');
}

// ------------------------------------------------------------------ target
function preflight(b) {
  const problems = [];
  const store = require('./sites/store'), users = require('./sites/users');
  if (store.get(b.domain)) problems.push(b.domain + ' already exists here');
  for (const h of b.homes || []) if (users.getent(h) || fs.existsSync('/home/' + h)) problems.push('unix user/home ' + h + ' already exists here');
  if (!['nodejs', 'python', 'static', 'php', 'reverse-proxy'].includes(b.type)) problems.push('unsupported site type ' + b.type);
  if (b.port) { const lp = require('./util').listeningPorts(); if (lp.has(Number(b.port)) || store.usedPorts().has(Number(b.port))) problems.push('port ' + b.port + ' is in use here'); }
  try { const s = fs.statfsSync('/'); if (s.bavail * s.bsize < 5 * 1024 ** 3) problems.push('less than 5 GB free'); } catch (_) {}
  if (!fs.existsSync('/usr/bin/cloudflared')) problems.push('cloudflared is not installed here');
  return { ok: !problems.length, problems };
}
function receiveChunk(id, n, buf) {
  if (!/^[0-9a-f]{16}$/.test(id) || !/^\d{1,5}$/.test(String(n))) throw bad('bad transfer id');
  const dir = path.join(STAGE, 'in-' + id); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, String(n).padStart(5, '0') + '.part'), buf, { mode: 0o600 });
  const rj = jobs.get('recv-' + id) || { id: 'recv-' + id, role: 'target', state: 'running', phase: 'receive', steps: [], started: new Date().toISOString() };
  rj.detail = 'received chunk ' + (Number(n) + 1); rj.progress = 20; jobs.set('recv-' + id, rj);
  return { ok: true, bytes: buf.length };
}
function startImport(id, b, fromPeer) {
  const dir = path.join(STAGE, 'in-' + id);
  if (!fs.existsSync(dir)) throw bad('no chunks for this transfer', 404);
  jobs.delete('recv-' + id);
  const job = { id, role: 'target', state: 'running', phase: 'decrypt', progress: 35, steps: [], from: fromPeer.name, started: new Date().toISOString() };
  jobs.set(id, job);
  const say = (a, d) => job.steps.push({ at: new Date().toISOString(), text: d ? a + ' — ' + d : a });
  (async () => {
    try {
      const parts = fs.readdirSync(dir).filter((f) => f.endsWith('.part')).sort();
      if (parts.length !== Number(b.chunks)) throw bad('expected ' + b.chunks + ' chunks, have ' + parts.length);
      const payload = Buffer.concat(parts.map((f) => fs.readFileSync(path.join(dir, f))));
      if (crypto.createHash('sha256').update(payload).digest('hex') !== b.sha256) throw bad('bundle checksum mismatch');
      const plain = aesDecrypt(cluster.dec(fromPeer.key_enc), payload);
      const sep = plain.indexOf(Buffer.from('\n\u0000'));
      const m = JSON.parse(plain.subarray(0, sep).toString());
      fs.writeFileSync(path.join(dir, 'homes.tar.gz'), plain.subarray(sep + 2), { mode: 0o600 });
      for (const f of parts) fs.unlinkSync(path.join(dir, f));
      job.domain = m.domain;
      job.phase = 'restore'; job.progress = 50;
      await restore(m, dir, say);
      job.manifestTunnel = m.tunnel;
      job.state = 'imported'; job.phase = 'wait-cutover'; job.progress = 90;
    } catch (e) { job.state = 'failed'; job.error = e.message + (e.detail ? ': ' + e.detail : ''); say('FAILED: ' + job.error); }
    finally { job.finished = new Date().toISOString(); }
  })();
  return { started: true };
}

async function restore(m, dir, say) {
  const store = require('./sites/store'), create = require('./sites/create'), users = require('./sites/users');
  const pf = preflight({ domain: m.domain, homes: m.homes, type: m.type, port: m.port });
  if (!pf.ok) throw bad(pf.problems.join('; '), 409);
  const row = reencrypt(m.row);
  const password = row.user_password_enc ? secrets.decrypt(row.user_password_enc) : undefined;
  const nodejs = (m.tables.site_nodejs || [])[0], python = (m.tables.site_python || [])[0];
  // 1. the site, through the normal create path — no tunnel, no repo, no extra db (they come from the bundle)
  const r = await create.createSite({ domain: m.domain, type: m.type, user: m.user, password, port: m.port || undefined, cf_only: row.cf_only,
    node_version: nodejs ? nodejs.node_version : undefined, python_version: python ? python.python_version : undefined, reverse_proxy_url: row.reverse_proxy_url || undefined,
    tunnel: false, github: false, sqlite: false, claude: false });
  say('created ' + m.domain + ' here', 'user ' + r.user);
  const site = store.get(m.domain);
  // 2. extra SSH users (their homes come from the tar)
  for (const u of reencrypt(m.tables.ssh_users || [])) {
    try { await users.createSshUser(site, u.username, u.password_enc ? secrets.decrypt(u.password_enc) : secrets.generatePassword(20), u.ssh_keys || ''); say('created SSH user ' + u.username); }
    catch (e) { say('could not create SSH user ' + u.username, e.message); }
  }
  // 3. the homes, over what create made (pm2 placeholder etc.)
  const asU = (cmd) => execP('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', cmd], { timeout: 30 * 60_000 });
  await asU('pm2 delete all >/dev/null 2>&1; true');
  const x = await execP('tar', ['-xzf', path.join(dir, 'homes.tar.gz'), '-C', '/home'], { timeout: 60 * 60_000 });
  if (x.err) throw bad('unpacking the homes failed', 500, x.stderr);
  say('unpacked ' + m.homes.map((h) => '/home/' + h).join(', '));
  // 4. rows keyed by site_id (replacing what create inserted), site columns, per-site kv, certificate, cron
  const db = open();
  for (const [t, rows] of Object.entries(reencrypt(m.tables))) {
    if (t === 'ssh_users') continue;
    const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all().map((c) => c.name);
    if (!cols.includes('site_id')) continue;
    db.prepare('DELETE FROM ' + JSON.stringify(t) + ' WHERE site_id = ?').run(site.id);
    for (const r0 of rows) {
      const keys = Object.keys(r0).filter((k) => cols.includes(k));
      db.prepare('INSERT INTO ' + JSON.stringify(t) + ' (site_id, ' + keys.map((k) => JSON.stringify(k)).join(', ') + ') VALUES (?' + ', ?'.repeat(keys.length) + ')').run(site.id, ...keys.map((k) => r0[k]));
    }
  }
  const keep = ['vhost_template', 'varnish_cache', 'cf_only', 'pagespeed_enabled', 'pagespeed_settings', 'ssh_keys', 'root_dir', 'application', 'vhost_source'];
  store.update(site.id, Object.fromEntries(keep.filter((k) => k in row).map((k) => [k, row[k]])));
  for (const [k, v] of Object.entries(reencrypt(m.kv))) if (!k.startsWith('tunnel.site:')) settings.set(k, v);
  if (m.cert && m.cert.crt && m.cert.key) { fs.writeFileSync('/etc/nginx/ssl-certificates/' + m.domain + '.crt', m.cert.crt); fs.writeFileSync('/etc/nginx/ssl-certificates/' + m.domain + '.key', m.cert.key, { mode: 0o600 }); }
  const fresh = store.get(m.domain);
  const vh = require('./sites/vhost'); const w = await vh.writeWithRollback(fresh, vh.render(fresh));
  say('restored settings, certificate and vhost', w.ok ? 'nginx reloaded' : 'nginx refused the vhost: ' + JSON.stringify(w.test || w.error));
  try { require('./sites/cron').writeFor(fresh.user); } catch (_) {}
  // 5. databases (PostgreSQL / MariaDB) from the dumps that came in the home
  for (const d of m.databases || []) {
    try {
      const made = await require('./sites/dbs').create(fresh, { engine: d.engine, name: d.name });
      if (d.dump && fs.existsSync(d.dump)) { await require('./sites/dbs').importDb(fresh, made.id, fs.createReadStream(d.dump), 50 * 1024 ** 3); say('restored ' + d.engine + ' database ' + d.name); }
    } catch (e) { say('could not restore database ' + d.name, e.message); }
  }
  // 6. runtime: python venv, pm2 under its systemd unit, start
  const doc = path.join('/home', fresh.user, 'htdocs', fresh.domain);
  const rt = require('./sites/runtime');
  if (fs.existsSync(path.join(doc, 'requirements.txt')) && !fs.existsSync(path.join(doc, '.venv'))) {
    const v = await asU('cd ' + JSON.stringify(doc) + ' && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt');
    say(v.err ? 'building the Python venv FAILED' : 'built the Python venv', v.err ? (v.stderr || '').slice(-300) : '');
  }
  if (fs.existsSync(path.join(doc, 'ecosystem.config.js'))) {
    await rt.installPm2(fresh.user, true).catch(() => {}); await rt.enableLinger(fresh.user).catch(() => {});
    const s = await asU('cd ' + JSON.stringify(doc) + ' && pm2 start ecosystem.config.js --update-env >/dev/null && pm2 save >/dev/null');
    await rt.pm2Startup(fresh.user, nodejs ? nodejs.node_version : require('./sites/nodever').LATEST).catch(() => {});
    say(s.err ? 'starting the app under pm2 FAILED' : 'started the app under pm2', s.err ? (s.stderr || '').slice(-300) : '');
  }
  await require('./whitelist').apply().catch(() => {});
  if (m.port) {
    let ok = false; for (let i = 0; i < 30 && !ok; i++) { await new Promise((z) => setTimeout(z, 2000)); ok = require('./util').listeningPorts().has(Number(m.port)); }
    if (!ok) throw bad('the app does not listen on port ' + m.port + ' here — not taking over the tunnel');
    say('the app listens on port ' + m.port);
  }
}

// Target: install and start the site's tunnel (same token → same tunnel, DNS unchanged).
async function cutover(id) {
  const job = jobs.get(id);
  if (!job || job.role !== 'target' || job.state !== 'imported' || !job.manifestTunnel) throw bad('no imported site waiting for its tunnel under this transfer', 409);
  const t = reencrypt(job.manifestTunnel);
  if (!t.token || !t.unit || !t.rec.tokenFile) throw bad('the bundle has no tunnel token');
  fs.mkdirSync('/etc/cloudflared', { recursive: true });
  fs.writeFileSync(t.rec.tokenFile, t.token, { mode: 0o600 });
  fs.writeFileSync('/etc/systemd/system/' + t.unit + '.service', t.unitFile || ['[Unit]', 'Description=cloudflared tunnel for ' + job.domain, 'After=network-online.target nginx.service', 'Wants=network-online.target', '', '[Service]', 'Type=notify', 'ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run --token-file ' + t.rec.tokenFile, 'Restart=on-failure', 'RestartSec=5s', '', '[Install]', 'WantedBy=multi-user.target', ''].join('\n'));
  await execP('systemctl', ['daemon-reload'], { timeout: 30_000 });
  const e = await execP('systemctl', ['enable', '--now', t.unit], { timeout: 60_000 });
  if (e.err) throw bad('could not start ' + t.unit, 500, e.stderr);
  settings.set('tunnel.site:' + job.domain, t.rec);
  // wait until the connector is up (cloudflared Type=notify: active means registered)
  let active = false; for (let i = 0; i < 20 && !active; i++) { await new Promise((z) => setTimeout(z, 3000)); active = (await execP('systemctl', ['is-active', t.unit], { timeout: 10_000 })).stdout.trim() === 'active'; }
  if (!active) throw bad(t.unit + ' did not come up', 500);
  job.state = 'live'; job.phase = 'done'; job.progress = 100;
  try { fs.rmSync(path.join(STAGE, 'in-' + id), { recursive: true, force: true }); } catch (_) {}
  try { require('./kuma').syncSoon(); } catch (_) {}
  return { ok: true, detail: t.unit + ' running here' };
}

function job(id) { const j = jobs.get(id); if (!j) throw bad('unknown transfer', 404); return { id: j.id, role: j.role, domain: j.domain, peer: j.peer, from: j.from, state: j.state, phase: j.phase || null, progress: j.progress, detail: j.detail || null, remote: j.remote || null, steps: j.steps, error: j.error, started: j.started, finished: j.finished }; }
function list() { return [...jobs.values()].map((j) => job(j.id)).reverse(); }

module.exports = { manifest, preflight, receiveChunk, startImport, cutover, startMove, job, list, plainify, reencrypt, aesEncrypt, aesDecrypt, siteTables };
