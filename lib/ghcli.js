'use strict';
// GitHub CLI (gh) on this server: version, latest release, whether it can do what the panel needs,
// and installing the current release.
//
// The panel needs: `gh auth login --web --skip-ssh-key` (Sign in with GitHub), `gh auth token --user`
// (several accounts, one per repo). Distro packages are often too old for that (Ubuntu 22.04: 2.4,
// Debian 13: 2.46 — no --skip-ssh-key), so the capability is checked by asking gh itself, not by
// a version number. Installing = the official .deb of the latest release from github.com/cli/cli
// (Debian/Ubuntu; apt keeps it afterwards like any package).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execP } = require('./util');

// gh reads its config even for --version/--help; give it an empty one so the answer never depends
// on (or touches) root's logins.
async function ghClean(args) {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-q-'));
  try { return await execP('gh', args, { timeout: 15_000, env: Object.assign({}, process.env, { GH_CONFIG_DIR: cfg, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' }) }); }
  finally { try { fs.rmSync(cfg, { recursive: true, force: true }); } catch (_) {} }
}
// "2.46.0"; null = not installed; 'unknown' = installed but would not say
async function version() {
  const r = await ghClean(['--version']);
  if (r.err && r.err.code === 'ENOENT') return null;
  const m = /gh version (\d+\.\d+\.\d+)/.exec((r.stdout || '') + (r.stderr || ''));
  return m ? m[1] : 'unknown';
}
// what is missing for the panel ([] = fine)
async function missing() {
  const login = await ghClean(['auth', 'login', '--help']), token = await ghClean(['auth', 'token', '--help']);
  const out = [];
  for (const f of ['--web', '--skip-ssh-key', '--scopes', '--git-protocol']) if (!(login.stdout + login.stderr).includes(f)) out.push('auth login ' + f);
  if (!(token.stdout + token.stderr).includes('--user')) out.push('auth token --user');
  return out;
}
async function latestRelease() {
  const r = await fetch('https://api.github.com/repos/cli/cli/releases/latest', { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sb-srv-mon' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error('GitHub releases: HTTP ' + r.status);
  const rel = await r.json();
  return { version: String(rel.tag_name || '').replace(/^v/, ''), assets: rel.assets || [] };
}
let latestCache = null;
async function latest() {
  if (latestCache && Date.now() - latestCache.at < 3600_000) return latestCache.v;
  try { const v = (await latestRelease()).version || null; latestCache = { at: Date.now(), v }; return v; } catch (_) { return null; }
}
// Install the latest release .deb. log(line) gets progress. Returns the new version.
async function install(log) {
  log = log || (() => {});
  const before = await version();
  const arch = (await execP('dpkg', ['--print-architecture'], { timeout: 10_000 })).stdout.trim();
  if (!arch) throw Object.assign(new Error('this server has no dpkg (not Debian/Ubuntu) — install gh from https://cli.github.com'), { status: 424 });
  const rel = await latestRelease();
  const asset = rel.assets.find((a) => a.name === 'gh_' + rel.version + '_linux_' + arch + '.deb');
  if (!asset) throw Object.assign(new Error('no gh ' + rel.version + ' package for ' + arch + ' — install gh from https://cli.github.com'), { status: 424 });
  log('gh ' + (before || 'not installed') + ' → ' + rel.version + ': downloading ' + asset.name + ' (' + Math.round(asset.size / 1e6) + ' MB)');
  const res = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error('download failed: HTTP ' + res.status);
  const deb = path.join(os.tmpdir(), asset.name);
  fs.writeFileSync(deb, Buffer.from(await res.arrayBuffer()));
  log('installing with dpkg -i');
  const r = await execP('dpkg', ['-i', deb], { timeout: 300_000, env: Object.assign({}, process.env, { DEBIAN_FRONTEND: 'noninteractive' }) });
  try { fs.unlinkSync(deb); } catch (_) {}
  if (r.stdout) log(r.stdout.trim());
  const now = await version();
  if (r.err || now !== rel.version) throw Object.assign(new Error('installing gh ' + rel.version + ' failed (now: ' + (now || 'not installed') + ')'), { status: 500, detail: (r.stderr || r.stdout || '').slice(-1500) });
  latestCache = null;
  log('gh ' + now + ' installed');
  return now;
}
// Make sure gh can do what the panel needs; installs the latest release when it cannot.
let ensuring = null;
async function ensure(log) {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const v = await version();
    if (v === 'unknown') return v;              // never replace a gh we cannot even read
    const miss = v ? await missing() : ['gh'];
    if (!miss.length) return v;
    (log || (() => {}))('gh ' + (v || 'is not installed') + (v ? ' lacks ' + miss.join(', ') : '') + ' — installing the current release');
    return install(log);
  })().finally(() => { ensuring = null; });
  return ensuring;
}

module.exports = { version, missing, latest, install, ensure };
