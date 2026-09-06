'use strict';
// Process-wide constants. APP_ROOT is the repo dir (NOT lib/) — .helpers/, .sessions/ and the
// JSON state files live there and running pty daemons hold absolute paths into .sessions/.
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.RHC_DATA_DIR || APP_ROOT;

module.exports = {
  APP_ROOT,
  DATA_DIR,
  PORT: Number(process.env.PORT) || 8899,
  HOST: '127.0.0.1',
  NO_JOBS: !!process.env.RHC_NO_JOBS,   // dev instance: no schedulers (auto-update, cleanup, backups, …)
  DEV: !!process.env.RHC_DEV,           // rebuild the UI page on every request
  EXEC_TIMEOUT: 10000,
};
