'use strict';
// cloudflared itself: installed version, the version its apt repo offers, update now, auto-update.
//
// cloudflared on this host comes from Cloudflare's apt repo, and `cloudflared update` refuses to
// touch a package-managed binary ("installed by a package manager") — the old timer ran it every
// night and never updated anything. The updater below goes through apt instead, and after a real
// upgrade restarts EVERY tunnel unit (cloudflared, cloudflared-kuma, cloudflared-site-*, …), not
// just the first one, so no tunnel keeps running the old binary.
//
// The update runs as the systemd unit cloudflared-update.service, not inside the panel: restarting
// the tunnel the browser is talking through would otherwise cut off the request that started it.
// Auto-update = cloudflared-update.timer enabled (daily, randomised).
const fs = require('fs');
const { execP } = require('./util');

const SCRIPT = '/usr/local/sbin/rhc-cloudflared-update';
const SERVICE = '/etc/systemd/system/cloudflared-update.service';
const TIMER = '/etc/systemd/system/cloudflared-update.timer';
const APT_LIST = 'sources.list.d/cloudflared.list';

const SCRIPT_BODY = `#!/bin/bash
# Managed by rhc-srv-mon (lib/cloudflared.js): update cloudflared from its apt repo and restart
# every tunnel unit when the version changed.
set -euo pipefail
before=$(dpkg-query -W -f='\${Version}' cloudflared 2>/dev/null || echo none)
apt-get update -qq -o Dir::Etc::sourcelist=${APT_LIST} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade -o Dpkg::Options::=--force-confold cloudflared
after=$(dpkg-query -W -f='\${Version}' cloudflared)
if [ "$before" != "$after" ]; then
  echo "updated cloudflared $before -> $after"
  for u in $(systemctl list-units --type=service --state=active --no-legend --plain 'cloudflared*' | awk '{print $1}' | grep -v '^cloudflared-update'); do
    systemctl restart "$u" && echo "restarted $u"
  done
else
  echo "cloudflared $after is the latest"
fi
`;
const SERVICE_BODY = `[Unit]
Description=Update cloudflared (apt) and restart every tunnel — managed by rhc-srv-mon
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${SCRIPT}
`;
const TIMER_BODY = `[Unit]
Description=Update cloudflared daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
`;

function writeIfDiffers(file, body, mode) {
  let cur = null; try { cur = fs.readFileSync(file, 'utf8'); } catch (_) {}
  if (cur === body) return false;
  fs.writeFileSync(file, body, { mode });
  fs.chmodSync(file, mode);
  return true;
}
// Idempotent: (re)writes the script and units only when they differ from what is shipped here.
async function ensureUpdater() {
  const a = writeIfDiffers(SCRIPT, SCRIPT_BODY, 0o755);
  const b = writeIfDiffers(SERVICE, SERVICE_BODY, 0o644);
  const c = writeIfDiffers(TIMER, TIMER_BODY, 0o644);
  if (a || b || c) await execP('systemctl', ['daemon-reload'], { timeout: 30_000 });
}

const dpkgVersion = async () => (await execP('dpkg-query', ['-W', '--showformat=${Version}', 'cloudflared'], { timeout: 10_000 })).stdout.trim() || null;
async function candidate() {
  const out = (await execP('apt-cache', ['policy', 'cloudflared'], { timeout: 15_000 })).stdout;
  const m = /Candidate:\s*(\S+)/.exec(out);
  return m && m[1] !== '(none)' ? m[1] : null;
}
async function timerState() {
  const enabled = (await execP('systemctl', ['is-enabled', 'cloudflared-update.timer'], { timeout: 10_000 })).stdout.trim() === 'enabled';
  const props = Object.fromEntries((await execP('systemctl', ['show', 'cloudflared-update.timer', 'cloudflared-update.service', '-p', 'NextElapseUSecRealtime', '-p', 'LastTriggerUSec', '-p', 'ActiveState', '-p', 'Result'], { timeout: 10_000 })).stdout
    .split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  return { enabled, next: props.NextElapseUSecRealtime || null, last: props.LastTriggerUSec && props.LastTriggerUSec !== 'n/a' ? props.LastTriggerUSec : null };
}
async function lastRun() {
  const r = await execP('journalctl', ['-u', 'cloudflared-update.service', '-n', '12', '--no-pager', '-o', 'short-iso'], { timeout: 10_000 });
  return r.stdout.split('\n').filter((l) => l && !/^-- /.test(l)).slice(-8);
}
async function running() { return (await execP('systemctl', ['is-active', 'cloudflared-update.service'], { timeout: 10_000 })).stdout.trim() === 'activating'; }

let ensured = null;
async function status() {
  if (!ensured) ensured = ensureUpdater().catch((e) => { ensured = null; console.error('cloudflared updater:', e.message); });   // replaces the old, never-working timer once
  await ensured;
  const [installed, latest, timer, log, busy] = await Promise.all([dpkgVersion(), candidate(), timerState(), lastRun(), running()]);
  return { installed, latest, updateAvailable: !!(installed && latest && installed !== latest), autoUpdate: timer.enabled, nextRun: timer.next, lastRun: timer.last, running: busy, log };
}
// Refresh the apt index for the cloudflared repo only, so "latest" is current.
async function check() {
  const r = await execP('apt-get', ['update', '-qq', '-o', 'Dir::Etc::sourcelist=' + APT_LIST, '-o', 'Dir::Etc::sourceparts=-', '-o', 'APT::Get::List-Cleanup=0'], { timeout: 120_000 });
  if (r.err) throw Object.assign(new Error('apt-get update failed'), { status: 502, detail: (r.stderr || r.err.message).slice(-2000) });
  return status();
}
// Starts the update in its own unit and returns at once; the page polls status().
async function update() {
  await ensureUpdater();
  const r = await execP('systemctl', ['start', '--no-block', 'cloudflared-update.service'], { timeout: 30_000 });
  if (r.err) throw Object.assign(new Error('could not start cloudflared-update.service'), { status: 500, detail: r.stderr });
  return { started: true };
}
async function setAutoUpdate(on) {
  await ensureUpdater();
  const r = await execP('systemctl', [on ? 'enable' : 'disable', '--now', 'cloudflared-update.timer'], { timeout: 30_000 });
  if (r.err) throw Object.assign(new Error('could not ' + (on ? 'enable' : 'disable') + ' the timer'), { status: 500, detail: r.stderr });
  return status();
}

module.exports = { status, check, update, setAutoUpdate, ensureUpdater };
