// ---- App Store: AI agents, runtimes (all PHP / Node / Python versions…), databases, tools.
let asData = null, asLoading = false, asCat = 'apps', asPoll = null, asOpenJob = null;
async function loadAppStore(refresh){
  asLoading = true;
  try { asData = await stApi('GET', 'api/appstore' + (refresh ? '?refresh=1' : '')); } catch(e){ asData = { error: e.message }; }
  asLoading = false;
  if (asCat === 'agents' && typeof loadAgents === 'function' && !agData) await loadAgents();
  if (state.tab === 'appstore') renderAppStore(true);
  clearTimeout(asPoll);
  if (asData && (asData.jobs || []).some(j => j.state === 'running' || j.state === 'queued')) asPoll = setTimeout(() => loadAppStore(false), 3000);
}
function renderAppStore(fromLoad){
  plainTabHeader('Install, update and remove server software — every version from the vendors\' own repositories');
  const view = document.getElementById('appstoreview');
  if (!asData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!asLoading) loadAppStore(false); return; }
  if (asData.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(asData.error) + '</div>'; return; }
  let h = '<div class="toolbar" style="margin-bottom:12px">' + asData.categories.map(([k, l]) => '<button class="chip' + (asCat === k ? ' active' : '') + '" onclick="asCat=\'' + k + '\'; ' + (k === 'agents' ? 'loadAgents().then(() => renderAppStore(true))' : 'renderAppStore(true)') + '">' + esc(l) + '</button>').join('')
    + '<button class="btn" style="margin-left:auto" onclick="loadAppStore(true)">⟳ Re-check installed</button></div>';
  // jobs
  const jobs = asData.jobs || [];
  if (jobs.length) {
    h += '<div class="upd-card" style="margin-bottom:14px"><h3>Jobs</h3>';
    for (const j of jobs.slice(0, 6)) h += '<details' + (j.state === 'running' || asOpenJob === j.id ? ' open' : '') + ' ontoggle="if(this.open){asOpenJob=\'' + j.id + '\'; asJobLog(\'' + j.id + '\')}"><summary>' + ({ running: '⏳', queued: '🕒', done: '✅', failed: '❌' }[j.state] || '') + ' ' + esc(j.action) + ' <b>' + esc(j.name) + '</b>' + (j.version !== 'latest' ? ' ' + esc(j.version) : '') + ' · ' + esc(j.state) + (j.error ? ' — <span style="color:var(--md-error-bright)">' + esc(j.error) + '</span>' : '') + ' <span class="dim">' + esc(new Date(j.started).toLocaleTimeString()) + '</span></summary><pre class="mono" id="asLog' + j.id + '" style="font-size:12px;max-height:260px;overflow:auto;white-space:pre-wrap;margin:6px 0">' + esc(j.log.join('\n')) + '</pre></details>';
    h += '</div>';
  }
  if (asCat === 'agents') {
    h += '<div class="upd-card">' + (typeof agentsCardHtml === 'function' ? agentsCardHtml() : '') + '</div>';
    view.innerHTML = h; return;
  }
  const busy = jobs.some(j => j.state === 'running' || j.state === 'queued');
  h += '<div class="upd-grid">';
  for (const it of asData.items.filter(x => x.category === asCat)) {
    if (it.app) { h += asAppCard(it, busy); continue; }
    const inst = Object.entries(it.installed).filter(([, v]) => v);
    h += '<div class="upd-card"><div class="site-card-hd"><h3>' + esc(it.name) + '</h3>' + (inst.length ? '<span class="upd-badge ok">installed</span>' : '<span class="upd-badge na">not installed</span>') + '</div>'
      + '<p class="dim" style="margin:0 0 8px;font-size:14px">' + esc(it.desc) + '</p>'
      + (it.risky ? '<p style="margin:0 0 8px;font-size:13.5px;color:var(--md-warning)">⚠ ' + esc(it.risky) + '</p>' : '')
      + '<table class="upd-table">';
    for (const v of it.versions) {
      const iv = it.installed[v];
      const label = v === 'latest' ? 'latest' : v;
      let btns = '';
      if (iv) {
        if (it.canUpdate) btns += '<button class="btn small" ' + (busy ? 'disabled ' : '') + 'onclick="asRun(\'' + it.id + '\',\'update\',\'' + v + '\',this)">⬆ Update</button> ';
        if (it.canRemove) btns += '<button class="btn small danger" ' + (busy ? 'disabled ' : '') + 'onclick="armConfirm(this, \'Remove ' + esc(it.name) + ' ' + label + '?\', () => asRun(\'' + it.id + '\',\'remove\',\'' + v + '\',this))">🗑 Remove</button>';
      } else {
        const other = !it.multi && inst.length;
        btns += '<button class="btn small ' + (other ? '' : 'pri') + '" ' + (busy ? 'disabled ' : '') + 'onclick="' + (other || it.risky ? 'armConfirm(this, \'' + (other ? 'Switch to ' + label + '?' : 'Install?') + '\', () => asRun(\'' + it.id + '\',\'install\',\'' + v + '\',this))' : 'asRun(\'' + it.id + '\',\'install\',\'' + v + '\',this)') + '">' + (other ? '⇄ Switch to ' + esc(label) : '＋ Install') + '</button>';
      }
      h += '<tr><td><b>' + esc(label) + '</b></td><td class="mono dim" style="font-size:13px">' + esc(iv || '') + '</td><td style="text-align:right;white-space:nowrap">' + btns + '</td></tr>';
    }
    h += '</table></div>';
  }
  view.innerHTML = h + '</div>';
}
// ---- Web apps (WordPress): its sites, + new site, updates
function asAppCard(it, busy){
  const sites = it.sites || [];
  let h = '<div class="upd-card" style="grid-column:1/-1"><div class="site-card-hd"><h3>' + esc(it.name) + '</h3>' + (it.latest ? '<span class="dim">latest ' + esc(it.latest) + '</span>' : '') + '</div>'
    + '<p class="dim" style="margin:0 0 10px;font-size:14px">' + esc(it.desc) + '</p>';
  if (sites.length) {
    h += '<table class="upd-table"><tr><th>Site</th><th>Version</th><th></th></tr>' + sites.map(x => '<tr><td><a href="https://' + esc(x.domain) + '/wp-admin/" target="_blank" rel="noopener"><b>' + esc(x.domain) + '</b> ↗</a></td><td class="mono">' + esc(x.version || '?') + (it.latest && x.version && x.version !== it.latest ? ' <span class="upd-badge new">⬆ ' + esc(it.latest) + '</span>' : '') + '</td><td style="text-align:right;white-space:nowrap">'
      + (x.managed ? '<button class="btn small" onclick="asWpLogin(\'' + esc(x.domain) + '\')">🔑 Login</button> ' : '')
      + '<button class="btn small" ' + (busy ? 'disabled ' : '') + 'onclick="asWpUpdate(\'' + esc(x.domain) + '\', this)" title="core, plugins, themes, languages">⬆ Update</button> <button class="btn small" onclick="siteGo(\'' + esc(x.domain) + '\', \'settings\')">Site ›</button></td></tr>').join('') + '</table>';
  } else h += '<div class="dim" style="margin-bottom:8px">No WordPress sites on this server yet.</div>';
  h += '<div class="site-actions" style="justify-content:space-between"><button class="btn pri" ' + (busy ? 'disabled ' : '') + 'onclick="asWpNew()">＋ New WordPress site</button>'
    + (sites.length > 1 ? '<button class="btn" ' + (busy ? 'disabled ' : '') + 'onclick="armConfirm(this, \'Update all ' + sites.length + '?\', () => asWpUpdate(null, this))">⬆ Update all</button>' : '') + '</div>';
  // the admin login of a WordPress install that just finished (shown once, kept in the Vault)
  const fin = (asData.jobs || []).find(j => j.app === 'wordpress' && j.action === 'install' && j.state === 'done' && j.result && j.result.domain && !asWpSeen[j.id]);
  if (fin) h += '<div style="margin-top:12px;padding:10px 12px;border-radius:8px;background:color-mix(in srgb, var(--md-success, #2e7d32) 14%, transparent);font-size:14.5px">✅ <b>' + esc(fin.result.domain) + '</b> is ready — <a href="' + esc(fin.result.admin) + '" target="_blank" rel="noopener">' + esc(fin.result.admin) + '</a><br>User <span class="mono">' + esc(fin.result.adminUser) + '</span> <button class="btn small" onclick="asWpLogin(\'' + esc(fin.result.domain) + '\')">🔑 Show login</button> <button class="btn small" onclick="asWpSeen[\'' + fin.id + '\']=1;renderAppStore(true)">Hide</button>'
    + '<div class="dim" style="font-size:13px">Also under 🔑 Login. The site is reachable once its DNS / Cloudflare tunnel points here (Sites → ' + esc(fin.result.domain) + ').</div></div>';
  return h + '</div>';
}
const asWpSeen = {};
async function asWpNew(){
  const bg = sshModal('<h3>New WordPress site</h3>'
    + sshField('Domain', '<input id="wpDom" placeholder="blog.example.com">', 'a new site is created for it — PHP, database, HTTPS')
    + sshField('Site title', '<input id="wpTitle" placeholder="My blog">')
    + '<div class="row2">' + sshField('Admin user', '<input id="wpUser" value="admin">') + sshField('Admin e-mail', '<input id="wpMail" type="email" placeholder="you@example.com">', 'password resets go here') + '</div>'
    + '<div class="row2">' + sshField('Language', '<select id="wpLoc"><option value="en_US">English (US)</option><option value="en_GB">English (UK)</option><option value="de_DE">Deutsch</option><option value="fr_FR">Français</option><option value="es_ES">Español</option><option value="it_IT">Italiano</option><option value="pt_PT">Português</option><option value="nl_NL">Nederlands</option><option value="pl_PL">Polski</option><option value="uk">Українська</option><option value="he_IL">עברית</option><option value="ru_RU">Русский</option></select>')
    + sshField('Admin password', '<input id="wpPw" type="password" placeholder="generated if empty">', 'at least 12 characters') + '</div>'
    + '<div class="foot"><button class="btn" id="wpNo">Cancel</button><button class="btn pri" id="wpYes">Install WordPress</button></div>');
  bg.querySelector('#wpNo').onclick = () => sshModalClose();
  bg.querySelector('#wpYes').onclick = async () => {
    const v = (id) => (document.getElementById(id) || {}).value || '';
    const body = { domain: v('wpDom').trim(), title: v('wpTitle').trim(), adminUser: v('wpUser').trim(), adminEmail: v('wpMail').trim(), locale: v('wpLoc') };
    if (v('wpPw')) body.adminPassword = v('wpPw');
    if (!body.domain || !body.adminEmail) { toast('Domain and admin e-mail are needed', 'error'); return; }
    try { const j = await stApi('POST', 'api/appstore/wordpress/install', body); asOpenJob = j.id; sshModalClose(); toast('Installing WordPress on ' + body.domain + ' — follow it under Jobs', 'success'); loadAppStore(false); }
    catch(e){ stErr(e, 'WordPress'); }
  };
}
async function asWpUpdate(domain, btn){
  if (btn) btn.disabled = true;
  try { const j = await stApi('POST', 'api/appstore/wordpress/update', domain ? { domain } : {}); asOpenJob = j.id; toast('Updating WordPress' + (domain ? ' on ' + domain : ''), 'success'); loadAppStore(false); }
  catch(e){ stErr(e, 'WordPress'); if (btn) btn.disabled = false; }
}
async function asWpLogin(domain){
  try { const c = await stApi('GET', 'api/appstore/wordpress/' + encodeURIComponent(domain) + '/login');
    sshModal('<h3>WordPress login — ' + esc(domain) + '</h3><p style="font-size:14.5px"><a href="https://' + esc(domain) + '/wp-admin/" target="_blank" rel="noopener">https://' + esc(domain) + '/wp-admin/</a></p><table class="upd-table"><tr><td>User</td><td class="mono">' + esc(c.adminUser) + '</td></tr><tr><td>Password</td><td class="mono">' + esc(c.password) + '</td></tr><tr><td>E-mail</td><td>' + esc(c.adminEmail) + '</td></tr></table><div class="dim" style="font-size:13px">The password set at install time — if it was changed in WordPress since, this one no longer works.</div><div class="foot"><button class="btn" onclick="sshModalClose()">Close</button></div>');
  } catch(e){ stErr(e, 'Login'); }
}
async function asJobLog(id){
  try { const j = await stApi('GET', 'api/appstore/jobs/' + id); const el = document.getElementById('asLog' + id); if (el) { el.textContent = j.log.join('\n'); el.scrollTop = el.scrollHeight; } } catch(_){}
}
async function asRun(id, action, version, btn){
  if (btn) btn.disabled = true;
  try { const j = await stApi('POST', 'api/appstore/' + id + '/' + action, { version }); asOpenJob = j.id; toast(action + ' ' + j.name + (version !== 'latest' ? ' ' + version : '') + ' started', 'success'); loadAppStore(false); }
  catch(e){ stErr(e, 'App Store'); if (btn) btn.disabled = false; }
}
