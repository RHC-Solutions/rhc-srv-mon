'use strict';
// AI coding agents (Updates → AI agents): a catalog of the major CLI agents plus custom ones.
//
// A tracked agent becomes an Updates component like Claude Code: its version is checked for root and
// every site/SSH user, it can be updated and removed, and it can be DEPLOYED (installed) for any of
// those users. npm agents install into the user's own prefix (~/.npm-global, on PATH via ~/.bashrc)
// — or system-wide for root; script agents run their vendor installer as the user.
// Custom agents: name + command + either an npm package or an install command (+ optional update
// command). Stored in kv: agents.tracked (keys), agents.custom (definitions).
const fs = require('fs');
const { settings } = require('./db');
const { execP } = require('./util');

const CATALOG = [
  { key: 'codex',    label: 'OpenAI Codex CLI',   bin: 'codex',        pkg: '@openai/codex',         vendor: 'OpenAI' },
  { key: 'gemini',   label: 'Gemini CLI',         bin: 'gemini',       pkg: '@google/gemini-cli',    vendor: 'Google' },
  { key: 'copilot',  label: 'GitHub Copilot CLI', bin: 'copilot',      pkg: '@github/copilot',       vendor: 'GitHub' },
  { key: 'qwen',     label: 'Qwen Code',          bin: 'qwen',         pkg: '@qwen-code/qwen-code',  vendor: 'Alibaba' },
  { key: 'opencode', label: 'OpenCode',           bin: 'opencode',     pkg: 'opencode-ai',           vendor: 'SST' },
  { key: 'amp',      label: 'Amp',                bin: 'amp',          pkg: '@sourcegraph/amp',      vendor: 'Sourcegraph' },
  { key: 'crush',    label: 'Crush',              bin: 'crush',        pkg: '@charmland/crush',      vendor: 'Charm' },
  { key: 'cursor',   label: 'Cursor CLI',         bin: 'cursor-agent', installCmd: 'curl -fsSL https://cursor.com/install | bash', updateCmd: 'cursor-agent update', vendor: 'Cursor' },
  { key: 'aider',    label: 'Aider',              bin: 'aider',        installCmd: 'curl -LsSf https://aider.chat/install.sh | sh', vendor: 'Aider' },
];
const bad = (m, s) => Object.assign(new Error(m), { status: s || 400 });
const KEY_RE = /^[a-z][a-z0-9-]{1,30}$/, BIN_RE = /^[A-Za-z0-9._-]{1,40}$/, PKG_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;

// The version flag is spliced into shell commands (version checks run as each user, root included):
// one plain word only. Stored entries from before this check are cleaned on read.
const VERFLAG_RE = /^-{0,2}[A-Za-z][A-Za-z0-9-]{0,20}$/;
const custom = () => (settings.get('agents.custom', []) || []).map((a) => (VERFLAG_RE.test(String(a.verFlag || '')) ? a : Object.assign({}, a, { verFlag: '--version' })));
const tracked = () => settings.get('agents.tracked', []) || [];
function all() { return [...CATALOG.map((a) => Object.assign({ builtin: true }, a)), ...custom().map((a) => Object.assign({ custom: true }, a))]; }
function find(key) { return all().find((a) => a.key === key) || null; }

// Updates components for the tracked agents (Claude Code itself is a built-in component).
function components() {
  const t = new Set(tracked());
  return all().filter((a) => t.has(a.key) || a.custom).map((a) => ({ key: a.key, label: a.label, bin: a.bin, pkg: a.pkg || null, verFlag: a.verFlag || '--version', agent: true, vendor: a.vendor || 'custom',
    installCmd: a.installCmd || null,
    // system-wide (root) update: npm agents use npm update -g; script agents re-run their updater
    updateCmd: a.pkg ? null : ['bash', '-lc', 'export PATH="$HOME/.local/bin:$PATH"; ' + (a.updateCmd || a.installCmd)] }));
}
function setTracked(keys) {
  const known = new Set(all().map((a) => a.key));
  const list = [...new Set((keys || []).map(String))].filter((k) => known.has(k));
  settings.set('agents.tracked', list);
  return list;
}
function addCustom(b) {
  const label = String(b.label || '').trim(), bin = String(b.bin || '').trim(), pkg = String(b.pkg || '').trim(), installCmd = String(b.installCmd || '').trim(), updateCmd = String(b.updateCmd || '').trim();
  const key = 'x-' + (String(b.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'agent');
  if (!label || label.length > 60) throw bad('name: 1–60 characters');
  if (!BIN_RE.test(bin)) throw bad('command: the program name, e.g. "myagent"');
  if (!pkg && !installCmd) throw bad('give an npm package or an install command');
  if (pkg && !PKG_RE.test(pkg)) throw bad('invalid npm package name');
  if (installCmd.length > 500 || updateCmd.length > 500 || /[\r\n]/.test(installCmd + updateCmd)) throw bad('commands: one line, at most 500 characters');
  if (!KEY_RE.test(key) || find(key)) throw bad('an agent with that name exists already');
  const a = { key, label, bin, pkg: pkg || null, installCmd: pkg ? null : installCmd, updateCmd: updateCmd || null, verFlag: String(b.verFlag || '--version').trim() || '--version' };
  if (!VERFLAG_RE.test(a.verFlag)) throw bad('version flag: one word like --version, -v or version');
  settings.set('agents.custom', [...custom(), a]);
  return a;
}
function removeCustom(key) {
  if (!custom().some((a) => a.key === key)) throw bad('no custom agent ' + key, 404);
  settings.set('agents.custom', custom().filter((a) => a.key !== key));
  settings.set('agents.tracked', tracked().filter((k) => k !== key));
}

// Deploy (install) an agent for one unix user. → { ok, user, version, output }
async function install(key, user) {
  const users = require('./sites/users');
  if (user !== 'root' && !users.getent(user)) return { ok: false, user, output: 'unknown unix user ' + user };
  if (key === 'claude') { const r = await require('./sites/claude').install(user); return Object.assign({ user }, r); }
  const a = find(key); if (!a) return { ok: false, user, output: 'unknown agent ' + key };
  const asU = (sh, t) => execP('sudo', ['-n', '-H', '-u', user, 'bash', '-lc', 'cd ~ && ' + sh + ' 2>&1'], { timeout: t || 10 * 60_000 });
  let r;
  if (a.pkg && user === 'root') r = await execP('npm', ['install', '-g', a.pkg + '@latest'], { timeout: 10 * 60_000 });
  else if (a.pkg) {
    r = await asU('mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g ' + a.pkg + '@latest');
    ensurePath(user, '$HOME/.npm-global/bin', 'npm global packages (AI agents)');
  } else {
    r = await asU(a.installCmd);
    ensurePath(user, '$HOME/.local/bin', 'user programs (AI agents)');
  }
  const v = await asU('export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"; ' + a.bin + ' ' + (a.verFlag || '--version'), 60_000);
  const ver = (((v.stdout || '') + (v.stderr || '')).match(/\d+\.\d+[\w.\-]*/) || [])[0] || null;
  return { ok: !r.err && !v.err, user, version: ver, output: (((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-6).join('\n')) };
}
// PATH for the user's own installs, in BOTH ~/.profile (login shells: SSH, cron's bash -l, scripts)
// and ~/.bashrc (interactive non-login shells) — Debian's .bashrc returns early when not interactive,
// so a line there alone never reaches a login shell, which then keeps finding an older system copy.
function ensurePath(user, dir, why) {
  const ent = user === 'root' ? { home: '/root', uid: 0, gid: 0 } : require('./sites/users').getent(user);
  if (!ent) return;
  for (const f of ['.profile', '.bashrc']) {
    const rc = ent.home + '/' + f;
    let txt = ''; try { if (fs.lstatSync(rc).isSymbolicLink()) continue; txt = fs.readFileSync(rc, 'utf8'); } catch (_) {}
    if (txt.includes('export PATH="' + dir + ':')) continue;
    fs.appendFileSync(rc, (txt && !txt.endsWith('\n') ? '\n' : '') + '\n# ' + why + '\nexport PATH="' + dir + ':$PATH"\n');
    try { fs.chownSync(rc, ent.uid, ent.gid); } catch (_) {}
  }
}
// Update a script-installed agent for a user (npm/native ones go through runUserUpdate).
async function scriptUpdate(key, user) {
  const a = find(key); if (!a) return { err: new Error('unknown agent'), out: '' };
  const cmd = a.updateCmd ? 'export PATH="$HOME/.local/bin:$PATH"; ' + a.updateCmd : a.installCmd;
  const r = await execP('sudo', ['-n', '-H', '-u', user, 'bash', '-lc', 'cd ~ && ' + cmd + ' 2>&1'], { timeout: 10 * 60_000 });
  return { err: r.err, out: ((r.stdout || '') + (r.stderr || '')).trim() };
}

module.exports = { CATALOG, all, find, components, tracked, setTracked, addCustom, removeCustom, install, scriptUpdate };
