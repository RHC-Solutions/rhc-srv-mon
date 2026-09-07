'use strict';
// Which Node.js versions this box actually has, and which one a site actually runs.
//
// `site_nodejs.node_version` is bookkeeping inherited from CloudPanel: it records the version CLP
// was told to install, not the interpreter the app ends up executing. On this host every app runs
// the system node while the field says 22, and no site home has an nvm at all — so the panel has to
// measure rather than repeat the record.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const procs = require('./procs');

const SYSTEM_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node', '/opt/node/bin/node'];

function versionOf(bin) {
  try { return execFileSync(bin, ['-v'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return null; }
}
// nvm keeps every install under ~/.nvm/versions/node/v<x.y.z>/bin/node.
function nvmVersions(user) {
  const dir = '/home/' + user + '/.nvm/versions/node';
  let names = []; try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.filter((n) => /^v\d+\./.test(n) && fs.existsSync(path.join(dir, n, 'bin', 'node')))
    .map((n) => ({ version: n, path: path.join(dir, n, 'bin', 'node'), source: 'nvm', user }));
}
// Everything installable/selectable for this site: the system interpreters plus that user's nvm builds.
function available(user) {
  const out = [];
  const seen = new Set();
  for (const bin of SYSTEM_CANDIDATES) {
    let real = null; try { real = fs.realpathSync(bin); } catch (_) { continue; }
    if (seen.has(real)) continue;
    const v = versionOf(bin);
    if (!v) continue;
    seen.add(real);
    out.push({ version: v, path: bin, source: 'system' });
  }
  if (user) out.push(...nvmVersions(user));
  return out;
}
// What the site's running processes actually execute, read from /proc/<pid>/exe. A binary shown as
// "(deleted)" means node was upgraded underneath a long-running process: it still maps the old
// inode and will only pick the new one up on restart.
function actual(site) {
  const seen = new Map();
  let list = [];
  try { list = procs.list(site).processes; } catch (_) { return []; }
  for (const p of list) {
    if (!p.pid) continue;
    let exe = null; try { exe = fs.readlinkSync('/proc/' + p.pid + '/exe'); } catch (_) { continue; }
    const stale = / \(deleted\)$/.test(exe);
    const clean = exe.replace(/ \(deleted\)$/, '');
    if (!/node$/.test(path.basename(clean))) continue;      // python/bash processes under pm2 are not node
    const version = stale ? null : versionOf(clean);
    const key = clean + '|' + stale;
    if (!seen.has(key)) seen.set(key, { version, path: clean, stale, procs: [] });
    seen.get(key).procs.push(p.name);
  }
  return [...seen.values()];
}
module.exports = { available, actual, versionOf, nvmVersions };
