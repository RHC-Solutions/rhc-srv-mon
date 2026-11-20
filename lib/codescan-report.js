'use strict';
// The code-scan report (lib/codescan.js): after each scheduled round — or on demand — one message to
// Telegram (summary + the worst findings, within Telegram's 4096-character limit) and one detailed
// e-mail through Brevo (every site, every critical/high finding with file:line or package + fix, the
// medium ones listed, change since the previous scan). Channels come from Settings › Notifications;
// the schedule's own switches (codescan.schedule.report) pick which of them get the report.
const os = require('os');

const SEVS = ['critical', 'high', 'medium', 'low'];
const htmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mdEsc = (s) => String(s == null ? '' : s).replace(/([_*`\[])/g, '\\$1');
const code = (s) => '`' + String(s == null ? '' : s).replace(/`/g, "'") + '`';
const sevOf = (s) => (s === 'moderate' ? 'medium' : s === 'info' ? 'low' : s);
const ICON = { critical: '🟥', high: '🟧', medium: '🟨', low: '⬜' };

// every finding of one site's result, flattened and ranked: { sev, tool, where, what, fix, url }
function findings(r) {
  const out = [];
  for (const f of (r && r.semgrep && r.semgrep.findings) || []) {
    out.push({ sev: f.severity, tool: 'Semgrep', where: f.path + (f.line ? ':' + f.line : ''), what: f.rule.split('.').pop() + ' — ' + f.message, fix: null, url: f.url, cwe: f.cwe });
  }
  for (const a of [].concat((r && r.npm) || [], (r && r.pip) || [])) {
    for (const v of a.vulns || []) out.push({ sev: sevOf(v.severity), tool: a.tool || 'npm', where: (a.dir && a.dir !== '.' ? a.dir + ' › ' : '') + v.name, what: v.title, fix: v.fix, url: v.url });
  }
  out.sort((x, y) => SEVS.indexOf(x.sev) - SEVS.indexOf(y.sev));
  return out;
}
const problems = (r) => {
  const p = [];
  if (r && r.error) p.push(r.error);
  if (r && r.semgrep && (r.semgrep.error || r.semgrep.skipped)) p.push(r.semgrep.error || r.semgrep.skipped);
  for (const a of [].concat((r && r.npm) || [], (r && r.pip) || [])) if (a.error) p.push(a.error);
  return p;
};
const zero = { critical: 0, high: 0, medium: 0, low: 0 };
const delta = (c, p) => { if (!p) return null; const d = (c.critical + c.high) - (p.critical + p.high); return d; };

// sites: [{ domain, result, prev }]  (prev = the result before this round, for the change column)
// sweep: lib/sites/codesweep.js reportData() — optional
function build(sites, meta, sweep) {
  const host = os.hostname();
  const tot = Object.assign({}, zero);
  for (const s of sites) for (const k of SEVS) tot[k] += ((s.result && s.result.counts) || zero)[k];
  const worse = sites.filter((s) => (delta((s.result && s.result.counts) || zero, s.prev && s.prev.counts) || 0) > 0);
  const subject = '[' + host + '] Code scan: ' + tot.critical + ' critical, ' + tot.high + ' high across ' + sites.length + ' site(s)' + (worse.length ? ' — ' + worse.length + ' got worse' : '');

  // ---- Telegram (Markdown, ≤ ~3800 chars after the host line)
  let t = '🔍 *Code scan report* — ' + sites.length + ' site(s)' + (meta && meta.by ? ' · ' + mdEsc(meta.by) : '') + '\n'
    + ICON.critical + ' ' + tot.critical + ' critical · ' + ICON.high + ' ' + tot.high + ' high · ' + ICON.medium + ' ' + tot.medium + ' medium · ' + tot.low + ' low\n';
  const ranked = sites.slice().sort((a, b) => { const ca = (a.result && a.result.counts) || zero, cb = (b.result && b.result.counts) || zero; return cb.critical - ca.critical || cb.high - ca.high || cb.medium - ca.medium || a.domain.localeCompare(b.domain); });
  t += '\n*Sites*\n';
  for (const s of ranked) {
    const c = (s.result && s.result.counts) || zero, d = delta(c, s.prev && s.prev.counts), p = problems(s.result);
    t += (c.critical ? ICON.critical : c.high ? ICON.high : c.medium ? ICON.medium : '✅') + ' ' + code(s.domain) + ' ' + c.critical + '/' + c.high + '/' + c.medium + '/' + c.low
      + (d ? (d > 0 ? ' ⬆️ +' + d : ' ⬇️ ' + d) + ' crit/high' : '') + (p.length ? ' ⚠️ ' + mdEsc(p[0].slice(0, 80)) : '') + '\n';
  }
  const top = [];
  for (const s of ranked) for (const f of findings(s.result)) if (f.sev === 'critical' || f.sev === 'high') top.push({ s: s.domain, f });
  top.sort((x, y) => SEVS.indexOf(x.f.sev) - SEVS.indexOf(y.f.sev));
  if (top.length) {
    t += '\n*Critical & high*\n';
    let shown = 0;
    for (const { s, f } of top) {
      const line = ICON[f.sev] + ' ' + mdEsc(s) + ' · ' + mdEsc(f.tool) + ' · ' + code(f.where.slice(0, 90)) + '\n   ' + mdEsc(String(f.what).slice(0, 140)) + (f.fix ? ' → fix: ' + mdEsc(f.fix) : '') + '\n';
      if (t.length + line.length > 3500) break;
      t += line; shown++;
    }
    if (shown < top.length) t += '…and ' + (top.length - shown) + ' more — full list in the e-mail report and on Security › Code scan\n';
  }
  if (sweep) {
    const found = sweep.reduce((n, x) => n + x.findings.length, 0);
    let sw = '\n*HCL AppScan CodeSweep* (pull requests) — ' + sweep.length + ' repo(s), ' + found + ' finding(s) in the latest PR scans\n';
    for (const x of sweep) sw += (x.findings.length ? '🟧 ' : x.scanned ? '✅ ' : '▫️ ') + code(x.domain) + ' ' + (x.scanned ? mdEsc(x.scanned.conclusion || 'running') + ' · ' + mdEsc(String(x.scanned.title).slice(0, 50)) + (x.findings.length ? ' · ' + x.findings.length + ' finding(s)' : '') : mdEsc(x.error || 'no pull request scanned yet')) + '\n';
    if (t.length + sw.length < 3900) t += sw; else t += '\n*CodeSweep*: ' + found + ' finding(s) — details in the e-mail\n';
  }
  t += '\n_counts: critical/high/medium/low_';

  // ---- e-mail (HTML)
  const cell = 'padding:4px 8px;border-bottom:1px solid #e3e3e3;vertical-align:top;text-align:left';
  const pill = (sev, n) => '<span style="display:inline-block;min-width:22px;padding:1px 6px;border-radius:9px;color:#fff;font-weight:600;text-align:center;background:' + ({ critical: '#b71c1c', high: '#e65100', medium: '#b28900', low: '#757575' }[sev]) + (n ? '' : ';opacity:.35') + '">' + n + '</span>';
  let h = '<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:14px;line-height:1.45;color:#222">'
    + '<h2 style="margin:0 0 4px">🔍 Code scan report — ' + htmlEsc(host) + '</h2>'
    + '<p style="margin:0 0 12px;color:#666">' + sites.length + ' site(s) · Semgrep, npm/pnpm audit, pip-audit · ' + htmlEsc(new Date().toUTCString()) + (meta && meta.by ? ' · ' + htmlEsc(meta.by) : '') + '</p>'
    + '<p>' + SEVS.map((k) => pill(k, tot[k]) + ' ' + k).join(' &nbsp; ') + '</p>'
    + '<table style="border-collapse:collapse;width:100%;margin:8px 0 18px"><tr><th style="' + cell + '">Site</th><th style="' + cell + '">Critical</th><th style="' + cell + '">High</th><th style="' + cell + '">Medium</th><th style="' + cell + '">Low</th><th style="' + cell + '">Change (crit+high)</th><th style="' + cell + '">Scan</th></tr>';
  for (const s of ranked) {
    const c = (s.result && s.result.counts) || zero, d = delta(c, s.prev && s.prev.counts), p = problems(s.result);
    h += '<tr><td style="' + cell + '"><b>' + htmlEsc(s.domain) + '</b></td>' + SEVS.map((k) => '<td style="' + cell + '">' + pill(k, c[k]) + '</td>').join('')
      + '<td style="' + cell + '">' + (d == null ? 'first scan' : d > 0 ? '<b style="color:#b71c1c">+' + d + '</b>' : d < 0 ? '<span style="color:#2e7d32">' + d + '</span>' : '–') + '</td>'
      + '<td style="' + cell + ';color:#666;font-size:12.5px">' + (s.result ? htmlEsc(new Date(s.result.at).toLocaleString('en-GB')) + (s.result.duration_ms ? ' · ' + Math.round(s.result.duration_ms / 1000) + ' s' : '') : 'not scanned') + (p.length ? '<br><span style="color:#b71c1c">⚠ ' + htmlEsc(p.join(' · ').slice(0, 300)) + '</span>' : '') + '</td></tr>';
  }
  h += '</table>';
  for (const s of ranked) {
    const all = findings(s.result);
    if (!all.length) continue;
    const ch = all.filter((f) => f.sev === 'critical' || f.sev === 'high'), med = all.filter((f) => f.sev === 'medium'), low = all.length - ch.length - med.length;
    h += '<h3 style="margin:18px 0 6px">' + htmlEsc(s.domain) + '</h3><table style="border-collapse:collapse;width:100%"><tr><th style="' + cell + '">Severity</th><th style="' + cell + '">Tool</th><th style="' + cell + '">Where</th><th style="' + cell + '">What</th><th style="' + cell + '">Fix</th></tr>';
    for (const f of ch.concat(med.slice(0, 50))) {
      h += '<tr><td style="' + cell + '">' + pill(f.sev, f.sev) + '</td><td style="' + cell + '">' + htmlEsc(f.tool) + '</td><td style="' + cell + ';font-family:monospace;font-size:12.5px">' + htmlEsc(f.where) + '</td>'
        + '<td style="' + cell + '">' + (f.url ? '<a href="' + htmlEsc(f.url) + '">' + htmlEsc(String(f.what).slice(0, 400)) + '</a>' : htmlEsc(String(f.what).slice(0, 400))) + (f.cwe ? '<br><span style="color:#666;font-size:12px">' + htmlEsc(f.cwe) + '</span>' : '') + '</td>'
        + '<td style="' + cell + ';font-size:12.5px">' + htmlEsc(f.fix || '') + '</td></tr>';
    }
    h += '</table>' + (med.length > 50 || low ? '<p style="color:#666;font-size:12.5px;margin:4px 0">' + (med.length > 50 ? (med.length - 50) + ' more medium · ' : '') + (low ? low + ' low' : '') + ' — on the site\'s Security tab in the panel</p>' : '');
  }
  if (sweep) {
    h += '<h2 style="margin:26px 0 4px">HCL AppScan CodeSweep — pull-request scans on GitHub</h2><p style="margin:0 0 8px;color:#666">The newest scanned pull request per repo and what it found. CodeSweep scans only the code a PR changes.</p>'
      + '<table style="border-collapse:collapse;width:100%"><tr><th style="' + cell + '">Site</th><th style="' + cell + '">Repo</th><th style="' + cell + '">Latest PR scan</th><th style="' + cell + '">Findings</th></tr>';
    for (const x of sweep) h += '<tr><td style="' + cell + '"><b>' + htmlEsc(x.domain) + '</b></td><td style="' + cell + '"><a href="https://github.com/' + htmlEsc(x.repo) + '">' + htmlEsc(x.repo) + '</a></td><td style="' + cell + '">'
      + (x.scanned ? '<a href="' + htmlEsc(x.scanned.url) + '">' + htmlEsc(x.scanned.title) + '</a><br><span style="color:#666;font-size:12px">' + htmlEsc(x.scanned.conclusion || 'running') + ' · ' + htmlEsc(new Date(x.scanned.at).toLocaleString('en-GB')) + '</span>' : '<span style="color:#666">' + htmlEsc(x.error || 'no pull request scanned yet') + '</span>')
      + '</td><td style="' + cell + '">' + x.findings.length + '</td></tr>';
    h += '</table>';
    for (const x of sweep.filter((y) => y.findings.length)) {
      h += '<h3 style="margin:14px 0 6px">' + htmlEsc(x.domain) + ' — CodeSweep</h3><table style="border-collapse:collapse;width:100%"><tr><th style="' + cell + '">Level</th><th style="' + cell + '">Where</th><th style="' + cell + '">What</th></tr>';
      for (const f of x.findings.slice(0, 100)) h += '<tr><td style="' + cell + '">' + htmlEsc(f.level) + '</td><td style="' + cell + ';font-family:monospace;font-size:12.5px">' + htmlEsc(f.path + (f.line ? ':' + f.line : '')) + '</td><td style="' + cell + '">' + htmlEsc((f.title ? f.title + ' — ' : '') + f.message) + '</td></tr>';
      h += '</table>';
    }
  }
  h += '<p style="color:#888;font-size:12px;margin-top:20px">Sent by RHC SRV MAN (Security › Code scan). Schedule and recipients: Security › Code scan and Settings › Notifications.</p></div>';

  // plain-text alternative for the e-mail
  const text = t.replace(/\\([_*`\[])/g, '$1').replace(/[*`]/g, '');
  return { subject, telegram: t, html: h, text };
}

// sends to the channels switched on for the report (and configured in Settings › Notifications)
async function send(rep, channels) {
  const notify = require('./notify');
  const out = {};
  const head = await notify.hostLine();
  const tg = notify.getConfig(), br = notify.getBrevo();
  if (channels.telegram !== false) out.telegram = tg && tg.enabled ? await notify.sendTelegram(head + '\n' + rep.telegram) : { ok: false, skipped: true, error: 'Telegram is not set up (Settings › Notifications)' };
  if (channels.email !== false) out.email = br && br.enabled ? await notify.sendBrevo(rep.text, null, rep.subject, rep.html) : { ok: false, skipped: true, error: 'e-mail (Brevo) is not set up (Settings › Notifications)' };
  return out;
}

module.exports = { build, send, findings };
