'use strict';
// The bridge from the event log to Telegram/Slack.
//
// events.js has had an `on()` since it was written, with a comment promising that "(later)
// notification rules subscribe to it" — and nothing ever did. Every site action was therefore
// recorded in the Events tab and went no further, which is why starting or stopping a site never
// produced the alert it was supposed to. This module is that missing subscriber.
//
// Deliberately a short allow-list rather than "notify on everything": the log takes every read and
// write the panel makes, and a chat that fires on all of them is one nobody reads. What earns a
// message is a change to whether a site is serving, or a failure.
const events = require('./events');
const notify = require('./notify');
const config = require('./config');

// pm2 control from the Sites tab. `site.pm2.<action>`.
const PM2_ACTION = /^site\.pm2\.(start|stop|restart|reload|resurrect)$/;
// Site lifecycle — creating or deleting a site is worth a line in the chat.
const LIFECYCLE = new Set(['sites.create', 'sites.delete']);

const ICON = { start: '▶️', stop: '⏹', restart: '🔄', reload: '🔁', resurrect: '⏫' };
const STATUS_ICON = { online: '🟢', degraded: '🟡', down: '🔴' };
// Telegram parses Markdown, and a domain or username holding _ or * would otherwise be swallowed.
const esc = (s) => String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
// Inside a code span Telegram takes the text literally, so escaping there would print the
// backslashes — a cron schedule is all asterisks and would come out unreadable. Only the delimiter
// itself has to go.
const code = (s) => '`' + String(s == null ? '' : s).replace(/`/g, "'") + '`';

function pm2Text(row) {
  const action = row.type.slice('site.pm2.'.length);
  const d = row.data || {};
  const results = Array.isArray(d.results) ? d.results : [];
  const failed = results.filter((r) => !r.ok);
  const head = (ICON[action] || '•') + ' *pm2 ' + action + '* · ' + esc(row.site || '?')
    + (failed.length ? ' — *failed*' : '');
  const lines = [head];
  // What the site looks like now — the point of the alert is "is it serving?", not "was the command
  // accepted". refreshSite() re-reads the site before the event is emitted, so this is current.
  if (d.status) lines.push((STATUS_ICON[d.status] || '') + ' now *' + esc(d.status) + '*' + (d.statusReason ? ' — ' + esc(d.statusReason) : ''));
  if (failed.length) for (const f of failed.slice(0, 3)) lines.push(code((f.output || '').split('\n')[0].slice(0, 160)));
  // A stop that a cron will undo within minutes is not really a stop; say so in the alert too.
  if (Array.isArray(d.watchdogs) && d.watchdogs.length) lines.push('⚠️ a cron on this site will start it again: ' + d.watchdogs.slice(0, 3).map((w) => code(w.schedule)).join(', '));
  lines.push('_by ' + esc(row.user || 'system') + (row.ip ? ' from ' + esc(row.ip) : '') + '_');
  return lines.join('\n');
}

function textFor(row) {
  if (PM2_ACTION.test(row.type)) return pm2Text(row);
  if (LIFECYCLE.has(row.type)) return (row.type === 'sites.delete' ? '🗑' : '✨') + ' *' + esc(row.message) + '*\n_by ' + esc(row.user || 'system') + '_';
  // Anything site-scoped that failed outright.
  if (row.level === 'error' && row.site) return '❌ *' + esc(row.site) + '* — ' + esc(row.message) + '\n_by ' + esc(row.user || 'system') + '_';
  return null;
}

function start() {
  // The dev instance runs against the same database, and therefore the same bot token and chat, as
  // the live one. Testing a change to these rules must not page the real chat.
  if (config.DEV) { console.log('notify-events: RHC_DEV set, site notifications are logged not sent'); }
  events.on((row) => {
    let text;
    try { text = textFor(row); } catch (_) { return; }
    if (!text) return;
    if (config.DEV) { console.log('notify-events (would send):\n' + text); return; }
    // Fire and forget: a chat that is unreachable must never make the action that caused it fail.
    notify.send(text, 'site').catch(() => {});
  });
}

module.exports = { start, textFor };
