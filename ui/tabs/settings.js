/* ---------------------------------------------------------------- settings */
// General · Notifications (Telegram, Slack) · Cloudflare & domains · Cleanup (moved from Modules).
let lastSettings = null, cfDomains = null, cfDomainsLoading = false;

async function loadSettings(){ try { lastSettings = await fetch('api/settings').then(r => r.json()); } catch(e){} renderSettings(); }
async function stApi(method, url, body){
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch(e){}
  if (!r.ok) { const e = new Error((j && j.error) || ('HTTP ' + r.status)); e.detail = j && j.detail; throw e; }
  return j;
}
const stErr = (e, what) => toast((what ? what + ': ' : '') + e.message, 'error', e.detail ? { detail: e.detail, duration: 12000 } : {});
const stField = (label, inner, hint) => sshField(label, inner, hint);

function renderSettings(){
  const view = document.getElementById('settingsview');
  document.getElementById('host').textContent = lastSettings ? lastSettings.general.hostname : '';
  showBanner(null); setStatus([]);
  if (!lastSettings) { view.innerHTML = '<div class="upd-card">Loading…</div>'; loadSettings(); return; }
  if (view.contains(document.activeElement) && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const d = lastSettings, g = d.general, tg = d.telegram, sl = d.slack, br = d.brevo || { senderEmail: 'sys@synergybeam.com', to: 'sys@synergybeam.com' }, cf = d.cloudflare, ts = d.turnstile || { enabled: false, siteKey: '' };
  document.getElementById('updated').textContent = g.panelDomain + ' · ' + g.hostname + ' · ' + g.timezone + ' · node ' + g.node;
  let html = '<div class="upd-grid">';
  // General
  html += '<div class="upd-card"><h3>General</h3><div class="row2">'
    + stField('Panel name', '<input id="stName" value="' + esc(g.panelName || '') + '" maxlength="60" placeholder="' + esc(g.panelNameDefault || '') + '">', 'shown in the logo, page title, sign-in page and notifications on this server')
    + stField('Logo', '<div style="display:flex;gap:8px;align-items:center">' + (g.logo ? '<img src="brand-logo?v=' + g.logo.v + '" alt="" style="height:32px;width:auto">' : '') + '<input id="stLogo" type="url" value="' + esc(logoUrlOf(g.logo)) + '" placeholder="' + (g.logo && !logoUrlOf(g.logo) ? esc(g.logo.source) + ' — paste a URL to replace' : 'https://…/logo.png') + '" style="flex:1">'
      + '<input type="file" id="stLogoFile" accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml" style="display:none" onchange="uploadLogo(this)"><button class="btn small" type="button" onclick="document.getElementById(\'stLogoFile\').click()">Upload…</button>'
      + (g.logo ? '<button class="btn small" type="button" onclick="removeLogo()">Remove</button>' : '') + '</div>', 'a URL is downloaded once and stored on this server, or upload a file (PNG, JPEG, GIF, WebP, SVG, max 2 MB): top bar, sign-in page, favicon') + '</div><div class="row2">'
    + stField('Panel domain', '<input value="' + esc(g.panelDomain) + '" disabled>', 'from ' + esc(g.panelDomainSource || 'nginx custom-domain.conf'))
    + stField('Server IP', '<input value="' + esc(g.ip || '') + '" disabled>', [g.ipSource, (g.lanIps || []).length ? 'LAN ' + g.lanIps.join(', ') : ''].filter(Boolean).map(esc).join(' · ')) + '</div><div class="row2">'
    + stField('Timezone', '<select id="stTz"><option>' + esc(g.timezone) + '</option></select>', 'server clock: scheduled backups/updates and all log times follow it')
    + stField('Event log retention (days)', '<input id="stRet" type="number" min="1" max="3650" value="' + esc(g.eventsRetentionDays) + '">') + '</div>'
    + stField('ACME / Let\'s Encrypt e-mail', '<input id="stAcme" type="email" value="' + esc(g.acmeEmail || '') + '" placeholder="admin@example.com">', 'used when certificates are issued from this panel (upcoming)')
    + '<div class="site-actions"><button class="btn pri" onclick="saveGeneralSettings()">Save</button></div></div>';
  // Telegram
  html += '<div class="upd-card"><h3>Telegram</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="tgOn"' + (tg.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Enabled</label></div>'
    + '<div class="row2">' + stField('Bot token', '<input type="password" id="tgToken" placeholder="' + (tg.hasToken ? esc(tg.botToken) + ' (leave empty to keep)' : '123456:ABC-DEF1234ghIkl') + '">')
    + stField('Chat ID', '<input id="tgChat" value="' + esc(tg.chatId || '') + '" placeholder="-100123456789">') + '</div>'
    + '<div class="upd-chk-grid"><label><input type="checkbox" id="tgUpd"' + (tg.notifyOnUpdate !== false ? ' checked' : '') + '> Updates available</label><label><input type="checkbox" id="tgDone"' + (tg.notifyOnComplete !== false ? ' checked' : '') + '> Update / backup / cleanup results</label><label><input type="checkbox" id="tgAuth"' + (tg.notifyOnAuth !== false ? ' checked' : '') + '> Web login attempts</label><label><input type="checkbox" id="tgSite"' + (tg.notifyOnSite !== false ? ' checked' : '') + '> Site start / stop / restart</label></div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'telegram\')">📨 Send test</button><button class="btn pri" onclick="saveTelegramSettings()">Save</button></div></div>';
  // Slack
  html += '<div class="upd-card"><h3>Slack</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="slOn"' + (sl.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Enabled</label></div>'
    + stField('Incoming webhook URL', '<input type="password" id="slUrl" placeholder="' + (sl.hasUrl ? esc(sl.webhookUrl) + ' (leave empty to keep)' : 'https://hooks.slack.com/services/T…/B…/…') + '">', 'Slack → Apps → Incoming Webhooks → pick a channel')
    + '<div class="upd-chk-grid"><label><input type="checkbox" id="slUpd"' + (sl.notifyOnUpdate !== false ? ' checked' : '') + '> Updates available</label><label><input type="checkbox" id="slDone"' + (sl.notifyOnComplete !== false ? ' checked' : '') + '> Update / backup / cleanup results</label><label><input type="checkbox" id="slAuth"' + (sl.notifyOnAuth !== false ? ' checked' : '') + '> Web login attempts</label><label><input type="checkbox" id="slSite"' + (sl.notifyOnSite !== false ? ' checked' : '') + '> Site start / stop / restart</label></div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'slack\')">📨 Send test</button><button class="btn pri" onclick="saveSlackSettings()">Save</button></div></div>';
  // Admin IP whitelist (filled in by loadWhitelist — its own endpoint)
  html += '<div class="upd-card" id="whitelist"><h3>Whitelist (admin IPs)</h3><div id="wlBody">' + wlBodyHtml() + '</div></div>';
  // Sites & apps: what every current and future site inherits
  const sd = lastSettings.sitesDefaults || { tunnel: 'own', repair: 'auto' };
  html += '<div class="upd-card" id="sites-defaults"><h3>Sites &amp; apps (shared)</h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Every setting on this page — Telegram, Slack, Brevo, Cloudflare, Wasabi, self-repair — is shared by all current and future sites. A site can switch any group to its own value on its <b>Overrides</b> tab.</p>'
    + '<div class="row2">' + stField('Tunnel for new sites', '<select id="sdTunnel"><option value="own"' + (sd.tunnel === 'own' ? ' selected' : '') + '>Own tunnel per site</option><option value="shared"' + (sd.tunnel === 'shared' ? ' selected' : '') + '>Route on the shared host tunnel</option></select>')
    + stField('GitHub owner for site repos', '<input id="sdGhOwner" value="' + esc(sd.githubOwner || 'roman-synergybeam') + '" placeholder="roman-synergybeam">', 'each site gets &lt;owner&gt;/&lt;domain&gt; unless a repo is set on its GitHub tab') + '</div><div class="row2">'
    + stField('Self-repair for sites', '<select id="sdRepair"><option value="auto"' + (sd.repair === 'auto' ? ' selected' : '') + '>Repair automatically</option><option value="off"' + (sd.repair === 'off' ? ' selected' : '') + '>Off — alert only</option></select>', 'the loop itself: <a href="self-repair">Self-repair</a>') + '</div>'
    + '<div class="site-actions"><button class="btn pri" onclick="saveSitesDefaults()">Save</button></div></div>';
  // Brevo (e-mail)
  html += '<div class="upd-card" id="brevo"><h3>Brevo (e-mail)</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="brOn"' + (br.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Enabled</label></div>'
    + stField('API key', '<input type="password" id="brKey" autocomplete="new-password" placeholder="' + (br.hasKey ? esc(br.apiKey) + ' (leave empty to keep)' : 'xkeysib-…') + '">', 'Brevo → SMTP &amp; API → API keys. Stored encrypted.')
    + '<div class="row2">' + stField('Sender e-mail', '<input id="brFrom" type="email" value="' + esc(br.senderEmail || '') + '" placeholder="sys@synergybeam.com">', 'must be a verified sender or domain in Brevo')
    + stField('Sender name', '<input id="brName" maxlength="70" value="' + esc(br.senderName || '') + '" placeholder="' + esc(g.hostname) + '">') + '</div>'
    + stField('Recipients', '<input id="brTo" value="' + esc(br.to || '') + '" placeholder="sys@synergybeam.com">', 'separate several with commas')
    + '<div class="upd-chk-grid"><label><input type="checkbox" id="brUpd"' + (br.notifyOnUpdate !== false ? ' checked' : '') + '> Updates available</label><label><input type="checkbox" id="brDone"' + (br.notifyOnComplete !== false ? ' checked' : '') + '> Update / backup / cleanup results</label><label><input type="checkbox" id="brAuth"' + (br.notifyOnAuth !== false ? ' checked' : '') + '> Web login attempts</label><label><input type="checkbox" id="brSite"' + (br.notifyOnSite !== false ? ' checked' : '') + '> Site start / stop / restart</label></div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'brevo\')">📨 Send test</button><button class="btn pri" onclick="saveBrevoSettings()">Save</button></div></div>';
  // Cloudflare
  html += '<div class="upd-card"><h3>Cloudflare</h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">API token with <b>Zone:Read</b> and <b>DNS:Edit</b> (Cloudflare dashboard → My Profile → API Tokens). Stored encrypted. Powers the domains overview below; DNS records for new sites and origin certificates come next.</p>'
    + stField('API token', '<input type="password" id="cfToken" placeholder="' + (cf.configured ? esc(cf.token) + ' (leave empty to keep, type REMOVE to delete)' : 'paste token') + '">')
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'cloudflare\')">Verify token</button><button class="btn pri" onclick="saveCloudflareSettings()">Save</button></div></div>';
  // Wasabi (backup target)
  const wb = lastSettings.wasabi || {};
  html += '<div class="upd-card" id="wasabi"><h3>Wasabi (backups)</h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Where the Backups tab uploads to. Wasabi console → Access Keys → create a key (a sub-user limited to this bucket is best). The secret is stored encrypted and never shown again. '
    + (wb.target ? 'Uploading to <b>' + esc(wb.target.label) + '</b>.' : '<b>Not configured</b> — scheduled backups are skipped until it is.') + '</p><div class="row2">'
    + stField('Access key', '<input id="wbKey" autocomplete="off" spellcheck="false" value="' + esc(wb.accessKey || '') + '" placeholder="WASABI ACCESS KEY">')
    + stField('Secret key', '<input id="wbSecret" type="password" autocomplete="new-password" placeholder="' + (wb.hasSecret ? '•••••••• (leave empty to keep)' : 'secret key') + '">') + '</div><div class="row2">'
    + stField('Region', '<select id="wbRegion">' + (wb.regions || ['eu-central-1']).map((r) => '<option' + (r === (wb.region || 'eu-central-1') ? ' selected' : '') + '>' + esc(r) + '</option>').join('') + '</select>', 'endpoint s3.&lt;region&gt;.wasabisys.com')
    + stField('Bucket', '<input id="wbBucket" spellcheck="false" value="' + esc(wb.bucket || '') + '" placeholder="my-backups">') + '</div>'
    + stField('Folder in the bucket', '<input id="wbPrefix" spellcheck="false" value="' + esc(wb.prefix || '') + '" placeholder="' + esc(wb.defaultPrefix || '') + '">', 'one folder per server — retention only ever prunes inside it')
    + '<div class="site-actions" style="justify-content:space-between"><span><button class="btn" onclick="testWasabi()">Test</button>' + (wb.configured ? ' <button class="btn" onclick="removeWasabi()">Remove</button>' : '') + '</span><button class="btn pri" onclick="saveWasabiSettings()">Save</button></div></div>';
  // Turnstile (login page challenge)
  html += '<div class="upd-card"><h3>Turnstile (login page)</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="tsOn"' + (ts.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Challenge visitors on the sign-in form</label></div>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Cloudflare dashboard → Turnstile → add a widget for <b>' + esc(g.panelDomain) + '</b> (Managed mode). '
    + 'It keeps password guessers off the login endpoint; a wrong challenge is refused before the password is ever checked. '
    + 'Requests over an SSH tunnel / loopback are never challenged, so a bad key cannot lock you out.</p>'
    + '<div class="row2">' + stField('Site key', '<input id="tsSite" value="' + esc(ts.siteKey || '') + '" placeholder="0x4AAAAAAA…">', 'public — the login page ships it to the browser')
    + stField('Secret key', '<input type="password" id="tsSecret" placeholder="' + (ts.hasSecret ? esc(ts.secretKey) + ' (leave empty to keep, type REMOVE to delete)' : '0x4AAAAAAA…') + '">', 'stored encrypted') + '</div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'turnstile\')">Verify secret</button><button class="btn pri" onclick="saveTurnstileSettings()">Save</button></div></div>';
  html += '</div>';
  // Domains (Cloudflare zones × our sites)
  html += '<div class="upd-card" style="margin-top:14px"><div class="site-card-hd"><h3>Domains</h3>' + (cf.configured ? '<button class="btn small" onclick="cfDomains=null; loadCfDomains()">↻</button>' : '') + '</div>';
  if (!cf.configured) html += '<p class="dim">Add a Cloudflare API token to see zones and how each site domain resolves.</p>';
  else if (!cfDomains) { html += '<p class="dim">Loading zones…</p>'; if (!cfDomainsLoading) loadCfDomains(); }
  else if (cfDomains.error) html += '<p style="color:var(--md-error-bright)">⚠ ' + esc(cfDomains.error) + '</p>';
  else {
    // One cryptic Cloudflare code repeated down every row explains nothing. The server probes the
    // zone per permission and returns which of the two causes it actually is — show that verdict.
    const failed = cfDomains.sites.filter(x => x.error);
    const diag = (failed.find(x => x.diagnosis) || {}).diagnosis;
    if (failed.length) html += '<div class="site-why">' + failed.length + ' of ' + cfDomains.sites.length + ' domains could not be read — Cloudflare answered <span class="mono">' + esc(failed[0].error) + '</span>.'
      + (diag ? '<br><br><b>' + esc(diag.verdict === 'dns-permission-missing' ? 'The DNS permission is missing from this token.' : diag.verdict === 'zone-not-in-scope' ? 'The zone is outside this token\'s resources.' : 'Diagnosis') + '</b> ' + esc(diag.message) : '')
      + '</div>';
    html += '<table class="upd-table"><tr><th>Site</th><th>Zone</th><th>DNS</th><th>Proxied</th><th>Points here</th><th>www</th></tr>';
    for (const s of cfDomains.sites) {
      html += '<tr><td><b>' + esc(s.domain) + '</b></td><td>' + (s.zone ? esc(s.zone) + (s.zone_status && s.zone_status !== 'active' ? ' <span class="dim">(' + esc(s.zone_status) + ')</span>' : '') : '<span class="dim">not in Cloudflare</span>') + '</td>'
        + '<td class="mono">' + (s.records ? (s.records.length ? s.records.map(r => esc(r.type + ' ' + r.content)).join('<br>') : '<span style="color:var(--md-warning)">no record</span>') : (s.error ? '<span style="color:var(--md-error-bright)">' + esc(s.error) + '</span>' : '')) + '</td>'
        + '<td>' + (s.proxied == null ? '' : s.proxied ? '☁️ yes' : 'no (DNS only)') + '</td>'
        + '<td>' + (s.records ? (s.points_here ? '✅' : s.proxied ? '<span class="dim">via Cloudflare</span>' : '<span style="color:var(--md-warning)">✗</span>') : '') + '</td>'
        + '<td class="mono dim">' + (s.www ? (s.www.length ? s.www.map(r => esc(r.type + ' ' + r.content)).join('<br>') : '–') : '') + '</td></tr>';
    }
    html += '</table><div class="dim" style="font-size:14px;margin-top:8px">Zones this token can see: ' + cfDomains.zones.map(z => esc(z.name) + (z.status !== 'active' ? ' (' + esc(z.status) + ')' : '')).join(', ') + '</div>';
  }
  html += '</div>';
  // Central certificate store
  // Cleanup (moved from Modules)
  const d2 = { cleanup: (lastModules && lastModules.cleanup) || { config: {}, preview: null, running: false, log: [] } };
  html += '<div style="margin-top:14px">' + cleanupCardHtml(d2) + '</div>';
  view.innerHTML = html;
  fillTzSelect();
  if (location.hash.length > 1 && !view.dataset.jumped) { const el = document.getElementById(location.hash.slice(1)); if (el) { view.dataset.jumped = '1'; el.scrollIntoView({ block: 'start' }); } }
  const cuSaveBtn = document.getElementById('cuSave');
  if (cuSaveBtn) cuSaveBtn.addEventListener('click', () => saveCleanupConfig(false));
  const cuMeasureBtn = document.getElementById('cuMeasure');
  if (cuMeasureBtn) cuMeasureBtn.addEventListener('click', () => measureCleanupNow());
  const cuRunBtn = document.getElementById('cuRun');
  if (cuRunBtn) cuRunBtn.addEventListener('click', () => armConfirm(cuRunBtn, '⚠ Click again to delete', () => runCleanupNow()));
}
// Certificates and Tunnels are their own left-menu pages; the cards keep their element ids so
// their loaders re-render them in place.
function plainTabHeader(sub){
  document.getElementById('host').textContent = lastSettings ? lastSettings.general.hostname : '';
  showBanner(null); setStatus([]);
  document.getElementById('updated').textContent = sub || '';
}
function renderCertsTab(){
  plainTabHeader('Certificates kept by this panel — deploy them to sites from here');
  document.getElementById('certsview').innerHTML = '<div class="upd-card" id="certStoreCard">' + certStoreCardHtml() + '</div>';
}
function renderTunnelsTab(){
  plainTabHeader('Cloudflare Tunnels running on this server');
  document.getElementById('tunnelsview').innerHTML = '<div class="upd-card" id="cfdCard" style="margin-bottom:14px">' + cfdCardHtml() + '</div><div class="upd-card" id="tunnels"><div class="site-card-hd"><h3>Cloudflare Tunnels</h3><button class="btn small" onclick="loadTunnels(true)">↻</button></div>' + tunnelsCardHtml() + '</div>';
}
let stTunnels = null, stTunnelsLoading = false;
// cloudflared binary: version / update / auto-update
let cfd = null, cfdLoading = false, cfdPoll = null;
function cfdCardHtml(){
  let h = '<div class="site-card-hd"><h3>cloudflared</h3><button class="btn small" onclick="cfdCheck()" title="Ask the apt repo for the newest version">Check for updates</button></div>';
  if (!cfd) { if (!cfdLoading) loadCfd(); return h + '<p class="dim">Loading…</p>'; }
  if (cfd.error) return h + '<p style="color:var(--md-error-bright)">⚠ ' + esc(cfd.error) + '</p>';
  const when = (v) => v ? esc(String(v).replace(/^\w+ /, '')) : '–';
  h += '<div class="row2">'
    + stField('Installed version', '<input class="mono" value="' + esc(cfd.installed || 'not installed') + '" disabled>')
    + stField('Latest (apt repo)', '<input class="mono" value="' + esc(cfd.latest || '?') + '" disabled>', cfd.updateAvailable ? '<span style="color:var(--md-warning)">update available</span>' : 'up to date') + '</div>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="cfdAuto"' + (cfd.autoUpdate ? ' checked' : '') + ' onchange="cfdSetAuto(this.checked)"><span class="slider"></span></label><label>Auto-update daily — every tunnel is restarted after an upgrade</label></div>'
    + '<div class="dim" style="font-size:13.5px">Next run: ' + (cfd.autoUpdate ? when(cfd.nextRun) : 'off') + ' · last run: ' + when(cfd.lastRun) + '</div>'
    + (cfd.log && cfd.log.length ? '<details style="margin-top:6px"><summary class="dim" style="cursor:pointer;font-size:13.5px">Last update log</summary><pre class="mono" style="font-size:12.5px;white-space:pre-wrap;margin:6px 0 0">' + esc(cfd.log.join('\n')) + '</pre></details>' : '')
    + '<div class="site-actions"><button class="btn pri" id="cfdUpd" onclick="cfdUpdate()"' + (cfd.running ? ' disabled' : '') + '>' + (cfd.running ? 'Updating…' : 'Update now') + '</button></div>';
  return h;
}
function rerenderCfd(){ const el = document.getElementById('cfdCard'); if (el && state.tab === 'tunnels') el.innerHTML = cfdCardHtml(); }
async function loadCfd(){
  cfdLoading = true;
  try { cfd = await stApi('GET', 'api/settings/tunnels/cloudflared'); } catch(e){ cfd = { error: e.message }; }
  cfdLoading = false; rerenderCfd();
  if (cfd && cfd.running && !cfdPoll) cfdPoll = setTimeout(() => { cfdPoll = null; loadCfd(); }, 4000);
}
async function cfdCheck(){
  toast('Checking the cloudflared apt repo…');
  try { cfd = await stApi('POST', 'api/settings/tunnels/cloudflared/check'); rerenderCfd(); toast(cfd.updateAvailable ? 'cloudflared ' + cfd.latest + ' is available' : 'cloudflared ' + cfd.installed + ' is the latest', 'success'); }
  catch(e){ stErr(e, 'Check'); }
}
async function cfdUpdate(){
  try {
    await stApi('POST', 'api/settings/tunnels/cloudflared/update');
    toast('Update started — tunnels restart if a new version is installed; this page may lose its connection for a few seconds', 'info', { duration: 9000 });
    if (cfd) cfd.running = true; rerenderCfd();
    setTimeout(loadCfd, 4000);
  } catch(e){ stErr(e, 'Update'); }
}
async function cfdSetAuto(on){
  try { cfd = await stApi('PUT', 'api/settings/tunnels/cloudflared/auto-update', { enabled: on }); rerenderCfd(); toast('Auto-update ' + (on ? 'on' : 'off'), 'success'); }
  catch(e){ stErr(e, 'Auto-update'); loadCfd(); }
}
const stTunnelTokens = {};   // unit → full token, only after an explicit Show / Copy
function tunnelsCardHtml(){
  if (!stTunnels) { if (!stTunnelsLoading) loadTunnels(false); return '<p class="dim">Loading tunnels…</p>'; }
  if (stTunnels.loadError) return '<p style="color:var(--md-error-bright)">⚠ ' + esc(stTunnels.loadError) + '</p>';
  const list = stTunnels.tunnels || [];
  let h = '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Every <span class="mono">cloudflared</span> service on this server. A tunnel token lets whoever holds it run that tunnel — '
    + 'revealing one is recorded in the event log.</p>';
  if (stTunnels.error) h += '<div class="site-why">' + esc(stTunnels.error) + '</div>';
  if (!list.length) return h + '<p class="dim">No cloudflared tunnels found.</p>';
  h += '<table class="upd-table"><tr><th>Tunnel</th><th>IDs</th><th>Routes</th><th>Token</th></tr>';
  for (const t of list) {
    const u = esc(t.unit), full = stTunnelTokens[t.unit];
    const routes = t.routes.length ? t.routes.map(r => '<b>' + esc(r.hostname) + '</b>' + (r.path ? esc(r.path) : '') + ' → <span class="mono">' + esc(r.service) + '</span>'
      + (r.local == null ? '' : r.local > 0 ? ' <span class="dim">(' + r.local + ')</span>' : ' <span style="color:var(--md-warning)">(not answering)</span>')).join('<br>') : '<span class="dim">none</span>';
    h += '<tr><td><b>' + u + '</b>' + (t.name && t.name !== t.unit ? '<br><span class="dim">' + esc(t.name) + '</span>' : '')
      + '<br>' + (t.active ? '<span style="color:var(--md-success, #2e7d32)">● running</span>' : '<span style="color:var(--md-error-bright)">● stopped</span>') + (t.status ? ' <span class="dim">· ' + esc(t.status) + '</span>' : '') + '</td>'
      + '<td class="mono" style="font-size:13px">' + [t.id && 'tunnel ' + esc(t.id), t.account && 'account ' + esc(t.account), t.config && 'config ' + esc(t.config)].filter(Boolean).join('<br>') + '</td>'
      + '<td>' + routes + (t.routesFrom === 'cloudflared' ? '<br><span class="dim" style="font-size:13px">from the running cloudflared</span>' : '') + '</td>'
      + '<td>' + (t.token
        ? '<input class="mono" readonly value="' + esc(full || t.token) + '" style="width:100%;min-width:14em;font-size:13px" onclick="this.select()">'
          + '<div class="dim" style="font-size:13px">' + esc(t.tokenSource || '') + '</div>'
          + '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn small" onclick="toggleTunnelToken(\'' + u + '\')">' + (full ? 'Hide' : 'Show') + '</button><button class="btn small" onclick="copyTunnelToken(\'' + u + '\')">Copy</button></div>'
        : '<span class="dim">' + (t.managed === 'local' ? 'credentials file (locally managed)' : 'no token') + '</span>') + '</td></tr>';
  }
  return h + '</table>';
}
function rerenderTunnels(){ if (state.tab === 'tunnels') renderTunnelsTab(); }
async function loadTunnels(refresh){
  stTunnelsLoading = true;
  try { stTunnels = await stApi('GET', 'api/settings/tunnels' + (refresh ? '?refresh=1' : '')); } catch(e){ stTunnels = { loadError: e.message }; }
  stTunnelsLoading = false;
  rerenderTunnels();
}
async function fetchTunnelToken(unit){
  if (!stTunnelTokens[unit]) stTunnelTokens[unit] = (await stApi('GET', 'api/settings/tunnels/' + encodeURIComponent(unit) + '/token')).token;
  return stTunnelTokens[unit];
}
async function toggleTunnelToken(unit){
  if (stTunnelTokens[unit]) { delete stTunnelTokens[unit]; rerenderTunnels(); return; }
  try { await fetchTunnelToken(unit); rerenderTunnels(); } catch(e){ stErr(e, 'Tunnel token'); }
}
async function copyTunnelToken(unit){
  try { const t = await fetchTunnelToken(unit); await navigator.clipboard.writeText(t); toast('Token of ' + unit + ' copied', 'success'); rerenderTunnels(); }
  catch(e){ stErr(e, 'Copy'); }
}
async function loadCfDomains(){
  cfDomainsLoading = true;
  try { cfDomains = await stApi('GET', 'api/settings/cloudflare/domains'); } catch(e){ cfDomains = { error: e.message }; }
  cfDomainsLoading = false;
  if (state.tab === 'settings') renderSettings();
}
const logoUrlOf = (l) => l && l.source && !/^upload: /.test(l.source) ? l.source : '';
function uploadLogo(inp){
  const f = inp.files && inp.files[0]; if (!f) return;
  if (f.size > 2 * 1024 * 1024) { toast('Logo larger than 2 MB', 'error'); inp.value = ''; return; }
  const rd = new FileReader();
  rd.onload = async () => {
    try { await stApi('POST', 'api/settings/logo/upload', { name: f.name, data: String(rd.result).replace(/^data:[^,]*,/, '') }); toast('Logo uploaded', 'success'); location.reload(); }
    catch(e){ stErr(e, 'Logo'); inp.value = ''; }
  };
  rd.readAsDataURL(f);
}
async function removeLogo(){
  try { await stApi('PUT', 'api/settings/logo', { url: '' }); toast('Logo removed', 'success'); location.reload(); } catch(e){ stErr(e, 'Logo'); }
}
// Fill the timezone picker once (≈600 zones), keeping the current one selected.
let stTzZones = null;
async function fillTzSelect(){
  const el = document.getElementById('stTz'); if (!el || el.dataset.filled) return;
  try { if (!stTzZones) stTzZones = await stApi('GET', 'api/settings/timezones'); } catch(e){ return; }
  const cur = el.value;
  el.innerHTML = stTzZones.zones.map(z => '<option' + (z === cur ? ' selected' : '') + '>' + esc(z) + '</option>').join('');
  el.dataset.filled = '1';
}
async function saveGeneralSettings(){
  const tzEl = document.getElementById('stTz'), g0tz = lastSettings && lastSettings.general.timezone;
  try { await stApi('PUT', 'api/settings/general', { timezone: tzEl ? tzEl.value : undefined, panelName: document.getElementById('stName').value, eventsRetentionDays: document.getElementById('stRet').value, acmeEmail: document.getElementById('stAcme').value }); const lg = document.getElementById('stLogo').value.trim(), g0 = lastSettings && lastSettings.general, logoChanged = !!lg && lg !== logoUrlOf(g0 && g0.logo); if (logoChanged) await stApi('PUT', 'api/settings/logo', { url: lg }); toast('Saved', 'success'); const nm = document.getElementById('stName').value.trim(); if (nm !== (g0 && g0.panelName) || logoChanged || (tzEl && tzEl.value !== g0tz)) { location.reload(); return; } lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Save'); }
}
async function saveTelegramSettings(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('tgOn').checked, chatId: g('tgChat').value, notifyOnUpdate: g('tgUpd').checked, notifyOnComplete: g('tgDone').checked, notifyOnAuth: g('tgAuth').checked, notifyOnSite: g('tgSite').checked };
  if (g('tgToken').value.trim()) body.botToken = g('tgToken').value.trim();
  try { await stApi('PUT', 'api/settings/telegram', body); toast('Telegram settings saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Telegram'); }
}
async function saveSlackSettings(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('slOn').checked, notifyOnUpdate: g('slUpd').checked, notifyOnComplete: g('slDone').checked, notifyOnAuth: g('slAuth').checked, notifyOnSite: g('slSite').checked };
  if (g('slUrl').value.trim()) body.webhookUrl = g('slUrl').value.trim();
  try { await stApi('PUT', 'api/settings/slack', body); toast('Slack settings saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Slack'); }
}
let wlData = null, wlLoading = false, wlRows = null;
function wlBodyHtml(){
  if (!wlData) { if (!wlLoading) loadWhitelist(); return '<p class="dim">Loading…</p>'; }
  if (wlData.error) return '<p style="color:var(--md-error-bright)">⚠ ' + esc(wlData.error) + '</p>';
  const rows = wlRows || (wlRows = wlData.ips.map(e => ({ ip: e.ip, label: e.label || '' })));
  let h = '<p class="dim" style="margin:0 0 8px;font-size:14.5px">One list for the whole server: <b>SSH</b> (admin users ' + esc(wlData.adminUsers.join(', ')) + ' and every site user: ' + esc(wlData.siteUsers.join(', ') || 'none') + ') is only reachable from these addresses, the firewall opens port 22 only to them, and fail2ban never bans them. IPs or CIDR ranges.</p>';
  if (wlData.yourIp) h += '<div class="' + (wlData.yourIpListed ? 'dim' : 'site-why') + '" style="font-size:14px;margin-bottom:8px">You are connected from <b class="mono">' + esc(wlData.yourIp) + '</b> — ' + (wlData.yourIpListed ? 'on the list ✓' : 'NOT on the list. <a href="#" onclick="wlAdd(\'' + esc(wlData.yourIp) + '\', \'my current IP\');return false">Add it</a>') + '</div>';
  h += '<table class="upd-table"><tr><th>IP / range</th><th>Label</th><th></th></tr>';
  rows.forEach((r, i) => { h += '<tr><td><input class="mono" value="' + esc(r.ip) + '" oninput="wlRows[' + i + '].ip=this.value" placeholder="203.0.113.10 or 10.0.0.0/24"></td><td><input value="' + esc(r.label) + '" oninput="wlRows[' + i + '].label=this.value" placeholder="office, home, VPN…" maxlength="60"></td><td><button class="btn small" onclick="wlRows.splice(' + i + ',1); wlRender()">Remove</button></td></tr>'; });
  h += '</table><div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="wlAdd(\'\', \'\')">＋ Add IP</button><button class="btn pri" onclick="saveWhitelist(this)">Save &amp; apply</button></div>';
  return h;
}
function wlRender(){ const el = document.getElementById('wlBody'); if (el) el.innerHTML = wlBodyHtml(); }
function wlAdd(ip, label){ if (!wlRows) return; wlRows.push({ ip, label }); wlRender(); }
async function loadWhitelist(){
  wlLoading = true;
  try { wlData = await stApi('GET', 'api/settings/whitelist'); wlRows = null; } catch(e){ wlData = { error: e.message }; }
  wlLoading = false; wlRender();
}
async function saveWhitelist(btn){
  btn.disabled = true;
  try {
    const r = await stApi('PUT', 'api/settings/whitelist', { ips: wlRows.filter(x => x.ip.trim()).map(x => ({ ip: x.ip.trim(), label: x.label.trim() })) });
    toast('Whitelist applied', 'success', { detail: r.steps.join('\n'), duration: 10000 });
    wlData = null; loadWhitelist();
  } catch(e){ stErr(e, 'Whitelist'); btn.disabled = false; }
}
async function saveSitesDefaults(){
  try { await stApi('PUT', 'api/settings/sites-defaults', { tunnel: document.getElementById('sdTunnel').value, repair: document.getElementById('sdRepair').value, githubOwner: document.getElementById('sdGhOwner').value }); toast('Shared site defaults saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Sites & apps'); }
}
function brevoBody(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('brOn').checked, senderEmail: g('brFrom').value, senderName: g('brName').value, to: g('brTo').value, notifyOnUpdate: g('brUpd').checked, notifyOnComplete: g('brDone').checked, notifyOnAuth: g('brAuth').checked, notifyOnSite: g('brSite').checked };
  if (g('brKey').value.trim()) body.apiKey = g('brKey').value.trim();
  return body;
}
async function saveBrevoSettings(){
  try { await stApi('PUT', 'api/settings/brevo', brevoBody()); toast('Brevo settings saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Brevo'); }
}
async function saveCloudflareSettings(){
  const v = document.getElementById('cfToken').value.trim();
  if (!v) return toast('Nothing to save — paste a token, or type REMOVE to delete the stored one', 'warn');
  try { const r = await stApi('PUT', 'api/settings/cloudflare', { token: v === 'REMOVE' ? '' : v }); toast(r.configured ? 'Cloudflare token verified and saved' : 'Cloudflare token removed', 'success'); cfDomains = null; lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Cloudflare'); }
}
async function saveWasabiSettings(){
  const g = (id) => document.getElementById(id).value.trim();
  const body = { accessKey: g('wbKey'), region: g('wbRegion'), bucket: g('wbBucket'), prefix: g('wbPrefix') };
  if (g('wbSecret')) body.secretKey = g('wbSecret');
  try { await stApi('PUT', 'api/settings/wasabi', body); toast('Wasabi saved — testing…', 'success'); lastSettings = null; await renderSettings(); testWasabi(); }
  catch(e){ stErr(e, 'Wasabi'); }
}
async function testWasabi(){
  toast('Testing Wasabi (list, write, delete)…');
  try { const r = await stApi('POST', 'api/settings/wasabi/test');
    if (r.ok) toast('Wasabi works: ' + r.steps.join(' · '), 'success'); else toast('Wasabi test failed: ' + r.error, 'error', { detail: (r.steps || []).join('\n'), duration: 12000 }); }
  catch(e){ stErr(e, 'Wasabi'); }
}
async function removeWasabi(){
  if (!confirm('Remove the Wasabi settings? Scheduled backups stop until it is set up again. Nothing in the bucket is deleted.')) return;
  try { await stApi('PUT', 'api/settings/wasabi', { remove: true }); toast('Wasabi settings removed', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Wasabi'); }
}
async function saveTurnstileSettings(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('tsOn').checked, siteKey: g('tsSite').value.trim() };
  if (g('tsSecret').value.trim()) body.secretKey = g('tsSecret').value.trim();
  try { const r = await stApi('PUT', 'api/settings/turnstile', body);
    toast(r.turnstile.active ? 'Turnstile is now live on the login page' : 'Turnstile settings saved (challenge off)', 'success');
    lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Turnstile'); }
}
// Tests use whatever is typed in the form, so a credential can be checked before it is saved.
async function testChannel(which){
  const val = (id) => { const el = document.getElementById(id); return el && el.value.trim() ? el.value.trim() : undefined; };
  const body = which === 'cloudflare' ? { token: val('cfToken') }
    : which === 'turnstile' ? { secretKey: val('tsSecret') }
    : which === 'telegram' ? { botToken: val('tgToken'), chatId: val('tgChat') }
    : which === 'brevo' ? brevoBody()
    : { webhookUrl: val('slUrl') };
  toast('Testing ' + which + '…');
  try {
    const r = await stApi('POST', 'api/settings/' + which + '/test', body);
    const cfMsg = 'Token ' + r.status + (r.kind === 'account' ? ' (account-owned' + (r.account ? ', ' + r.account.name : '') + ')' : '') + (r.saved ? '' : ' (not saved yet — press Save to keep it)') + ' · ' + r.zones + ' zone' + (r.zones === 1 ? '' : 's') + (r.zoneNames && r.zoneNames.length ? ': ' + r.zoneNames.join(', ') : '');
    toast(which === 'cloudflare' ? cfMsg : which === 'turnstile' ? 'Cloudflare accepted the secret key' : which === 'brevo' ? 'Test e-mail sent to ' + r.to : 'Test message sent — check ' + which,
      which === 'cloudflare' && r.warning ? 'warn' : 'success',
      Object.assign({ duration: 9000 }, (which === 'cloudflare' || which === 'turnstile') && (r.warning || r.note) ? { detail: [r.warning, r.note].filter(Boolean).join('\n\n'), duration: 14000 } : {}));
  } catch(e){ stErr(e, which); }
}

// ---- Cleanup card (moved from the Modules tab; the API stays under /api/modules/cleanup*) ----
function cleanupCardHtml(d){
  let html = '';
  // Cleanup card (disk hygiene: regenerable caches + build leftovers)
  const cu = d.cleanup || { config: {}, preview: null, running: false, log: [] };
  const cuCfg = cu.config || {};
  const cuPrev = cu.preview;
  const cuLast = (cu.log && cu.log.length) ? cu.log[cu.log.length-1] : null;
  const cuKeys = ['npmCache','pnpmCache','pnpmStore','bunCache','pipCache','projectCaches','nextCache','leftovers'];
  const cuLabels = { npmCache:'npm caches', pnpmCache:'pnpm metadata caches', pnpmStore:'pnpm store prune', bunCache:'bun caches', pipCache:'pip caches', projectCaches:'project tool caches (node_modules/.cache)', nextCache:'Next.js build caches (.next/cache)', leftovers:'leftover node_modules copies (node_modules.pre-*, .bak, .old)' };
  const cuHints = { npmCache:'~/.npm/_cacache + _logs for every user and root', pnpmCache:'~/.cache/pnpm — metadata only, the content store is untouched', pnpmStore:'/var/lib/pnpm-store: removes packages no project references any more (shows store size, not the reclaimable amount)', bunCache:'~/.bun/install/cache', pipCache:'~/.cache/pip', projectCaches:'babel/eslint/webpack/turbo caches, rebuilt on the next build', nextCache:'the next Next.js build is slower once after removal', leftovers:'copies left behind by the npm → pnpm migration; safe to drop once the site runs fine on pnpm' };
  let cuSel = 0;
  html += '<div class="auto-card">';
  html += '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px">';
  html += '<h3 style="margin:0;font-size:17px;font-weight:700">🧹 Cleanup</h3>';
  html += '<span class="hint" style="font-size:14px">regenerable caches + build leftovers · only under /home/*/ and /root · refuses to run while an install is active</span>';
  if (cuLast) html += '<span class="auto-stat" style="margin-left:auto" title="Last run">last run <span class="v">'+new Date(cuLast.timestamp).toLocaleString()+'</span> · freed <span class="v">'+bkBytes(cuLast.freedBytes||0)+'</span>'+((cuLast.errors||[]).length?' · ⚠ <span class="v">'+cuLast.errors.length+'</span> errors':'')+'</span>';
  else html += '<span class="auto-stat" style="margin-left:auto">never run</span>';
  html += '</div>';
  html += '<div class="auto-projlist" style="grid-template-columns:repeat(auto-fill,minmax(360px,1fr))">';
  for (const k of cuKeys) {
    const t = cuPrev ? (cuPrev.targets||[]).find(x => x.key===k) : null;
    const on = !!cuCfg[k];
    if (on && t && !t.prune) cuSel += (t.bytes||0);
    const size = t ? (t.count ? bkBytes(t.bytes)+(t.prune?' in store':'')+' · '+t.count+(t.count===1?' path':' paths') : 'nothing found') : '';
    html += '<label title="'+esc(cuHints[k])+'" style="display:flex;align-items:center;gap:8px"><input type="checkbox" class="cuOpt" data-key="'+k+'" '+(on?'checked':'')+'><span>'+esc(cuLabels[k])+'</span><span style="margin-left:auto;color:var(--md-on-surface-med);font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap">'+esc(size)+'</span></label>';
  }
  html += '</div>';
  if (cuPrev && cuPrev.targets) {
    const lo = cuPrev.targets.find(x => x.key==='leftovers');
    if (lo && lo.items && lo.items.length) html += '<div class="hint" style="font-size:13px;margin-top:8px;line-height:1.7">leftovers: '+lo.items.map(i => '<code style="background:var(--md-surface-04dp);padding:1px 6px;border-radius:4px">'+esc(i.path.replace(/^\/home\//,'~'))+'</code> '+bkBytes(i.bytes)).join(' · ')+'</div>';
  }
  html += '<div class="auto-row" style="margin-top:10px"><label class="switch"><input type="checkbox" id="cuAfterAuto" '+(cuCfg.afterAutoUpdate?'checked':'')+'><span class="slider"></span></label>';
  html += '<label for="cuAfterAuto">Run after the nightly auto-update pass</label>';
  html += '<span class="hint" style="margin-left:auto">'+(cuPrev?('measured '+new Date(cuPrev.measuredAt).toLocaleString()+' · selected ≈ '+bkBytes(cuSel)):'not measured yet — click Measure')+'</span></div>';
  html += '<div class="auto-row"><button class="btn" id="cuSave" style="background:var(--md-primary);color:var(--md-on-primary);padding:8px 16px;font-size:14px">💾 Save</button>';
  html += '<button class="btn" id="cuMeasure" style="padding:8px 16px;font-size:14px">📏 Measure</button>';
  html += '<button class="btn" id="cuRun" '+(cu.running?'disabled':'')+' style="padding:8px 16px;font-size:14px">'+(cu.running?'⏳ cleaning…':'🧹 Clean now')+'</button>';
  if (cuLast && cuLast.results && cuLast.results.length) html += '<span class="hint" style="margin-left:auto">'+cuLast.results.map(r => esc(cuLabels[r.key]||r.key)+': '+bkBytes(r.freed||0)).join(' · ')+'</span>';
  html += '</div>';
  if (cuLast && cuLast.errors && cuLast.errors.length) html += '<div class="hint" style="color:var(--md-error-bright);font-size:13px;margin-top:6px">'+cuLast.errors.slice(0,5).map(esc).join('<br>')+'</div>';
  html += '</div>';

  return html;
}
function readCleanupForm() {
  const view = document.getElementById('settingsview');
  const cfg = {};
  for (const c of view.querySelectorAll('.cuOpt')) cfg[c.dataset.key] = c.checked;
  const aa = view.querySelector('#cuAfterAuto');
  cfg.afterAutoUpdate = aa ? aa.checked : false;
  return cfg;
}
async function saveCleanupConfig(silent) {
  try {
    const res = await fetch('api/modules/cleanup/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(readCleanupForm()) });
    const j = await res.json();
    if (!res.ok) { toast('Save failed: ' + (j.error || res.status), 'error'); return false; }
    if (lastModules) lastModules.cleanup = j.cleanup;
    if (!silent) { renderSettings(); toast('Cleanup settings saved', 'success'); }
    return true;
  } catch (e) { toast('Error: ' + e.message, 'error'); return false; }
}
async function measureCleanupNow() {
  toast('Measuring caches… this can take a minute', 'info');
  try {
    const res = await fetch('api/modules/cleanup/measure', { method:'POST' });
    const j = await res.json();
    if (!res.ok) { toast('Measure failed: ' + (j.error || res.status), 'error'); return; }
    if (lastModules) lastModules.cleanup = j.cleanup;
    if (state.tab === 'settings') renderSettings();
    const p = j.cleanup && j.cleanup.preview;
    toast('Measured · ' + bkBytes(p ? p.totalBytes : 0) + ' in regenerable caches/leftovers', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}
async function runCleanupNow() {
  if (!(await saveCleanupConfig(true))) return;
  toast('Cleanup started…', 'info');
  if (lastModules && lastModules.cleanup) lastModules.cleanup.running = true;
  if (state.tab === 'settings') renderSettings();
  try {
    const res = await fetch('api/modules/cleanup/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: '{}' });
    const j = await res.json();
    if (!res.ok) toast('Cleanup not run: ' + (j.error || j.reason || res.status), 'error');
    else toast('Cleanup done · freed ' + bkBytes(j.freedBytes||0) + ((j.errors||[]).length ? ' · ' + j.errors.length + ' errors' : ''), (j.errors||[]).length ? 'warn' : 'success');
    if (j.cleanup && lastModules) lastModules.cleanup = j.cleanup;
    if (state.tab === 'settings') renderSettings();
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

/* ---- central certificate store ---- */
let certStore = null, certStoreLoading = false;
async function loadCertStore(){
  certStoreLoading = true;
  try { certStore = await stApi('GET', 'api/certstore'); } catch(e){ certStore = { error: e.message }; }
  certStoreLoading = false;
  const el = document.getElementById('certStoreCard'); if (el) el.innerHTML = certStoreCardHtml();
}
function certStoreCardHtml(){
  let h = '<div class="site-card-hd"><h3>Certificate store</h3><span><button class="btn small" onclick="certStoreImport()">Import from sites</button> <button class="btn small pri" onclick="certStoreUpload()">＋ Add certificate…</button> <button class="btn small" onclick="certStore=null; loadCertStore()">↻</button></span></div>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">One copy of each certificate (e.g. the Cloudflare origin wildcard <span class="mono">*.rhc.pw</span>), keys stored encrypted. '
    + '<b>A new site automatically gets the matching certificate from here</b> instead of a self-signed one; existing sites can take one under SSL/TLS. Certificates uploaded to any site are added here too.</p>';
  if (!certStore) { if (!certStoreLoading) loadCertStore(); return h + '<p class="dim">Loading…</p>'; }
  if (certStore.error) return h + '<p style="color:var(--md-error-bright)">⚠ ' + esc(certStore.error) + '</p>';
  const rows = certStore.certificates.map(c => {
    const days = c.expires_at ? Math.floor((Date.parse(c.expires_at) - Date.now()) / 86400e3) : null;
    const pending = c.matches.filter(d => !c.used_by.includes(d));
    return '<tr><td><b>' + esc(c.name) + '</b><div class="dim mono" style="font-size:13px">' + esc(c.sans.join(', ')) + '</div></td>'
      + '<td>' + esc(c.type.replace('_', ' ')) + '</td>'
      + '<td' + (days != null && days < 30 ? ' style="color:var(--md-error-bright)"' : '') + '>' + (c.expires_at ? c.expires_at.slice(0, 10) + ' <span class="dim">(' + (days < 0 ? 'expired' : days + 'd') + ')</span>' : '') + '</td>'
      + '<td style="font-size:13px">' + (c.used_by.length ? c.used_by.map(esc).join('<br>') : '<span class="dim">–</span>')
      + (pending.length ? '<div style="color:var(--md-warning);margin-top:4px">' + pending.length + ' covered site(s) serve another cert: ' + pending.map(esc).join(', ') + '</div>' : '') + '</td>'
      + '<td style="text-align:right;white-space:nowrap">' + (pending.length && !c.expired ? '<button class="btn small" onclick="certStoreDeploy(' + c.id + ', this)">Deploy to ' + pending.length + '</button> ' : '')
      + '<button class="btn small" onclick="certStoreRename(' + c.id + ')">Rename</button> <button class="btn small" onclick="armConfirm(this, \'Click again\', () => certStoreDelete(' + c.id + '))">Delete</button></td></tr>';
  }).join('');
  return h + '<table class="upd-table"><tr><th>Certificate</th><th>Type</th><th>Expires</th><th>Served by</th><th></th></tr>' + (rows || '<tr><td colspan="5" class="dim">Empty — add one or import from sites</td></tr>') + '</table>';
}
function certStoreUpload(){
  const bg = sshModal('<h3>Add certificate to the store</h3>' + stField('Name (optional)', '<input id="csName" placeholder="defaults to the SAN list, e.g. *.rhc.pw, rhc.pw">')
    + stField('Certificate (PEM)', '<textarea id="csCrt" rows="5" class="mono" placeholder="-----BEGIN CERTIFICATE-----"></textarea>', 'Cloudflare → SSL/TLS → Origin Server → Create certificate; a full bundle may be pasted here')
    + stField('Private key (PEM)', '<textarea id="csKey" rows="5" class="mono" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>')
    + stField('Chain (optional)', '<textarea id="csChain" rows="3" class="mono"></textarea>')
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="csGo">Add</button></div>');
  bg.querySelector('#csGo').onclick = async () => {
    try {
      const r = await stApi('POST', 'api/certstore', { name: bg.querySelector('#csName').value, certificate: bg.querySelector('#csCrt').value, key: bg.querySelector('#csKey').value, chain: bg.querySelector('#csChain').value });
      sshModalClose(); toast(r.created ? 'Certificate added to the store' : 'Already in the store', 'success'); loadCertStore();
    } catch(e){ stErr(e, 'Certificate'); }
  };
}
async function certStoreImport(){
  try { const r = await stApi('POST', 'api/certstore/import'); toast('Imported ' + r.added + ' new certificate(s) (' + r.seen + ' checked)', 'success'); loadCertStore(); }
  catch(e){ stErr(e, 'Import'); }
}
async function certStoreRename(id){
  const c = (certStore.certificates || []).find(x => x.id === id); const name = prompt('Name', c ? c.name : '');
  if (name == null) return;
  try { await stApi('PATCH', 'api/certstore/' + id, { name }); loadCertStore(); } catch(e){ stErr(e, 'Rename'); }
}
async function certStoreDelete(id){
  try { await stApi('DELETE', 'api/certstore/' + id); toast('Removed from the store (sites keep their copy)', 'success'); loadCertStore(); } catch(e){ stErr(e, 'Delete'); }
}
async function certStoreDeploy(id, btn){
  btn.disabled = true;
  try {
    const r = await stApi('POST', 'api/certstore/' + id + '/deploy', {});
    const bad = r.results.filter(x => !x.ok);
    toast('Deployed to ' + (r.results.length - bad.length) + ' site(s)' + (bad.length ? ', ' + bad.length + ' failed' : ''), bad.length ? 'warn' : 'success', bad.length ? { detail: bad.map(x => x.domain + ': ' + x.error).join('\n'), duration: 15000 } : {});
  } catch(e){ stErr(e, 'Deploy'); }
  loadCertStore();
}
