'use strict';
// Router-based SSH endpoints (the rest still live in the legacy dispatcher in server.js).
//   DELETE /api/ssh/installs      → forget every finished install (running ones stay)
//   DELETE /api/ssh/install/:id   → forget one entry
// Retrying an install re-uses POST /api/ssh/install: the UI reopens the install dialog with the
// failed job's options so the sudo password (never stored) can be entered again.
const router = require('../http');
const { httpError } = router;
const ssh = require('../ssh');
const events = require('../events');

// The VNC password is handed to the browser so noVNC can answer the RFB challenge; the panel session
// is already authenticated, and the same page can reveal site/SSH passwords.
router.add('GET', '/api/ssh/hosts/:id/vnc', { perm: 'ssh.write' }, async (ctx) => {
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  if ((h.protocol || 'ssh') !== 'vnc') throw httpError(400, 'not a VNC host');
  const vnc = require('../vnc');
  const t = vnc.targetOf(h);
  // check the target first so a failure is reported with its reason instead of a dead viewer
  if (ctx.query.get('probe') !== '0') {
    const p = await vnc.probe(h);
    if (!p.ok) throw httpError(502, 'cannot reach ' + t.host + ':' + t.port + (t.tunnel ? ' through ssh ' + (h.user || 'root') + '@' + h.host : '') + ' — ' + p.error);
  }
  events.emit('vnc.open', { req: ctx.req, target: h.name, message: 'VNC viewer opened for ' + h.name + ' (' + (t.tunnel ? 'through ssh ' : 'direct ') + t.host + ':' + t.port + ')' });
  return { password: h.vncPassword || '', viewOnly: !!h.vncViewOnly, target: t };
});

// Live SSH logins on a remote host + disconnect. GET is a live ssh probe, so it is never polled
// automatically — the UI asks for it when the panel is opened or refreshed.
router.add('GET', '/api/ssh/hosts/:id/sessions', { perm: 'ssh.read' }, async (ctx) => {
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  const r = await ssh.sshRemoteSessions(h);
  return Object.assign({ host: h.name, target: (h.user || 'root') + '@' + h.host }, r);
});
router.add('POST', '/api/ssh/hosts/:id/sessions/:pid/disconnect', { perm: 'ssh.write' }, async (ctx) => {
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  const r = await ssh.sshKillRemoteSession(h, ctx.params.pid);
  events.emit('ssh.session.disconnect', { req: ctx.req, target: h.name, level: r.ok ? 'warn' : 'error',
    message: (r.ok ? 'Disconnected' : 'Could not disconnect') + ' ssh session pid ' + r.pid + ' on ' + h.name, data: r });
  if (!r.ok) throw httpError(502, 'the session did not go away' + (r.output ? ': ' + r.output : ''));
  return r;
});
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
