'use strict';
/* ---------------------------------------------------------------- history */
// history: { "<user>/<app>": [[epochSec, state], ...] }  state: 1 up, 0 down, 2 restarted
// Also holds the "db::<name>" series written by postgres.js via series()/record().
const fs = require('fs');
const os = require('os');
const path = require('path');
const { APP_ROOT } = require('./config');
const { collect } = require('./collect');

const SAMPLE_MS = 60_000;            // heartbeat sampling interval
const HISTORY_MAX = 1440;            // keep 24h of samples per app
const BEATS_SHOWN = 50;              // beats rendered per bar
const HISTORY_FILE = path.join(APP_ROOT, 'history.json');

let history = {};
let prevRestarts = {};

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (data && typeof data === 'object') { history = data.history || {}; prevRestarts = data.prevRestarts || {}; }
  } catch (_) { /* first run */ }
}

let lastSaved = 0;
function saveHistory(force) {
  const now = Date.now();
  if (!force && now - lastSaved < 5 * 60_000) return;
  lastSaved = now;
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify({ history, prevRestarts }));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) { console.error('history save failed:', e.message); }
}

let latest = null;           // last collected groups
let latestAt = 0;

async function sample() {
  let groups;
  try { groups = await collect(); } catch (e) { console.error('collect failed:', e.message); return; }
  latest = groups; latestAt = Date.now();
  const t = Math.floor(Date.now() / 1000);
  for (const g of groups) {
    if (g.error) continue;                      // daemon unreachable: skip, don't fake "down" for all apps
    for (const p of g.processes) {
      const key = `${g.user}/${p.name}`;
      let state = p.status === 'online' ? 1 : 0;
      if (state === 1 && prevRestarts[key] != null && p.restarts > prevRestarts[key]) state = 2;
      prevRestarts[key] = p.restarts;
      const arr = history[key] || (history[key] = []);
      arr.push([t, state]);
      if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
    }
  }
  saveHistory(false);
}

function uptimePct(arr) {
  if (!arr || !arr.length) return null;
  const up = arr.filter((b) => b[1] !== 0).length;
  return (up / arr.length) * 100;
}

function buildPayload() {
  const groups = (latest || []).map((g) => ({
    user: g.user,
    pm2_home: g.pm2_home,
    error: g.error,
    processes: g.processes.map((p) => {
      const key = `${g.user}/${p.name}`;
      const arr = history[key] || [];
      return { ...p, beats: arr.slice(-BEATS_SHOWN), uptime24h: uptimePct(arr) };
    }),
  }));
  const all = groups.flatMap((g) => g.processes);
  return {
    generated_at: new Date(latestAt || Date.now()).toISOString(),
    hostname: os.hostname(),
    sample_interval_s: SAMPLE_MS / 1000,
    summary: {
      daemons: groups.length,
      total: all.length,
      online: all.filter((p) => p.status === 'online').length,
      down: all.filter((p) => p.status !== 'online').length,
      memory: all.reduce((s, p) => s + (p.memory || 0), 0),
    },
    groups,
  };
}


// Series accessors for other samplers (postgres): get-or-create the array for a key, push one beat.
function series(key) { return history[key] || (history[key] = []); }
function get(key) { return history[key] || []; }   // read-only: never creates the key
function record(key, state, t) {
  const arr = series(key);
  arr.push([t || Math.floor(Date.now() / 1000), state]);
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  return arr;
}
function getLatest() { return latest; }

module.exports = { SAMPLE_MS, HISTORY_MAX, BEATS_SHOWN, loadHistory, saveHistory, sample, buildPayload, uptimePct, series, get, record, getLatest };
