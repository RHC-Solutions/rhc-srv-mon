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
  const d = lastSettings, g = d.general, tg = d.telegram, sl = d.slack, cf = d.cloudflare;
  document.getElementById('updated').textContent = g.panelDomain + ' · ' + g.hostname + ' · ' + g.timezone + ' · node ' + g.node;
  let html = '<div class="upd-grid">';
  // General
  html += '<div class="upd-card"><h3>General</h3><div class="row2">'
    + stField('Panel domain', '<input value="' + esc(g.panelDomain) + '" disabled>', 'from nginx custom-domain.conf')
    + stField('Server IP', '<input value="' + esc(g.ip || '') + '" disabled>') + '</div><div class="row2">'
    + stField('Timezone', '<input value="' + esc(g.timezone) + '" disabled>')
    + stField('Event log retention (days)', '<input id="stRet" type="number" min="1" max="3650" value="' + esc(g.eventsRetentionDays) + '">') + '</div>'
    + stField('ACME / Let\'s Encrypt e-mail', '<input id="stAcme" type="email" value="' + esc(g.acmeEmail || '') + '" placeholder="admin@example.com">', 'used when certificates are issued from this panel (upcoming)')
    + '<div class="site-actions"><button class="btn pri" onclick="saveGeneralSettings()">Save</button></div></div>';
  // Telegram
  html += '<div class="upd-card"><h3>Telegram</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="tgOn"' + (tg.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Enabled</label></div>'
    + '<div class="row2">' + stField('Bot token', '<input type="password" id="tgToken" placeholder="' + (tg.hasToken ? esc(tg.botToken) + ' (leave empty to keep)' : '123456:ABC-DEF1234ghIkl') + '">')
    + stField('Chat ID', '<input id="tgChat" value="' + esc(tg.chatId || '') + '" placeholder="-100123456789">') + '</div>'
    + '<div class="upd-chk-grid"><label><input type="checkbox" id="tgUpd"' + (tg.notifyOnUpdate !== false ? ' checked' : '') + '> Updates available</label><label><input type="checkbox" id="tgDone"' + (tg.notifyOnComplete !== false ? ' checked' : '') + '> Update / backup / cleanup results</label><label><input type="checkbox" id="tgAuth"' + (tg.notifyOnAuth !== false ? ' checked' : '') + '> Web login attempts</label></div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'telegram\')">📨 Send test</button><button class="btn pri" onclick="saveTelegramSettings()">Save</button></div></div>';
  // Slack
  html += '<div class="upd-card"><h3>Slack</h3>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox" id="slOn"' + (sl.enabled ? ' checked' : '') + '><span class="slider"></span></label><label>Enabled</label></div>'
    + stField('Incoming webhook URL', '<input type="password" id="slUrl" placeholder="' + (sl.hasUrl ? esc(sl.webhookUrl) + ' (leave empty to keep)' : 'https://hooks.slack.com/services/T…/B…/…') + '">', 'Slack → Apps → Incoming Webhooks → pick a channel')
    + '<div class="upd-chk-grid"><label><input type="checkbox" id="slUpd"' + (sl.notifyOnUpdate !== false ? ' checked' : '') + '> Updates available</label><label><input type="checkbox" id="slDone"' + (sl.notifyOnComplete !== false ? ' checked' : '') + '> Update / backup / cleanup results</label><label><input type="checkbox" id="slAuth"' + (sl.notifyOnAuth !== false ? ' checked' : '') + '> Web login attempts</label></div>'
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'slack\')">📨 Send test</button><button class="btn pri" onclick="saveSlackSettings()">Save</button></div></div>';
  // Cloudflare
  html += '<div class="upd-card"><h3>Cloudflare</h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">API token with <b>Zone:Read</b> and <b>DNS:Edit</b> (Cloudflare dashboard → My Profile → API Tokens). Stored encrypted. Powers the domains overview below; DNS records for new sites and origin certificates come next.</p>'
    + stField('API token', '<input type="password" id="cfToken" placeholder="' + (cf.configured ? esc(cf.token) + ' (leave empty to keep, type REMOVE to delete)' : 'paste token') + '">')
    + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="testChannel(\'cloudflare\')">Verify token</button><button class="btn pri" onclick="saveCloudflareSettings()">Save</button></div></div>';
  html += '</div>';
  // Domains (Cloudflare zones × our sites)
  html += '<div class="upd-card" style="margin-top:14px"><div class="site-card-hd"><h3>Domains</h3>' + (cf.configured ? '<button class="btn small" onclick="cfDomains=null; loadCfDomains()">↻</button>' : '') + '</div>';
  if (!cf.configured) html += '<p class="dim">Add a Cloudflare API token to see zones and how each site domain resolves.</p>';
  else if (!cfDomains) { html += '<p class="dim">Loading zones…</p>'; if (!cfDomainsLoading) loadCfDomains(); }
  else if (cfDomains.error) html += '<p style="color:#ff8088">⚠ ' + esc(cfDomains.error) + '</p>';
  else {
    html += '<table class="upd-table"><tr><th>Site</th><th>Zone</th><th>DNS</th><th>Proxied</th><th>Points here</th><th>www</th></tr>';
    for (const s of cfDomains.sites) {
      html += '<tr><td><b>' + esc(s.domain) + '</b></td><td>' + (s.zone ? esc(s.zone) + (s.zone_status !== 'active' ? ' <span class="dim">(' + esc(s.zone_status) + ')</span>' : '') : '<span class="dim">not in Cloudflare</span>') + '</td>'
        + '<td class="mono">' + (s.records ? (s.records.length ? s.records.map(r => esc(r.type + ' ' + r.content)).join('<br>') : '<span style="color:#f8a306">no record</span>') : (s.error ? '<span style="color:#ff8088">' + esc(s.error) + '</span>' : '')) + '</td>'
        + '<td>' + (s.proxied == null ? '' : s.proxied ? '☁️ yes' : 'no (DNS only)') + '</td>'
        + '<td>' + (s.records ? (s.points_here ? '✅' : s.proxied ? '<span class="dim">via Cloudflare</span>' : '<span style="color:#f8a306">✗</span>') : '') + '</td>'
        + '<td class="mono dim">' + (s.www ? (s.www.length ? s.www.map(r => esc(r.type + ' ' + r.content)).join('<br>') : '–') : '') + '</td></tr>';
    }
    html += '</table><div class="dim" style="font-size:14px;margin-top:8px">Zones in this account: ' + cfDomains.zones.map(z => esc(z.name) + (z.status !== 'active' ? ' (' + esc(z.status) + ')' : '')).join(', ') + '</div>';
  }
  html += '</div>';
  // Cleanup (moved from Modules)
  const d2 = { cleanup: (lastModules && lastModules.cleanup) || { config: {}, preview: null, running: false, log: [] } };
  html += '<div style="margin-top:14px">' + cleanupCardHtml(d2) + '</div>';
  view.innerHTML = html;
  const cuSaveBtn = document.getElementById('cuSave');
  if (cuSaveBtn) cuSaveBtn.addEventListener('click', () => saveCleanupConfig(false));
  const cuMeasureBtn = document.getElementById('cuMeasure');
  if (cuMeasureBtn) cuMeasureBtn.addEventListener('click', () => measureCleanupNow());
  const cuRunBtn = document.getElementById('cuRun');
  if (cuRunBtn) cuRunBtn.addEventListener('click', () => armConfirm(cuRunBtn, '⚠ Click again to delete', () => runCleanupNow()));
}
async function loadCfDomains(){
  cfDomainsLoading = true;
  try { cfDomains = await stApi('GET', 'api/settings/cloudflare/domains'); } catch(e){ cfDomains = { error: e.message }; }
  cfDomainsLoading = false;
  if (state.tab === 'settings') renderSettings();
}
async function saveGeneralSettings(){
  try { await stApi('PUT', 'api/settings/general', { eventsRetentionDays: document.getElementById('stRet').value, acmeEmail: document.getElementById('stAcme').value }); toast('Saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Save'); }
}
async function saveTelegramSettings(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('tgOn').checked, chatId: g('tgChat').value, notifyOnUpdate: g('tgUpd').checked, notifyOnComplete: g('tgDone').checked, notifyOnAuth: g('tgAuth').checked };
  if (g('tgToken').value.trim()) body.botToken = g('tgToken').value.trim();
  try { await stApi('PUT', 'api/settings/telegram', body); toast('Telegram settings saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Telegram'); }
}
async function saveSlackSettings(){
  const g = (id) => document.getElementById(id);
  const body = { enabled: g('slOn').checked, notifyOnUpdate: g('slUpd').checked, notifyOnComplete: g('slDone').checked, notifyOnAuth: g('slAuth').checked };
  if (g('slUrl').value.trim()) body.webhookUrl = g('slUrl').value.trim();
  try { await stApi('PUT', 'api/settings/slack', body); toast('Slack settings saved', 'success'); lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Slack'); }
}
async function saveCloudflareSettings(){
  const v = document.getElementById('cfToken').value.trim();
  if (!v) return toast('Nothing to save — paste a token, or type REMOVE to delete the stored one', 'warn');
  try { const r = await stApi('PUT', 'api/settings/cloudflare', { token: v === 'REMOVE' ? '' : v }); toast(r.configured ? 'Cloudflare token verified and saved' : 'Cloudflare token removed', 'success'); cfDomains = null; lastSettings = null; renderSettings(); }
  catch(e){ stErr(e, 'Cloudflare'); }
}
// Tests use whatever is typed in the form, so a credential can be checked before it is saved.
async function testChannel(which){
  const val = (id) => { const el = document.getElementById(id); return el && el.value.trim() ? el.value.trim() : undefined; };
  const body = which === 'cloudflare' ? { token: val('cfToken') }
    : which === 'telegram' ? { botToken: val('tgToken'), chatId: val('tgChat') }
    : { webhookUrl: val('slUrl') };
  toast('Testing ' + which + '…');
  try {
    const r = await stApi('POST', 'api/settings/' + which + '/test', body);
    const cfMsg = 'Token ' + r.status + (r.kind === 'account' ? ' (account-owned' + (r.account ? ', ' + r.account.name : '') + ')' : '') + (r.saved ? '' : ' (not saved yet — press Save to keep it)') + ' · ' + r.zones + ' zone' + (r.zones === 1 ? '' : 's') + (r.zoneNames && r.zoneNames.length ? ': ' + r.zoneNames.join(', ') : '');
    toast(which === 'cloudflare' ? cfMsg : 'Test message sent — check ' + which,
      which === 'cloudflare' && r.warning ? 'warn' : 'success',
      Object.assign({ duration: 9000 }, which === 'cloudflare' && (r.warning || r.note) ? { detail: [r.warning, r.note].filter(Boolean).join('\n\n'), duration: 14000 } : {}));
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
    html += '<label title="'+esc(cuHints[k])+'" style="display:flex;align-items:center;gap:8px"><input type="checkbox" class="cuOpt" data-key="'+k+'" '+(on?'checked':'')+'><span>'+esc(cuLabels[k])+'</span><span style="margin-left:auto;color:#9ca3af;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap">'+esc(size)+'</span></label>';
  }
  html += '</div>';
  if (cuPrev && cuPrev.targets) {
    const lo = cuPrev.targets.find(x => x.key==='leftovers');
    if (lo && lo.items && lo.items.length) html += '<div class="hint" style="font-size:13px;margin-top:8px;line-height:1.7">leftovers: '+lo.items.map(i => '<code style="background:#12141d;padding:1px 6px;border-radius:4px">'+esc(i.path.replace(/^\/home\//,'~'))+'</code> '+bkBytes(i.bytes)).join(' · ')+'</div>';
  }
  html += '<div class="auto-row" style="margin-top:10px"><label class="switch"><input type="checkbox" id="cuAfterAuto" '+(cuCfg.afterAutoUpdate?'checked':'')+'><span class="slider"></span></label>';
  html += '<label for="cuAfterAuto">Run after the nightly auto-update pass</label>';
  html += '<span class="hint" style="margin-left:auto">'+(cuPrev?('measured '+new Date(cuPrev.measuredAt).toLocaleString()+' · selected ≈ '+bkBytes(cuSel)):'not measured yet — click Measure')+'</span></div>';
  html += '<div class="auto-row"><button class="btn" id="cuSave" style="background:#5cdd8b;color:#0b2818;padding:8px 16px;font-size:14px">💾 Save</button>';
  html += '<button class="btn" id="cuMeasure" style="padding:8px 16px;font-size:14px">📏 Measure</button>';
  html += '<button class="btn" id="cuRun" '+(cu.running?'disabled':'')+' style="padding:8px 16px;font-size:14px">'+(cu.running?'⏳ cleaning…':'🧹 Clean now')+'</button>';
  if (cuLast && cuLast.results && cuLast.results.length) html += '<span class="hint" style="margin-left:auto">'+cuLast.results.map(r => esc(cuLabels[r.key]||r.key)+': '+bkBytes(r.freed||0)).join(' · ')+'</span>';
  html += '</div>';
  if (cuLast && cuLast.errors && cuLast.errors.length) html += '<div class="hint" style="color:#ff8088;font-size:13px;margin-top:6px">'+cuLast.errors.slice(0,5).map(esc).join('<br>')+'</div>';
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
