// ---- Security: IP intel (ipinfo.io / AbuseIPDB), fail2ban, block rules by IP / range / ASN / country.
let secData = null, secLoading = false, secIntel = {}, secLookup = null;
async function loadSecurity(){
  secLoading = true;
  try { secData = await stApi('GET', 'api/security'); } catch(e){ secData = { error: e.message }; }
  secLoading = false;
  if (state.tab === 'security') renderSecurity(true);
}
const secFlag = (cc) => cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
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
  view.innerHTML = h;
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
