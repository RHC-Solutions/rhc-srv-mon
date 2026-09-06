'use strict';
// Per-site cron jobs materialised as /etc/cron.d/<siteUser> (CloudPanel layout): `MAILTO=""` then one
// line per job in cron.d format (with the user column). cron.d quirks handled: the file name must
// match ^[A-Za-z0-9_-]+$ (dots → ignored file), '%' means newline unless escaped, mode 0644, trailing \n.
const fs = require('fs');
const path = require('path');
const store = require('./store');

const CRON_DIR = '/etc/cron.d';
const FIELD_RE = /^[\d*,\/\-]+$|^\*\/\d+$/;
const NAMES = { month: /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$/i, weekday: /^(sun|mon|tue|wed|thu|fri|sat)$/i };
const PRESETS = { '@hourly': ['0', '*', '*', '*', '*'], '@daily': ['0', '0', '*', '*', '*'], '@weekly': ['0', '0', '*', '*', '0'], '@monthly': ['0', '0', '1', '*', '*'] };

function fileFor(user) { return path.join(CRON_DIR, String(user).replace(/[^A-Za-z0-9_-]/g, '_')); }

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
function validateField(name, v) {
  v = String(v == null ? '' : v).trim();
  if (!v) throw bad('cron: ' + name + ' is required');
  if (FIELD_RE.test(v) || (NAMES[name] && v.split(',').every((p) => NAMES[name].test(p)))) return v;
  throw bad('cron: invalid ' + name + ' "' + v + '"');
}
function validate(job) {
  const j = {};
  if (typeof job.preset === 'string' && PRESETS[job.preset]) [j.minute, j.hour, j.day, j.month, j.weekday] = PRESETS[job.preset];
  else for (const f of ['minute', 'hour', 'day', 'month', 'weekday']) j[f] = validateField(f, job[f]);
  const cmd = String(job.command || '').trim();
  if (!cmd) throw bad('cron: command is required');
  if (/[\n\r]/.test(cmd)) throw bad('cron: command must be a single line');
  if (cmd.length > 1000) throw bad('cron: command too long');
  j.command = cmd;
  return j;
}
function escapeCommand(cmd) { return cmd.replace(/(?<!\\)%/g, '\\%'); }

// Rewrite /etc/cron.d/<user> from the DB rows (or remove it when there are none).
function writeFor(site) {
  const jobs = store.cronJobs.list(site.id);
  const file = fileFor(site.user);
  if (!jobs.length) { try { fs.unlinkSync(file); } catch (_) {} return { file, jobs: 0, removed: true }; }
  const lines = ['MAILTO=""'];
  for (const j of jobs) lines.push([j.minute, j.hour, j.day, j.month, j.weekday, site.user, escapeCommand(j.command)].join(' '));
  fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n', { mode: 0o644 });
  fs.renameSync(file + '.tmp', file);
  fs.chmodSync(file, 0o644);
  return { file, jobs: jobs.length, removed: false };
}
function remove(user) { try { fs.unlinkSync(fileFor(user)); return true; } catch (_) { return false; } }
function readFile(user) { try { return fs.readFileSync(fileFor(user), 'utf8'); } catch (_) { return null; } }

module.exports = { CRON_DIR, PRESETS, fileFor, validate, writeFor, remove, readFile };
