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

// RDP: each viewer gets a throwaway X display on this server with xfreerdp drawing into it, which is
// then served as VNC. Opening returns the id the viewer connects to (rdp:<display>).
router.add('GET', '/api/ssh/rdp', { perm: 'ssh.read' }, () => {
  const rdp = require('../rdp');
  return Object.assign({ sessions: rdp.list() }, rdp.ready());
});
router.add('POST', '/api/ssh/hosts/:id/rdp', { perm: 'ssh.write' }, async (ctx) => {
  const rdp = require('../rdp');
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  if ((h.protocol || 'ssh') !== 'rdp') throw httpError(400, 'not an RDP host');
  const lines = [];
  const sess = await rdp.startSession(h, (m) => { lines.push(m); if (lines.length > 200) lines.shift(); });
  sess.log = lines;
  events.emit('rdp.open', { req: ctx.req, target: h.name, message: 'RDP session opened for ' + h.name + ' (' + sess.target + ' on display :' + sess.display + ')' });
  return { id: 'rdp:' + sess.display, display: sess.display, password: sess.vncPw, target: sess.target, geometry: rdp.targetOf(h).geometry };
});
router.add('DELETE', '/api/ssh/rdp/:display', { perm: 'ssh.write' }, (ctx) => {
  const rdp = require('../rdp');
  const s = rdp.get(ctx.params.display);
  const ok = rdp.stop(ctx.params.display);
  if (ok && s) events.emit('rdp.close', { req: ctx.req, target: s.hostName, message: 'RDP session closed (' + s.target + ')' });
  return { ok };
});
router.add('GET', '/api/ssh/rdp/:display/log', { perm: 'ssh.read' }, (ctx) => {
  const s = require('../rdp').logOf(ctx.params.display);
  if (!s) throw httpError(404, 'no such session');
  return { display: s.display, target: s.target, startedAt: s.startedAt, endedAt: s.endedAt || null, finished: !!s.finished, error: s.err || null, log: s.log || [] };
});

// Deploy a VNC server on a host over SSH (packages, password file, systemd unit, loopback only).
router.add('POST', '/api/ssh/hosts/:id/deploy-vnc', { perm: 'ssh.write' }, async (ctx) => {
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  const b = await router.readJson(ctx.req);
  if (!require('../vnc-passwd').available()) throw httpError(409, 'this server cannot build a VNC password file (openssl legacy provider missing)');
  const job = ssh.sshStartVncInstall(ctx.params.id, b);
  events.emit('vnc.deploy', { req: ctx.req, target: h.name, message: 'VNC server deployment started on ' + h.name + ' (display :' + job.opts.display + ', ' + job.opts.desktop + ')', data: { jobId: job.id, opts: job.opts } });
  return { ok: true, jobId: job.id, password: job.password, display: job.opts.display, port: 5900 + job.opts.display };
});

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
  const mode = ctx.query.get('mode') === 'kill' ? 'kill' : 'hangup';
  const r = await ssh.sshKillRemoteSession(h, ctx.params.pid, mode);
  events.emit('ssh.session.disconnect', { req: ctx.req, target: h.name, level: r.ok ? 'warn' : 'error',
    message: (r.ok ? (mode === 'kill' ? 'Killed' : 'Disconnected') : 'Could not disconnect') + ' ssh session pid ' + r.pid + ' on ' + h.name + (mode === 'kill' ? ' (session scope terminated)' : ''), data: r });
  if (!r.ok) throw httpError(502, 'the session did not go away' + (r.output ? ': ' + r.output : ''));
  return r;
});
// Disconnect every login except the ones this panel makes (its probe and open terminals).
router.add('POST', '/api/ssh/hosts/:id/sessions/disconnect-all', { perm: 'ssh.write' }, async (ctx) => {
  const h = ssh.sshFindHost(ctx.params.id);
  if (!h) throw httpError(404, 'unknown host');
  const dryRun = ctx.query.get('dryRun') === '1';
  const mode = ctx.query.get('mode') === 'kill' ? 'kill' : 'hangup';
  const r = await ssh.sshDisconnectOthers(h, { dryRun, mode });
  if (dryRun) return r;
  const n = (r.results || []).filter((x) => x.ok).length;
  events.emit('ssh.session.disconnect', { req: ctx.req, target: h.name, level: 'warn',
    message: (mode === 'kill' ? 'Killed ' : 'Disconnected ') + n + ' of ' + (r.targets || []).length + ' ssh session(s) on ' + h.name
      + (r.kept ? ', kept ' + r.kept + ' from this panel' : '') + ((r.skippedEnded || []).length ? ', skipped ' + r.skippedEnded.length + ' already ended' : ''), data: r });
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
