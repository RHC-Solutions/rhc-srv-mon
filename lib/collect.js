'use strict';
/* ---------------------------------------------------------------- collect */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EXEC_TIMEOUT } = require('./config');
const { uidToName } = require('./util');

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
    let pid;
    try { pid = parseInt(fs.readFileSync(path.join(dir, 'pm2.pid'), 'utf8').trim(), 10); } catch (_) { continue; }
    if (!pid) continue;
    try { process.kill(pid, 0); } catch (_) { continue; }
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


module.exports = { discoverDaemons, pm2Jlist, collect };
