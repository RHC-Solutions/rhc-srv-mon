'use strict';
// The panel's one and only GitHub repo: RHC-Solutions/rhc-srv-mon. Every server that runs the panel
// takes its updates from it (Updates › Update from GitHub follows main's upstream), and the
// auto-commit (resources/rhc-autocommit.sh) commits and syncs only with it.
// At start the checkout is put right: a remote pointing at the repo (origin, added or re-pointed
// when missing), main tracking it, and remotes of retired repos (roman-synergybeam/sbsrvman) removed.
const { execFileSync } = require('child_process');
const { APP_ROOT } = require('./config');

const REPO = 'RHC-Solutions/rhc-srv-mon';
const URL = 'https://github.com/' + REPO + '.git';
const IS_CANON = /[:/]RHC-Solutions\/rhc-srv-mon(\.git)?\/?$/i;
const RETIRED = [/[:/]roman-synergybeam\/sbsrvman(\.git)?\/?$/i];

const git = (args) => execFileSync('git', ['-C', APP_ROOT, ...args], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function remotes() {
  const out = {};
  for (const l of git(['remote', '-v']).split('\n')) { const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/); if (m) out[m[1]] = m[2]; }
  return out;
}

// Returns what it changed ([] when the checkout was already right).
function ensure() {
  const changed = [];
  try { git(['rev-parse', '--git-dir']); } catch (_) { return changed; }
  let r = remotes();
  let name = Object.keys(r).find((n) => IS_CANON.test(r[n]));
  if (!name) {
    if (r.origin) { git(['remote', 'set-url', 'origin', URL]); changed.push('origin re-pointed from ' + r.origin + ' to ' + URL); }
    else { git(['remote', 'add', 'origin', URL]); changed.push('origin added: ' + URL); }
    name = 'origin';
  }
  r = remotes();
  for (const [n, u] of Object.entries(r)) {
    if (n !== name && RETIRED.some((re) => re.test(u))) { git(['remote', 'remove', n]); changed.push('removed remote ' + n + ' (' + u + ')'); }
  }
  let branch = ''; try { branch = git(['branch', '--show-current']); } catch (_) {}
  if (branch === 'main') {
    let cur = ''; try { cur = git(['config', '--get', 'branch.main.remote']); } catch (_) {}
    if (cur !== name) {
      git(['config', 'branch.main.remote', name]); git(['config', 'branch.main.merge', 'refs/heads/main']);
      changed.push('main now tracks ' + name + '/main' + (cur ? ' (was ' + cur + ')' : ''));
    }
  }
  return changed;
}

module.exports = { ensure, REPO, URL, IS_CANON };
