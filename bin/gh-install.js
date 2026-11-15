#!/usr/bin/env node
'use strict';
// Install the latest GitHub CLI release (Updates → GitHub CLI). Run as root. See lib/ghcli.js.
require('../lib/ghcli').install((l) => console.log(l))
  .then(() => process.exit(0))
  .catch((e) => { console.error(e.message + (e.detail ? '\n' + e.detail : '')); process.exit(1); });
