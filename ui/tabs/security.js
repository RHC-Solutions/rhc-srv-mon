// ---- Security: IP intel (ipinfo.io / AbuseIPDB), fail2ban, block rules by IP / range / ASN / country.
let secData = null, secLoading = false, secIntel = {}, secLookup = null;
async function loadSecurity(){
  secLoading = true;
  try { secData = await stApi('GET', 'api/security'); } catch(e){ secData = { error: e.message }; }
  secLoading = false;
  if (state.tab === 'security') renderSecurity(true);
}
// a flag image (served and cached by the panel, lib/flags.js) — Windows shows flag emoji as two letters
const secFlag = (cc) => cc && /^[A-Z]{2}$/i.test(cc) ? '<img class="flag" src="flag/' + cc.toLowerCase() + '" alt="' + cc.toUpperCase() + '" title="' + cc.toUpperCase() + '" width="20" height="15" loading="lazy" style="vertical-align:-2px;border-radius:2px" onerror="this.replaceWith(this.alt)">' : '';
function secIntelLine(i){
  if (!i) return '<span class="dim">…</span>';
  if (i.error) return '<span class="dim">' + esc(i.error) + '</span>';
  const ab = i.abuse ? ' · <span style="color:' + (i.abuse.score >= 50 ? 'var(--md-error-bright)' : i.abuse.score >= 10 ? 'var(--md-warning)' : 'var(--md-success, #2e7d32)') + '">abuse ' + i.abuse.score + '%</span> <span class="dim">(' + i.abuse.reports + ' reports)</span>' : '';
  return secFlag(i.country) + ' ' + esc([i.country, i.city].filter(Boolean).join(' · ')) + (i.asn ? ' · <span class="mono">' + esc(i.asn) + '</span> ' + esc(i.org || '') : (i.org ? ' · ' + esc(i.org) : '')) + ab;
}
function renderSecurity(fromLoad){
  plainTabHeader('IP lookups (ipinfo.io, AbuseIPDB) and block rules by IP, range, AS or country — fail2ban and ufw are on the Firewall page');
  const view = document.getElementById('securityview');
  if (!secData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!secLoading) loadSecurity(); return; }
  if (!fromLoad && view.contains(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  if (secData.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(secData.error) + '</div>'; return; }
  const c = secData.config;
  let h = '<div class="upd-grid">';
  // lookup
  h += '<div class="upd-card"><h3>Look up an IP</h3><div style="display:flex;gap:8px"><input id="secIp" class="mono" placeholder="203.0.113.10" style="flex:1" onkeydown="if(event.key===\'Enter\')secDoLookup()"><button class="btn pri" onclick="secDoLookup()">Look up</button></div>';
  if (secLookup) {
    const i = secLookup;
    h += i.error ? '<p style="color:var(--md-error-bright)">' + esc(i.error) + '</p>' : '<table class="upd-table" style="margin-top:8px"><tr><td>IP</td><td class="mono">' + esc(i.ip) + (i.hostname ? ' <span class="dim">' + esc(i.hostname) + '</span>' : '') + '</td></tr>'
      + '<tr><td>Location</td><td>' + secFlag(i.country) + ' ' + esc([i.city, i.region, i.country].filter(Boolean).join(', ') || '–') + '</td></tr>'
      + '<tr><td>Network</td><td>' + (i.asn ? '<span class="mono">' + esc(i.asn) + '</span> ' : '') + esc(i.org || '–') + '</td></tr>'
      + '<tr><td>AbuseIPDB</td><td>' + (i.abuse ? i.abuse.score + '% confidence · ' + i.abuse.reports + ' reports · ' + esc(i.abuse.usage || '') + (i.abuse.tor ? ' · Tor' : '') : '<span class="dim">' + (c.hasAbuse ? 'no data' : 'add an AbuseIPDB key below') + '</span>') + '</td></tr></table>'
      + (i.errors && i.errors.length ? '<p class="dim" style="font-size:13px">' + esc(i.errors.join(' · ')) + '</p>' : '')
      + '<div class="site-actions" style="flex-wrap:wrap;gap:6px"><button class="btn small" onclick="secBlock(\'ip\',\'' + esc(i.ip) + '\')">Block this IP</button>'
      + (i.asn ? '<button class="btn small" onclick="secBlock(\'asn\',\'' + esc(i.asn) + '\',\'' + esc((i.org || '').replace(/[\'"]/g, '')) + '\')">Block ' + esc(i.asn) + '</button>' : '')
      + (i.country ? '<button class="btn small" onclick="secBlock(\'country\',\'' + esc(i.country) + '\')">Block country ' + esc(i.country) + '</button>' : '')
      + (c.hasAbuse ? '<button class="btn small" onclick="secReport(\'' + esc(i.ip) + '\')">Report to AbuseIPDB</button>' : '') + '</div>';
  }
  h += '</div>';
  // keys
  h += '<div class="upd-card"><h3>Services</h3><div class="row2">'
    + stField('ipinfo.io token', '<input type="password" id="secIpinfo" autocomplete="new-password" placeholder="' + (c.hasIpinfo ? '•••••••• (stored — leave empty to keep)' : 'optional — free at ipinfo.io/signup') + '">', 'country, city, AS; works without a token at a lower limit')
    + stField('AbuseIPDB API key', '<input type="password" id="secAbuse" autocomplete="new-password" placeholder="' + (c.hasAbuse ? '•••••••• (stored — leave empty to keep)' : 'free at abuseipdb.com/account/api') + '">', 'abuse score; reporting') + '</div>'
    + (c.hasAbuse && secData.abuseUsage ? '<p class="dim" style="font-size:13px;margin:4px 0">AbuseIPDB checks today: ' + secData.abuseUsage.used + ' / 1000 (Firewall list stops at ' + secData.abuseUsage.bulkCap + ', manual lookups at ' + secData.abuseUsage.cap + '; results cached 24 h)' + (secData.abuseUsage.pausedUntil ? ' · <span style="color:var(--md-warning)">paused until ' + esc(new Date(secData.abuseUsage.pausedUntil).toLocaleString()) + '</span>' : '') + '</p>' : '')
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="secReportBans"' + (c.reportBans ? ' checked' : '') + '><span class="slider"></span></label><label>Report new fail2ban bans to AbuseIPDB (admin IPs never)</label></div>'
    + '<div class="site-actions"><button class="btn pri" onclick="secSaveCfg()">Save</button></div></div></div>';
  // rules
  const R = secData.rules || [];
  h += '<div class="upd-card" style="margin-top:14px"><h3>Block rules <span class="dim" style="font-weight:400">' + R.length + '</span>' + (secData.host ? ' <span class="dim" style="font-weight:400;font-size:13px">· ' + secData.host.droppedPackets + ' packets dropped on this server</span>' : '') + '</h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14px"><b>This server</b>: its own firewall (nftables) — SSH and anything reaching the server directly; admin IPs, Cloudflare and loopback always pass. <b>Cloudflare</b>: web visitors of every domain in the account — they arrive through Cloudflare, so this is the only place to block them.</p>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">'
    + stField('Type', '<select id="secType"><option value="ip">IP</option><option value="range">IP range</option><option value="asn">AS number</option><option value="country">Country</option></select>')
    + stField('Value', '<input id="secVal" class="mono" placeholder="203.0.113.10 · 203.0.113.0/24 · AS13335 · CN">')
    + stField('Note', '<input id="secNote" placeholder="optional">')
    + '<label style="padding-bottom:10px"><input type="checkbox" id="secScHost" checked> This server</label><label style="padding-bottom:10px"><input type="checkbox" id="secScCf" checked> Cloudflare</label>'
    + '<button class="btn pri" style="margin-bottom:8px" onclick="secAddRule(this)">Block</button></div>';
  if (R.length) {
    h += '<table class="upd-table"><tr><th>Block</th><th>Where</th><th>Status</th><th></th></tr>';
    for (const r of R) h += '<tr><td><b>' + esc({ ip: 'IP', range: 'Range', asn: 'AS', country: 'Country' }[r.type]) + '</b> <span class="mono">' + (r.type === 'country' ? secFlag(r.value) + ' ' : '') + esc(r.value) + '</span>' + (r.note ? '<br><span class="dim">' + esc(r.note) + '</span>' : '') + '</td>'
      + '<td>' + esc(r.scope.map(s => s === 'host' ? 'this server' : 'Cloudflare').join(' + ')) + (r.prefixes ? '<br><span class="dim" style="font-size:12.5px">' + r.prefixes + ' ranges</span>' : '') + '</td>'
      + '<td style="font-size:13px">' + Object.entries(r.status || {}).map(([k, v]) => '<div style="color:' + (/FAILED|not applied/.test(v) ? 'var(--md-warning)' : '') + '">' + esc((k === 'host' ? 'server: ' : 'Cloudflare: ') + v) + '</div>').join('') + '</td>'
      + '<td style="text-align:right"><button class="btn small" onclick="armConfirm(this, \'Unblock?\', () => secRemoveRule(\'' + r.id + '\'))">Unblock</button></td></tr>';
    h += '</table>';
  }
  h += '</div>';
  // fail2ban lives on the Firewall page (jails, settings, bans); a pointer with the headline here
  const f = secData.fail2ban || {};
  const nBanned = (f.jails || []).reduce((a, j) => a + (j.banned || []).length, 0);
  h += '<div class="upd-card" style="margin-top:14px"><h3>fail2ban</h3><p style="margin:0">' + (f.installed ? (f.jails || []).length + ' jail(s) running, ' + nBanned + ' IP(s) banned. ' : 'fail2ban is not running. ')
    + '<a href="firewall" onclick="event.preventDefault();setTab(\'firewall\')">Manage jails and bans on the Firewall page →</a></p></div>';
  h += '<div class="upd-card" style="margin-top:14px" id="secScan">' + secScanHtml() + '</div>';
  h += '<div class="upd-card" style="margin-top:14px" id="secSweep">' + secSweepHtml() + '</div>';
  h += '<div class="upd-card" style="margin-top:14px" id="secLeak">' + secLeakHtml() + '</div>';
  view.innerHTML = h;
  if (!secSweep && !secSweepLoading) secSweepLoad();
  if (!secLeak && !secLeakLoading) secLeakLoad();
  if (!secScan && !secScanLoading) secScanLoad();
}
// ---- Code scan of every site on this server (Semgrep, npm audit, pip-audit — lib/codescan.js)
let secScan = null, secScanLoading = false, secScanPoll = null;
async function secScanLoad(){
  clearTimeout(secScanPoll); secScanLoading = true;
  try { secScan = await stApi('GET', 'api/codescan'); } catch(e){ secScan = { error: e.message }; }
  secScanLoading = false;
  const el = document.getElementById('secScan'); if (!el) return;
  el.innerHTML = secScanHtml();
  if (secScan.running || (secScan.queue || []).length) secScanPoll = setTimeout(() => { if (state.tab === 'security') secScanLoad(); }, 5000);
}
function secScanHtml(){
  let h = '<h3>🔍 Code scan — Semgrep · npm audit · pip-audit</h3><p class="dim" style="margin:0 0 8px;font-size:14px">Every site\'s code on this server, scanned as its own user (one site at a time), on the schedule below — then a detailed report goes to Telegram and e-mail. Details on each site\'s Security tab.</p>';
  if (!secScan) return h + '<div class="dim">Loading…</div>';
  if (secScan.error) return h + '<div style="color:var(--md-error-bright)">' + esc(secScan.error) + '</div>';
  if (!secScan.installed.semgrep) h += '<div class="banner bad" style="margin-bottom:10px"><span class="ico">⚠</span> Semgrep is not installed — only dependency audits run. <a href="appstore" onclick="event.preventDefault();asCat=\'tools\';setTab(\'appstore\')">Install it: App Store › Tools › Code scanners</a></div>';
  h += secScanSchedHtml(secScan.schedule, secScan.round);
  const q = secScan.queue || [], run = secScan.running;
  h += '<table class="upd-table"><tr><th>Site</th><th>Findings</th><th>Last scan</th><th></th></tr>' + secScan.sites.map(x => {
    const st = run && run.domain === x.domain ? '⏳ ' + esc(run.step) + '…' : q.includes(x.domain) ? '🕒 queued' : '';
    return '<tr><td><a href="sites?d=' + esc(encodeURIComponent(x.domain)) + '&t=security" onclick="event.preventDefault();siteGo(\'' + esc(x.domain) + '\', \'security\')"><b>' + esc(x.domain) + '</b></a></td><td>' + (x.last && x.last.error ? '<span style="color:var(--md-error-bright)">' + esc(x.last.error) + '</span>' : scanCountsHtml(x.last && x.last.counts)) + '</td>'
      + '<td class="dim" style="font-size:13px">' + (st || (x.last ? esc(new Date(x.last.at).toLocaleString()) : '–')) + '</td><td style="text-align:right"><button class="btn small" ' + (st ? 'disabled ' : '') + 'onclick="secScanRun(\'' + esc(x.domain) + '\', this)">Scan</button></td></tr>'; }).join('') + '</table>';
  h += '<div class="site-actions"><button class="btn pri" ' + (run ? 'disabled ' : '') + 'onclick="secScanRun(null, this)" title="scans every site, then sends the report">Scan all now</button> <button class="btn" onclick="secScanReport(this)" title="send the report of the latest results now">Send report now</button> <button class="btn" onclick="secScanLoad()">↻</button></div>';
  return h;
}
const SEC_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function secScanSchedHtml(s, round){
  if (!s) return '';
  const chk = (id, on, label) => '<label class="chip" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';
  const lr = s.lastReport;
  const sentTxt = lr ? Object.entries(lr.sent || {}).map(([k, v]) => (v.ok ? '✅ ' : v.skipped ? '⏭ ' : '❌ ') + k + (v.ok ? '' : ' (' + esc(v.error || 'skipped') + ')')).join(' · ') : '';
  return '<div style="border:1px solid var(--md-divider);border-radius:10px;padding:10px 12px;margin:0 0 12px">'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">'
    + chk('csOn', s.enabled, '<b>Scheduled scan</b>')
    + '<label>at <input id="csTime" type="time" value="' + esc(s.time) + '" style="width:110px"></label> <span class="dim" style="font-size:13px">' + esc(s.tz || '') + '</span>'
    + '<span style="display:inline-flex;gap:4px;flex-wrap:wrap">' + SEC_DAYS.map((d, i) => chk('csDay' + i, s.days.includes(i), d)).join('') + '</span></div>'
    + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:8px"><span>Report to</span>' + chk('csTg', s.report.telegram, 'Telegram') + chk('csMail', s.report.email, 'E-mail') + '<span class="dim" style="font-size:13px">(channels from Settings › Notifications)</span>'
    + '<button class="btn small pri" onclick="secScanSchedSave(this)">Save</button></div>'
    + '<div class="dim" style="font-size:13px;margin-top:6px">' + (s.enabled ? 'Next run: <b>' + (s.next ? esc(new Date(s.next).toLocaleString()) : '–') + '</b>' : 'Off — scans run only when started here') + (round ? ' · round in progress: ' + round.done + ' of ' + round.domains + ' sites' : '')
    + (lr ? ' · last report ' + esc(new Date(lr.at).toLocaleString()) + ': ' + sentTxt : '') + '</div></div>';
}
async function secScanSchedSave(btn){
  const g = (id) => document.getElementById(id);
  const b = { enabled: g('csOn').checked, time: g('csTime').value, days: SEC_DAYS.map((_, i) => i).filter(i => g('csDay' + i).checked), report: { telegram: g('csTg').checked, email: g('csMail').checked } };
  btn.disabled = true;
  try { const r = await stApi('PUT', 'api/codescan/schedule', b); toast(r.enabled ? 'Code scan scheduled — next ' + (r.next ? new Date(r.next).toLocaleString() : '–') : 'Scheduled code scan off', 'success'); secScanLoad(); }
  catch(e){ stErr(e, 'Code scan schedule'); btn.disabled = false; }
}
async function secScanReport(btn){
  btn.disabled = true;
  try { const r = await stApi('POST', 'api/codescan/report', {}); const s = Object.entries(r.sent || {}); toast('Report: ' + (s.map(([k, v]) => k + (v.ok ? ' sent' : ' — ' + (v.error || 'skipped'))).join(' · ') || 'no channel'), r.ok ? 'success' : 'warn', { duration: 10000 }); }
  catch(e){ stErr(e, 'Code scan report'); }
  btn.disabled = false; secScanLoad();
}
async function secScanRun(domain, btn){
  if (btn) btn.disabled = true;
  try { const r = await stApi('POST', 'api/codescan/run', domain ? { domain } : {}); toast((r.queued.length || 'No') + ' site(s) queued for a code scan', 'success'); }
  catch(e){ stErr(e, 'Code scan'); }
  secScanLoad();
}
// ---- GitHub secret scanning on the panel's own repo (read through the signed-in account)
let secLeak = null, secLeakLoading = false;
async function secLeakLoad(){
  secLeakLoading = true;
  try { secLeak = await stApi('GET', 'api/panelrepo/secret-alerts'); } catch(e){ secLeak = { error: e.message }; }
  secLeakLoading = false;
  const el = document.getElementById('secLeak'); if (el) el.innerHTML = secLeakHtml();
}
function secLeakHtml(){
  let h = '<h3>🔑 Leaked secrets — panel repo</h3><p class="dim" style="margin:0 0 8px;font-size:14px">GitHub secret-scanning alerts on ' + esc((secLeak && secLeak.repo) || 'the panel repo') + '. A leaked secret stays in git history: revoke it at its provider, then close the alert on GitHub.</p>';
  if (!secLeak) return h + '<div class="dim">Loading…</div>';
  if (secLeak.error) return h + '<div style="color:var(--md-error-bright)">' + esc(secLeak.error) + '</div>';
  const A = secLeak.alerts || [], open = A.filter(a => a.state === 'open');
  if (!open.length) return h + '<div>🟢 No open alerts' + (A.length ? ' (' + A.length + ' closed)' : '') + '.</div>';
  h += '<table class="upd-table"><tr><th>Secret</th><th>Found in</th><th>Status</th><th></th></tr>' + open.map(a => '<tr><td><b>' + esc(a.type) + '</b>' + (a.botName ? ' <span class="mono">' + esc(a.botName) + '</span>' : a.botId ? ' <span class="mono dim">bot ' + esc(a.botId) + '</span>' : '') + (a.publicly_leaked ? ' <span style="color:var(--md-error-bright)">public</span>' : '') + '</td>'
    + '<td class="mono dim" style="font-size:13px">' + (a.locations || []).map(l => esc(l.path + ':' + l.line + ' @' + l.commit)).join('<br>') + '</td><td>'
    + (a.live === true ? '<span style="color:var(--md-error-bright)">still works — revoke it</span>' : a.live === false ? '<span class="dim">no longer works — close the alert</span>' : '<span class="dim">' + esc(a.validity || 'unknown') + '</span>')
    + (a.panelBot ? '<div class="dim" style="font-size:12.5px">panel notifications: ' + esc(a.panelBot) + '</div>' : '') + '</td>'
    + '<td style="text-align:right"><a class="btn small" href="' + esc(a.url) + '" target="_blank" rel="noopener">GitHub ↗</a></td></tr>').join('') + '</table>';
  return h + '<div class="site-actions"><button class="btn" onclick="secLeak=null;secLeakLoad()">↻</button></div>';
}
// ---- Code scanning: HCL AppScan CodeSweep (pull-request GitHub Action) on every site's repo
let secSweep = null, secSweepLoading = false;
async function secSweepLoad(){
  secSweepLoading = true;
  try { secSweep = await stApi('GET', 'api/codesweep'); } catch(e){ secSweep = { error: e.message }; }
  secSweepLoading = false;
  const el = document.getElementById('secSweep'); if (el) el.innerHTML = secSweepHtml();
}
function secSweepHtml(){
  let h = '<h3>🔎 Code scanning — HCL AppScan CodeSweep</h3><p class="dim" style="margin:0 0 8px;font-size:14px">A GitHub Action on each site\'s repo that scans the code every <b>pull request</b> changes (annotations + check run on the PR). Switch it per site here or on the site\'s GitHub tab.</p>';
  if (!secSweep) return h + '<div class="dim">Loading…</div>';
  if (secSweep.error) return h + '<div style="color:var(--md-error-bright)">' + esc(secSweep.error) + '</div>';
  const S = secSweep.sites || [], conn = S.filter(x => x.connected), on = conn.filter(x => x.enabled);
  h += '<table class="upd-table"><tr><th>Site</th><th>Repo</th><th>CodeSweep</th><th></th></tr>' + S.map(x => '<tr><td><a href="sites?d=' + esc(encodeURIComponent(x.domain)) + '&t=github" onclick="event.preventDefault();siteGo(\'' + esc(x.domain) + '\', \'github\')"><b>' + esc(x.domain) + '</b></a></td><td class="mono dim" style="font-size:13px">' + esc(x.repo || 'not connected') + '</td><td>'
    + (x.error ? '<span style="color:var(--md-error-bright)">' + esc(x.error) + '</span>' : !x.connected ? '<span class="dim">–</span>' : x.enabled ? '🟢 on' + (x.managed ? '' : ' <span class="dim">(repo\'s own)</span>') : '<span class="dim">off</span>') + '</td><td style="text-align:right">'
    + (x.connected && !x.error ? (x.enabled ? (x.managed ? '<button class="btn small" onclick="secSweepSite(\'' + esc(x.domain) + '\', false, this)">Switch off</button>' : '') : '<button class="btn small pri" onclick="secSweepSite(\'' + esc(x.domain) + '\', true, this)">Switch on</button>') : '') + '</td></tr>').join('') + '</table>';
  h += '<div class="site-actions" style="justify-content:space-between"><span class="dim" style="font-size:13.5px">' + on.length + ' of ' + conn.length + ' connected site(s) on</span><span>'
    + (on.length < conn.length ? '<button class="btn pri" onclick="armConfirm(this, \'Add the workflow to ' + (conn.length - on.length) + ' repo(s) and push?\', () => secSweepAll(true, this))">Switch on for all</button> ' : '')
    + (on.length ? '<button class="btn danger" onclick="armConfirm(this, \'Remove it from every repo?\', () => secSweepAll(false, this))">Switch off for all</button>' : '') + '</span></div>';
  return h;
}
async function secSweepSite(domain, on, btn){
  if (btn) btn.disabled = true;
  try { const r = await stApi('PUT', 'api/sites/' + encodeURIComponent(domain) + '/codesweep', { on }); toast(domain + ': CodeSweep ' + (on ? 'on' : 'off') + ' — ' + r.push.summary, 'success', { duration: 8000 }); }
  catch(e){ stErr(e, 'CodeSweep'); }
  secSweepLoad();
}
async function secSweepAll(on, btn){
  if (btn) btn.disabled = true;
  toast((on ? 'Adding' : 'Removing') + ' CodeSweep on every connected site…');
  try { const r = await stApi('POST', 'api/codesweep/all', { on }); const bad = r.results.filter(x => !x.ok);
    toast(r.results.length - bad.length + ' site(s) done' + (bad.length ? ', ' + bad.length + ' failed: ' + bad.map(x => x.domain + ' (' + x.summary + ')').join('; ') : ''), bad.length ? 'warn' : 'success', { duration: 12000 }); }
  catch(e){ stErr(e, 'CodeSweep'); }
  secSweepLoad();
}
async function secDoLookup(){ const ip = (document.getElementById('secIp') || {}).value.trim(); if (!ip) return; secLookupIp(ip); }
async function secLookupIp(ip){
  secLookup = { ip, errors: [] }; try { secLookup = await stApi('GET', 'api/security/intel/' + encodeURIComponent(ip) + '?fresh=1'); } catch(e){ secLookup = { error: e.message }; }
  renderSecurity(true); const el = document.getElementById('secIp'); if (el) el.value = ip; window.scrollTo(0, 0);
}
async function secSaveCfg(){
  const g = (id) => document.getElementById(id);
  const b = { reportBans: g('secReportBans').checked }; if (g('secIpinfo').value) b.ipinfoToken = g('secIpinfo').value; if (g('secAbuse').value) b.abuseKey = g('secAbuse').value;
  try { await stApi('PUT', 'api/security/config', b); toast('Saved', 'success'); secIntel = {}; secData = null; loadSecurity(); } catch(e){ stErr(e, 'Security'); }
}
function secBlock(type, value, note){
  const t = document.getElementById('secType'), v = document.getElementById('secVal'), n = document.getElementById('secNote');
  if (t) t.value = type; if (v) v.value = value; if (n && note) n.value = note;
  if (v) { v.scrollIntoView({ block: 'center' }); v.focus(); }
  toast('Check the rule below and press Block', 'info');
}
async function secAddRule(btn){
  const g = (id) => document.getElementById(id);
  const scope = [g('secScHost').checked && 'host', g('secScCf').checked && 'cloudflare'].filter(Boolean);
  btn.disabled = true; toast('Applying… (a country or AS can take a few seconds)');
  try { const r = await stApi('POST', 'api/security/rules', { type: g('secType').value, value: g('secVal').value, note: g('secNote').value, scope });
    const warn = Object.values(r.status).some(s => /FAILED|not applied/.test(s));
    toast('Blocked ' + r.value, warn ? 'warn' : 'success', { detail: Object.entries(r.status).map(([k, v]) => (k === 'host' ? 'this server: ' : 'Cloudflare: ') + v).join('\n'), duration: 12000 }); secData = null; loadSecurity(); }
  catch(e){ stErr(e, 'Block'); btn.disabled = false; }
}
async function secRemoveRule(id){ try { await stApi('DELETE', 'api/security/rules/' + id); toast('Unblocked', 'success'); secData = null; loadSecurity(); } catch(e){ stErr(e, 'Unblock'); } }
async function secReport(ip){ try { const r = await stApi('POST', 'api/security/report', { ip, comment: 'abusive traffic seen by ' + location.host }); toast('Reported — abuse score now ' + r.score + '%', 'success'); } catch(e){ stErr(e, 'Report'); } }
