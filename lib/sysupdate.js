'use strict';
// System packages (Updates → System updates): apt update, the list of upgradable packages, apt upgrade,
// and restarting the server when an upgrade needs it.
//
//   upgrade  runs in its own transient systemd unit (sb-apt-upgrade), not as a child of the panel: an
//            upgrade that restarts pm2/node (or the panel restarting for any reason) must not kill
//            dpkg halfway. Output goes to LOG; the page follows it. Non-interactive, keeps changed
//            config files (--force-confold), installs new dependencies (kernels) but never removes.
//            needrestart (Ubuntu) only lists services, it does not restart them behind our back.
//   reboot   needed when /var/run/reboot-required exists (Ubuntu, Debian with unattended-upgrades) or a
//            newer kernel is installed than the one running (Debian does not always write the flag).
//            The restart is scheduled a few seconds out so the request can answer first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execP } = require('./util');

const UNIT = 'sb-apt-upgrade';
const LOG_DIR = '/var/log/sb-srv-mon';
const LOG = path.join(LOG_DIR, 'apt-upgrade.log');
const ENV = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive', NEEDRESTART_MODE: 'l', LC_ALL: 'C' });
const bad = (m, s, detail) => Object.assign(new Error(m), { status: s || 400, detail });

const hasApt = () => fs.existsSync('/usr/bin/apt-get');
let lastCheck = null;   // { at, error }

// "name/suite 1.2.3 amd64 [upgradable from: 1.2.2]"
async function upgradable() {
  const r = await execP('apt', ['list', '--upgradable'], { timeout: 60_000, env: ENV });
  return (r.stdout || '').split('\n').map((l) => /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]/.exec(l))
    .filter(Boolean).map((m) => ({ name: m[1], suite: m[2], to: m[3], from: m[4].trim(), security: /security/i.test(m[2]) }));
}

function kernelState() {
  const running = os.release();
  let installed = [];
  try { installed = fs.readdirSync('/lib/modules').filter((d) => fs.existsSync(path.join('/lib/modules', d, 'modules.dep'))); } catch (_) {}
  const cmp = (a, b) => a.localeCompare(b, undefined, { numeric: true });
  const newest = installed.sort(cmp).pop() || running;
  return { running, newest, newer: cmp(newest, running) > 0 };
}
function rebootState() {
  const flag = fs.existsSync('/var/run/reboot-required');
  let pkgs = [];
  try { pkgs = fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean); } catch (_) {}
  const k = kernelState();
  const reasons = [];
  if (flag) reasons.push('the system asks for it' + (pkgs.length ? ' (' + [...new Set(pkgs)].join(', ') + ')' : ''));
  if (k.newer) reasons.push('kernel ' + k.newest + ' is installed, ' + k.running + ' is running');
  let bootedAt = null;
  try { bootedAt = new Date(Date.now() - Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000).toISOString(); } catch (_) {}
  return { required: reasons.length > 0, reasons, kernel: k, bootedAt };
}

async function unitActive() { return (await execP('systemctl', ['is-active', UNIT], { timeout: 10_000 })).stdout.trim() === 'active'; }
function logTail(n) {
  try { const t = fs.readFileSync(LOG, 'utf8'); return t.split('\n').slice(-(n || 200)).join('\n'); } catch (_) { return ''; }
}
async function job() {
  const active = await unitActive();
  const tail = logTail(200);
  const m = /__EXIT__ (\d+)/.exec(tail);
  let startedAt = null; try { startedAt = fs.statSync(LOG).birthtime.toISOString(); } catch (_) {}
  if (!tail && !active) return null;
  return { running: active, done: !active, ok: m ? m[1] === '0' : (active ? null : false), exit: m ? Number(m[1]) : null, log: tail.replace(/\n?__EXIT__ \d+\s*$/, ''), startedAt };
}

async function status() {
  if (!hasApt()) return { apt: false, reboot: rebootState() };
  return { apt: true, packages: await upgradable(), lastCheck, job: await job(), reboot: rebootState(), hostname: os.hostname() };
}

// apt-get update (refresh the package lists), then the list of what can be upgraded.
async function check() {
  if (!hasApt()) throw bad('this server has no apt', 424);
  if (await unitActive()) throw bad('an upgrade is running', 409);
  const r = await execP('apt-get', ['update', '-q', '-o', 'DPkg::Lock::Timeout=120'], { timeout: 300_000, env: ENV });
  lastCheck = { at: new Date().toISOString(), error: r.err ? (r.stderr || r.err.message).trim().split('\n').slice(-3).join('\n') : null };
  if (r.err) throw bad('apt-get update failed', 502, (r.stderr || r.stdout || '').slice(-2000));
  return status();
}

async function upgrade() {
  if (!hasApt()) throw bad('this server has no apt', 424);
  if (await unitActive()) throw bad('an upgrade is already running', 409);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try { fs.unlinkSync(LOG); } catch (_) {}
  const script = 'set -o pipefail; exec >>' + LOG + ' 2>&1; echo "== $(date -u +%F\\ %T) UTC: apt-get update"; '
    + 'apt-get update -q -o DPkg::Lock::Timeout=600; '
    + 'echo "== apt-get upgrade"; '
    + 'apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold --with-new-pkgs upgrade; rc=$?; '
    + '[ $rc -eq 0 ] && { echo "== apt-get autoclean"; apt-get -y -q autoclean; }; '
    + 'echo "== done $(date -u +%T) UTC"; echo "__EXIT__ $rc"';
  const r = await execP('systemd-run', ['--unit=' + UNIT, '--collect', '--quiet', '--description=System upgrade (sb-srv-mon)',
    '--setenv=DEBIAN_FRONTEND=noninteractive', '--setenv=NEEDRESTART_MODE=l', '--setenv=LC_ALL=C', '/bin/bash', '-c', script], { timeout: 30_000 });
  if (r.err) throw bad('could not start the upgrade', 500, (r.stderr || r.err.message).trim());
  watch();
  return { started: true };
}
// Report the outcome (event + notification) once the unit is done — including whether a restart is due.
function watch() {
  const t = setInterval(async () => {
    const j = await job().catch(() => null);
    if (!j || j.running) return;
    clearInterval(t);
    const rb = rebootState();
    const summary = (/(\d+) upgraded, (\d+) newly installed/.exec(j.log) || [])[0] || '';
    try {
      require('./events').emit('system.upgrade', { user: 'system', target: os.hostname(), level: j.ok ? 'info' : 'error',
        message: 'System upgrade ' + (j.ok ? 'finished' : 'FAILED (exit ' + j.exit + ')') + (summary ? ': ' + summary : '') + (rb.required ? ' — restart needed: ' + rb.reasons.join('; ') : ''), data: { log: j.log.slice(-3000) } });
      await require('./notify').send((j.ok ? '✅' : '❌') + ' *System upgrade* on ' + os.hostname() + ': ' + (j.ok ? 'done' : 'failed') + (summary ? '\n' + summary : '') + (rb.required ? '\n🔁 restart needed — Updates → System updates' : ''), 'complete');
    } catch (_) {}
  }, 5000);
  if (t.unref) t.unref();
}

let rebootAt = null;
async function reboot() {
  if (await unitActive()) throw bad('an upgrade is running — restart after it finishes', 409);
  const r = await execP('systemd-run', ['--unit=sb-reboot', '--collect', '--quiet', '--on-active=10', '--description=Server restart requested in sb-srv-mon', '/bin/systemctl', 'reboot'], { timeout: 30_000 });
  if (r.err) throw bad('could not schedule the restart', 500, (r.stderr || r.err.message).trim());
  rebootAt = new Date(Date.now() + 10_000).toISOString();
  return { scheduled: true, at: rebootAt };
}

module.exports = { status, check, upgrade, reboot, rebootState, upgradable };
