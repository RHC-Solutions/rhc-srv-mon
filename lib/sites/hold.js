'use strict';
// Sites a person stopped on purpose, and the guarantee that they stay stopped.
//
// A whole-site stop from the panel puts the site on hold; only a start/restart/resurrect from the
// panel takes it off again. Until then the site reads "Stopped" (not Down/Degraded, which is what
// got lumenloom.studio "fixed" back online on 2026-10-22 while it was meant to be off), and every
// few minutes anything that brought one of its apps back online behind the panel's back — a cron,
// a shell, a script — is stopped again and reported.
const { settings } = require('../db');
const events = require('../events');
const notify = require('../notify');

const KEY = 'sites.heldStopped';

const all = () => settings.get(KEY, {}) || {};
const get = (domain) => all()[domain] || null;
function set(domain, by) {
  const a = all();
  if (a[domain]) return;   // already held: keep who stopped it first, and when
  a[domain] = { by: by || 'unknown', at: new Date().toISOString() };
  settings.set(KEY, a);
}
function clear(domain) {
  const a = all();
  if (!a[domain]) return false;
  delete a[domain];
  settings.set(KEY, a);
  return true;
}

let running = false;
async function enforce() {
  if (running) return [];
  running = true;
  const out = [];
  try {
    const store = require('./store');
    const procs = require('./procs');
    for (const [domain, h] of Object.entries(all())) {
      const site = store.get(domain);
      if (!site) continue;
      let live;
      try { live = await procs.list(site, { live: true }); } catch (_) { continue; }
      const up = (live.processes || []).filter((p) => p.status === 'online' || p.status === 'launching');
      if (!up.length) continue;
      const r = await procs.act(site, 'stop');
      const names = up.map((p) => p.name).join(', ');
      out.push({ domain, apps: names, ok: r.ok });
      events.emit('site.pm2.hold_enforced', { user: 'system', site: domain, level: r.ok ? 'warn' : 'error',
        message: (r.ok ? 'Stopped again' : 'Failed to stop again') + ' ' + domain + ' (held stopped by ' + h.by + ' since ' + h.at + '): ' + names + ' had come back online outside the panel',
        data: { held: h, apps: up.map((p) => ({ name: p.name, user: p.pm2User })) } });
      const esc = (s) => String(s).replace(/([_*`\[])/g, '\\$1');
      notify.send((r.ok ? '⏹ ' : '❌ ') + '*' + esc(domain) + '* is held stopped (by ' + esc(h.by) + ') but ' + esc(names) + ' came back online outside the panel — '
        + (r.ok ? 'stopped again' : 'stopping it again FAILED') + '. Start it from the panel to release the hold.', 'site').catch(() => {});
    }
  } finally { running = false; }
  return out;
}

module.exports = { all, get, set, clear, enforce };
