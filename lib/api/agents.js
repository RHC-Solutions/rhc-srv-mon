'use strict';
// AI agents API (Updates → AI agents). Deploys run as background jobs (installers take minutes).
const crypto = require('crypto');
const fs = require('fs');
const router = require('../http');
const { httpError, readJson, actorOf } = router;
const events = require('../events');
const agents = require('../agents');

const jobs = new Map();
let chain = Promise.resolve();      // deploys run one after another
function deployTargets() {
  const out = new Set(['root']);
  try { for (const s of require('../sites/store').list()) out.add(s.user); } catch (_) {}
  try { for (const u of require('../sites/store').sshUsers.all()) out.add(u.username); } catch (_) {}
  try { for (const h of fs.readdirSync('/home')) if (require('../sites/users').getent(h)) out.add(h); } catch (_) {}
  return [...out].filter((u) => u !== 'clp').sort((a, b) => (a === 'root' ? -1 : b === 'root' ? 1 : a.localeCompare(b)));
}
router.add('GET', '/api/agents', { perm: 'settings.read' }, () => {
  const t = new Set(agents.tracked());
  return { agents: [{ key: 'claude', label: 'Claude Code', bin: 'claude', pkg: '@anthropic-ai/claude-code', vendor: 'Anthropic', builtin: true, tracked: true, always: true },
    ...agents.all().map((a) => Object.assign({}, a, { tracked: t.has(a.key) || !!a.custom }))], users: deployTargets(), jobs: [...jobs.values()].slice(-10).reverse() };
});
router.add('PUT', '/api/agents/tracked', { perm: 'settings.write' }, async (ctx) => {
  const keys = agents.setTracked((await readJson(ctx.req)).keys);
  events.emit('settings.save', { req: ctx.req, target: 'agents', message: 'Tracked AI agents: ' + (keys.join(', ') || 'none besides Claude Code') });
  require('../updates').collectUpdates().catch(() => {});
  return { keys };
});
router.add('POST', '/api/agents/custom', { perm: 'settings.write' }, async (ctx) => {
  const a = agents.addCustom(await readJson(ctx.req));
  events.emit('settings.save', { req: ctx.req, target: 'agents', message: 'Custom AI agent added: ' + a.label + ' (' + (a.pkg || a.installCmd) + ')' });
  require('../updates').collectUpdates().catch(() => {});
  return a;
});
router.add('DELETE', '/api/agents/custom/:key', { perm: 'settings.write' }, (ctx) => {
  agents.removeCustom(ctx.params.key);
  events.emit('settings.save', { req: ctx.req, target: 'agents', level: 'warn', message: 'Custom AI agent removed from the list: ' + ctx.params.key + ' (installed copies stay)' });
  require('../updates').collectUpdates().catch(() => {});
  return { ok: true };
});
router.add('POST', '/api/agents/:key/deploy', { perm: 'settings.write' }, async (ctx) => {
  const key = ctx.params.key;
  if (key !== 'claude' && !agents.find(key)) throw httpError(404, 'unknown agent');
  const b = await readJson(ctx.req);
  const allowed = new Set(deployTargets());
  const users = [...new Set((b.users || []).map(String))];
  if (!users.length || users.some((u) => !allowed.has(u))) throw httpError(400, 'pick users from the list');
  const label = key === 'claude' ? 'Claude Code' : agents.find(key).label;
  const job = { id: crypto.randomBytes(6).toString('hex'), key, label, users, state: 'running', results: [], started: new Date().toISOString() };
  jobs.set(job.id, job);
  const actor = actorOf(ctx.req);
  job.state = 'queued';
  chain = chain.then(async () => {
    job.state = 'running';
    for (const u of users) {
      job.current = u; job.currentSince = new Date().toISOString();
      const r = await agents.install(key, u).catch((e) => ({ ok: false, user: u, output: e.message }));
      job.results.push(r);
      events.emit('agents.deploy', Object.assign({ user: 'system' }, actor, { target: u + '/' + key, level: r.ok ? 'info' : 'error', message: (r.ok ? 'Deployed ' : 'Deploy failed: ') + label + ' for ' + u + (r.version ? ' (' + r.version + ')' : ''), data: { output: String(r.output || '').slice(0, 800) } }));
    }
    job.state = 'done'; job.current = null; job.finished = new Date().toISOString();
    require('../updates').collectUpdates().catch(() => {});
  }).catch(() => {});
  return job;
});
router.add('GET', '/api/agents/jobs/:id', { perm: 'settings.read' }, (ctx) => { const j = jobs.get(ctx.params.id); if (!j) throw httpError(404, 'unknown job'); return j; });
