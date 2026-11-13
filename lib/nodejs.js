'use strict';
// The system Node.js: always the newest LTS major, always its latest patch.
//
// Node comes from NodeSource's apt repo, one major per repo (deb.nodesource.com/node_<N>.x), so
// apt alone only ever patches within the major it was set up with — this host sat on 24 for weeks
// after 26 became LTS. The updater below reads nodejs.org's release index once a day; when a newer
// major has reached LTS (and NodeSource publishes it) it moves the repo to that major, then installs
// whatever apt offers. "Stable" means LTS: odd/"Current" majors are never picked.
//
// After a real upgrade the script restarts pm2-root (the panel's own daemon). Every other pm2 daemon
// (sites, Uptime Kuma — everything under /home) is moved onto the new binary by the panel itself,
// one user at a time with health checks: lib/sites/daemons.js refreshStale(), every 5 minutes.
//
// Like cloudflared-update, this runs as its own systemd unit, not inside the panel: it restarts the
// pm2 daemon the panel lives in. Auto-update = nodejs-update.timer enabled; it is enabled once, when
// the timer is first installed, and left alone after that (switching it off sticks).
const fs = require('fs');
const { execP } = require('./util');

const SCRIPT = '/usr/local/sbin/rhc-nodejs-update';
const SERVICE = '/etc/systemd/system/nodejs-update.service';
const TIMER = '/etc/systemd/system/nodejs-update.timer';

const SCRIPT_BODY = `#!/bin/bash
# Managed by sb-srv-mon (lib/nodejs.js): keep the system Node.js on the newest LTS major from
# NodeSource and on its latest patch; restart pm2-root after a real upgrade.
set -euo pipefail
SRC=/etc/apt/sources.list.d/nodesource.sources
PREV=/etc/apt/nodesource.sources.prev   # outside sources.list.d, which apt would scan (and warn about)
before=$(dpkg-query -W -f='\${Version}' nodejs 2>/dev/null || echo none)
cur=$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
lts=$(curl -fsS --max-time 60 https://nodejs.org/dist/index.json | /usr/bin/node -e '
  let s = ""; process.stdin.on("data", (d) => s += d).on("end", () => {
    const r = JSON.parse(s).find((r) => r.lts); process.stdout.write(r ? r.version.slice(1).split(".")[0] : "");
  })' 2>/dev/null || true)
moved=0
if ! [[ "$lts" =~ ^[0-9]+$ ]]; then
  echo "could not read the Node.js release index; patch update only"
elif (( lts > cur )); then
  if curl -fsSI --max-time 30 "https://deb.nodesource.com/node_\${lts}.x/dists/nodistro/Release" >/dev/null 2>&1; then
    cp -a "$SRC" "$PREV"
    sed -i -E "s#(deb\\.nodesource\\.com/node_)[0-9]+(\\.x)#\\1\${lts}\\2#" "$SRC"
    moved=1
    echo "NodeSource repo node_\${cur}.x -> node_\${lts}.x (newest LTS)"
  else
    echo "Node \${lts} is LTS but NodeSource has no node_\${lts}.x yet; staying on \${cur}"
  fi
else
  echo "Node \${cur} is the newest LTS major"
fi
if ! { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::=--force-confold nodejs; }; then
  if (( moved )); then mv -f "$PREV" "$SRC"; apt-get update -qq || true; echo "upgrade failed; NodeSource repo put back to node_\${cur}.x"; fi
  exit 1
fi
rm -f "$PREV"
after=$(dpkg-query -W -f='\${Version}' nodejs)
if [ "$before" != "$after" ]; then
  echo "updated nodejs $before -> $after"
  if systemctl is-active --quiet pm2-root; then systemctl restart pm2-root && echo "restarted pm2-root (panel) on $(/usr/bin/node -v)"; fi
  echo "site pm2 daemons follow via the panel (lib/sites/daemons.js) within ~10 minutes"
else
  echo "nodejs $after is the latest"
fi
`;
const SERVICE_BODY = `[Unit]
Description=Keep Node.js on the newest LTS (NodeSource) — managed by sb-srv-mon
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${SCRIPT}
`;
const TIMER_BODY = `[Unit]
Description=Update Node.js daily

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
// Idempotent: (re)writes the script and units when they differ; enables the timer only the first
// time it is installed, so an admin who switched auto-update off keeps it off.
async function ensureUpdater() {
  const fresh = !fs.existsSync(TIMER);
  const a = writeIfDiffers(SCRIPT, SCRIPT_BODY, 0o755);
  const b = writeIfDiffers(SERVICE, SERVICE_BODY, 0o644);
  const c = writeIfDiffers(TIMER, TIMER_BODY, 0o644);
  if (a || b || c) await execP('systemctl', ['daemon-reload'], { timeout: 30_000 });
  if (fresh) await execP('systemctl', ['enable', '--now', 'nodejs-update.timer'], { timeout: 30_000 });
}

async function status() {
  const v = (await execP('/usr/bin/node', ['-v'], { timeout: 10_000 })).stdout.trim() || null;
  const enabled = (await execP('systemctl', ['is-enabled', 'nodejs-update.timer'], { timeout: 10_000 })).stdout.trim() === 'enabled';
  const log = (await execP('journalctl', ['-u', 'nodejs-update.service', '-n', '12', '--no-pager', '-o', 'short-iso'], { timeout: 10_000 })).stdout
    .split('\n').filter((l) => l && !/^-- /.test(l)).slice(-8);
  return { installed: v, autoUpdate: enabled, log };
}
// Starts the update in its own unit and returns at once.
async function update() {
  await ensureUpdater();
  const r = await execP('systemctl', ['start', '--no-block', 'nodejs-update.service'], { timeout: 30_000 });
  if (r.err) throw Object.assign(new Error('could not start nodejs-update.service'), { status: 500, detail: r.stderr });
  return { started: true };
}
async function setAutoUpdate(on) {
  await ensureUpdater();
  const r = await execP('systemctl', [on ? 'enable' : 'disable', '--now', 'nodejs-update.timer'], { timeout: 30_000 });
  if (r.err) throw Object.assign(new Error('could not ' + (on ? 'enable' : 'disable') + ' the timer'), { status: 500, detail: r.stderr });
  return status();
}

module.exports = { ensureUpdater, status, update, setAutoUpdate };
