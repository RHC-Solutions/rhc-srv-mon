'use strict';
/* ---------------------------------------------------------------- collect */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EXEC_TIMEOUT } = require('./config');
const { uidToName } = require('./util');

// The live God Daemon of a pm2 home. pm2.pid is read first; when it is stale (a home copied from
// another server brought that server's pm2.pid along) the daemon is found by its process title,
// "PM2 vX: God Daemon (<home>)", so a running daemon is never reported as missing.
function daemonPid(dir) {
  let pid = null;
  try { pid = parseInt(fs.readFileSync(path.join(dir, 'pm2.pid'), 'utf8').trim(), 10) || null; } catch (_) {}
  if (pid) { try { process.kill(pid, 0); return pid; } catch (_) {} }
  const want = ': God Daemon (' + dir + ')';
  let found = null;
  try {
    for (const e of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(e)) continue;
      let cl; try { cl = fs.readFileSync('/proc/' + e + '/cmdline', 'utf8'); } catch (_) { continue; }
      if (/^PM2 v[\d.]+: God Daemon \(/.test(cl) && cl.replace(/\0+$/, '').endsWith(want)) { found = Number(e); break; }
    }
  } catch (_) {}
  return found;
}

function discoverDaemons() {
  const daemons = [];
  const candidates = [];
  try {
    for (const entry of fs.readdirSync('/home')) {
      candidates.push(path.join('/home', entry, '.pm2'));
    }
  } catch (_) { /* no /home */ }
  candidates.push('/root/.pm2');

  for (const dir of candidates) {
    let st;
    try { st = fs.statSync(dir); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    if (!daemonPid(dir)) continue;
    daemons.push({ dir, uid: st.uid });
  }
  return daemons;
}


function pm2Jlist(user, pm2Home) {
  return new Promise((resolve) => {
    execFile('sudo', ['-n', '-H', '-u', user, 'sh', '-c',
      `PM2_HOME='${pm2Home}' pm2 jlist --no-color 2>/dev/null | grep -E '^\\[' | head -1`],
      { timeout: EXEC_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: String(err.code || err.signal || err.message) });
        try {
          const procs = JSON.parse(stdout.trim());
          resolve({ procs });
        } catch (e) { resolve({ error: 'JSON parse failed' }); }
      });
  });
}

async function collect() {
  const daemons = discoverDaemons();
  const groups = await Promise.all(daemons.map(async (d) => {
    const user = uidToName(d.uid);
    const res = await pm2Jlist(user, d.dir);
    const procs = (res.procs || [])
      .filter((p) => !(p.pm2_env && p.pm2_env.axm_options && p.pm2_env.axm_options.isModule === true))
      .map((p) => {
        const env = p.pm2_env || {};
        const monit = p.monit || {};
        return {
          name: p.name,
          pid: p.pid || null,          // lets the Sites tab read /proc/<pid>/exe for the real interpreter
          status: env.status || 'unknown',
          restarts: env.restart_time ?? 0,
          cpu: monit.cpu ?? 0,
          memory: monit.memory ?? 0,
          uptime_ms: env.status === 'online' && env.pm_uptime ? Date.now() - env.pm_uptime : null,
          out_log: env.pm_out_log_path || null,
          err_log: env.pm_err_log_path || null,
        };
      });
    return { user, pm2_home: d.dir, error: res.error || null, processes: procs };
  }));
  return groups.sort((a, b) => a.user.localeCompare(b.user));
}


module.exports = { discoverDaemons, daemonPid, pm2Jlist, collect };
