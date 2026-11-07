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
const CHUNK = 20 * 1024 * 1024;   // smaller chunks: a dropped connection loses less, and each is retried
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
  // tar stores members as "<home>/…", so each exclude is spelled out per home ("./x" never matched
  // anything — moves used to carry pm2's pid file and sockets, .nvm, caches and logs along).
  const packHomes = m.homes.filter((h) => fs.existsSync('/home/' + h));
  for (const h of packHomes) for (const x of HOME_EXCLUDES) args.push('--exclude=' + h + '/' + x.replace(/^\.\//, ''));
  args.push('-C', '/home', ...packHomes);
  const t = await execP('tar', args, { timeout: 60 * 60_000 });
  if (t.err && !fs.existsSync(tarFile)) throw bad('tar failed', 500, t.stderr);
  const size = fs.statSync(tarFile).size;
  say('packed ' + m.homes.map((h) => '/home/' + h).join(', '), Math.round(size / 1048576) + ' MB');
  return { dir, manifest: m, tarFile, size };
}

// ------------------------------------------------------------------ source: orchestrate
// Readiness check (source → target), before any move: the same preflight the move runs, check-only —
// nothing is sent, no request or alert is created on the target.
async function precheck(domains, peerId) {
  const store = require('./sites/store');
  const p = cluster.peer(peerId);
  const out = await Promise.all(domains.map(async (domain) => {
    const site = store.get(domain);
    if (!site) return { domain, ok: false, problems: ['unknown site here'] };
    try {
      const m0 = await manifest(site);
      const viaDns = !settings.get('tunnel.site:' + domain, null);
      const r = await cluster.call(p, 'POST', '/api/cluster/peer/preflight', { domain, user: site.user, type: site.type, port: m0.port, homes: m0.homes, checkOnly: true,
        phpVersion: ((m0.tables.site_php || [])[0] || {}).php_version || null, dbEngines: [...new Set((m0.databases || []).map((d) => d.engine))], viaDns, ownCfToken: !!(m0.tables.site_cloudflare || []).length });
      return { domain, ok: !!r.ok, problems: r.problems || [], notes: r.notes || [], type: site.type, php: ((m0.tables.site_php || [])[0] || {}).php_version || null, viaDns, homes: m0.homes, databases: (m0.databases || []).length };
    } catch (e) { return { domain, ok: false, problems: [e.message] }; }
  }));
  return { target: p.name, checked: new Date().toISOString(), sites: out };
}
// Moves run in parallel: every site asks the target at once (the target sees ONE request for the whole
// batch and decides site by site), then at most HEAVY sites pack/upload/import at the same time (each
// bundles a whole home in memory). When the last move to a temporary partner has finished, the pairing
// is forgotten on both sides.
const HEAVY = 3;
let heavyBusy = 0; const heavyWait = [];
function heavySlot() {
  if (heavyBusy < HEAVY) { heavyBusy++; return Promise.resolve(); }
  return new Promise((res) => heavyWait.push(res));
}
function heavyFree() { const n = heavyWait.shift(); if (n) n(); else heavyBusy--; }
const pending = new Map();      // peer id → moves still queued/running
const failedFor = new Map();    // peer id → failed moves in the current batch (connection stays open then)
function startMove(domain, peerId, actor, batch) {
  const p0 = cluster.peer(peerId);
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, role: 'source', domain, peer: { id: p0.id, name: p0.name }, state: 'queued', steps: [], started: new Date().toISOString(), batch: batch || null };
  jobs.set(id, job);
  pending.set(peerId, (pending.get(peerId) || 0) + 1);
  runMove(job, actor).catch(() => {}).finally(() => {
    const left = (pending.get(peerId) || 1) - 1; pending.set(peerId, left);
    if (job.state === 'failed') failedFor.set(peerId, (failedFor.get(peerId) || 0) + 1);
    if (left <= 0) {
      pending.delete(peerId);
      const nFailed = failedFor.get(peerId) || 0; failedFor.delete(peerId);
      const pp = cluster.peers().find((x) => x.id === peerId);
      // close the temporary connection only when everything moved — after a failure it stays, so a retry needs no new code
      if (pp && pp.temp && !nFailed) cluster.forget(peerId, true).then(() => job.steps.push({ at: new Date().toISOString(), text: 'transfer finished — the connection to ' + p0.name + ' was closed on both sides' }));
      else if (pp && nFailed) job.steps.push({ at: new Date().toISOString(), text: nFailed + ' move(s) failed — the connection to ' + p0.name + ' stays open for a retry (closes by itself when it expires)' });
    }
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
    let b = null, p = null, slot = false;
    try {
      const site = store.get(domain); if (!site) throw bad('unknown site ' + domain, 404);
      p = cluster.peer(peerId);
      const viaDns = !settings.get('tunnel.site:' + domain, null);
      if (viaDns) say(domain + ' has no tunnel of its own here — after the import the target publishes it through its own tunnel and takes over its DNS records');
      const ph = (phase, pct, detail) => { job.phase = phase; job.progress = Math.round(pct); job.detail = detail || null; };
      ph('preflight', 2, 'checking ' + p.name);
      say('preflight on ' + p.name);
      const m0 = await manifest(site);
      const batch = job.batch ? { id: job.batch.id, domains: job.batch.domains } : undefined;
      const pf = await cluster.call(p, 'POST', '/api/cluster/peer/preflight', { domain, user: site.user, type: site.type, port: m0.port, homes: m0.homes, bytesHint: 0, batch,
        phpVersion: ((m0.tables.site_php || [])[0] || {}).php_version || null, dbEngines: [...new Set((m0.databases || []).map((d) => d.engine))], viaDns, ownCfToken: !!(m0.tables.site_cloudflare || []).length });
      let pfr = pf;
      if (pfr.pending) {
        ph('approval', 4, 'waiting for ' + p.name + ' to accept ' + domain + ' (Transfer page there)');
        say('asked ' + p.name + ' to accept ' + domain + ' — waiting for confirmation there');
        for (let i = 0; i < 360 && pfr.pending; i++) {      // up to 30 min
          if (pfr.message) ph('approval', 4, pfr.message);
          await new Promise((x) => setTimeout(x, 5000));
          pfr = await cluster.call(p, 'POST', '/api/cluster/peer/preflight', { domain, user: site.user, type: site.type, port: m0.port, homes: m0.homes, batch,
            phpVersion: ((m0.tables.site_php || [])[0] || {}).php_version || null, dbEngines: [...new Set((m0.databases || []).map((d) => d.engine))], viaDns, ownCfToken: !!(m0.tables.site_cloudflare || []).length }).catch(() => pfr);
        }
        if (pfr.pending) throw bad(p.name + ' did not accept ' + domain + ' within 30 minutes', 408);
        if (pfr.rejected) throw bad(p.name + ' rejected ' + domain, 409);
        say(p.name + ' accepted ' + domain);
      }
      if (!pfr.ok) throw bad(p.name + ' cannot take ' + domain + ': ' + pfr.problems.join('; '), 409);
      if (heavyBusy >= HEAVY) { ph('pack', 5, 'accepted — waiting for a free slot (' + HEAVY + ' sites pack and upload at the same time)'); say('waiting for a free slot'); }
      await heavySlot(); slot = true;
      ph('pack', 6, 'dumping databases and packing the site');
      b = await buildBundle(site, id, say);
      ph('pack', 22, 'encrypting the bundle');
      const key = cluster.dec(p.key_enc);
      const payload = aesEncrypt(key, Buffer.concat([Buffer.from(JSON.stringify(b.manifest) + '\n\u0000'), fs.readFileSync(b.tarFile)]));
      const n = Math.ceil(payload.length / CHUNK);
      const mb = (x) => Math.round(x / 1048576);
      for (let i = 0; i < n; i++) {
        ph('upload', 25 + (i / n) * 45, 'chunk ' + (i + 1) + ' of ' + n + ' (' + mb(Math.min((i + 1) * CHUNK, payload.length)) + ' of ' + mb(payload.length) + ' MB)');
        // the connection through Cloudflare can drop (ERR_HTTP2_STREAM_ERROR, resets) — the target just
        // overwrites a chunk it gets twice, so retry each chunk a few times before giving up
        for (let attempt = 1; ; attempt++) {
          try { await cluster.call(p, 'POST', '/api/cluster/peer/upload/' + id + '/' + i, payload.subarray(i * CHUNK, (i + 1) * CHUNK), { timeout: 10 * 60_000 }); break; }
          catch (e) {
            if (attempt >= 6) throw e;
            const wait = Math.min(60, 5 * 2 ** (attempt - 1));
            say('chunk ' + (i + 1) + ' of ' + n + ' did not go through (' + e.message + ') — retry ' + attempt + ' of 5 in ' + wait + ' s');
            ph('upload', 25 + (i / n) * 45, 'chunk ' + (i + 1) + ' of ' + n + ' — connection dropped, retrying in ' + wait + ' s');
            await new Promise((x) => setTimeout(x, wait * 1000));
          }
        }
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
      const c = await cluster.call(p, 'POST', '/api/cluster/peer/cutover/' + id, {}, { timeout: 600_000 });
      say(p.name + ' runs the tunnel', c.detail || '');
      ph('cutover', 96, 'stopping the copy here');
      await localRetire(site, p, say);
      // proof: a request from the internet to https://<domain>/ must land in the TARGET's nginx log
      ph('verify', 98, 'checking that ' + domain + ' answers from ' + p.name);
      let v = null;
      try { v = await cluster.call(p, 'POST', '/api/cluster/peer/verify/' + id, {}, { timeout: 120_000 }); }
      catch (e) { v = { confirmed: false, detail: /404|unknown route|not found/i.test(e.message) ? p.name + ' runs an older version that cannot confirm — update it' : e.message }; }
      job.verify = v;
      say(v.confirmed ? '✅ confirmed: ' + v.detail : '⚠ NOT confirmed: ' + v.detail);
      ph('done', 100, v.confirmed ? 'confirmed — runs on ' + p.name : 'moved to ' + p.name + ', but not confirmed: ' + v.detail);
      job.state = 'done';
      events.emit('cluster.move', { user: actor || 'system', site: domain, level: v.confirmed ? 'warn' : 'error', message: domain + ' moved to ' + p.name + (v.confirmed ? ' — confirmed live there' : ' — NOT confirmed: ' + v.detail), data: { steps: job.steps } });
      try { require('./notify').send((v.confirmed ? '✅ *Site moved*\n`' + domain + '` now runs on `' + p.name + '` — confirmed: ' : '⚠️ *Site moved, not confirmed*\n`' + domain + '` → `' + p.name + '`: ') + v.detail + '\nThe copy on ' + require('./cluster').self().name + ' is stopped and kept.', 'site').catch(() => {}); } catch (_) {}
    } catch (e) {
      job.state = 'failed'; job.error = e.message + (e.detail ? ': ' + e.detail : '');
      say('FAILED: ' + job.error + ' — the site keeps running here');
      events.emit('cluster.move', { user: actor || 'system', site: domain, level: 'error', message: 'Moving ' + domain + ' to ' + (p ? p.name : '?') + ' failed: ' + e.message });
    } finally {
      job.finished = new Date().toISOString();
      if (slot) heavyFree();
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
  const vr = await retireVhost(site);
  say(vr.ok ? 'disabled the nginx vhost of ' + site.domain + ' here (kept as ' + path.basename(vr.file) + ')' : 'could not disable the nginx vhost here: ' + vr.error);
  try { require('./sites/hold').set(site.domain, { by: 'cluster move → ' + p.name, at: new Date().toISOString() }); } catch (_) {}
  settings.set('site.movedTo:' + site.domain, { peer: p.id, name: p.name, at: new Date().toISOString() });
  say('stopped ' + site.domain + ' here and put it on hold — the copy stays until you delete the site');
}

// A moved site must not be served here any more (PHP sites have no pm2 to stop): its vhost is
// renamed to <domain>.conf.moved — nginx loads only *.conf — and nginx reloaded. Rolled back if
// nginx -t fails. Also enforced hourly for every site marked moved (covers moves made by older versions).
async function retireVhost(site) {
  const vh = require('./sites/vhost');
  const f = vh.confPath(site.domain), to = f + '.moved';
  if (!fs.existsSync(f)) return { ok: true, file: to, already: true };
  try { fs.renameSync(f, to); } catch (e) { return { ok: false, error: e.message }; }
  const t = await vh.nginxTest();
  if (!t.ok) { try { fs.renameSync(to, f); } catch (_) {} return { ok: false, error: 'nginx -t failed: ' + t.output.slice(-300) }; }
  await vh.reloadNginx();
  return { ok: true, file: to };
}
async function enforceMoved() {
  const store = require('./sites/store');
  for (const s of store.list()) {
    const mv = settings.get('site.movedTo:' + s.domain, null);
    if (!mv || !fs.existsSync(require('./sites/vhost').confPath(s.domain))) continue;
    try { await require('./sites/procs').act(s, 'stop', {}); } catch (_) {}
    try { require('./sites/hold').set(s.domain, 'cluster move → ' + mv.name); } catch (_) {}
    const r = await retireVhost(s);
    events.emit('cluster.move', { user: 'system', site: s.domain, level: r.ok ? 'warn' : 'error', message: r.ok ? s.domain + ' was moved to ' + mv.name + ' — its vhost here is now disabled' : 'could not disable the vhost of moved ' + s.domain + ': ' + r.error });
  }
}
if (!process.env.RHC_NO_JOBS) { setTimeout(() => enforceMoved().catch(() => {}), 90_000).unref(); setInterval(() => enforceMoved().catch(() => {}), 3600_000).unref(); }

// ------------------------------------------------------------------ target
// Incoming transfers need a human on the target: the first preflight for a site registers a
// request (and alerts Telegram/Slack); the source keeps asking until it is accepted or rejected.
// An acceptance covers that site from that source for one hour.
const phpInstalls = new Map();   // PHP version → App Store job (one install for all sites of a batch)
const requests = new Map();      // id → { id, from, fromId, domain, type, php, state, at, decidedBy }
function incoming() { const now = Date.now(); for (const [k, r] of requests) if (now - Date.parse(r.at) > 6 * 3600_000) requests.delete(k); return [...requests.values()].reverse(); }
// One batch (several sites from the same source at once) = one alert; decided site by site or all at once.
function decideBatch(batchId, accept, who) {
  const list = [...requests.values()].filter((r) => r.batch === batchId && r.state === 'pending');
  if (!list.length) throw bad('nothing waiting in this batch', 404);
  for (const r of list) decide(r.id, accept, who);
  return { batch: batchId, state: accept ? 'accepted' : 'rejected', domains: list.map((r) => r.domain), from: list[0].from };
}
function decide(id, accept, who) {
  const r = requests.get(id); if (!r) throw bad('no such request', 404);
  if (r.state !== 'pending') throw bad('already ' + r.state, 409);
  r.state = accept ? 'accepted' : 'rejected'; r.decidedBy = who || null; r.decidedAt = new Date().toISOString();
  return r;
}
async function preflightFrom(b, fromPeer) {
  const pf = preflight(b);
  if (b.viaDns && !b.ownCfToken) {        // checked even when other problems exist: report them all at once
    // the DNS switch happens at the very end — find out now whether this server may do it
    const cf = require('./cloudflare');
    try {
      const zone = cf.zoneFor(b.domain, await cf.zones());
      const me = require('./cluster').self().name;
      if (!zone) pf.problems.push('the Cloudflare token of ' + me + ' cannot see the zone of ' + b.domain + ' — in the Cloudflare dashboard give that token access to the zone (or its account), or set a Cloudflare token on this site (Cloudflare tab) on the source');
      else { try { await cf.api('/zones/' + zone.id + '/dns_records?per_page=1'); } catch (e) { pf.problems.push('the Cloudflare token of ' + me + ' may not edit DNS of ' + zone.name + ' — in the Cloudflare dashboard (My Profile → API Tokens) give that token Zone → DNS → Edit for ' + zone.name + ' or all zones'); } }
    } catch (e) { pf.problems.push('Cloudflare: ' + e.message); }
    pf.ok = !pf.problems.length;
  }
  if (!pf.ok || b.checkOnly) return pf;                     // problems first — and a readiness check never creates a request
  const key = fromPeer.id + '|' + b.domain;
  let r = [...requests.values()].find((x) => x.key === key && (x.state === 'pending' || (x.state !== 'pending' && Date.now() - Date.parse(x.decidedAt || x.at) < 3600_000)));
  if (!r) {
    const batchId = b.batch && /^[0-9a-f]{8,32}$/.test(String(b.batch.id)) ? crypto.createHash('sha1').update(fromPeer.id + ':' + b.batch.id).digest('hex').slice(0, 16) : null;
    const firstOfBatch = !batchId || ![...requests.values()].some((x) => x.batch === batchId);
    r = { id: crypto.randomBytes(6).toString('hex'), key, from: fromPeer.name, fromId: fromPeer.id, domain: b.domain, type: b.type, php: b.phpVersion || null, viaDns: !!b.viaDns, state: 'pending', at: new Date().toISOString(), batch: batchId };
    requests.set(r.id, r);
    const many = batchId && Array.isArray(b.batch.domains) ? b.batch.domains.map(String).slice(0, 50) : null;
    if (many && many.length > 1) {
      if (firstOfBatch) {
        events.emit('cluster.request', { user: 'cluster:' + fromPeer.name, level: 'warn', message: fromPeer.name + ' wants to move ' + many.length + ' sites to this server (' + many.join(', ') + ') — accept them on the Transfer page' });
        try { require('./notify').send('📥 *Incoming site transfer*\n`' + fromPeer.name + '` wants to move ' + many.length + ' sites to this server:\n' + many.map((d) => '• `' + d + '`').join('\n') + '\nAccept them (all or site by site) on the Transfer page.', 'site').catch(() => {}); } catch (_) {}
      }
    } else {
    events.emit('cluster.request', { user: 'cluster:' + fromPeer.name, site: b.domain, level: 'warn', message: fromPeer.name + ' wants to move ' + b.domain + ' to this server — accept or reject it on the Transfer page' });
    try { require('./notify').send('📥 *Incoming site transfer*\n`' + fromPeer.name + '` wants to move `' + b.domain + '` (' + b.type + (b.phpVersion ? ', PHP ' + b.phpVersion : '') + ') to this server.\nAccept or reject it on the Transfer page.', 'site').catch(() => {}); } catch (_) {}
    }
  }
  if (r.state === 'pending') return { ok: false, pending: true, requestId: r.id, problems: [] };
  if (r.state === 'rejected') return { ok: false, rejected: true, problems: ['rejected on ' + require('./cluster').self().name] };
  if (pf.needPhp) {
    const store = require('./appstore');
    if (!r.phpJob && phpInstalls.has(pf.needPhp) && store.getJob(phpInstalls.get(pf.needPhp)).state !== 'failed') r.phpJob = phpInstalls.get(pf.needPhp);
    if (!r.phpJob) { r.phpJob = store.run('install', 'php', pf.needPhp, 'transfer from ' + fromPeer.name).id; phpInstalls.set(pf.needPhp, r.phpJob); events.emit('cluster.request', { user: 'cluster:' + fromPeer.name, site: b.domain, message: 'Installing PHP ' + pf.needPhp + ' for the incoming ' + b.domain }); }
    const j = store.getJob(r.phpJob);
    if (j.state === 'failed') { r.phpJob = null; return { ok: false, problems: ['installing PHP ' + pf.needPhp + ' on ' + require('./cluster').self().name + ' failed: ' + (j.error || '') + ' — see its App Store log'] }; }
    return { ok: false, pending: true, message: 'installing PHP ' + pf.needPhp + ' on ' + require('./cluster').self().name + ' (' + j.state + ', ' + j.log.length + ' log lines)', problems: [] };
  }
  return pf;
}
// Problems block a move; notes are what the target will do by itself (e.g. install the PHP version).
// Messages name this server ("on sbapps01") — they are read on the SOURCE's screen.
function preflight(b) {
  const problems = [], notes = [];
  const me = 'on ' + require('./cluster').self().name;
  const store = require('./sites/store'), users = require('./sites/users');
  if (store.get(b.domain)) problems.push(b.domain + ' already exists ' + me);
  for (const h of b.homes || []) if (users.getent(h) || fs.existsSync('/home/' + h)) problems.push('unix user/home ' + h + ' already exists ' + me);
  if (!['nodejs', 'python', 'static', 'php', 'reverse-proxy'].includes(b.type)) problems.push('unsupported site type ' + b.type);
  if (b.port) { const lp = require('./util').listeningPorts(); if (lp.has(Number(b.port)) || store.usedPorts().has(Number(b.port))) problems.push('port ' + b.port + ' is in use ' + me); }
  try { const s = fs.statfsSync('/'); if (s.bavail * s.bsize < 5 * 1024 ** 3) problems.push('less than 5 GB free ' + me); } catch (_) {}
  if (!fs.existsSync('/usr/bin/cloudflared')) problems.push('cloudflared is not installed ' + me + ' — install it on its Tunnels page');
  let needPhp = null;
  if (b.phpVersion && !require('./sites/php').listVersions().includes(String(b.phpVersion))) {
    const offered = (require('./appstore').ITEMS.find((x) => x.id === 'php') || { versions: [] }).versions;
    if (offered.includes(String(b.phpVersion))) { needPhp = String(b.phpVersion); notes.push('PHP ' + b.phpVersion + ' will be installed ' + me + ' automatically before the transfer'); }
    else problems.push('PHP ' + b.phpVersion + ' is not installed ' + me + ' and not offered by its App Store');
  }
  for (const e of b.dbEngines || []) {
    if (/^(pg|postgres)/i.test(e) && !fs.existsSync('/usr/bin/psql')) problems.push('PostgreSQL is not installed ' + me + ' — install it from its App Store → Databases');
    if (/^(my|maria)/i.test(e) && !fs.existsSync('/usr/sbin/mariadbd') && !fs.existsSync('/usr/sbin/mysqld')) problems.push('MariaDB is not installed ' + me + ' — install it from its App Store → Databases');
  }
  if (b.viaDns && !require('./cloudflare').configured()) problems.push('no Cloudflare API token ' + me + ' (its Settings → Cloudflare) — needed to publish the site and take over its DNS');
  return { ok: !problems.length, problems, notes, needPhp };
}
// Leftovers of uploads that never finished (source failed or gave up): removed after 6 hours.
function sweepStage() {
  try {
    for (const d of fs.readdirSync(STAGE)) {
      const f = path.join(STAGE, d), id = d.replace(/^in-/, '');
      const j = jobs.get(id) || jobs.get('recv-' + id);
      if (j && (j.state === 'running' || j.state === 'imported')) continue;
      if (Date.now() - fs.statSync(f).mtimeMs > 6 * 3600_000) fs.rmSync(f, { recursive: true, force: true });
    }
  } catch (_) {}
}
setInterval(sweepStage, 3600_000).unref(); setTimeout(sweepStage, 60_000).unref();
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
      await restore(m, dir, say).catch(async (e) => { await undoRestore(m, say); throw e; });
      job.manifestTunnel = m.tunnel;
      job.state = 'imported'; job.phase = 'wait-cutover'; job.progress = 90;
    } catch (e) { job.state = 'failed'; job.error = e.message + (e.detail ? ': ' + e.detail : ''); say('FAILED: ' + job.error); }
    finally { job.finished = new Date().toISOString(); }
  })();
  return { started: true };
}

// Several imports run at once; steps that touch shared config (site creation, nginx, sshd, tunnels/DNS)
// take turns.
let shared = Promise.resolve();
function serial(fn) { const run = shared.then(fn, fn); shared = run.catch(() => {}); return run; }
async function restore(m, dir, say) {
  const store = require('./sites/store'), create = require('./sites/create'), users = require('./sites/users');
  const pf = preflight({ domain: m.domain, homes: m.homes, type: m.type, port: m.port });
  if (!pf.ok) throw bad(pf.problems.join('; '), 409);
  const row = reencrypt(m.row);
  const password = row.user_password_enc ? secrets.decrypt(row.user_password_enc) : undefined;
  const nodejs = (m.tables.site_nodejs || [])[0], python = (m.tables.site_python || [])[0];
  // 1. the site, through the normal create path — no tunnel, no repo, no extra db (they come from the bundle)
  const r = await serial(() => create.createSite({ domain: m.domain, type: m.type, user: m.user, password, port: m.port || undefined, cf_only: row.cf_only,
    node_version: nodejs ? require('./sites/nodever').LATEST : undefined, python_version: python ? python.python_version : undefined, php_version: ((m.tables.site_php || [])[0] || {}).php_version || undefined, reverse_proxy_url: row.reverse_proxy_url || undefined,
    tunnel: false, github: false, sqlite: false, claude: false }));
  m.createdHere = true;
  say('created ' + m.domain + ' here', 'user ' + r.user);
  const site = store.get(m.domain);
  // 2. extra SSH users (their homes come from the tar)
  for (const u of reencrypt(m.tables.ssh_users || [])) {
    try {
      const pw = u.password_enc ? secrets.decrypt(u.password_enc) : secrets.generatePassword(20);
      await users.createSshUser(site, u.username, pw, u.ssh_keys || '');
      store.sshUsers.insert({ site_id: site.id, username: u.username, ssh_keys: u.ssh_keys || null, password_enc: secrets.encrypt(pw) });
      say('created SSH user ' + u.username);
    }
    catch (e) { say('could not create SSH user ' + u.username, e.message); }
  }
  // 3. the homes, over what create made (pm2 placeholder etc.)
  const asU = (cmd) => execP('sudo', ['-n', '-H', '-u', site.user, 'bash', '-lc', cmd], { timeout: 30 * 60_000 });
  // no pm2 daemon may run while its home is replaced, and the source's pm2 runtime files (pid file,
  // sockets — bundles from sources before the exclude fix carry them) must not survive the unpack:
  // a foreign pm2.pid makes the panel think this user's daemon is dead.
  for (const h of m.homes) await execP('sudo', ['-n', '-H', '-u', h, 'bash', '-lc', 'PM2_HOME=/home/' + h + '/.pm2 pm2 kill >/dev/null 2>&1; true'], { timeout: 60_000 }).catch(() => {});
  const x = await execP('tar', ['-xzf', path.join(dir, 'homes.tar.gz'), '-C', '/home'], { timeout: 60 * 60_000 });
  if (x.err) throw bad('unpacking the homes failed', 500, x.stderr);
  for (const h of m.homes) {
    const pm = path.join('/home', h, '.pm2');
    try { for (const f of fs.readdirSync(pm)) if (/\.(pid|sock)$/.test(f)) fs.rmSync(path.join(pm, f), { force: true }); } catch (_) {}
    try { fs.rmSync(path.join(pm, 'pids'), { recursive: true, force: true }); } catch (_) {}
  }
  say('unpacked ' + m.homes.map((h) => '/home/' + h).join(', '));
  // the tar replaced the site's log files that nginx already had open — make nginx open the new ones
  await execP('nginx', ['-s', 'reopen'], { timeout: 30_000 });
  // 4. rows keyed by site_id (replacing what create inserted), site columns, per-site kv, certificate, cron
  // `databases` rows are not copied: their server_id points at the SOURCE's database_servers
  // (FOREIGN KEY failure here) — step 5 creates them again against this server's own DB servers.
  const db = open();
  db.exec('BEGIN');
  try {
    for (const [t, rows] of Object.entries(reencrypt(m.tables))) {
      if (t === 'ssh_users' || t === 'databases') continue;
      const cols = db.prepare('PRAGMA table_info(' + JSON.stringify(t) + ')').all().map((c) => c.name);
      if (!cols.includes('site_id')) continue;
      db.prepare('DELETE FROM ' + JSON.stringify(t) + ' WHERE site_id = ?').run(site.id);
      for (const r0 of rows) {
        if (t === 'site_nodejs' && 'node_version' in r0) r0.node_version = require('./sites/nodever').LATEST;   // a moved site always runs on the latest (system) Node
        const keys = Object.keys(r0).filter((k) => cols.includes(k));
        try { db.prepare('INSERT INTO ' + JSON.stringify(t) + ' (site_id, ' + keys.map((k) => JSON.stringify(k)).join(', ') + ') VALUES (?' + ', ?'.repeat(keys.length) + ')').run(site.id, ...keys.map((k) => r0[k])); }
        catch (e) { e.message = 'restoring ' + t + ': ' + e.message; throw e; }
      }
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
  const keep = ['vhost_template', 'varnish_cache', 'cf_only', 'pagespeed_enabled', 'pagespeed_settings', 'ssh_keys', 'root_dir', 'application', 'vhost_source'];
  store.update(site.id, Object.fromEntries(keep.filter((k) => k in row).map((k) => [k, row[k]])));
  for (const [k, v] of Object.entries(reencrypt(m.kv))) if (!k.startsWith('tunnel.site:')) settings.set(k, v);
  if (m.cert && m.cert.crt && m.cert.key) { fs.writeFileSync('/etc/nginx/ssl-certificates/' + m.domain + '.crt', m.cert.crt); fs.writeFileSync('/etc/nginx/ssl-certificates/' + m.domain + '.key', m.cert.key, { mode: 0o600 }); }
  const fresh = store.get(m.domain);
  const vh = require('./sites/vhost'); const w = await serial(() => vh.writeWithRollback(fresh, vh.render(fresh)));
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
    await rt.pm2Startup(fresh.user, require('./sites/nodever').LATEST).catch(() => {});
    say(s.err ? 'starting the app under pm2 FAILED' : 'started the app under pm2', s.err ? (s.stderr || '').slice(-300) : '');
  }
  await serial(() => require('./whitelist').apply()).catch(() => {});
  if (m.port) {
    let ok = false; for (let i = 0; i < 30 && !ok; i++) { await new Promise((z) => setTimeout(z, 2000)); ok = require('./util').listeningPorts().has(Number(m.port)); }
    if (!ok) throw bad('the app does not listen on port ' + m.port + ' here — not taking over the tunnel');
    say('the app listens on port ' + m.port);
  }
}

// A failed import removes what it made here (site, unix/SSH users, homes, databases, vhost) so the
// source can simply retry — the site keeps running on the source, nothing was cut over yet.
async function undoRestore(m, say) {
  const site = m.createdHere && require('./sites/store').get(m.domain);
  if (!site) return;
  try {
    const r = await serial(() => require('./sites/create').deleteSite(site, {}));
    say('removed the partly imported ' + m.domain + ' here — a retry can start clean', r.errors.length ? 'left over: ' + r.errors.join('; ') : '');
  } catch (e) { say('could not remove the partly imported ' + m.domain + ' here', e.message); }
}

// Target: install and start the site's tunnel (same token → same tunnel, DNS unchanged).
function cutover(id) { return serial(() => cutoverNow(id)); }
async function cutoverNow(id) {
  const job = jobs.get(id);
  if (!job || job.role !== 'target' || job.state !== 'imported') throw bad('no imported site waiting for its tunnel under this transfer', 409);
  if (!job.manifestTunnel) {
    const site = require('./sites/store').get(job.domain);
    const steps = [];
    const rec = await require('./sites/tunnel').publish(site, (a, d) => steps.push(d ? a + ' — ' + d : a), { takeoverDns: true });
    job.state = 'live'; job.phase = 'done'; job.progress = 100;
    for (const s of steps) job.steps.push({ at: new Date().toISOString(), text: s });
    if (!settings.get('site.github:' + job.domain, null)) {
      require('./sites/github').connect(site, (a, d) => job.steps.push({ at: new Date().toISOString(), text: 'GitHub: ' + (d ? a + ' — ' + d : a) }))
        .catch((e) => job.steps.push({ at: new Date().toISOString(), text: 'GitHub: could not connect — ' + e.message + ' (connect it on the site\'s GitHub tab)' }));
    }
    try { fs.rmSync(path.join(STAGE, 'in-' + id), { recursive: true, force: true }); } catch (_) {}
    try { require('./kuma').syncSoon(); } catch (_) {}
    return { ok: true, detail: 'published through its own tunnel ' + (rec.tunnelName || '') + ' here; DNS: ' + steps.filter((s) => /DNS/.test(s)).join('; ') };
  }
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

// Target, after the source stopped its copy: prove the site answers from HERE — fetch
// https://<domain>/?sb-verify=<nonce> through the public internet and find that nonce in this site's
// nginx access log; also check its DNS records point to this server's tunnel.
async function verifyLive(id) {
  const j = jobs.get(id);
  if (!j || j.role !== 'target' || j.state !== 'live') throw bad('no live site under this transfer', 409);
  const site = require('./sites/store').get(j.domain); if (!site) throw bad('site not found here', 404);
  const me = require('./cluster').self().name;
  const nonce = crypto.randomBytes(8).toString('hex');
  const logFile = '/home/' + site.user + '/logs/nginx/access.log';
  let http = null, seen = false;
  for (let i = 0; i < 8 && !seen; i++) {
    if (i) await new Promise((z) => setTimeout(z, 5000));
    try {
      const r = await fetch('https://' + j.domain + '/?sb-verify=' + nonce + '-' + i, { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 sb-srv-mon-verify' } });
      http = r.status; await r.arrayBuffer().catch(() => {});
    } catch (e) { http = e.cause && e.cause.code || e.message; }
    await new Promise((z) => setTimeout(z, 1500));
    try { const st = fs.statSync(logFile); const fd = fs.openSync(logFile, 'r'); const len = Math.min(st.size, 512 * 1024); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); seen = b.toString().includes('sb-verify=' + nonce); } catch (_) {}
  }
  // DNS → this server's tunnel?
  let dns = '';
  try {
    const t = settings.get('tunnel.site:' + j.domain, null);
    if (t && t.tunnelId && t.zoneId) {
      const cf = require('./cloudflare');
      const recs = (await cf.api('/zones/' + t.zoneId + '/dns_records?per_page=100')).result.filter((x) => (t.hosts || [j.domain]).includes(x.name) && ['A', 'AAAA', 'CNAME'].includes(x.type));
      const bad2 = recs.filter((x) => x.content !== t.tunnelId + '.cfargotunnel.com');
      dns = bad2.length ? '; DNS still has ' + bad2.map((x) => x.type + ' ' + x.name + ' → ' + x.content).join(', ') : '; DNS ' + recs.map((x) => x.name).join(', ') + ' → tunnel of ' + me;
    }
  } catch (_) {}
  const ok = seen && !/DNS still/.test(dns);
  const detail = (seen ? 'https://' + j.domain + ' answered HTTP ' + http + ' and the request reached the nginx of ' + me : 'a request to https://' + j.domain + ' (HTTP ' + http + ') did not show up in the nginx log of ' + me) + dns;
  j.steps.push({ at: new Date().toISOString(), text: (ok ? 'confirmed: ' : 'not confirmed: ') + detail });
  return { confirmed: ok, http, seen, detail };
}

function job(id) { const j = jobs.get(id); if (!j) throw bad('unknown transfer', 404); return { id: j.id, role: j.role, domain: j.domain, peer: j.peer, from: j.from, state: j.state, phase: j.phase || null, progress: j.progress, detail: j.detail || null, remote: j.remote || null, verify: j.verify || null, steps: j.steps, error: j.error, started: j.started, finished: j.finished }; }
function list() { return [...jobs.values()].map((j) => job(j.id)).reverse(); }

module.exports = { verifyLive, enforceMoved, precheck, incoming, decide, decideBatch, preflightFrom, manifest, preflight, receiveChunk, startImport, cutover, startMove, job, list, plainify, reencrypt, aesEncrypt, aesDecrypt, siteTables };
