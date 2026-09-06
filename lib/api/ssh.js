'use strict';
// Router-based SSH endpoints (the rest still live in the legacy dispatcher in server.js).
//   DELETE /api/ssh/installs      → forget every finished install (running ones stay)
//   DELETE /api/ssh/install/:id   → forget one entry
// Retrying an install re-uses POST /api/ssh/install: the UI reopens the install dialog with the
// failed job's options so the sudo password (never stored) can be entered again.
const router = require('../http');
const ssh = require('../ssh');
const events = require('../events');

router.add('DELETE', '/api/ssh/installs', { perm: 'ssh.write' }, (ctx) => {
  const r = ssh.clearInstallLog();
  events.emit('ssh.install.clear', { req: ctx.req, message: 'Install history cleared (' + r.removed + ' entr' + (r.removed === 1 ? 'y' : 'ies') + ')' });
  return Object.assign({ ok: true }, r);
});
router.add('DELETE', '/api/ssh/install/:id', { perm: 'ssh.write' }, (ctx) => {
  const job = ssh.sshFindJob(ctx.params.id);
  const r = ssh.removeInstallJob(ctx.params.id);
  if (r.removed) events.emit('ssh.install.clear', { req: ctx.req, target: job && (job.hostName || job.target), message: 'Install entry removed (' + ((job && job.hostName) || ctx.params.id) + ')' });
  return Object.assign({ ok: true }, r);
});
