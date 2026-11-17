'use strict';
// The panel's own repo sync (rhc-autocommit.timer → /usr/local/sbin/rhc-autocommit): commits and syncs
// with the panel's one repo, RHC-Solutions/rhc-srv-mon (lib/panelrepo.js), and nothing else.
// The script lives in resources/rhc-autocommit.sh; at start the panel (root) writes it over the installed
// copy when they differ. Only where the service already exists: a server that never had auto-commit set
// up is not made to push to GitHub.
const fs = require('fs');
const path = require('path');
const { APP_ROOT } = require('./config');

const SCRIPT = '/usr/local/sbin/rhc-autocommit';
const SERVICE = '/etc/systemd/system/rhc-autocommit.service';
const SRC = path.join(APP_ROOT, 'resources', 'rhc-autocommit.sh');

function ensure() {
  if (!fs.existsSync(SERVICE) || !fs.existsSync(path.join(APP_ROOT, '.git'))) return false;
  const body = fs.readFileSync(SRC, 'utf8').replace(/^D=\/opt\/sb-srv-mon$/m, 'D=' + APP_ROOT);
  let cur = null; try { cur = fs.readFileSync(SCRIPT, 'utf8'); } catch (_) {}
  if (cur === body) return false;
  fs.writeFileSync(SCRIPT + '.new', body, { mode: 0o755 });
  fs.renameSync(SCRIPT + '.new', SCRIPT);
  const svc = fs.readFileSync(SERVICE, 'utf8');
  const desc = 'Description=Commit sb-srv-mon and sync it with RHC-Solutions/rhc-srv-mon';
  if (!svc.includes(desc)) fs.writeFileSync(SERVICE, svc.replace(/^Description=.*$/m, desc));
  return true;
}

module.exports = { ensure };
