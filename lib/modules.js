'use strict';
/* ---------------------------------------------------------------- modules */
// Modules scan/update + auto-update + cleanup. All three persist into one modules.json,
// which is why they stay in one file.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { APP_ROOT } = require('./config');
const { execP, fmtBytes, homeUsers, existingDir, uidToName, USER_NAME_RE } = require('./util');
const notify = require('./notify');
const events = require('./events');
const MODULES_FILE = path.join(APP_ROOT, 'modules.json');
const MODULES_TIMEOUT = 90_000;          // per-project npm outdated timeout
const MODULES_CONCURRENCY = 3;           // parallel scans (registry-bound)
const MODULES_INTERVAL_MS = 6 * 3600_000; // refresh every 6h
const MOD_UPDATE_TIMEOUT = 5 * 60_000;   // per-update timeout
const MOD_UPDATE_LOG_MAX = 50;
const PKG_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const MOD_SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt', '.cache', 'cache',
  'coverage', '.git', 'tmp', '.turbo', '.vite', '.parcel-cache', '.svelte-kit',
]);

let modulesCache = null;
let modulesScanInProgress = false;
let modulesScanProgress = { total: 0, done: 0, current: null, startedAt: null };
const moduleUpdatesActive = {};   // key: realpath dir -> { user, packages, startedAt }
let moduleUpdateLog = [];          // recent results, newest last
let moduleUpdateAllRunning = false;   // a global "update all projects" pass is in flight
let moduleUpdateAllProgress = null;   // { total, done, current, succeeded, failed, startedAt, finishedAt }

function loadModulesCache() {
  try {
    const data = JSON.parse(fs.readFileSync(MODULES_FILE, 'utf8'));
    if (data && typeof data === 'object') {
      modulesCache = data;
      moduleUpdateLog = Array.isArray(data.updateLog) ? data.updateLog : [];
      autoUpdateLog = Array.isArray(data.autoUpdateLog) ? data.autoUpdateLog : [];
      cleanupLog = Array.isArray(data.cleanupLog) ? data.cleanupLog : [];
    }
  } catch (_) { /* first run */ }
}

function saveModulesCache() {
  try {
    if (modulesCache) {
      modulesCache.updateLog = moduleUpdateLog;
      modulesCache.autoUpdateLog = autoUpdateLog;
      modulesCache.cleanupLog = cleanupLog;
    }
    fs.writeFileSync(MODULES_FILE + '.tmp', JSON.stringify(modulesCache));
    fs.renameSync(MODULES_FILE + '.tmp', MODULES_FILE);
  } catch (e) { console.error('modules save failed:', e.message); }
}

function detectPM(dir) {
  try { if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun'; } catch {}
  try { if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm'; } catch {}
  try { if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn'; } catch {}
  return 'npm';
}

// Find bun in standard locations. Returns absolute path or null.
// If found only in a per-user dir (e.g. /home/rh-x/.bun/bin/bun) that other
// project users can't traverse, copy it to /usr/local/bin/bun once so every
// project user can execute it.
let _bunPathCache = undefined;
function findBun() {
  if (_bunPathCache !== undefined) return _bunPathCache;
  // Prefer system-wide locations
  for (const c of ['/usr/local/bin/bun', '/usr/bin/bun']) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && (st.mode & 0o111)) { _bunPathCache = c; return c; }
    } catch (_) {}
  }
  // Otherwise search user homes
  let userBun = null;
  try {
    for (const u of fs.readdirSync('/home')) {
      const cand = `/home/${u}/.bun/bin/bun`;
      try {
        const st = fs.statSync(cand);
        if (st.isFile() && (st.mode & 0o111)) { userBun = cand; break; }
      } catch (_) {}
    }
  } catch (_) {}
  if (!userBun) { _bunPathCache = null; return null; }
  // Try to copy to /usr/local/bin/bun so every project user can reach it.
  // We run as root, so this should succeed; fall back to the per-user path if not.
  try {
    fs.copyFileSync(userBun, '/usr/local/bin/bun');
    fs.chmodSync('/usr/local/bin/bun', 0o755);
    console.log('rhc-srv-mon: installed bun from', userBun, '-> /usr/local/bin/bun');
    _bunPathCache = '/usr/local/bin/bun';
  } catch (e) {
    console.error('rhc-srv-mon: could not copy bun to /usr/local/bin (' + e.message + '), falling back to ' + userBun);
    _bunPathCache = userBun;
  }
  return _bunPathCache;
}

// Walk a tree looking for installed projects (dirs with both package.json AND node_modules).
// Stops descending into a project once found (its own node_modules is uninteresting).
function findInstalledProjects(root, maxDepth = 5) {
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    let hasPkg = false, hasNm = false;
    for (const e of entries) {
      if (e.name === 'package.json' && e.isFile()) hasPkg = true;
      else if (e.name === 'node_modules' && e.isDirectory()) hasNm = true;
    }
    if (hasPkg && hasNm) { results.push(dir); continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (MOD_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  return results;
}

function dirOwner(dir) {
  try { return uidToName(fs.statSync(dir).uid); } catch { return 'root'; }
}

function discoverModuleProjects() {
  const found = [];
  // /home/<user>/htdocs/...
  let users;
  try { users = fs.readdirSync('/home'); } catch { users = []; }
  for (const user of users) {
    const htdocs = path.join('/home', user, 'htdocs');
    let st;
    try { st = fs.statSync(htdocs); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const dir of findInstalledProjects(htdocs)) {
      found.push({ dir, user: dirOwner(dir), scope: user });
    }
  }
  // /opt/<dir>
  try {
    for (const e of fs.readdirSync('/opt', { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue;
      const root = path.join('/opt', e.name);
      for (const dir of findInstalledProjects(root, 4)) {
        found.push({ dir, user: dirOwner(dir), scope: 'opt:' + e.name });
      }
    }
  } catch (_) { /* no /opt */ }
  // Dedup by realpath
  const seen = new Set();
  const out = [];
  for (const p of found) {
    let real;
    try { real = fs.realpathSync(p.dir); } catch { real = p.dir; }
    if (seen.has(real)) continue;
    seen.add(real);
    out.push({ ...p, dir: real });
  }
  return out;
}

function readPkgJson(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { return null; }
}

// Map `pnpm outdated --format json` ({name:{current,latest,wanted,isDeprecated,dependencyType}})
// onto the npm-outdated shape the rest of the module code expects ({current,wanted,latest,type}).
function normalizePnpmOutdated(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue;
    // pnpm also lists deprecated packages that are already on the latest version -- nothing to update.
    if (info.current && info.latest && info.current === info.latest) continue;
    out[name] = {
      current: info.current || null,
      wanted: info.wanted || info.latest || null,
      latest: info.latest || null,
      type: info.dependencyType || 'dependencies',
    };
  }
  return out;
}

// Per-project outdated scan. Uses the project's own package manager for pnpm: npm's arborist cannot
// read a pnpm-managed node_modules (every dep comes back as MISSING / current=null, and package.json
// `overrides` trip EOVERRIDE), which made pnpm projects show dozens of phantom "outdated" rows that
// the auto-updater could never clear (no current version => no severity => never picked).
function npmOutdated(project) {
  return new Promise((resolve) => {
    const cwdEsc = project.dir.replace(/'/g, `'\\''`);
    const pm = project.pm || detectPM(project.dir);
    const shCmd = pm === 'pnpm'
      ? `cd '${cwdEsc}' && pnpm outdated --format json 2>/dev/null || true`
      : `cd '${cwdEsc}' && npm outdated --json --depth=0 2>/dev/null || true`;
    const isRoot = !project.user || project.user === 'root';
    const bin = isRoot ? 'sh' : 'sudo';
    const args = isRoot ? ['-c', shCmd] : ['-n', '-H', '-u', project.user, 'sh', '-c', shCmd];
    execFile(bin, args, { timeout: MODULES_TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: String(err.code || err.signal || err.message) });
        const trimmed = (stdout || '').trim();
        if (!trimmed) return resolve({ outdated: {} });
        let parsed;
        try { parsed = JSON.parse(trimmed); }
        catch (_) { return resolve({ error: pm + ' outdated parse failed' }); }
        // npm prints its failure as {"error":{code,summary,detail}} on stdout -- report it as an
        // error instead of listing a package literally named "error".
        if (parsed && parsed.error && typeof parsed.error === 'object' && !parsed.error.latest) {
          return resolve({ error: parsed.error.summary || parsed.error.code || 'npm outdated failed' });
        }
        return resolve({ outdated: pm === 'pnpm' ? normalizePnpmOutdated(parsed) : parsed });
      });
  });
}

function semverParts(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

function severityOf(current, latest) {
  const a = semverParts(current);
  const b = semverParts(latest);
  if (!a || !b) return null;
  // Never treat a pre-release as "the update" for a stable install (e.g. prisma 7.10 -> 8.0.0-rc.13:
  // the rc CLI has no `generate`, so the project's postinstall fails and the whole install exits 2).
  if (/-/.test(String(latest)) && !/-/.test(String(current))) return null;
  if (a[0] !== b[0]) return 'major';
  if (a[1] !== b[1]) return 'minor';
  if (a[2] !== b[2]) return 'patch';
  return null;
}

function relPath(dir) {
  const m = dir.match(/^\/home\/([^/]+)\/(.*)$/);
  if (m) return '~' + m[1] + '/' + m[2];
  return dir;
}

async function collectModules() {
  if (modulesScanInProgress) return modulesCache;
  modulesScanInProgress = true;
  modulesScanProgress = { total: 0, done: 0, current: null, startedAt: new Date().toISOString() };
  try {
    const projects = discoverModuleProjects();
    modulesScanProgress.total = projects.length;

    // Pre-fill metadata from package.json
    const enriched = projects.map((p) => {
      const pkg = readPkgJson(p.dir) || {};
      const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      return {
        dir: p.dir,
        relDir: relPath(p.dir),
        user: p.user,
        scope: p.scope,
        pm: detectPM(p.dir),
        pkgName: pkg.name || path.basename(p.dir),
        pkgVersion: pkg.version || null,
        depCount: Object.keys(direct).length,
        outdated: null,
        error: null,
        scannedAt: null,
      };
    });

    let idx = 0;
    async function worker() {
      while (idx < enriched.length) {
        const i = idx++;
        const p = enriched[i];
        modulesScanProgress.current = p.dir;
        const r = await npmOutdated({ dir: p.dir, user: p.user, pm: p.pm });
        p.error = r.error || null;
        p.outdated = r.outdated || {};
        p.scannedAt = new Date().toISOString();
        modulesScanProgress.done++;
      }
    }
    await Promise.all(Array.from({ length: MODULES_CONCURRENCY }, () => worker()));

    // Flatten outdated rows + classify severity
    const rows = [];
    let major = 0, minor = 0, patch = 0;
    for (const p of enriched) {
      if (!p.outdated) continue;
      for (const [name, info] of Object.entries(p.outdated)) {
        const sev = severityOf(info.current, info.latest);
        rows.push({
          user: p.user,
          dir: p.dir,
          relDir: p.relDir,
          pkgName: p.pkgName,
          pm: p.pm,
          package: name,
          current: info.current || null,
          wanted: info.wanted || null,
          latest: info.latest || null,
          type: info.type || 'dependencies',
          severity: sev,
        });
        if (sev === 'major') major++;
        else if (sev === 'minor') minor++;
        else if (sev === 'patch') patch++;
      }
    }

    const prevAutoUpdate = modulesCache && modulesCache.autoUpdate;
    const prevCleanup = modulesCache && modulesCache.cleanup;
    modulesCache = {
      generated_at: new Date().toISOString(),
      summary: {
        projects: enriched.length,
        projectsOutdated: enriched.filter((p) => p.outdated && Object.keys(p.outdated).length).length,
        outdatedTotal: rows.length,
        major, minor, patch,
        errors: enriched.filter((p) => p.error).length,
      },
      projects: enriched,
      outdated: rows,
      updateLog: moduleUpdateLog,
      autoUpdateLog,
      autoUpdate: prevAutoUpdate || undefined,
      cleanup: prevCleanup || undefined,
      cleanupLog,
    };
    saveModulesCache();
  } catch (e) {
    console.error('collectModules failed:', e.message);
  } finally {
    modulesScanInProgress = false;
    modulesScanProgress = { total: 0, done: 0, current: null, startedAt: null };
  }
  return modulesCache;
}

function recomputeModulesSummary() {
  if (!modulesCache) return;
  const rows = [];
  let major = 0, minor = 0, patch = 0;
  for (const p of modulesCache.projects) {
    if (!p.outdated) continue;
    for (const [name, info] of Object.entries(p.outdated)) {
      const sev = severityOf(info.current, info.latest);
      rows.push({
        user: p.user, dir: p.dir, relDir: p.relDir, pkgName: p.pkgName, pm: p.pm,
        package: name,
        current: info.current || null,
        wanted: info.wanted || null,
        latest: info.latest || null,
        type: info.type || 'dependencies',
        severity: sev,
      });
      if (sev === 'major') major++;
      else if (sev === 'minor') minor++;
      else if (sev === 'patch') patch++;
    }
  }
  modulesCache.outdated = rows;
  modulesCache.summary = {
    projects: modulesCache.projects.length,
    projectsOutdated: modulesCache.projects.filter((p) => p.outdated && Object.keys(p.outdated).length).length,
    outdatedTotal: rows.length,
    major, minor, patch,
    errors: modulesCache.projects.filter((p) => p.error).length,
  };
}

async function rescanProject(dir, user) {
  if (!modulesCache) return;
  const idx = modulesCache.projects.findIndex((p) => p.dir === dir);
  if (idx < 0) return;
  const pm = detectPM(dir);
  const r = await npmOutdated({ dir, user, pm });
  const pkg = readPkgJson(dir) || {};
  const direct = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const proj = modulesCache.projects[idx];
  proj.outdated = r.outdated || {};
  proj.error = r.error || null;
  proj.scannedAt = new Date().toISOString();
  proj.pkgName = pkg.name || path.basename(dir);
  proj.pkgVersion = pkg.version || null;
  proj.depCount = Object.keys(direct).length;
  proj.pm = pm;
  recomputeModulesSummary();
  modulesCache.generated_at = new Date().toISOString();
  saveModulesCache();
}

function appendUpdateLog(entry) {
  moduleUpdateLog.push(entry);
  if (moduleUpdateLog.length > MOD_UPDATE_LOG_MAX) {
    moduleUpdateLog.splice(0, moduleUpdateLog.length - MOD_UPDATE_LOG_MAX);
  }
  if (modulesCache) modulesCache.updateLog = moduleUpdateLog;
  saveModulesCache();
}

function buildInstallCmd(dir, pm, packages, extraFlags) {
  const dirEsc = dir.replace(/'/g, `'\\''`);
  const pkgsAtLatest = packages.length ? packages.map((p) => `'${p}@latest'`).join(' ') : '';
  const flags = (extraFlags || '').trim();
  if (pm === 'npm') {
    // Always carry --legacy-peer-deps + --no-fund --no-audit --no-progress; extraFlags adds e.g. --force.
    return `cd '${dirEsc}' && npm install --legacy-peer-deps --no-fund --no-audit --no-progress ${flags} ${pkgsAtLatest} 2>&1`;
  }
  if (pm === 'pnpm') {
    return `cd '${dirEsc}' && pnpm ${packages.length ? 'add' : 'install'} --config.package-import-method=copy ${flags} ${pkgsAtLatest} 2>&1`;
  }
  if (pm === 'yarn') {
    return `cd '${dirEsc}' && yarn ${packages.length ? 'add' : 'install'} ${flags} ${pkgsAtLatest} 2>&1`;
  }
  if (pm === 'bun') {
    const bun = findBun();
    if (!bun) return null;
    const bunEsc = bun.replace(/'/g, `'\\''`);
    return `cd '${dirEsc}' && '${bunEsc}' ${packages.length ? 'add' : 'install'} ${flags} ${pkgsAtLatest} 2>&1`;
  }
  return null;
}

// Raw exec — NO validation; callers must validate inputs before calling.
function _runInstall(dir, user, pm, packages, extraFlags) {
  const shCmd = buildInstallCmd(dir, pm, packages, extraFlags);
  if (!shCmd) {
    const reason = pm === 'bun'
      ? 'bun binary not found in /usr/bin, /usr/local/bin, or /home/*/.bun/bin/bun'
      : 'unsupported PM: ' + pm;
    return Promise.resolve({ success: false, error: reason, output: '', duration_ms: 0 });
  }
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const isRoot = user === 'root';
    const bin = isRoot ? 'sh' : 'sudo';
    const args = isRoot ? ['-c', shCmd] : ['-n', '-H', '-u', user, 'sh', '-c', shCmd];
    execFile(bin, args, { timeout: MOD_UPDATE_TIMEOUT, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const output = (stdout || '').toString();
        resolve({
          success: !err,
          error: err ? String(err.code || err.signal || err.message) : null,
          output,
          duration_ms: Date.now() - startedAt,
        });
      });
  });
}

// Detect a fix strategy from npm output. Returns { strategy, ...metadata } or null.
function detectAutoFix(output, error) {
  const out = (output || '') + ' ' + (error || '');
  // pnpm >=11: dependencies with install scripts must be explicitly allowed in pnpm-workspace.yaml
  // (allowBuilds), otherwise install exits 1 with ERR_PNPM_IGNORED_BUILDS and native modules
  // (better-sqlite3, ...) are left unbuilt. Recovery: allow them, rebuild, retry the install.
  const ib = out.match(/ERR_PNPM_IGNORED_BUILDS\]?\s*Ignored build scripts:\s*([^\n]+)/i);
  if (ib) {
    const pkgs = ib[1].split(',').map((x) => x.trim().replace(/@[^@/]+$/, '')).filter((p) => p && PKG_NAME_RE.test(p));
    if (pkgs.length) return { strategy: 'approve-builds', packages: pkgs };
  }
  // Permission errors — chown back to project owner (most decisive: fixes the root cause)
  // Covers npm/pnpm/yarn ("EACCES"/"EPERM"/"operation was rejected") + bun ("error ACCES" / "GlobError")
  if (/operation was rejected by your operating system|EACCES|EPERM|do not have the permissions|permission denied|\berror ACCES\b|GlobError/i.test(out)) {
    return { strategy: 'fix-perms' };
  }
  // EOVERRIDE — extract conflicting package so we can drop it from the install list
  // npm 11+ throws this when a package is in both `dependencies` and `overrides`.
  // --force does NOT bypass it; the only programmatic recovery is to skip the package.
  const eo = out.match(/Override for ((?:@[^@\s/]+\/)?[^@\s]+?)(?:@\S+)? conflicts/i);
  if (eo) return { strategy: 'eoverride-skip', package: eo[1] };
  if (/\bEOVERRIDE\b/.test(out)) return { strategy: 'eoverride-skip' };
  // "Cannot read properties of null (reading 'matches')" — corrupt node_modules tree
  // or stale npm cache. Reliable fix: rm -rf node_modules && npm install.
  if (/Cannot read propert(?:y|ies) of null.*matches/i.test(out)) return { strategy: 'clean-reinstall' };
  // Lockfile out of sync (EUSAGE) — same recovery path
  if (/lockfile.*out of sync|EUSAGE|Missing.*from lock file|npm error EUSAGE/i.test(out)) return { strategy: 'clean-reinstall' };
  // Peer-dep conflicts — try --force
  if (/ERESOLVE|Conflicting peer dependency/.test(out)) return { strategy: 'force' };
  // Network — single retry
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|FETCH_ERROR|socket hang up|registry .* unreachable/i.test(out)) return { strategy: 'retry' };
  return null;
}

// Generic shell command runner for non-install helpers (chown, rm, etc.)
function _runShell(asUser, shCmd, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const isRoot = asUser === 'root';
    const bin = isRoot ? 'sh' : 'sudo';
    const args = isRoot ? ['-c', shCmd] : ['-n', '-H', '-u', asUser, 'sh', '-c', shCmd];
    execFile(bin, args, { timeout: timeoutMs || 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        const output = (stdout || '').toString();
        resolve({
          success: !err,
          error: err ? String(err.code || err.signal || err.message) : null,
          output,
          duration_ms: Date.now() - startedAt,
        });
      });
  });
}

// Strategy: clean-reinstall — destroy node_modules and reinstall from package.json.
// Safe because node_modules is always regenerable; lockfile is preserved.
async function _runCleanReinstall(project) {
  if (!USER_NAME_RE.test(project.user)) return { success: false, error: 'invalid user: ' + project.user, output: '', duration_ms: 0 };
  const dirEsc = project.dir.replace(/'/g, `'\\''`);
  let shCmd;
  if (project.pm === 'npm') {
    shCmd = `cd '${dirEsc}' && rm -rf node_modules && npm cache verify >/dev/null 2>&1; npm install --legacy-peer-deps --no-fund --no-audit --no-progress 2>&1`;
  } else if (project.pm === 'pnpm') {
    shCmd = `cd '${dirEsc}' && rm -rf node_modules && pnpm install 2>&1`;
  } else if (project.pm === 'yarn') {
    shCmd = `cd '${dirEsc}' && rm -rf node_modules && yarn install 2>&1`;
  } else if (project.pm === 'bun') {
    const bun = findBun();
    if (!bun) return { success: false, error: 'bun not available', output: '', duration_ms: 0 };
    const bunEsc = bun.replace(/'/g, `'\\''`);
    shCmd = `cd '${dirEsc}' && rm -rf node_modules && '${bunEsc}' install 2>&1`;
  } else {
    return { success: false, error: 'unsupported pm: ' + project.pm, output: '', duration_ms: 0 };
  }
  return _runShell(project.user, shCmd, MOD_UPDATE_TIMEOUT);
}

// Strategy: fix-perms — chown the project tree + ~/.npm cache back to project owner.
// Runs as root (the page runs as root anyway). Username validated.
// We chown the whole project tree (not just node_modules) because CloudPanel
// dual-user setups often have mixed ownership in subdirectories that breaks
// install / bun-workspace traversal.
async function _runFixPerms(project) {
  if (!USER_NAME_RE.test(project.user)) return { success: false, error: 'invalid user: ' + project.user, output: '', duration_ms: 0 };
  const dirEsc = project.dir.replace(/'/g, `'\\''`);
  const homeEsc = `/home/${project.user}`.replace(/'/g, `'\\''`);
  const u = project.user;
  const shCmd = `set +e
GID="$(id -gn '${u}' 2>/dev/null)"
if [ -z "$GID" ]; then echo "user ${u} not found"; exit 1; fi
echo "fixing perms: ${u}:$GID for ${dirEsc}"
if [ -d '${dirEsc}' ]; then
  # Count files not owned by the project user before chown
  # Skip files with >1 hard link: those are pnpm-store inodes shared with other projects/users —
  # chowning them steals them from everybody else (that is what broke every pnpm project once).
  BEFORE=$(find '${dirEsc}' \\( -type d -o -links 1 \\) -not -user '${u}' 2>/dev/null | wc -l)
  find '${dirEsc}' \\( -type d -o -links 1 \\) -not -user '${u}' -exec chown -h '${u}':"$GID" {} + 2>/dev/null
  AFTER=$(find '${dirEsc}' \\( -type d -o -links 1 \\) -not -user '${u}' 2>/dev/null | wc -l)
  LINKED=$(find '${dirEsc}' -type f -links +1 -not -user '${u}' 2>/dev/null | wc -l)
  echo "project tree: $BEFORE files were misowned, $AFTER remain after chown ($LINKED shared pnpm-store hard links left alone)"
fi
if [ -d '${homeEsc}/.npm' ]; then
  chown -R '${u}':"$GID" '${homeEsc}/.npm' 2>/dev/null && echo "chowned ~/.npm"
fi
echo "done"
exit 0`;
  return _runShell('root', shCmd, 300_000);
}

// Allow build scripts for the given packages in <dir>/pnpm-workspace.yaml (pnpm >=10 `allowBuilds`
// map, or the older `onlyBuiltDependencies` list if that is what the project uses). Line-based edit
// so comments/ordering survive; the file is rewritten in place so ownership is preserved.
function approveBuildsInWorkspaceYaml(dir, pkgs) {
  const file = path.join(dir, 'pnpm-workspace.yaml');
  let text = '';
  const existed = fs.existsSync(file);
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { text = ''; }
  const lines = text.length ? text.replace(/\r\n/g, '\n').split('\n') : [];
  const yamlKey = (p) => (/^[A-Za-z0-9_.-]+$/.test(p) ? p : "'" + p + "'");
  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const blockEnd = (start) => {
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || /^\s/.test(lines[end]))) end++;
    while (end > start + 1 && lines[end - 1].trim() === '') end--;
    return end;
  };
  const idx = lines.findIndex((l) => /^allowBuilds:\s*(#.*)?$/.test(l));
  if (idx === -1) {
    const ob = lines.findIndex((l) => /^onlyBuiltDependencies:\s*(#.*)?$/.test(l));
    if (ob !== -1) {
      const end = blockEnd(ob);
      const have = lines.slice(ob + 1, end).map((l) => l.replace(/^\s*-\s*/, '').replace(/^['"]|['"]$/g, '').trim());
      lines.splice(end, 0, ...pkgs.filter((p) => !have.includes(p)).map((p) => '  - ' + yamlKey(p)));
    } else {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('allowBuilds:');
      for (const p of pkgs) lines.push('  ' + yamlKey(p) + ': true');
    }
  } else {
    let end = blockEnd(idx);
    for (const p of pkgs) {
      const re = new RegExp('^\\s+[\'"]?' + escRe(p) + '[\'"]?\\s*:');
      let found = false;
      for (let i = idx + 1; i < end; i++) {
        if (re.test(lines[i])) { lines[i] = '  ' + yamlKey(p) + ': true'; found = true; }
      }
      if (!found) { lines.splice(idx + 1, 0, '  ' + yamlKey(p) + ': true'); end++; }
    }
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (!existed) {
    // new file must stay editable by the project owner (pnpm itself writes allowBuilds stubs)
    try { const st = fs.statSync(dir); fs.chownSync(file, st.uid, st.gid); fs.chmodSync(file, 0o664); } catch (_) {}
  }
  return file;
}

// Strategy: approve-builds -- allow the flagged build scripts, then rebuild those packages as the
// project owner so the native binaries exist before the actual install is retried.
async function _runApproveBuilds(project, pkgs) {
  if (!USER_NAME_RE.test(project.user)) return { success: false, error: 'invalid user: ' + project.user, output: '', duration_ms: 0 };
  if (project.pm !== 'pnpm') return { success: false, error: 'approve-builds only applies to pnpm projects', output: '', duration_ms: 0 };
  const valid = pkgs.filter((p) => PKG_NAME_RE.test(p));
  if (!valid.length) return { success: false, error: 'no valid package names', output: '', duration_ms: 0 };
  const startedAt = Date.now();
  let file;
  try { file = approveBuildsInWorkspaceYaml(project.dir, valid); }
  catch (e) { return { success: false, error: 'pnpm-workspace.yaml edit failed: ' + e.message, output: '', duration_ms: Date.now() - startedAt }; }
  const dirEsc = project.dir.replace(/'/g, `'\\''`);
  const list = valid.map((p) => `'${p}'`).join(' ');
  const r = await _runShell(project.user, `cd '${dirEsc}' && pnpm rebuild ${list} 2>&1`, MOD_UPDATE_TIMEOUT);
  r.output = 'allowed build scripts in ' + file + ': ' + valid.join(', ') + '\n' + (r.output || '');
  r.duration_ms = Date.now() - startedAt;
  return r;
}

// Turn a failed install's output into a one-line reason (instead of a bare exit code).
function summarizeInstallError(output, code) {
  const lines = String(output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const prio = [
    /ERR_PNPM_[A-Z_]+/, /ELIFECYCLE/, /npm error (?!code\b|For a full|A complete log)/i,
    /\bE[A-Z]{4,}\b/, /(^|\s)error[:\s]/i, /failed/i,
  ];
  let pick = '';
  for (const re of prio) {
    const hits = lines.filter((l) => re.test(l));
    if (hits.length) { pick = hits[hits.length - 1]; break; }
  }
  if (!pick && lines.length) pick = lines[lines.length - 1];
  const tag = code ? ('exit ' + code) : 'failed';
  const base = pick.replace(/\s+/g, ' ').slice(0, 220);
  return base ? (base + ' (' + tag + ')') : tag;
}

// Run an update for one project with auto-fix retry chain.
// Returns { success, attempts, finalOutput, autoFix, finalPackages }.
async function runProjectUpdateWithFix(project, packages, withAutoFix) {
  const attempts = [];
  let finalPackages = packages.slice();

  // Attempt 1: default flags
  let r = await _runInstall(project.dir, project.user, project.pm, packages, '');
  attempts.push({ strategy: 'normal', success: r.success, error: r.error, duration_ms: r.duration_ms });
  if (r.success) return { success: true, attempts, finalOutput: r.output, finalPackages, autoFix: null };

  let fix = detectAutoFix(r.output, r.error);

  // Strategy: approve-builds -- pnpm >=11 aborts with ERR_PNPM_IGNORED_BUILDS when a dependency's
  // install script is not allowed in pnpm-workspace.yaml. npm ran those scripts unconditionally,
  // so allowing them restores the pre-migration behaviour. It is a project policy fix rather than
  // a workaround, so it applies to manual updates as well (independent of the auto-fix switch).
  if (fix && fix.strategy === 'approve-builds') {
    const approved = [];
    for (let iter = 0; iter < 3 && fix && fix.strategy === 'approve-builds'; iter++) {
      const pkgs = (fix.packages || []).filter((p) => !approved.includes(p));
      if (!pkgs.length) break;
      const ra = await _runApproveBuilds(project, pkgs);
      approved.push(...pkgs);
      attempts.push({ strategy: 'approve-builds:' + pkgs.join(','), success: ra.success, error: ra.error, duration_ms: ra.duration_ms });
      if (!ra.success) return { success: false, attempts, finalOutput: ra.output, finalPackages, autoFix: 'approve-builds:' + approved.join(',') };
      r = await _runInstall(project.dir, project.user, project.pm, packages, '');
      attempts.push({ strategy: 'retry-after-approve', success: r.success, error: r.error, duration_ms: r.duration_ms });
      if (r.success) return { success: true, attempts, finalOutput: r.output, finalPackages, autoFix: 'approve-builds:' + approved.join(',') };
      fix = detectAutoFix(r.output, r.error);
    }
    if (!fix || fix.strategy === 'approve-builds') {
      return { success: false, attempts, finalOutput: r.output, finalPackages, autoFix: 'approve-builds:' + approved.join(',') };
    }
    // a different, fixable error surfaced after approving builds -- fall through to the normal chain
  }

  if (!withAutoFix) return { success: false, attempts, finalOutput: r.output, finalPackages, autoFix: null };
  if (!fix) return { success: false, attempts, finalOutput: r.output, finalPackages, autoFix: null };

  // Strategy: --force
  if (fix.strategy === 'force') {
    const r2 = await _runInstall(project.dir, project.user, project.pm, packages, '--force');
    attempts.push({ strategy: 'force', success: r2.success, error: r2.error, duration_ms: r2.duration_ms });
    return { success: r2.success, attempts, finalOutput: r2.output, finalPackages, autoFix: 'force' };
  }

  // Strategy: EOVERRIDE — iteratively drop conflicting packages and retry.
  // npm reports one conflict at a time; loop up to 10 times accumulating skips.
  if (fix.strategy === 'eoverride-skip') {
    let current = packages.slice();
    const skippedAccum = [];

    if (!fix.package || !current.includes(fix.package)) {
      // Pre-existing project config bug (override conflicts with a package not in our update list)
      return { success: false, attempts, finalOutput: r.output, finalPackages: current, autoFix: 'eoverride-skip:needs-manual-fix' };
    }
    current = current.filter((p) => p !== fix.package);
    skippedAccum.push(fix.package);

    let lastOutput = '';
    for (let iter = 0; iter < 10 && current.length > 0; iter++) {
      const r2 = await _runInstall(project.dir, project.user, project.pm, current, '');
      attempts.push({ strategy: 'skip-' + skippedAccum[skippedAccum.length - 1], success: r2.success, error: r2.error, duration_ms: r2.duration_ms });
      lastOutput = r2.output;
      if (r2.success) {
        finalPackages = current;
        return { success: true, attempts, finalOutput: r2.output, finalPackages, autoFix: 'eoverride-skip:' + skippedAccum.join(',') };
      }
      const next = detectAutoFix(r2.output, r2.error);
      if (!next || next.strategy !== 'eoverride-skip' || !next.package || !current.includes(next.package)) {
        // Different error or unrecognizable conflict — stop
        return { success: false, attempts, finalOutput: r2.output, finalPackages: current, autoFix: 'eoverride-skip:' + skippedAccum.join(',') };
      }
      current = current.filter((p) => p !== next.package);
      skippedAccum.push(next.package);
    }
    return { success: false, attempts, finalOutput: lastOutput, finalPackages: current, autoFix: 'eoverride-skip:' + skippedAccum.join(',') + ':exhausted' };
  }

  // Strategy: clean-reinstall — rm -rf node_modules, full install, then retry our targeted install
  if (fix.strategy === 'clean-reinstall') {
    let r0 = await _runCleanReinstall(project);
    attempts.push({ strategy: 'clean-reinstall', success: r0.success, error: r0.error, duration_ms: r0.duration_ms });
    // If clean reinstall failed due to permissions, chown and retry the clean reinstall once
    if (!r0.success && /EACCES|EPERM|permission denied|operation was rejected/i.test(r0.output || '')) {
      const rp = await _runFixPerms(project);
      attempts.push({ strategy: 'fix-perms-fallback', success: rp.success, error: rp.error, duration_ms: rp.duration_ms });
      if (rp.success) {
        r0 = await _runCleanReinstall(project);
        attempts.push({ strategy: 'clean-reinstall-retry', success: r0.success, error: r0.error, duration_ms: r0.duration_ms });
      }
    }
    if (!r0.success) return { success: false, attempts, finalOutput: r0.output, finalPackages, autoFix: 'clean-reinstall' };
    const r2 = await _runInstall(project.dir, project.user, project.pm, packages, '');
    attempts.push({ strategy: 'retry-after-clean', success: r2.success, error: r2.error, duration_ms: r2.duration_ms });
    return { success: r2.success, attempts, finalOutput: r2.output, finalPackages, autoFix: 'clean-reinstall' };
  }

  // Strategy: fix-perms — chown back to project owner, retry targeted install
  if (fix.strategy === 'fix-perms') {
    const rp = await _runFixPerms(project);
    attempts.push({ strategy: 'fix-perms', success: rp.success, error: rp.error, duration_ms: rp.duration_ms });
    if (!rp.success) return { success: false, attempts, finalOutput: rp.output, finalPackages, autoFix: 'fix-perms' };
    const r2 = await _runInstall(project.dir, project.user, project.pm, packages, '');
    attempts.push({ strategy: 'retry-after-perms', success: r2.success, error: r2.error, duration_ms: r2.duration_ms });
    return { success: r2.success, attempts, finalOutput: r2.output, finalPackages, autoFix: 'fix-perms' };
  }

  // Strategy: network retry
  if (fix.strategy === 'retry') {
    const r2 = await _runInstall(project.dir, project.user, project.pm, packages, '');
    attempts.push({ strategy: 'network-retry', success: r2.success, error: r2.error, duration_ms: r2.duration_ms });
    return { success: r2.success, attempts, finalOutput: r2.output, finalPackages, autoFix: 'retry' };
  }

  return { success: false, attempts, finalOutput: r.output, finalPackages, autoFix: null };
}

// Validate inputs and run an update for one project. packages is array of npm names; if empty, update all outdated in the project.
async function runModuleUpdate(dir, user, packagesIn, actor) {
  if (!modulesCache) return { success: false, error: 'no scan cache; rescan first' };
  const project = modulesCache.projects.find((p) => p.dir === dir);
  if (!project) return { success: false, error: 'project not in scan cache' };

  // Verify dir is owned by claimed user (defense in depth — UI sends both)
  let actualUser;
  try { actualUser = uidToName(fs.statSync(dir).uid); }
  catch (e) { return { success: false, error: 'cannot stat dir: ' + e.message }; }
  if (actualUser !== user) return { success: false, error: `user mismatch (dir owned by '${actualUser}', not '${user}')` };

  // Compose the package list
  let packages;
  if (Array.isArray(packagesIn) && packagesIn.length) {
    packages = packagesIn;
  } else {
    packages = Object.keys(project.outdated || {});
  }
  if (!packages.length) return { success: false, error: 'no packages to update' };
  for (const pkg of packages) {
    if (!PKG_NAME_RE.test(pkg)) return { success: false, error: 'invalid package name: ' + pkg };
    if (!project.outdated || !project.outdated[pkg]) {
      return { success: false, error: `package '${pkg}' not in outdated list for this project (rescan?)` };
    }
  }

  if (moduleUpdatesActive[dir]) {
    return { success: false, error: 'an update is already running for this project' };
  }
  moduleUpdatesActive[dir] = { user, packages, startedAt: new Date().toISOString() };

  try {
    const r = await runProjectUpdateWithFix(project, packages, false);  // manual: no auto-fix retry
    const result = {
      timestamp: new Date().toISOString(),
      dir, relDir: project.relDir, user,
      packages, pm: project.pm,
      success: r.success,
      error: r.success ? null : summarizeInstallError(r.finalOutput, r.attempts[r.attempts.length - 1].error),
      output: (r.finalOutput || '').slice(-4000),
      duration_ms: r.attempts.reduce((s, a) => s + (a.duration_ms || 0), 0),
      attempts: r.attempts,
      autoFix: r.autoFix,
    };
    appendUpdateLog(result);
    events.emit('modules.update', Object.assign({ user: 'system' }, actor, { target: dir, level: result.success ? 'info' : 'error',
      message: (result.success ? 'Updated ' : 'Update failed in ') + relPath(dir) + (result.packages && result.packages.length ? ': ' + result.packages.join(', ') : ''),
      data: { user: result.user, packages: result.packages, error: result.error, autoFix: result.autoFix, duration_ms: result.duration_ms } }));
    return result;
  } finally {
    delete moduleUpdatesActive[dir];
    try { await rescanProject(dir, user); } catch (e) { console.error('post-update rescan failed:', e.message); }
  }
}

// Manual "update everything" — sequentially update ALL outdated packages in every
// scanned project (all severities, no exclusions). Each project is run through the
// normal runModuleUpdate path, so every project lands its own entry in the Recent
// Updates log and gets a post-update rescan. Distinct from auto-update, which
// applies severity filters/exclusions and logs to the auto-update log.
async function runUpdateAllPass() {
  if (moduleUpdateAllRunning) return { skipped: true, reason: 'already running' };
  if (!modulesCache || !modulesCache.projects || !modulesCache.projects.length) {
    return { skipped: true, reason: 'no scan cache; rescan first' };
  }
  if (modulesScanInProgress) return { skipped: true, reason: 'scan in progress' };

  const targets = modulesCache.projects.filter(
    (p) => !p.error && p.outdated && Object.keys(p.outdated).length
  );

  moduleUpdateAllRunning = true;
  moduleUpdateAllProgress = {
    total: targets.length, done: 0, current: null,
    succeeded: 0, failed: 0, startedAt: new Date().toISOString(), finishedAt: null,
  };

  try {
    for (const t of targets) {
      moduleUpdateAllProgress.current = t.relDir;
      if (moduleUpdatesActive[t.dir]) { moduleUpdateAllProgress.done++; continue; }
      let r;
      try { r = await runModuleUpdate(t.dir, t.user, []); }  // [] => all outdated, re-read fresh
      catch (e) { r = { success: false, error: e.message }; }
      if (r && r.success) moduleUpdateAllProgress.succeeded++;
      else moduleUpdateAllProgress.failed++;
      moduleUpdateAllProgress.done++;
    }
    return { ok: true, progress: { ...moduleUpdateAllProgress } };
  } finally {
    moduleUpdateAllRunning = false;
    if (moduleUpdateAllProgress) {
      moduleUpdateAllProgress.current = null;
      moduleUpdateAllProgress.finishedAt = new Date().toISOString();
    }
  }
}

/* ---------------------------------------------------------------- auto-update */
const AUTO_UPDATE_LOG_MAX = 50;
const DEFAULT_AUTO_UPDATE = {
  enabled: false,
  hour: 3,
  min: 0,
  severities: ['patch'],          // any of: 'patch','minor','major'
  autoFix: true,
  excludedDirs: [],
  excludedPackages: [],
  notifyTelegram: false,
  notifyOnFailureOnly: true,
};

let autoUpdateRunning = false;
let autoUpdateLog = [];
let lastAutoTickKey = null;        // suppress double-fire within the same minute

function getAutoUpdateConfig() {
  return { ...DEFAULT_AUTO_UPDATE, ...((modulesCache && modulesCache.autoUpdate) || {}) };
}

function setAutoUpdateConfig(patch) {
  if (!modulesCache) modulesCache = { generated_at: null, summary: {}, projects: [], outdated: [] };
  const cur = getAutoUpdateConfig();
  // Sanitize
  const next = { ...cur, ...patch };
  next.hour = Math.max(0, Math.min(23, parseInt(next.hour, 10) || 0));
  next.min  = Math.max(0, Math.min(59, parseInt(next.min, 10) || 0));
  if (!Array.isArray(next.severities)) next.severities = ['patch'];
  next.severities = next.severities.filter((s) => ['patch','minor','major'].includes(s));
  if (!next.severities.length) next.severities = ['patch'];
  if (!Array.isArray(next.excludedDirs)) next.excludedDirs = [];
  if (!Array.isArray(next.excludedPackages)) next.excludedPackages = [];
  next.excludedPackages = next.excludedPackages
    .map((p) => String(p).trim())
    .filter((p) => p && PKG_NAME_RE.test(p));
  modulesCache.autoUpdate = next;
  saveModulesCache();
  return next;
}

function pickAutoUpdatablePackages(project, config) {
  if (!project.outdated) return [];
  if (project.error) return [];
  if (config.excludedDirs.includes(project.dir)) return [];
  const out = [];
  for (const [name, info] of Object.entries(project.outdated)) {
    if (config.excludedPackages.includes(name)) continue;
    const sev = severityOf(info.current, info.latest);
    if (sev && config.severities.includes(sev)) out.push(name);
  }
  return out;
}

function appendAutoUpdateLog(entry) {
  autoUpdateLog.push(entry);
  if (autoUpdateLog.length > AUTO_UPDATE_LOG_MAX) {
    autoUpdateLog.splice(0, autoUpdateLog.length - AUTO_UPDATE_LOG_MAX);
  }
  if (modulesCache) modulesCache.autoUpdateLog = autoUpdateLog;
  saveModulesCache();
}

async function runAutoUpdatePass(triggeredBy, actor) {
  if (autoUpdateRunning) return { skipped: true, reason: 'already running' };
  if (!modulesCache || !modulesCache.projects || !modulesCache.projects.length) {
    return { skipped: true, reason: 'no scan cache' };
  }
  if (modulesScanInProgress) return { skipped: true, reason: 'scan in progress' };

  const config = getAutoUpdateConfig();
  if (triggeredBy === 'schedule' && !config.enabled) return { skipped: true, reason: 'disabled' };

  autoUpdateRunning = true;
  const startedAt = Date.now();
  const results = [];

  try {
    for (const project of modulesCache.projects) {
      if (moduleUpdatesActive[project.dir]) {
        results.push({ dir: project.dir, relDir: project.relDir, user: project.user, skipped: true, reason: 'manual update active', packages: [] });
        continue;
      }
      const packages = pickAutoUpdatablePackages(project, config);
      if (!packages.length) continue;

      // Validate package names defensively (already filtered by detection but be safe)
      const validPackages = packages.filter((p) => PKG_NAME_RE.test(p));
      if (!validPackages.length) continue;

      // Verify dir owner still matches
      let actualUser;
      try { actualUser = uidToName(fs.statSync(project.dir).uid); }
      catch { actualUser = null; }
      if (actualUser !== project.user) {
        results.push({ dir: project.dir, relDir: project.relDir, user: project.user, skipped: true, reason: 'owner mismatch', packages: [] });
        continue;
      }

      moduleUpdatesActive[project.dir] = { user: project.user, packages: validPackages, startedAt: new Date().toISOString(), auto: true };
      let r;
      try {
        r = await runProjectUpdateWithFix(project, validPackages, config.autoFix);
      } catch (e) {
        r = { success: false, attempts: [{ strategy: 'crashed', success: false, error: e.message, duration_ms: 0 }], finalOutput: '', autoFix: null };
      }
      delete moduleUpdatesActive[project.dir];

      try { await rescanProject(project.dir, project.user); } catch (e) { /* ignore */ }

      results.push({
        dir: project.dir, relDir: project.relDir, user: project.user,
        packages: validPackages, pm: project.pm,
        success: r.success,
        autoFix: r.autoFix,
        attempts: r.attempts.map((a) => ({ strategy: a.strategy, success: a.success, error: a.error, duration_ms: a.duration_ms })),
        finalError: r.success ? null : summarizeInstallError(r.finalOutput, r.attempts[r.attempts.length - 1].error),
        outputTail: (r.finalOutput || '').slice(-2000),
        duration_ms: r.attempts.reduce((s, a) => s + (a.duration_ms || 0), 0),
      });
    }

    const summary = {
      timestamp: new Date().toISOString(),
      triggeredBy,
      duration_ms: Date.now() - startedAt,
      projectsConsidered: modulesCache.projects.length,
      projectsAttempted: results.filter((r) => !r.skipped).length,
      projectsSucceeded: results.filter((r) => r.success).length,
      projectsFailed: results.filter((r) => !r.success && !r.skipped).length,
      packagesUpdated: results.filter((r) => r.success).reduce((s, r) => s + r.packages.length, 0),
      autoFixesApplied: results.filter((r) => r.autoFix).length,
      results,
    };
    // Log every manual run; only log scheduled runs that actually attempted something
    if (summary.projectsAttempted > 0 || triggeredBy !== 'schedule') {
      appendAutoUpdateLog(summary);
      events.emit('modules.auto-update', { user: triggeredBy === 'schedule' ? 'system' : (actor && actor.user) || 'system', ip: actor && actor.ip, target: triggeredBy,
        level: summary.projectsFailed ? 'warn' : 'info',
        message: 'Auto-update (' + triggeredBy + '): ' + summary.projectsSucceeded + ' ok, ' + summary.projectsFailed + ' failed, ' + summary.packagesUpdated + ' packages',
        data: { projectsAttempted: summary.projectsAttempted, projectsSucceeded: summary.projectsSucceeded, projectsFailed: summary.projectsFailed, packagesUpdated: summary.packagesUpdated, autoFixesApplied: summary.autoFixesApplied } });
    }

    // Telegram notification (reuses Updates-tab Telegram config)
    if (config.notifyTelegram && summary.projectsAttempted > 0) {
      const shouldNotify = !config.notifyOnFailureOnly || summary.projectsFailed > 0;
      if (shouldNotify) {
        {
          const lines = [];
          lines.push('*📦 Auto-update*');
          lines.push('✅ ' + summary.projectsSucceeded + ' succeeded · ❌ ' + summary.projectsFailed + ' failed · 📦 ' + summary.packagesUpdated + ' pkgs · ⏱ ' + Math.round(summary.duration_ms / 1000) + 's');
          if (summary.autoFixesApplied) lines.push('🔧 ' + summary.autoFixesApplied + ' auto-fixes applied');
          lines.push('');
          for (const r of results) {
            if (r.skipped) continue;
            const icon = r.success ? '✅' : '❌';
            lines.push(icon + ' `' + r.user + '` · ' + r.relDir + ' (' + r.packages.length + ' pkg' + (r.packages.length === 1 ? '' : 's') + ')');
            if (!r.success && r.attempts.length) {
              lines.push('   tried: ' + r.attempts.map((a) => a.strategy + (a.success ? '✓' : '✗')).join(', '));
            }
            if (!r.success && r.finalError) {
              lines.push('   `' + String(r.finalError).replace(/`/g, "'").slice(0, 160) + '`');
            }
          }
          try { await notify.send(lines.join('\n'), 'complete'); } catch (_) { /* ignore */ }
        }
      }
    }

    return { skipped: false, summary };
  } finally {
    autoUpdateRunning = false;
  }
}

function autoUpdateTick() {
  const config = getAutoUpdateConfig();
  if (!config.enabled) return;
  const now = new Date();
  const hh = now.getHours();
  const mm = now.getMinutes();
  const targetMin = config.hour * 60 + config.min;
  const nowMin = hh * 60 + mm;
  // Match within a 2-minute window starting at the configured time
  const diff = (nowMin - targetMin + 1440) % 1440;
  if (diff > 2) return;
  const key = `${now.toISOString().slice(0, 10)}-${config.hour}-${config.min}`;
  if (lastAutoTickKey === key) return;
  lastAutoTickKey = key;
  runAutoUpdatePass('schedule')
    .then((r) => {
      if (r && !r.skipped && getCleanupConfig().afterAutoUpdate) {
        return runCleanup('after-auto-update').catch((e) => console.error('post-update cleanup failed:', e.message));
      }
    })
    .catch((e) => console.error('auto-update pass failed:', e.message));
}

/* ---------------------------------------------------------------- cleanup */
// Disk cleanup of regenerable package-manager caches and build leftovers. Everything here is
// re-creatable by the next install/build; project sources, site runtime output (.next itself,
// dist, uploads) and databases are never touched. Paths are validated against fixed patterns
// under /home/<user>/ and /root/ before anything is removed.
const CLEANUP_LOG_MAX = 30;
const DEFAULT_CLEANUP = {
  npmCache: true,        // ~/.npm/_cacache + ~/.npm/_logs (every user + root)
  pnpmCache: true,       // ~/.cache/pnpm (metadata cache; the content store is separate)
  pnpmStore: true,       // `pnpm store prune` on the shared store: drops packages no project references
  bunCache: true,        // ~/.bun/install/cache
  pipCache: true,        // ~/.cache/pip
  projectCaches: true,   // <project>/node_modules/.cache (babel/eslint/webpack/turbo caches)
  nextCache: false,      // <project>/.next/cache (next build is slower once after removal)
  leftovers: false,      // <project>/node_modules.pre-*, node_modules.bak*, node_modules.old* (migration copies)
  afterAutoUpdate: false,
};
const CLEANUP_LEFTOVER_RE = /^node_modules[._-](pre-[\w.-]+|bak[\w.-]*|old[\w.-]*|backup[\w.-]*)$/;
const PNPM_STORE_DIR = '/var/lib/pnpm-store';
let cleanupRunning = false;
let cleanupPreview = null;    // { measuredAt, targets: [{ key, label, prune, count, bytes, items:[{path,bytes}] }], totalBytes }
let cleanupLog = [];          // recent runs, newest last

function getCleanupConfig() {
  return { ...DEFAULT_CLEANUP, ...((modulesCache && modulesCache.cleanup) || {}) };
}
function setCleanupConfig(patch) {
  if (!modulesCache) modulesCache = { generated_at: null, summary: {}, projects: [], outdated: [] };
  const next = { ...getCleanupConfig() };
  for (const k of Object.keys(DEFAULT_CLEANUP)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  modulesCache.cleanup = next;
  saveModulesCache();
  return next;
}
function getCleanupState() {
  return { config: getCleanupConfig(), preview: cleanupPreview, running: cleanupRunning, log: cleanupLog.slice(-10) };
}

// Concrete paths per cleanup key. Site roots = /home/<user>/htdocs/<site> plus one level of
// sub-projects (dirs with a package.json), which is how CloudPanel + monorepo-ish sites are laid out here.
function cleanupTargets() {
  const t = {
    npmCache:      { label: 'npm caches', paths: [] },
    pnpmCache:     { label: 'pnpm metadata caches', paths: [] },
    pnpmStore:     { label: 'pnpm store prune', paths: [], prune: true },
    bunCache:      { label: 'bun caches', paths: [] },
    pipCache:      { label: 'pip caches', paths: [] },
    projectCaches: { label: 'project tool caches', paths: [] },
    nextCache:     { label: 'Next.js build caches', paths: [] },
    leftovers:     { label: 'leftover node_modules copies', paths: [] },
  };
  const users = homeUsers();
  for (const h of users.map((u) => '/home/' + u).concat(['/root'])) {
    for (const p of [h + '/.npm/_cacache', h + '/.npm/_logs']) if (existingDir(p)) t.npmCache.paths.push(p);
    if (existingDir(h + '/.cache/pnpm')) t.pnpmCache.paths.push(h + '/.cache/pnpm');
    if (existingDir(h + '/.bun/install/cache')) t.bunCache.paths.push(h + '/.bun/install/cache');
    if (existingDir(h + '/.cache/pip')) t.pipCache.paths.push(h + '/.cache/pip');
  }
  if (existingDir(PNPM_STORE_DIR)) t.pnpmStore.paths.push(PNPM_STORE_DIR);
  for (const u of users) {
    const htdocs = '/home/' + u + '/htdocs';
    let sites = [];
    try { sites = fs.readdirSync(htdocs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(htdocs, e.name)); } catch (_) {}
    const roots = [];
    for (const sdir of sites) {
      roots.push(sdir);
      try {
        for (const e of fs.readdirSync(sdir, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && fs.existsSync(path.join(sdir, e.name, 'package.json'))) roots.push(path.join(sdir, e.name));
        }
      } catch (_) {}
    }
    for (const p of roots) {
      if (existingDir(path.join(p, 'node_modules', '.cache'))) t.projectCaches.paths.push(path.join(p, 'node_modules', '.cache'));
      if (existingDir(path.join(p, '.next', 'cache'))) t.nextCache.paths.push(path.join(p, '.next', 'cache'));
      try {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          if (e.isDirectory() && !e.isSymbolicLink() && CLEANUP_LEFTOVER_RE.test(e.name)) t.leftovers.paths.push(path.join(p, e.name));
        }
      } catch (_) {}
    }
  }
  // CloudPanel pairs each site user with an ssh user whose ~/htdocs symlinks to the same tree, so
  // the same directory shows up twice; keep one path per real directory.
  for (const key of Object.keys(t)) {
    const seen = new Set();
    t[key].paths = t[key].paths.filter((p) => {
      let real = p;
      try { real = fs.realpathSync(p); } catch (_) {}
      if (seen.has(real)) return false;
      seen.add(real);
      return true;
    });
  }
  return t;
}

async function duSizes(paths) {
  const sizes = new Map();
  if (!paths.length) return sizes;
  const r = await execP('du', ['-s', '-B1', '--', ...paths], { timeout: 15 * 60_000 });
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (m) sizes.set(m[2], parseInt(m[1], 10));
  }
  return sizes;
}

async function measureCleanup() {
  const t = cleanupTargets();
  const targets = [];
  for (const key of Object.keys(t)) {
    const sizes = await duSizes(t[key].paths);   // one du per group so a slow group can't hide the others
    const items = t[key].paths.map((p) => ({ path: p, bytes: sizes.get(p) || 0 }));
    targets.push({ key, label: t[key].label, prune: !!t[key].prune, count: items.length, bytes: items.reduce((a, i) => a + i.bytes, 0), items });
  }
  cleanupPreview = {
    measuredAt: new Date().toISOString(),
    targets,
    totalBytes: targets.filter((x) => !x.prune).reduce((a, x) => a + x.bytes, 0),
  };
  return cleanupPreview;
}

function safeCleanupPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.split('/').includes('..')) return false;
  if (!/^\/home\/[^/]+\/.+/.test(p) && !/^\/root\/.+/.test(p)) return false;
  const base = path.basename(p);
  // <project>/node_modules/.cache (projectCaches target) — only when it really sits inside node_modules
  if (base === '.cache') return path.basename(path.dirname(p)) === 'node_modules';
  return ['_cacache', '_logs', 'pnpm', 'cache', 'pip'].includes(base) || CLEANUP_LEFTOVER_RE.test(base);
}

async function runCleanup(trigger, overrides, actor) {
  if (cleanupRunning) return { skipped: true, reason: 'already running' };
  // never pull caches out from under a running install
  if (Object.keys(moduleUpdatesActive).length || moduleUpdateAllRunning || (autoUpdateRunning && trigger !== 'after-auto-update')) {
    return { skipped: true, reason: 'package updates in progress' };
  }
  cleanupRunning = true;
  const startedAt = Date.now();
  const cfg = { ...getCleanupConfig(), ...(overrides || {}) };
  const results = [];
  const errors = [];
  try {
    const before = await measureCleanup();
    for (const tgt of before.targets) {
      if (!cfg[tgt.key] || !tgt.count) continue;
      if (tgt.prune) {
        const r = await execP('pnpm', ['store', 'prune', '--store-dir', PNPM_STORE_DIR], { timeout: 30 * 60_000, env: Object.assign({}, process.env, { HOME: '/root' }) });
        if (r.err) errors.push('pnpm store prune: ' + ((r.stderr || r.stdout || r.err.message || '').split('\n').filter(Boolean).slice(-1)[0] || 'failed'));
        const after = await duSizes([PNPM_STORE_DIR]);
        const storeAfter = after.get(PNPM_STORE_DIR);
        results.push({ key: tgt.key, label: tgt.label, count: 1, freed: (storeAfter != null) ? Math.max(0, tgt.bytes - storeAfter) : 0, ok: !r.err });
        continue;
      }
      let freed = 0, n = 0;
      for (const it of tgt.items) {
        if (!safeCleanupPath(it.path)) { errors.push('refused unsafe path: ' + it.path); continue; }
        // npm (or a build) can be writing into a cache while this walks it: new files appear in
        // directories rm has already emptied and it fails ENOTEMPTY. force only swallows ENOENT, so
        // retries are what handle a live directory — Node retries ENOTEMPTY/EBUSY/EPERM for us.
        try { fs.rmSync(it.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); n++; freed += it.bytes; }
        catch (e) { errors.push('rm ' + it.path + ': ' + (e.code === 'ENOTEMPTY' ? 'something is still writing into it (' + e.code + ') — it was in use during the sweep; run cleanup again' : e.message)); }
      }
      results.push({ key: tgt.key, label: tgt.label, count: n, freed, ok: n === tgt.items.length });
    }
  } catch (e) {
    errors.push('cleanup: ' + e.message);
  } finally {
    cleanupRunning = false;
    cleanupPreview = null;   // sizes are stale now; UI offers Measure again
  }
  const entry = {
    timestamp: new Date().toISOString(), trigger, duration_ms: Date.now() - startedAt,
    freedBytes: results.reduce((a, r) => a + (r.freed || 0), 0), results, errors,
  };
  cleanupLog.push(entry);
  if (cleanupLog.length > CLEANUP_LOG_MAX) cleanupLog.splice(0, cleanupLog.length - CLEANUP_LOG_MAX);
  if (modulesCache) modulesCache.cleanupLog = cleanupLog;
  saveModulesCache();
  events.emit('modules.cleanup', { user: trigger === 'manual' ? (actor && actor.user) || 'system' : 'system', ip: actor && actor.ip, target: trigger,
    level: errors.length ? 'warn' : 'info', message: 'Cleanup (' + trigger + ') freed ' + fmtBytes(entry.freedBytes) + (errors.length ? ', ' + errors.length + ' error(s)' : ''),
    data: { freedBytes: entry.freedBytes, errors, results: results.map((r) => ({ key: r.key, freed: r.freed, count: r.count })) } });
  // Every run reports, manual included, and says what happened even when that is "nothing" — a
  // cleanup that silently did nothing is exactly the case worth knowing about.
  const status = errors.length ? (entry.freedBytes > 0 ? '⚠ partial' : '❌ failed') : (entry.freedBytes > 0 ? '✅ ok' : '✅ nothing to free');
  try {
    const who = trigger === 'manual' ? 'manual' + ((actor && actor.user) ? ' by ' + actor.user : '') : trigger;
    const lines = ['🧹 *Cleanup* — ' + status,
      'trigger: ' + who + ' · freed ' + fmtBytes(entry.freedBytes) + ' · took ' + Math.round((entry.duration_ms || 0) / 1000) + 's'];
    for (const r of results.filter((x) => x.count || x.freed)) lines.push('• ' + r.label + ' — ' + fmtBytes(r.freed) + ' (' + r.count + ' item' + (r.count === 1 ? '' : 's') + ')');
    if (errors.length) {
      lines.push('⚠ ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') + ':');
      for (const e of errors.slice(0, 5)) lines.push('   ' + e);
      if (errors.length > 5) lines.push('   …and ' + (errors.length - 5) + ' more');
    }
    await notify.send(lines.join('\n'));
  } catch (_) { /* a failed notification must not fail the cleanup */ }
  return entry;
}


// Accessors for the dispatcher — the live scan/update flags merged the same way the old
// inline /api/modules handler did.
function getCache() { return modulesCache; }
function liveState() {
  return { scanInProgress: modulesScanInProgress, scanProgress: modulesScanProgress, activeUpdates: moduleUpdatesActive,
    updateLog: moduleUpdateLog, updateAllRunning: moduleUpdateAllRunning, updateAllProgress: moduleUpdateAllProgress,
    autoUpdate: getAutoUpdateConfig(), autoUpdateLog, autoUpdateRunning, cleanup: getCleanupState() };
}
// Full GET /api/modules payload (cache + live flags; same keys whether or not a scan has run).
function apiState() {
  return modulesCache
    ? { ...modulesCache, ...liveState() }
    : { generated_at: null, summary: {}, projects: [], outdated: [], ...liveState() };
}
function isScanning() { return modulesScanInProgress; }
function scanProgress() { return modulesScanProgress; }
function isUpdateAllRunning() { return moduleUpdateAllRunning; }
function updateAllProgress() { return moduleUpdateAllProgress; }
function isAutoUpdateRunning() { return autoUpdateRunning; }
function clearUpdateLog() { moduleUpdateLog = []; if (modulesCache) modulesCache.updateLog = []; saveModulesCache(); }
function clearAutoUpdateLog() { autoUpdateLog = []; if (modulesCache) modulesCache.autoUpdateLog = []; saveModulesCache(); }
function clearCleanupLog() { cleanupLog = []; if (modulesCache) modulesCache.cleanupLog = []; saveModulesCache(); }
function exportSettings() { return { autoUpdate: getAutoUpdateConfig(), cleanup: getCleanupConfig() }; }

module.exports = {
  MODULES_INTERVAL_MS, DEFAULT_AUTO_UPDATE, DEFAULT_CLEANUP,
  loadModulesCache, saveModulesCache, collectModules, runModuleUpdate, runUpdateAllPass,
  getAutoUpdateConfig, setAutoUpdateConfig, runAutoUpdatePass, autoUpdateTick,
  getCleanupConfig, setCleanupConfig, getCleanupState, measureCleanup, runCleanup,
  getCache, liveState, apiState, isScanning, scanProgress, isUpdateAllRunning, updateAllProgress, isAutoUpdateRunning,
  clearUpdateLog, clearAutoUpdateLog, clearCleanupLog, exportSettings,
};
