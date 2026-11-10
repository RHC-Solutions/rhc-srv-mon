'use strict';
// The panel itself (left menu → Panel): restart and stop from the browser. Start is not here — a
// stopped panel serves no page; `sbctl start` on the server does that.
// pm2 restart/stop kills this very process, so the command is handed to a transient systemd unit
// (same as the self-update in lib/updates.js) and runs a second after the reply has gone out.
const { execFile } = require('child_process');
const router = require('../http');
const { readJson } = router;
const events = require('../events');

const pm2Name = () => (process.env.pm_id !== undefined ? process.env.name : null);
const tell = (text) => { try { require('../notify').send(text, 'complete').catch(() => {}); } catch (_) {} };
const actor = (ctx) => (router.actorOf(ctx.req).user || 'local');
function handOff(action) {
  return new Promise((resolve, reject) => execFile('systemd-run', ['--unit=rhc-panel-' + action + '-' + Date.now(), '--collect', '--quiet', '--setenv=HOME=/root', '--setenv=PATH=' + process.env.PATH,
    'sh', '-c', 'sleep 1; pm2 ' + action + ' "$1" --update-env >/dev/null 2>&1', 'sh', pm2Name()], { timeout: 10000 }, (err, so, se) => (err ? reject(Object.assign(new Error('systemd-run failed: ' + (se || err.message).trim()), { status: 500 })) : resolve())));
}

router.add('GET', '/api/panel', { perm: 'settings.read' }, () => ({ pm2: pm2Name(), pid: process.pid, uptime_s: Math.round(process.uptime()), node: process.version }));
router.add('POST', '/api/panel/restart', { perm: 'settings.write' }, async (ctx) => {
  if (!pm2Name()) throw Object.assign(new Error('the panel is not running under pm2 — restart it by hand'), { status: 409 });
  const b = await readJson(ctx.req).catch(() => ({}));
  if (!b.force) {
    const r = require('../selfcheck').check();
    if (r.bad.length) throw Object.assign(new Error('not restarting — the code has ' + r.bad.length + ' problem(s); the running panel stays up'), { status: 409, detail: r.bad.join('\n') });
  }
  await handOff('restart');
  events.emit('panel.restart', { req: ctx.req, target: 'panel', level: 'warn', message: 'Panel restart' + (b.force ? ' (code check skipped)' : '') });
  tell('🔄 *Panel restarting* — by ' + actor(ctx));
  return { ok: true };
});
router.add('POST', '/api/panel/stop', { perm: 'settings.write' }, async (ctx) => {
  if (!pm2Name()) throw Object.assign(new Error('the panel is not running under pm2'), { status: 409 });
  await handOff('stop');
  events.emit('panel.stop', { req: ctx.req, target: 'panel', level: 'warn', message: 'Panel stopped from the web UI' });
  tell('⏹ *Panel stopped* — by ' + actor(ctx) + '. Self-repair, backups and alerts are off until `sbctl start` on the server.');
  return { ok: true };
});
