'use strict';
// Portainer CE from the App Store: Docker management UI as the container "portainer"
// (image portainer/portainer-ce:lts, data in the docker volume portainer_data), HTTP on
// 127.0.0.1:<free port from 9900> only — publish it as a reverse-proxy site to reach it from outside.
// Portainer talks to /var/run/docker.sock, i.e. it is root on this server: never expose it without auth.
//
// Install creates the admin account from a password file (/root/.portainer/admin.json, shown in Vault);
// Portainer only uses it while it has no admin yet. Remove deletes the container and keeps the volume
// (a reinstall finds its users, endpoints and stacks again).
const fs = require('fs');
const { settings } = require('./db');
const secrets = require('./secrets');
const { execP } = require('./util');

const NAME = 'portainer';
const IMAGE = 'portainer/portainer-ce:lts';
const VOLUME = 'portainer_data';
const CRED = '/root/.portainer/admin.json';
const PASS_FILE = '/root/.portainer/password';     // plain password, read by Portainer at first start
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const ENV = Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive', HOME: '/root', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' });
const sh = (script, t) => execP('bash', ['-c', 'set -o pipefail; ' + script], { timeout: t || 20 * 60_000, env: ENV });

const local = () => settings.get('portainer.local', null);   // { port, installed }

async function step(log, what, script, t) {
  log('» ' + what);
  const r = await sh(script, t);
  log((r.stdout || '') + (r.stderr || ''));
  if (r.err) throw bad(what + ' failed (exit ' + (r.err.code || '?') + ')');
  return r;
}

async function status(port) {
  try { const r = await fetch('http://127.0.0.1:' + port + '/api/status', { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch (_) { return null; }
}
async function detect() {
  const lc = local(); if (!lc) return { latest: null };
  const s = await status(lc.port);
  return { latest: s && s.Version ? s.Version : 'installed (not answering)' };
}

async function waitUp(port, log) {
  for (let i = 0; i < 60; i++) { const s = await status(port); if (s) return s; await new Promise((res) => setTimeout(res, 2000)); }
  const l = await sh('docker logs --tail 30 ' + NAME + ' 2>&1', 15_000); log(l.stdout);
  throw bad('Portainer did not answer within 2 minutes');
}

const runCmd = (port) => 'docker run -d --name ' + NAME + ' --restart=always -p 127.0.0.1:' + port + ':9000'
  + ' -v /var/run/docker.sock:/var/run/docker.sock -v ' + VOLUME + ':/data -v ' + PASS_FILE + ':/run/portainer-pass:ro '
  + IMAGE + ' --admin-password-file /run/portainer-pass 2>&1';

async function ensureDocker(log) {
  const r = await sh('command -v docker >/dev/null && systemctl is-active --quiet docker', 15_000);
  if (!r.err) return;
  await step(log, 'install Docker (Debian docker.io)', 'apt-get update -q >/dev/null; apt-get -y -q -o Dpkg::Options::=--force-confold install docker.io 2>&1 && systemctl enable --now docker 2>&1');
}

async function install(_v, log) {
  if (local()) throw bad('Portainer is already installed here — use Update');
  await ensureDocker(log);
  const ex = await sh('docker inspect ' + NAME + ' >/dev/null 2>&1', 15_000);
  if (!ex.err) throw bad('a container named "' + NAME + '" already exists — remove it first (docker rm -f ' + NAME + ')');
  const port = require('./sites/create').freePort(9900);
  let cred = null; try { cred = JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch (_) {}
  if (!cred || !cred.password) {
    cred = { username: 'admin', password: secrets.generatePassword(24) };
    fs.mkdirSync('/root/.portainer', { recursive: true, mode: 0o700 });
    fs.writeFileSync(CRED, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  }
  fs.writeFileSync(PASS_FILE, cred.password, { mode: 0o600 });
  await step(log, 'pull ' + IMAGE, 'docker pull -q ' + IMAGE + ' 2>&1');
  await step(log, 'start the container on 127.0.0.1:' + port, 'docker volume create ' + VOLUME + ' >/dev/null && ' + runCmd(port));
  const s = await waitUp(port, log);
  settings.set('portainer.local', { port, installed: new Date().toISOString() });
  log('Portainer ' + (s.Version || '') + ' answers on http://127.0.0.1:' + port + ' — login "admin", password in Vault (Portainer admin login).');
  log('A volume that existed before keeps its old admin password. To open it from outside, publish it as a site with a reverse proxy to http://127.0.0.1:' + port + ' (behind Cloudflare Access or basic auth — Portainer is root on this server).');
  return { stdout: '', stderr: '' };
}

// Pull the newest lts image and recreate the container with the same port, volume and options.
async function update(_v, log) {
  const lc = local(); if (!lc) throw bad('Portainer is not installed from the App Store here');
  await step(log, 'pull ' + IMAGE, 'docker pull -q ' + IMAGE + ' 2>&1');
  if (!fs.existsSync(PASS_FILE)) { let c = null; try { c = JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch (_) {} fs.mkdirSync('/root/.portainer', { recursive: true, mode: 0o700 }); fs.writeFileSync(PASS_FILE, (c && c.password) || secrets.generatePassword(24), { mode: 0o600 }); }
  await step(log, 'recreate the container', 'docker rm -f ' + NAME + ' >/dev/null 2>&1; ' + runCmd(lc.port));
  const s = await waitUp(lc.port, log);
  log('Portainer ' + (s.Version || '') + ' running');
  await sh('docker image prune -f >/dev/null 2>&1', 60_000);
  return { stdout: '', stderr: '' };
}

async function remove(_v, log) {
  if (!local()) throw bad('Portainer is not installed from the App Store here');
  await step(log, 'remove the container (the volume ' + VOLUME + ' is kept)', 'docker rm -f ' + NAME + ' 2>&1 || true');
  settings.del('portainer.local');
  log('data kept in the docker volume ' + VOLUME + ' — delete it with: docker volume rm ' + VOLUME);
  return { stdout: '', stderr: '' };
}

module.exports = { install, update, remove, detect, CRED };
