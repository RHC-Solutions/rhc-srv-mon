'use strict';
// Claude Code CLI for site / SSH users: the official native installer, run as the user, so each
// account gets its own self-updating copy in ~/.local/bin (the layout every site user here already has).
// Never fatal — a site or SSH user without the CLI is still a working account.
const fs = require('fs');
const runtime = require('./runtime');
const users = require('./users');

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash';
const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';

// ~/.bashrc must put ~/.local/bin on PATH. Appends with a leading newline so a file that does not
// end in one (the old skeleton ended in "umask 007") never turns into "umask 007export …".
function ensurePath(user) {
  const ent = users.getent(user); if (!ent) return false;
  const rc = ent.home + '/.bashrc';
  let txt = ''; try { if (fs.lstatSync(rc).isSymbolicLink()) return false; txt = fs.readFileSync(rc, 'utf8'); } catch (_) {}
  if (txt.includes('.local/bin')) return false;
  fs.appendFileSync(rc, (txt && !txt.endsWith('\n') ? '\n' : '') + '\n# Claude Code CLI\n' + PATH_LINE + '\n');
  try { fs.chownSync(rc, ent.uid, ent.gid); } catch (_) {}
  return true;
}

// → { ok, version, output }
async function install(user) {
  if (!users.getent(user)) return { ok: false, output: 'unknown unix user ' + user };
  const have = await runtime.asUser(user, '~/.local/bin/claude --version', { timeout: 30_000 });
  if (!have.ok) {
    const r = await runtime.asUser(user, INSTALL, { timeout: 5 * 60_000 });
    if (!r.ok) return { ok: false, output: r.output };
  }
  ensurePath(user);
  const v = await runtime.asUser(user, '~/.local/bin/claude --version', { timeout: 30_000 });
  return { ok: v.ok, version: v.ok ? v.output.trim().split('\n').pop() : null, output: v.output };
}

module.exports = { install, ensurePath };
