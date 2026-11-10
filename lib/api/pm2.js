'use strict';
// Monitor tab: start / stop / restart one pm2 app of one user.
// The user and the app must be ones the Monitor itself lists (history.getLatest()) — the pm2 home
// comes from that list, never from the request — and pm2 runs without a shell, so a crafted name
// cannot become a command. (The old handler in server.js built `sh -c "… pm2 <cmd> <app>"` from
// the URL: CodeQL "uncontrolled command line".)
const path = require('path');
const { execFile } = require('child_process');
const router = require('../http');
const events = require('../events');
const history = require('../history');

const ACTIONS = { start: 'start', stop: 'stop', restart: 'restart' };

router.add('POST', '/api/pm2/:action/:user/:app', { perm: 'sites.write' }, (ctx) => {
  const cmd = ACTIONS[ctx.params.action];
  if (!cmd) throw Object.assign(new Error('action must be start, stop or restart'), { status: 400 });
  const groups = history.getLatest() || [];
  const g = groups.find((x) => x.user === ctx.params.user && x.pm2_home);
  if (!g) throw Object.assign(new Error('no pm2 daemon of user ' + ctx.params.user + ' is being monitored'), { status: 404 });
  const app = (g.processes || []).find((p) => p.name === ctx.params.app);
  if (!app) throw Object.assign(new Error('user ' + g.user + ' has no pm2 app called ' + ctx.params.app), { status: 404 });
  return new Promise((resolve) => {
    // -H and an accessible cwd matter: pm2 spawns the app from its own cwd, and this process runs
    // from /root (0700), so an inherited cwd makes the app's `spawn node` fail with EACCES.
    execFile('sudo', ['-n', '-H', '-u', g.user, 'env', 'PM2_HOME=' + g.pm2_home, 'pm2', cmd, app.name],
      { timeout: 30000, cwd: path.dirname(g.pm2_home) },
      (err, stdout, stderr) => {
        const output = ((stdout || '') + (stderr || '')).trim();
        events.emit('pm2.' + cmd, { req: ctx.req, target: g.user + '/' + app.name, level: err ? 'error' : 'info', message: 'pm2 ' + cmd + ' ' + app.name + ' (' + g.user + ')' + (err ? ' failed' : ''), data: err ? { output: output.slice(0, 1000) } : undefined });
        resolve({ action: cmd, user: g.user, app: app.name, success: !err, output });
      });
  });
});
