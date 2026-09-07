/* ---------------------------------------------------------------- sites */
// List (cards with health) → detail with CloudPanel-style sub-tabs. Sub-navigation lives in the
// query string (sites?d=<domain>&t=<tab>) so every relative api/ URL keeps working behind nginx.
let lastSites = null;
const SITE_TABS = [['settings', 'Settings'], ['procs', 'Processes'], ['vhost', 'Vhost'], ['databases', 'Databases'], ['ssl', 'SSL/TLS'], ['cloudflare', 'Cloudflare'], ['security', 'Security'], ['ssh', 'SSH/FTP'], ['files', 'File Manager'], ['cron', 'Cron Jobs'], ['logs', 'Logs']];
let siteView = { domain: null, tab: 'settings', data: null, loading: false, sub: {} };   // sub: per-tab fetched data
let siteQ = state.siteQ || '';
let siteViewMode = state.siteViewMode || 'cards';      // cards | table
let siteSort = state.siteSort || 'status';             // table sort column
let siteSortDir = state.siteSortDir || 1;
let siteStatusFilter = '';                              // toolbar pill filter: online | degraded | down

function siteParams(){ return new URLSearchParams(location.search); }
function siteGo(domain, tab, opts){
  opts = opts || {};
  const p = new URLSearchParams();
  if (domain) { p.set('d', domain); p.set('t', tab || 'settings'); }
  const url = 'sites' + (p.toString() ? '?' + p.toString() : '');
  try { history[opts.replace ? 'replaceState' : 'pushState']({ tab: 'sites' }, '', url); } catch(e){}
  if (domain && domain !== siteView.domain) siteView = { domain, tab: tab || 'settings', data: null, loading: false, sub: {} };
  else if (domain) siteView.tab = tab || 'settings';
  else siteView = { domain: null, tab: 'settings', data: null, loading: false, sub: {} };
  renderSites();
}
// JSON helper for this tab: throws with server message (+detail) on error.
async function siteApi(method, url, body){
  const r = await fetch(url, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch(e){}
  if (!r.ok) { const e = new Error((j && j.error) || ('HTTP ' + r.status)); e.detail = j && j.detail; e.status = r.status; throw e; }
  return j;
}
function siteErr(e, what){ toast((what ? what + ': ' : '') + e.message, 'error', e.detail ? { detail: e.detail, duration: 12000 } : { duration: 8000 }); }
function siteTypeLabel(t){ return t === 'nodejs' ? 'Node.js' : t === 'php' ? 'PHP' : t === 'static' ? 'Static' : t === 'reverse-proxy' ? 'Reverse Proxy' : t === 'python' ? 'Python' : t; }
function siteDays(iso){ if (!iso) return null; return Math.floor((new Date(iso).getTime() - Date.now()) / 86400000); }
const siteUrl = (rest) => 'api/sites/' + encodeURIComponent(siteView.domain) + (rest || '');

function renderSites(){
  const p = siteParams();
  const d = p.get('d');
  if (d && siteView.domain !== d) siteView = { domain: d, tab: p.get('t') || 'settings', data: null, loading: false, sub: {} };
  else if (d && p.get('t') && p.get('t') !== siteView.tab) siteView.tab = p.get('t');
  else if (!d && siteView.domain) siteView = { domain: null, tab: 'settings', data: null, loading: false, sub: {} };
  if (siteView.domain) return renderSiteDetail();
  renderSitesList();
}

/* ================================================================= list */
function renderSitesList(){
  const view = document.getElementById('sitesview');
  if (!lastSites) { view.innerHTML = '<div class="upd-card">Loading…</div>'; return; }
  if (view.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const d = lastSites;
  document.getElementById('host').textContent = '';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.generated_at ? new Date(d.generated_at).toLocaleString() : 'never') + ' · auto-refresh 5 min';
  // no banner when everything is fine — problems show as a red banner, counts live in the toolbar pills
  const down = d.sites.filter(s => s.status === 'down').length, degraded = d.sites.filter(s => s.status === 'degraded').length, total = d.sites.length, online = d.sites.filter(s => s.status === 'online').length;
  if (down === 0 && degraded === 0) { showBanner(null); setStatus([{ level:'ok', icon:'✅', text:'All sites operational', sub: total + ' sites' }]); }
  else { const parts = []; if (down) parts.push(down + ' down'); if (degraded) parts.push(degraded + ' degraded'); showBanner('<span class="ico">🔴</span> ' + parts.join(', ') + ' <span style="margin-left:auto;font-size:15px;font-weight:400">'+(total-down-degraded)+'/'+total+' ok</span>'); setStatus([{ level: down ? 'bad' : 'warn', icon: down ? '🔴' : '🟠', text: parts.join(', '), sub: (total-down-degraded)+'/'+total+' ok' }]); }
  const pill = (st, n) => n ? '<button class="chip' + (siteStatusFilter === st ? ' active' : '') + '" onclick="siteStatusFilter = siteStatusFilter === \'' + st + '\' ? \'\' : \'' + st + '\'; renderSitesList()" title="Show only ' + st + ' sites"><span class="dot ' + st + '"></span>' + n + ' ' + st + '</button>' : '';

  let html = '<div class="site-toolbar"><input id="siteQ" type="search" placeholder="Filter sites…" autocomplete="off" value="' + esc(siteQ) + '" oninput="siteQ=this.value; state.siteQ=siteQ; saveState(); renderSitesList()">'
    + '<div class="site-stats">' + pill('online', online) + pill('degraded', degraded) + pill('down', down) + '<span class="dim" style="font-size:14px;margin-left:4px">' + total + ' sites' + (d.sites.some(s => s.managed_by === 'clp') ? ' · ' + d.sites.filter(s => s.managed_by === 'clp').length + ' owned by CloudPanel' : '') + '</span></div>'
    + '<span style="flex:1"></span>'
    + '<div class="site-viewsw"><button class="chip' + (siteViewMode === 'cards' ? ' active' : '') + '" onclick="siteSetView(\'cards\')" title="Cards">▦</button><button class="chip' + (siteViewMode === 'table' ? ' active' : '') + '" onclick="siteSetView(\'table\')" title="Table">☰</button></div>'
    + '<button class="btn" onclick="siteSyncClp()" title="Re-read CloudPanel\'s database (sites this panel already manages are left alone)">⟳ Sync from CloudPanel</button>'
    + '<button class="btn pri" onclick="siteNewDialog()">＋ New Site</button></div>';
  const sortOrder = { 'down': 0, 'degraded': 1, 'online': 2 };
  const q = siteQ.trim().toLowerCase();
  const filtered = [...d.sites].filter(s => (!siteStatusFilter || s.status === siteStatusFilter) && (!q || s.domain.toLowerCase().includes(q) || (s.user||'').toLowerCase().includes(q) || (s.type||'').includes(q)));
  const byStatus = (a, b) => (sortOrder[a.status]||9) - (sortOrder[b.status]||9) || a.domain.localeCompare(b.domain);
  if (siteViewMode === 'table') { view.innerHTML = html + siteTableHtml(filtered, byStatus); return; }
  const sorted = filtered.sort(byStatus);
  html += '<div class="site-grid">';
  for (const s of sorted) {
    const appVer = s.nodeVersion ? 'Node ' + s.nodeVersion : s.phpVersion ? 'PHP ' + s.phpVersion : '';
    const portInfo = s.nodePort ? ':' + s.nodePort : s.poolPort ? ':' + s.poolPort : '';
    const healthIcon = s.httpUp ? '✅' : (s.httpUp === false ? '❌' : '—');
    html += '<div class="site-card clickable" onclick="siteGo(\'' + esc(s.domain) + '\', state.siteTab || \'settings\')">';
    html += '<div class="top"><div class="domain">' + esc(s.domain) + '<span class="hint">' + esc(siteTypeLabel(s.type)) + (s.managed_by === 'clp' ? ' · CLP' : '') + '</span></div>';
    html += '<span class="badge ' + s.status + '">' + s.statusLabel + '</span></div>';
    html += '<div class="meta"><span>Port: <span class="val">' + (portInfo || 'n/a') + '</span></span><span>HTTP: <span class="val">' + healthIcon + '</span></span><span>' + esc(appVer) + '</span><span>Disk: <span class="val">' + esc(s.disk || '?') + '</span></span></div>';
    if (s.statusReason) html += '<div class="site-why">' + esc(s.statusReason) + '</div>';
    if (s.pm2 && s.pm2.length) {
      html += '<div class="procs">';
      for (const p of s.pm2) { const pUp = p.status === 'online'; html += '<div class="prow"><span class="pname">' + esc(p.name) + '</span><span class="pstat ' + (pUp?'up':'down') + '">' + (pUp?'🟢':'🔴') + ' ' + esc(p.status) + ' <span class="dim">CPU ' + p.cpu + '% · ' + fmtMem(p.memory) + '</span></span></div>'; }
      html += '</div>';
    }
    if (s.canControl) html += siteCtlHtml(s.domain, null, null, 'card');
    html += '</div>';
  }
  if (!sorted.length) html += '<div class="upd-card dim">No sites match.</div>';
  html += '</div>';
  view.innerHTML = html;
}
// Start/stop/restart for a site's PM2 apps. Rendered on the list (whole site) and per process in the
// Processes tab; clicks never bubble into the card/row navigation.
function siteCtlHtml(domain, app, user, kind){
  const a = (act, label, title, cls) => '<button class="btn small' + (cls ? ' ' + cls : '') + '" title="' + esc(title) + '" onclick="event.stopPropagation(); siteCtl(this, \'' + esc(domain) + '\', \'' + act + '\'' + (app ? ', ' + JSON.stringify(app) : ', null') + (user ? ', ' + JSON.stringify(user) : ', null') + ')">' + label + '</button>';
  const what = app ? 'this process' : 'every PM2 app of this site';
  return '<div class="site-ctl' + (kind === 'card' ? ' on-card' : '') + '" onclick="event.stopPropagation()">'
    + a('start', '▶', 'Start ' + what + ' (resurrects a pm2 daemon that is down)')
    + a('restart', '⟳', 'Restart ' + what)
    + a('stop', '⏹', 'Stop ' + what, 'danger')
    + '</div>';
}
async function siteCtl(btn, domain, action, app, user){
  if (action === 'stop' && btn && !btn._armed) { armConfirm(btn, 'stop?', () => { btn._armed = true; siteCtl(btn, domain, action, app, user); }); return; }
  if (btn) { btn._armed = false; btn.disabled = true; }
  const label = (app || 'all') + ' · ' + domain;
  try {
    const q = [];
    if (app) q.push('app=' + encodeURIComponent(app));
    if (user) q.push('user=' + encodeURIComponent(user));
    const r = await siteApi('POST', 'api/sites/' + encodeURIComponent(domain) + '/processes/' + action + (q.length ? '?' + q.join('&') : ''));
    const out = r.results.map(x => x.user + ': ' + (x.command || '') + '\n' + (x.output || '')).join('\n\n');
    if (r.ok) toast('pm2 ' + action + ' · ' + label, 'success', { detail: out, duration: 6000 });
    else toast('pm2 ' + action + ' did not fully succeed · ' + label, 'warn', { detail: out, duration: 14000 });
    setTimeout(() => { if (siteView.domain) siteSubReload('procs'); refresh(); }, 1200);
  } catch(e){ siteErr(e, 'pm2 ' + action); }
  finally { if (btn) btn.disabled = false; }
}

function siteSetView(m){ siteViewMode = m; state.siteViewMode = m; saveState(); renderSitesList(); }
function siteSetSort(col){ if (siteSort === col) siteSortDir = -siteSortDir; else { siteSort = col; siteSortDir = 1; } state.siteSort = siteSort; state.siteSortDir = siteSortDir; saveState(); renderSitesList(); }
// Compact table: one row per site, sortable columns, whole row opens the site.
function siteTableHtml(list, byStatus){
  const cols = [['status', 'Status'], ['domain', 'Domain'], ['type', 'Type'], ['user', 'Site user'], ['port', 'Port'], ['http', 'HTTP'], ['runtime', 'Runtime'], ['pm2', 'PM2'], ['disk', 'Disk'], ['owner', 'Owner']];
  const val = (s, c) => c === 'port' ? Number(s.nodePort || s.poolPort || 0) : c === 'http' ? (s.httpUp ? 1 : 0) : c === 'runtime' ? (s.nodeVersion ? 'node ' + s.nodeVersion : s.phpVersion ? 'php ' + s.phpVersion : '') : c === 'pm2' ? (s.pm2 ? s.pm2.filter(p => p.status === 'online').length : -1) : c === 'disk' ? siteDiskBytes(s.disk) : c === 'owner' ? s.managed_by : (s[c] || '');
  const rows = list.slice().sort((a, b) => { if (siteSort === 'status') return byStatus(a, b) * siteSortDir; const x = val(a, siteSort), y = val(b, siteSort); const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); return (r || a.domain.localeCompare(b.domain)) * siteSortDir; });
  let h = '<div class="upd-card" style="padding:6px 16px 10px"><table class="upd-table site-table"><thead><tr>' + cols.map(([k, l]) => '<th onclick="siteSetSort(\'' + k + '\')" class="sortable' + (siteSort === k ? ' on' : '') + '">' + l + (siteSort === k ? (siteSortDir > 0 ? ' ▲' : ' ▼') : '') + '</th>').join('') + '<th></th></tr></thead><tbody>';
  for (const s of rows) {
    const port = s.nodePort || s.poolPort || '';
    const pm2 = s.pm2 && s.pm2.length ? '<span class="' + (s.pm2.every(p => p.status === 'online') ? 'up' : 'down') + '">' + s.pm2.filter(p => p.status === 'online').length + '/' + s.pm2.length + '</span> <span class="dim" title="' + esc(s.pm2.map(p => p.name + ' ' + p.status).join('\n')) + '">' + esc(s.pm2.map(p => p.name).join(', ')).slice(0, 60) + '</span>' : '<span class="dim">–</span>';
    h += '<tr class="site-row" onclick="siteGo(\'' + esc(s.domain) + '\', state.siteTab || \'settings\')">'
      + '<td><span class="badge ' + s.status + '"' + (s.statusReason ? ' title="' + esc(s.statusReason) + '"' : '') + '>' + esc(s.statusLabel) + '</span></td>'
      + '<td class="site-td-domain"><b>' + esc(s.domain) + '</b></td>'
      + '<td>' + esc(siteTypeLabel(s.type)) + (s.application && !['Nodejs','Static','ReverseProxy','Python','Generic'].includes(s.application) ? ' <span class="dim">' + esc(s.application) + '</span>' : '') + '</td>'
      + '<td class="mono">' + esc(s.user || '') + '</td>'
      + '<td class="mono">' + (port ? ':' + esc(port) : '<span class="dim">–</span>') + '</td>'
      + '<td>' + (s.httpUp ? '✅' : s.httpUp === false ? '❌' : '—') + '</td>'
      + '<td>' + esc(s.nodeVersion ? 'Node ' + s.nodeVersion : s.phpVersion ? 'PHP ' + s.phpVersion : '') + '</td>'
      + '<td>' + pm2 + '</td>'
      + '<td class="mono">' + esc(s.disk || '?') + '</td>'
      + '<td>' + (s.managed_by === 'clp' ? '<span class="badge type">CloudPanel</span>' : '<span class="badge online">this panel</span>') + '</td>'
      + '<td style="text-align:right;white-space:nowrap">' + (s.canControl ? siteCtlHtml(s.domain, null, null, 'row') : '') + '<a class="btn small" href="sites?d=' + esc(encodeURIComponent(s.domain)) + '&t=settings" onclick="event.stopPropagation(); event.preventDefault(); siteGo(\'' + esc(s.domain) + '\', \'settings\')">Open</a> <a class="btn small" href="https://' + esc(s.domain) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">↗</a></td></tr>';
  }
  if (!rows.length) h += '<tr><td colspan="11" class="dim">No sites match.</td></tr>';
  return h + '</tbody></table></div>';
}
function siteDiskBytes(d){ const m = /^([\d.]+)\s*([KMGT]?)/i.exec(String(d || '')); if (!m) return -1; return parseFloat(m[1]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase()] || 1); }
async function siteSyncClp(){
  toast('Syncing from CloudPanel…');
  try { const r = await siteApi('POST', 'api/sites/sync-clp'); toast('Sync: ' + r.sites + ' new, ' + r.updated + ' refreshed, ' + r.skipped + ' managed here' + (r.errors.length ? ' · ' + r.errors.length + ' error(s)' : ''), r.errors.length ? 'warn' : 'success', r.errors.length ? { detail: r.errors.join('\n') } : {}); refresh(); }
  catch(e){ siteErr(e, 'Sync'); }
}
function siteNewDialog(){ toast('New Site comes with the next milestone (1b) — create sites in CloudPanel for now; they appear here after the next sync.', 'info', { duration: 7000 }); }

/* =============================================================== detail */
async function siteLoad(){
  if (siteView.loading) return; siteView.loading = true;
  try { siteView.data = await siteApi('GET', siteUrl()); siteView.error = null; }
  catch(e){ siteView.error = e.message; }
  finally { siteView.loading = false; }
  renderSiteDetail();
}
function siteHeader(s){
  const t = siteView.tab;
  return '<div class="site-head"><a class="site-back" href="sites" onclick="event.preventDefault(); siteGo(null)">← Sites</a>'
    + '<div class="site-head-grid">'
    + '<div><div class="k">Domain</div><div class="v"><a href="https://' + esc(s.domain) + '" target="_blank" rel="noopener">' + esc(s.domain) + ' ↗</a></div></div>'
    + '<div><div class="k">Site User</div><div class="v mono">' + esc(s.user) + '</div></div>'
    + '<div><div class="k">IP Address</div><div class="v mono">' + esc(s.ip || '?') + '</div></div>'
    + '<div><div class="k">Type</div><div class="v">' + esc(siteTypeLabel(s.type)) + (s.application && s.application !== siteTypeLabel(s.type) ? ' · ' + esc(s.application) : '') + '</div></div>'
    + '<div><div class="k">Status</div><div class="v">' + (s.health ? '<span class="badge ' + s.health.status + '">' + esc(s.health.statusLabel) + '</span>' : '<span class="dim">unknown</span>') + (s.managed_by === 'clp' ? ' <span class="badge type" title="Imported from CloudPanel. The first change made here takes it over — do not edit it in CloudPanel afterwards.">owned by CloudPanel</span>' : '') + '</div></div>'
    + '</div></div>'
    + '<div class="site-tabs">' + SITE_TABS.map(([k, l]) => '<a class="site-tab' + (k === t ? ' active' : '') + '" href="sites?d=' + esc(encodeURIComponent(s.domain)) + '&t=' + k + '" onclick="event.preventDefault(); state.siteTab=\'' + k + '\'; saveState(); siteGo(\'' + esc(s.domain) + '\', \'' + k + '\')">' + l + '</a>').join('') + '</div>';
}
function renderSiteDetail(){
  const view = document.getElementById('sitesview');
  document.getElementById('host').textContent = siteView.domain;
  showBanner(null); setStatus([]);
  document.getElementById('updated').textContent = '';
  if (!siteView.data) {
    if (siteView.error) { view.innerHTML = '<div class="site-head"><a class="site-back" href="sites" onclick="event.preventDefault(); siteGo(null)">← Sites</a></div><div class="upd-card">⚠ ' + esc(siteView.error) + '</div>'; return; }
    view.innerHTML = '<div class="upd-card">Loading ' + esc(siteView.domain) + '…</div>'; siteLoad(); return;
  }
  // do not clobber a form the user is typing in (10 s refresh)
  if (view.contains(document.activeElement) && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName)) return;
  const s = siteView.data;
  const body = ({ settings: siteTabSettings, procs: siteTabProcs, vhost: siteTabVhost, databases: siteTabDatabases, ssl: siteTabSsl, cloudflare: siteTabCf, security: siteTabSecurity, ssh: siteTabSsh, files: siteTabFiles, cron: siteTabCron, logs: siteTabLogs }[siteView.tab] || siteTabSettings)(s);
  view.innerHTML = siteHeader(s) + '<div class="site-body">' + body + '</div>';
  if (typeof siteView.afterRender === 'function') { const f = siteView.afterRender; siteView.afterRender = null; f(); }
}
// Sub-tab data: fetch once per (domain, tab) and cache in siteView.sub; call siteSubReload() after mutations.
function siteSub(key, url, render){
  const c = siteView.sub[key];
  if (c && c.data) return render(c.data);
  if (!c) { siteView.sub[key] = { loading: true }; siteApi('GET', url).then(d => { siteView.sub[key] = { data: d }; renderSiteDetail(); }).catch(e => { siteView.sub[key] = { error: e.message }; renderSiteDetail(); }); }
  if (c && c.error) return '<div class="upd-card">⚠ ' + esc(c.error) + ' <button class="btn small" onclick="siteSubReload(\'' + esc(key) + '\')">Retry</button></div>';
  return '<div class="upd-card dim">Loading…</div>';
}
function siteSubReload(key){ delete siteView.sub[key]; renderSiteDetail(); }
function siteReloadAll(){ const keep = { fmPath: siteView.sub.fmPath, logKind: siteView.sub.logKind }; siteView.sub = keep; siteView.data = null; renderSiteDetail(); }
const siteField = (label, inner, hint) => sshField(label, inner, hint);
const siteCard = (title, inner, right) => '<div class="upd-card"><div class="site-card-hd"><h3>' + title + '</h3>' + (right || '') + '</div>' + inner + '</div>';

/* ---- Processes ---- */
// PM2 apps of this site. A site's apps often run under one of its SSH users, and when that user's
// pm2 daemon is down the apps are only visible in its dump.pm2 — which is exactly when this page
// matters, so daemons are listed separately from processes.
function siteTabProcs(s){
  const h = s.health || {};
  let head = '';
  if (h.status) {
    const bits = [];
    if (h.originStatus != null) bits.push('nginx on this host answered <b>' + h.originStatus + '</b>' + (h.cfOnly && h.originStatus === 403 ? ' <span class="dim">(Cloudflare-only vhost — it refuses the panel, not the app)</span>' : ''));
    else if (h.originError) bits.push('nginx on this host did not answer <span class="dim">(' + esc(h.originError) + ')</span>');
    if (h.appStatus != null) bits.push('the app answered <b>' + h.appStatus + '</b> on its own port');
    else if (h.appError) bits.push('the app did not answer on its own port <span class="dim">(' + esc(h.appError) + ')</span>');
    head = siteCard('Health', '<div class="site-health"><span class="badge ' + h.status + '">' + esc(h.statusLabel) + '</span>'
      + (h.statusReason ? '<div class="site-why">' + esc(h.statusReason) + '</div>' : '')
      + '<ul class="site-probe">' + bits.map(b => '<li>' + b + '</li>').join('') + '</ul></div>',
      '<button class="btn small" onclick="siteRecheck(this)">Re-check now</button>');
  }
  return head + siteSub('procs', siteUrl('/processes'), (d) => {
    let h2 = '';
    for (const home of d.homes) {
      h2 += '<div class="site-daemon"><span class="' + (home.running ? 'up' : 'down') + '">' + (home.running ? '🟢' : '🔴') + '</span> <b class="mono">' + esc(home.user) + '</b> · pm2 daemon ' + (home.running ? 'running' : 'not running')
        + ' <span class="dim">' + home.dump.length + ' app(s) saved in dump.pm2</span>'
        + (!home.running && home.dump.length ? ' <button class="btn small pri" onclick="siteCtl(this, \'' + esc(s.domain) + '\', \'resurrect\', null, ' + JSON.stringify(home.user) + ')" title="pm2 resurrect — start every app in this user\'s dump.pm2">Resurrect</button>' : '') + '</div>';
    }
    if (!d.homes.length) h2 += '<p class="dim">No pm2 daemon belongs to this site (no <span class="mono">~/.pm2</span> for ' + esc(s.user) + ' or any of its SSH users).</p>';
    if (d.processes.length) {
      h2 += '<table class="upd-table"><thead><tr><th>Process</th><th>Status</th><th>CPU</th><th>Memory</th><th>Restarts</th><th>Uptime</th><th>Runs as</th><th></th></tr></thead><tbody>';
      for (const p of d.processes) {
        const up = p.status === 'online';
        h2 += '<tr><td class="mono"><b>' + esc(p.name) + '</b></td>'
          + '<td><span class="' + (up ? 'up' : 'down') + '">' + (up ? '🟢' : '🔴') + ' ' + esc(p.status) + '</span></td>'
          + '<td>' + (p.fromDump ? '<span class="dim">–</span>' : p.cpu + '%') + '</td>'
          + '<td>' + (p.fromDump ? '<span class="dim">–</span>' : fmtMem(p.memory)) + '</td>'
          + '<td>' + (p.fromDump ? '<span class="dim">–</span>' : p.restarts) + '</td>'
          + '<td>' + (p.uptime_ms ? esc(fmtUp(p.uptime_ms)) : '<span class="dim">–</span>') + '</td>'
          + '<td class="mono dim">' + esc(p.pm2User) + '</td>'
          + '<td style="text-align:right;white-space:nowrap">' + siteCtlHtml(s.domain, p.name, p.pm2User, 'row') + '</td></tr>';
      }
      h2 += '</tbody></table>';
    } else h2 += '<p class="dim">No processes.</p>';
    return siteCard('PM2 Processes', h2,
      '<div class="site-ctl">' + (d.homes.length ? '<button class="btn small" onclick="siteCtl(this, \'' + esc(s.domain) + '\', \'start\')">▶ Start all</button><button class="btn small" onclick="siteCtl(this, \'' + esc(s.domain) + '\', \'restart\')">⟳ Restart all</button><button class="btn small danger" onclick="siteCtl(this, \'' + esc(s.domain) + '\', \'stop\')">⏹ Stop all</button>' : '') + '<button class="btn small" onclick="siteSubReload(\'procs\')">↻</button></div>');
  });
}
async function siteRecheck(btn){
  if (btn) btn.disabled = true;
  try { await siteApi('POST', 'api/sites/check'); siteView.data = null; siteSubReload('procs'); toast('Re-checked', 'success'); }
  catch(e){ siteErr(e, 'Re-check'); }
  finally { if (btn) btn.disabled = false; }
}

/* ---- Cloudflare ---- */
// One site, one Cloudflare credential. Domains here live in different Cloudflare accounts and an
// account-owned token cannot see outside its own account, so the token belongs to the site; a site
// with none falls back to the account-wide token from the Settings tab.
function siteTabCf(s){
  return siteSub('cf', siteUrl('/cloudflare'), (d) => {
    const src = d.source === 'site' ? '<span class="badge online">this site\'s own token</span>'
      : d.source === 'account' ? '<span class="badge type">account-wide token (Settings)</span>'
      : '<span class="badge down">not connected</span>';
    let head = '<div class="site-cf-src">Credential: ' + src
      + (d.stored && d.stored.account_name ? ' <span class="dim">· account ' + esc(d.stored.account_name) + '</span>' : '')
      + (d.stored && d.stored.checked_at ? ' <span class="dim">· checked ' + esc(new Date(d.stored.checked_at).toLocaleString()) + '</span>' : '') + '</div>';

    if (!d.source) {
      return siteCard('Cloudflare', head
        + '<p class="dim">This site has no Cloudflare credential, and no account-wide token is configured in Settings. '
        + 'Connect a token created in the Cloudflare account that holds <b>' + esc(s.domain) + '</b>.</p>'
        + siteCfConnectForm(s));
    }
    if (d.error) {
      return siteCard('Cloudflare', head
        + '<div class="site-why">' + esc(d.error) + '</div>'
        + (d.errorDetail ? '<pre class="site-cf-detail">' + esc(d.errorDetail) + '</pre>' : '')
        + siteCfConnectForm(s), d.hasOwnToken ? '<button class="btn small danger" onclick="siteCfDisconnect(this)">Disconnect</button>' : '');
    }
    const ip = d.serverIp;
    const rows = (list, label) => list.map(r => '<tr><td class="mono">' + esc(r.name) + '</td><td>' + esc(r.type) + '</td><td class="mono">' + esc(r.content) + '</td>'
      + '<td>' + (r.proxied ? '<span class="up">🟠 proxied</span>' : '<span class="dim">DNS only</span>') + '</td>'
      + '<td style="text-align:right;white-space:nowrap"><button class="btn small" onclick="siteCfProxy(this, \'' + esc(r.id) + '\', ' + (r.proxied ? 'false' : 'true') + ')">' + (r.proxied ? 'Unproxy' : 'Proxy') + '</button></td></tr>').join('')
      || '<tr><td colspan="5" class="dim">no ' + label + ' record</td></tr>';

    const zone = d.zone;
    let body = head
      + '<div class="row3">'
      + siteField('Zone', '<input value="' + esc(zone.name) + '" disabled>', 'status ' + esc(zone.status) + (zone.paused ? ' · paused' : '') + (zone.plan ? ' · ' + esc(zone.plan) : ''))
      + siteField('Cloudflare account', '<input value="' + esc((d.account && d.account.name) || '?') + '" disabled>')
      + siteField('This server', '<input value="' + esc(ip || '?') + '" disabled>', d.points_here ? '<span class="up">the apex A record points here</span>' : '<span style="color:#f8a306">the apex A record does not point here</span>')
      + '</div>'
      + '<table class="upd-table"><thead><tr><th>Name</th><th>Type</th><th>Content</th><th>Proxy</th><th></th></tr></thead><tbody>'
      + rows(d.records, 'apex') + rows(d.www, 'www') + '</tbody></table>'
      + '<div class="site-actions"><button class="btn" onclick="siteCfPointHere(this, true)" title="Create or update the apex A record to this server, proxied">Point ' + esc(s.domain) + ' here (proxied)</button>'
      + '<button class="btn" onclick="siteCfPointHere(this, false)" title="Same, but DNS-only (grey cloud)">Point here (DNS only)</button></div>';
    if (!d.hasOwnToken) body += '<div class="site-cf-alt"><p class="dim">This site is using the account-wide token. If ' + esc(s.domain) + ' ever moves to another Cloudflare account, connect a token of its own here.</p>' + siteCfConnectForm(s) + '</div>';
    return siteCard('Cloudflare', body, d.hasOwnToken ? '<button class="btn small danger" onclick="siteCfDisconnect(this)">Disconnect</button>' : '');
  });
}
function siteCfConnectForm(s){
  return '<div class="site-cf-connect">' + siteField('API token for this site',
    '<div style="display:flex;gap:6px"><input id="stCfToken" type="password" placeholder="paste a token from the account that owns ' + esc(s.domain) + '" style="flex:1" autocomplete="off"><button class="btn pri" onclick="siteCfConnect(this)">Connect</button></div>',
    'Needs <b>Zone → Zone → Read</b> and <b>Zone → DNS → Edit</b>, scoped to this zone. Leave Client IP Filtering empty. Stored encrypted.') + '</div>';
}
async function siteCfConnect(btn){
  const el = document.getElementById('stCfToken');
  const token = el && el.value.trim();
  if (!token) return toast('Paste a token first', 'warn');
  if (btn) btn.disabled = true;
  try { const r = await siteApi('PUT', siteUrl('/cloudflare'), { token }); toast('Connected · zone ' + r.zone.name + (r.account ? ' · account ' + r.account.name : ''), 'success'); siteSubReload('cf'); }
  catch(e){ siteErr(e, 'Cloudflare'); }
  finally { if (btn) btn.disabled = false; }
}
function siteCfDisconnect(btn){
  armConfirm(btn, 'remove token?', async () => {
    try { await siteApi('DELETE', siteUrl('/cloudflare')); toast('Token removed', 'success'); siteSubReload('cf'); }
    catch(e){ siteErr(e, 'Cloudflare'); }
  });
}
async function siteCfProxy(btn, id, proxied){
  if (btn) btn.disabled = true;
  try { await siteApi('POST', siteUrl('/cloudflare/records/' + encodeURIComponent(id) + '/proxy'), { proxied }); toast(proxied ? 'Proxy enabled' : 'Proxy disabled', 'success'); siteSubReload('cf'); }
  catch(e){ siteErr(e, 'Cloudflare'); }
  finally { if (btn) btn.disabled = false; }
}
function siteCfPointHere(btn, proxied){
  armConfirm(btn, 'change DNS?', async () => {
    try { const r = await siteApi('POST', siteUrl('/cloudflare/point-here'), { proxied });
      toast('DNS updated · ' + r.changes.map(c => c.action).join(', '), 'success', { detail: r.changes.map(c => c.action + (c.from ? ' ' + c.from + ' → ' + c.to : c.to ? ' ' + c.to : '') + (c.note ? ' — ' + c.note : '')).join('\n'), duration: 12000 });
      siteSubReload('cf'); }
    catch(e){ siteErr(e, 'Cloudflare'); }
  });
}

/* ---- Settings ---- */
function siteTabSettings(s){
  let html = siteCard('Domain Settings',
    '<div class="row2">' + siteField('Domain Name', '<input value="' + esc(s.domain) + '" disabled>') +
    siteField('Root Directory *', '<input id="stRoot" value="' + esc(s.root_dir) + '">', esc('/home/' + s.user + '/htdocs/') + '<b>' + esc(s.root_dir) + '</b>') + '</div>'
    + (s.type === 'reverse-proxy' ? siteField('Reverse Proxy URL', '<input id="stProxy" value="' + esc(s.reverse_proxy_url || '') + '" placeholder="http://127.0.0.1:8080">') : '')
    + '<div class="site-actions"><button class="btn pri" onclick="siteSaveDomain()">Save</button></div>');
  html += siteCard('Site User Settings',
    '<div class="row2">' + siteField('Site User', '<input value="' + esc(s.user) + '" disabled>', s.unix ? 'uid ' + s.unix.uid + ' · ' + esc(s.unix.home) : '<span style="color:#ff8088">unix user missing!</span>')
    + siteField('Password', '<div class="site-pw"><input id="stPw" type="password" value="' + (s.hasPassword ? '****************' : '') + '" placeholder="' + (s.hasPassword ? '' : 'not stored — generate one') + '" readonly><button class="btn small" onclick="sitePwReveal()" title="Show">👁</button><button class="btn small" onclick="sitePwCopy()" title="Copy">⧉</button></div>',
      '<a href="#" onclick="event.preventDefault(); sitePwGenerate()">Generate new password</a>' + (s.managed_by === 'clp' && !s.hasPassword ? ' · the CloudPanel password is not readable by this panel' : '')) + '</div>'
    + siteField('SSH Keys', '<textarea id="stKeys" rows="5" placeholder="ssh-ed25519 AAAA… user@host (one per line)">' + esc(s.ssh_keys || '') + '</textarea>', 'Written to ' + esc('/home/' + s.user + '/.ssh/authorized_keys'))
    + '<div class="site-actions"><button class="btn pri" onclick="siteSaveKeys()">Save</button></div>');
  if (s.type === 'nodejs' && s.nodejs) {
    if (!siteView.sub.runtimes) siteSub('runtimes', 'api/sites/runtimes?user=' + encodeURIComponent(s.user), () => '');
    const rtn = siteView.sub.runtimes && siteView.sub.runtimes.data;
    const avail = rtn && rtn.node && rtn.node.available ? rtn.node.available : [];
    const recorded = String(s.nodejs.node_version || '');
    // The recorded version is CloudPanel bookkeeping; keep it selectable so saving does not silently
    // change it, but show what is installed and what the site's processes actually execute.
    const opts = avail.map(v => '<option value="' + esc(v.version.replace(/^v/, '')) + '"' + (v.version.replace(/^v/, '') === recorded.replace(/^v/, '') ? ' selected' : '') + '>' + esc(v.version) + ' · ' + esc(v.source === 'nvm' ? 'nvm (' + v.user + ')' : 'system') + '</option>').join('');
    const known = avail.some(v => v.version.replace(/^v/, '') === recorded.replace(/^v/, ''));
    const sel = '<select id="stNodeVer">' + (known ? '' : '<option value="' + esc(recorded) + '" selected>' + esc(recorded) + ' · recorded, not installed</option>') + opts + '</select>';
    const act = (s.nodejs.actual || []);
    const actNote = act.length
      ? 'Actually running: ' + act.map(a => (a.stale ? '<b style="color:#f8a306">' + esc(a.path) + ' (deleted — node was upgraded under it; restart to pick up the new one)</b>' : '<b>' + esc(a.version || '?') + '</b> <span class="dim">' + esc(a.path) + '</span>') + ' <span class="dim">(' + esc(a.procs.slice(0, 4).join(', ')) + (a.procs.length > 4 ? ' +' + (a.procs.length - 4) : '') + ')</span>').join(' · ')
      : 'No running Node process found for this site — the value above is only what is recorded.';
    html += siteCard('Node.js Settings',
      '<div class="row2">' + siteField('Node.js Version *', '<div style="display:flex;gap:6px"><span style="flex:1">' + sel + '</span><label class="chip" style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="stNodeInstall"> nvm install</label></div>', actNote)
      + siteField('App Port *', '<input id="stNodePort" type="number" min="1024" max="65535" value="' + s.nodejs.port + '">', 'nginx proxies / to 127.0.0.1:' + s.nodejs.port + (s.vhost_placeholders.includes('app_port') ? '' : ' — the vhost has a literal port; it will be patched')) + '</div>'
      + '<div class="site-actions"><button class="btn pri" onclick="siteSaveNode()">Save</button></div>');
  }
  if (s.type === 'php' && s.php) {
    const rt = siteView.sub.runtimes && siteView.sub.runtimes.data;
    if (!siteView.sub.runtimes) siteSub('runtimes', 'api/sites/runtimes', () => '');
    const vers = rt ? rt.php : [s.php.php_version];
    const num = (id, label, v, hint) => siteField(label, '<input id="' + id + '" value="' + esc(v) + '">', hint);
    html += siteCard('PHP Settings',
      '<div class="row3">' + siteField('PHP Version *', '<select id="stPhpVer">' + vers.map(v => '<option' + (v === s.php.php_version ? ' selected' : '') + '>' + v + '</option>').join('') + '</select>', 'pool 127.0.0.1:' + s.php.pool_port + ' · switching moves the pool file and reloads both php-fpm services')
      + num('stPhpMem', 'memory_limit', s.php.memory_limit) + num('stPhpExec', 'max_execution_time (s)', s.php.max_execution_time) + '</div>'
      + '<div class="row3">' + num('stPhpInput', 'max_input_time (s)', s.php.max_input_time) + num('stPhpVars', 'max_input_vars', s.php.max_input_vars) + num('stPhpPost', 'post_max_size', s.php.post_max_size) + '</div>'
      + '<div class="row2">' + num('stPhpUpload', 'upload_max_filesize', s.php.upload_max_filesize)
      + siteField('Additional configuration', '<textarea id="stPhpExtra" rows="3">' + esc(s.php.additional_configuration == null ? 'date.timezone=UTC;\ndisplay_errors=off;' : s.php.additional_configuration) + '</textarea>', 'ini lines appended to PHP_VALUE') + '</div>'
      + '<div class="site-actions"><button class="btn pri" onclick="siteSavePhp()">Save</button></div>');
  }
  return html;
}
async function siteSaveDomain(){
  const body = { root_dir: document.getElementById('stRoot').value };
  const px = document.getElementById('stProxy'); if (px) body.reverse_proxy_url = px.value;
  try { const r = await siteApi('PATCH', siteUrl(), body); toast('Saved' + (r.vhost.changed ? ' · nginx reloaded' : ''), 'success'); siteReloadAll(); }
  catch(e){ siteErr(e, 'Save'); }
}
async function sitePwReveal(){
  const inp = document.getElementById('stPw');
  if (inp.type === 'text') { inp.type = 'password'; return; }
  try { const r = await siteApi('GET', siteUrl('/password')); inp.value = r.password; inp.type = 'text'; }
  catch(e){ siteErr(e); }
}
async function sitePwCopy(){
  try { const r = await siteApi('GET', siteUrl('/password')); await navigator.clipboard.writeText(r.password); toast('Password copied', 'success'); }
  catch(e){ siteErr(e); }
}
function sitePwGenerate(){
  const bg = sshModal('<h3>Generate new password</h3><p class="dim">Sets a new random password for the unix user <b>' + esc(siteView.data.user) + '</b> (SSH/SFTP login) and stores it encrypted so it can be shown here again.</p>'
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="pwGo">Generate</button></div>');
  bg.querySelector('#pwGo').onclick = async () => {
    try { const r = await siteApi('POST', siteUrl('/password'), {}); sshModalClose(); siteView.data.hasPassword = true; renderSiteDetail(); const inp = document.getElementById('stPw'); if (inp) { inp.value = r.password; inp.type = 'text'; } toast('New password set', 'success'); }
    catch(e){ siteErr(e, 'Password'); }
  };
}
async function siteSaveKeys(){
  try { await siteApi('PUT', siteUrl('/ssh-keys'), { ssh_keys: document.getElementById('stKeys').value }); toast('authorized_keys saved', 'success'); siteReloadAll(); }
  catch(e){ siteErr(e, 'SSH keys'); }
}
async function siteSaveNode(){
  const body = { node_version: document.getElementById('stNodeVer').value.trim(), port: Number(document.getElementById('stNodePort').value), install: document.getElementById('stNodeInstall').checked };
  toast('Saving… (nvm install can take a minute)');
  try { const r = await siteApi('PUT', siteUrl('/nodejs'), body); toast('Node.js settings saved' + (r.vhost.changed ? ' · nginx reloaded' : ''), 'success', r.nvm ? { detail: r.nvm } : {}); siteReloadAll(); }
  catch(e){ siteErr(e, 'Node.js'); }
}
async function siteSavePhp(){
  const g = (id) => document.getElementById(id).value.trim();
  const body = { php_version: g('stPhpVer'), memory_limit: g('stPhpMem'), max_execution_time: g('stPhpExec'), max_input_time: g('stPhpInput'), max_input_vars: g('stPhpVars'), post_max_size: g('stPhpPost'), upload_max_filesize: g('stPhpUpload'), additional_configuration: document.getElementById('stPhpExtra').value };
  try { const r = await siteApi('PUT', siteUrl('/php'), body); toast('PHP settings saved' + (r.fpm ? ' · php-fpm switched' : '') + (r.vhost.changed ? ' · nginx reloaded' : ''), 'success'); siteReloadAll(); }
  catch(e){ siteErr(e, 'PHP'); }
}

/* ---- Vhost ---- */
function siteTabVhost(s){
  return siteSub('vhost', siteUrl('/vhost'), (v) => {
    const warn = !v.in_sync ? '<div class="banner bad" style="margin-bottom:12px"><span class="ico">⚠</span> The file on disk differs from what this template renders — someone edited ' + esc(v.file) + ' directly. Saving will overwrite it (a backup is kept).</div>' : '';
    const missing = !v.placeholders.includes('settings');
    return warn + siteCard('Vhost <span class="dim" style="font-weight:400;font-size:14px">' + esc(v.file) + '</span>',
      '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Edit the <b>template</b>: <code>{{placeholders}}</code> (' + v.placeholders.map(p => '<code>' + esc(p) + '</code>').join(' ') + ') are filled in on save from the site\'s settings. Saving runs <code>nginx -t</code> and reloads nginx; on failure the previous file is restored.'
        + (missing ? ' <span style="color:#f8a306">No <code>{{settings}}</code> placeholder: Security features (basic auth, blocked IPs…) need it — the Security tab can insert it.</span>' : '') + '</p>'
      + '<textarea id="vhEditor" class="site-code" spellcheck="false" rows="28">' + esc(v.template) + '</textarea>'
      + '<div class="site-actions" style="justify-content:space-between"><div><button class="btn" onclick="siteVhostPreview()">Preview rendered</button> <button class="btn" onclick="siteVhostReset()">Reset to template…</button></div><div><button class="btn pri" onclick="siteVhostSave()">Save</button></div></div>'
      + '<pre id="vhPreview" class="site-code-pre" style="display:none"></pre>');
  });
}
async function siteVhostSave(){
  const tpl = document.getElementById('vhEditor').value;
  toast('Testing configuration…');
  try { const r = await siteApi('PUT', siteUrl('/vhost'), { template: tpl }); toast(r.changed ? 'Vhost saved · nginx reloaded' : 'Saved — no change on disk', 'success', r.test ? { detail: r.test } : {}); siteReloadAll(); }
  catch(e){ siteErr(e, 'Vhost'); }
}
function siteVhostPreview(){
  const pre = document.getElementById('vhPreview'); const v = siteView.sub.vhost.data;
  if (pre.style.display !== 'none') { pre.style.display = 'none'; return; }
  pre.textContent = v.rendered; pre.style.display = '';
}
async function siteVhostReset(){
  try {
    const t = await siteApi('GET', 'api/sites/templates');
    const s = siteView.data;
    const opts = t.filter(x => x.type === s.type).map(x => '<option' + (x.name === s.application ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('');
    const bg = sshModal('<h3>Reset vhost to a template</h3><p class="dim">Replaces the stored template with a freshly generated one for this site (server_name, redirect block, PHP settings). <b>Custom edits are lost</b> — a backup of the current file is kept.</p>'
      + sshField('Template', '<select id="vrTpl">' + opts + '</select>') + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn danger" id="vrGo">Reset</button></div>');
    bg.querySelector('#vrGo').onclick = async () => {
      try { const r = await siteApi('POST', siteUrl('/vhost/reset'), { template: bg.querySelector('#vrTpl').value }); sshModalClose(); toast('Vhost reset' + (r.changed ? ' · nginx reloaded' : ''), 'success'); siteReloadAll(); }
      catch(e){ siteErr(e, 'Reset'); }
    };
  } catch(e){ siteErr(e); }
}

/* ---- Databases (slice 1c) ---- */
function siteTabDatabases(s){
  return siteCard('Databases', '<p class="dim">MariaDB and PostgreSQL databases for this site arrive with the next milestone (1c). Existing databases keep working; manage them with the CLI until then.</p>');
}

/* ---- SSL/TLS ---- */
function siteTabSsl(s){
  return siteSub('ssl', siteUrl('/certificates'), (v) => {
    const rows = v.certificates.map(c => { const days = siteDays(c.expires_at); return '<tr' + (c.is_active ? ' style="background:#20242f"' : '') + '><td>' + (c.is_active ? '<span class="upd-badge ok">active</span>' : '<span class="upd-badge na">stored</span>') + '</td><td>' + esc(c.type.replace('_', ' ')) + '</td><td>' + esc(c.subject || '') + '<div class="dim" style="font-size:13px">' + esc((c.sans || []).join(', ')) + '</div></td><td>' + esc((c.issuer || '').split(',')[1] || c.issuer || '') + '</td><td' + (days != null && days < 30 ? ' style="color:#ff8088"' : '') + '>' + (c.expires_at ? c.expires_at.slice(0, 10) + (days != null ? ' <span class="dim">(' + (days < 0 ? 'expired' : days + 'd') + ')</span>' : '') : '') + '</td><td style="text-align:right;white-space:nowrap">'
      + (!c.is_active && c.has_key ? '<button class="btn small" onclick="siteCertActivate(' + c.id + ')">Activate</button> ' : '') + (!c.is_active ? '<button class="btn small" onclick="armConfirm(this, \'⚠ Delete?\', () => siteCertDelete(' + c.id + '))">Delete</button>' : '') + '</td></tr>'; }).join('');
    const inst = v.installed;
    return siteCard('Certificates', '<p class="dim" style="margin:0 0 8px;font-size:14.5px">nginx serves ' + (inst ? '<b>' + esc(inst.subject) + '</b> from ' + esc((inst.issuer || '').split(',')[1] || inst.issuer) + ', valid until ' + inst.expires_at.slice(0, 10) : '<span style="color:#ff8088">no certificate file</span>') + '. Let\'s Encrypt and Cloudflare-issued origin certificates come with the Settings → Cloudflare phase; upload a PEM pair for now.</p>'
      + '<table class="upd-table"><tr><th></th><th>Type</th><th>Subject / SANs</th><th>Issuer</th><th>Expires</th><th></th></tr>' + (rows || '<tr><td colspan="6" class="dim">No certificates stored</td></tr>') + '</table>'
      + '<div class="site-actions"><button class="btn" onclick="siteCertSelfSigned()">Self-signed</button><button class="btn pri" onclick="siteCertUpload()">Upload certificate…</button></div>');
  });
}
function siteCertUpload(){
  const bg = sshModal('<h3>Upload certificate</h3>' + sshField('Private key (PEM)', '<textarea id="ceKey" rows="5" class="mono" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>')
    + sshField('Certificate (PEM)', '<textarea id="ceCrt" rows="5" class="mono" placeholder="-----BEGIN CERTIFICATE-----"></textarea>', 'A full bundle (leaf + intermediates) may be pasted here')
    + sshField('Chain (optional)', '<textarea id="ceChain" rows="3" class="mono"></textarea>')
    + '<label class="upd-toggle" style="margin-top:6px"><input type="checkbox" id="ceAct" checked> Activate immediately (installs the files and reloads nginx)</label>'
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="ceGo">Upload</button></div>');
  bg.querySelector('#ceGo').onclick = async () => {
    try { const r = await siteApi('POST', siteUrl('/certificates'), { key: bg.querySelector('#ceKey').value, certificate: bg.querySelector('#ceCrt').value, chain: bg.querySelector('#ceChain').value, activate: bg.querySelector('#ceAct').checked }); sshModalClose(); toast('Certificate ' + (r.activated ? 'installed' : 'stored'), 'success'); siteReloadAll(); }
    catch(e){ siteErr(e, 'Certificate'); }
  };
}
async function siteCertSelfSigned(){
  try { await siteApi('POST', siteUrl('/certificates'), { self_signed: true, activate: false }); toast('Self-signed certificate stored (activate it when you want)', 'success'); siteSubReload('ssl'); }
  catch(e){ siteErr(e, 'Self-signed'); }
}
async function siteCertActivate(id){
  try { await siteApi('POST', siteUrl('/certificates/' + id + '/activate')); toast('Certificate activated · nginx reloaded', 'success'); siteReloadAll(); }
  catch(e){ siteErr(e, 'Activate'); }
}
async function siteCertDelete(id){
  try { await siteApi('DELETE', siteUrl('/certificates/' + id)); toast('Certificate removed', 'success'); siteSubReload('ssl'); }
  catch(e){ siteErr(e, 'Delete'); }
}

/* ---- Security ---- */
function siteTabSecurity(s){
  return siteSub('security', siteUrl('/security'), (v) => {
    const ba = v.basic_auth || {};
    const noPh = !v.has_settings_placeholder ? '<div class="banner bad" style="margin-bottom:12px"><span class="ico">⚠</span> This vhost template has no <code>{{settings}}</code> placeholder, so these settings would not reach nginx. <button class="btn small" onclick="siteSecuritySave(true)" style="margin-left:8px">Insert {{settings}} after the .well-known block</button></div>' : '';
    return noPh + siteCard('Basic Authentication',
      '<label class="upd-toggle"><span class="switch"><input type="checkbox" id="seBaOn"' + (ba.is_active ? ' checked' : '') + '><span class="slider"></span></span> Protect the whole site with a username + password</label>'
      + '<div class="row2">' + siteField('Username', '<input id="seBaUser" value="' + esc(ba.username || '') + '">') + siteField('Password', '<input id="seBaPw" type="password" placeholder="' + (ba.has_password ? 'unchanged' : 'required') + '">') + '</div>'
      + siteField('Allowed IPs (no password asked)', '<input id="seBaIps" value="' + esc((ba.allowed_ips || []).join(', ')) + '" placeholder="1.2.3.4, 10.0.0.0/8">'))
    + siteCard('Blocked IPs', siteField('One IP or CIDR per line — answered with 403', '<textarea id="seIps" rows="4" class="mono">' + esc(v.blocked_ips.join('\n')) + '</textarea>', v.cf_only ? 'Matched against the Cloudflare-forwarded client IP' : ''))
    + siteCard('Blocked Bots', siteField('User-Agent substrings, one per line — answered with 444 (connection closed)', '<textarea id="seBots" rows="4" class="mono">' + esc(v.blocked_bots.join('\n')) + '</textarea>', 'Case-insensitive. Ignored while basic authentication is active (CloudPanel behaviour).'))
    + siteCard('Cloudflare', '<label class="upd-toggle"><span class="switch"><input type="checkbox" id="seCf"' + (v.cf_only ? ' checked' : '') + '><span class="slider"></span></span> Allow traffic from Cloudflare only (include /etc/nginx/cloudflare/ips; access log in <code>cloudflare</code> format)</label>')
    + '<div class="site-actions"><button class="btn pri" onclick="siteSecuritySave(false)">Save security settings</button></div>'
    + (v.preview ? '<details style="margin-top:10px"><summary class="dim" style="cursor:pointer;font-size:14.5px">Rendered {{settings}} block</summary><pre class="site-code-pre">' + esc(v.preview) + '</pre></details>' : '');
  });
}
async function siteSecuritySave(insertPlaceholder){
  const g = (id) => document.getElementById(id);
  const lines = (id) => g(id).value.split(/[\n,]/).map(x => x.trim()).filter(Boolean);
  const body = { blocked_ips: lines('seIps'), blocked_bots: g('seBots').value.split('\n').map(x => x.trim()).filter(Boolean), cf_only: g('seCf').checked };
  const on = g('seBaOn').checked, user = g('seBaUser').value.trim(), pw = g('seBaPw').value;
  body.basic_auth = (!on && !user) ? null : { is_active: on, username: user, password: pw || undefined, allowed_ips: lines('seBaIps') };
  if (insertPlaceholder) body.insert_settings_placeholder = true;
  toast('Applying…');
  try { const r = await siteApi('PUT', siteUrl('/security'), body); toast('Security settings saved' + (r.vhost.changed ? ' · nginx reloaded' : ''), 'success'); siteReloadAll(); }
  catch(e){ siteErr(e, 'Security'); }
}

/* ---- SSH/FTP ---- */
function siteTabSsh(s){
  return siteSub('ssh', siteUrl('/ssh-users'), (list) => {
    const rows = list.map(u => '<tr><td class="mono">' + esc(u.username) + (u.unix ? '' : ' <span style="color:#ff8088">(unix user missing)</span>') + '</td><td class="dim">' + (u.unix ? 'uid ' + u.unix.uid + ' · ' + esc(u.unix.home) : '') + '</td><td>' + (u.ssh_keys ? u.ssh_keys.split('\n').filter(x => x.trim()).length + ' key(s)' : '<span class="dim">no keys</span>') + '</td><td style="text-align:right;white-space:nowrap">'
      + (u.has_password ? '<button class="btn small" onclick="siteSshPw(' + u.id + ')">Show password</button> ' : '') + '<button class="btn small" onclick="siteSshEdit(' + u.id + ')">Edit</button> <button class="btn small" onclick="armConfirm(this, \'⚠ Delete user + home?\', () => siteSshDelete(' + u.id + '))">Delete</button></td></tr>').join('');
    return siteCard('SSH Users', '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Separate logins with their own home that see this site\'s <code>htdocs</code>, <code>logs</code> and <code>backups</code> (symlinks; group = site user, umask 007 so files stay shared).</p>'
      + '<table class="upd-table"><tr><th>User</th><th></th><th>Keys</th><th></th></tr>' + (rows || '<tr><td colspan="4" class="dim">No SSH users</td></tr>') + '</table>'
      + '<div class="site-actions"><button class="btn pri" onclick="siteSshAdd()">Add SSH user…</button></div>')
    + siteCard('FTP Users', '<p class="dim">FTP accounts (proftpd) come with the Instance phase. None exist on this host today.</p>');
  });
}
function siteSshAdd(){
  const s = siteView.data;
  const bg = sshModal('<h3>Add SSH user</h3><div class="row2">' + sshField('User name', '<input id="suName" value="' + esc(s.user.replace(/[^a-z0-9_-]/g, '')) + '_ssh">', 'lowercase letters, digits, _ and -') + sshField('Password', '<input id="suPw" placeholder="leave empty to generate">') + '</div>'
    + sshField('SSH keys (optional)', '<textarea id="suKeys" rows="3" class="mono"></textarea>') + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="suGo">Create</button></div>');
  bg.querySelector('#suGo').onclick = async () => {
    try { const r = await siteApi('POST', siteUrl('/ssh-users'), { username: bg.querySelector('#suName').value.trim(), password: bg.querySelector('#suPw').value || undefined, ssh_keys: bg.querySelector('#suKeys').value }); sshModalClose(); siteShowSecret('SSH user created', r.username, r.password); siteSubReload('ssh'); }
    catch(e){ siteErr(e, 'SSH user'); }
  };
}
function siteShowSecret(title, user, pw){
  sshModal('<h3>' + esc(title) + '</h3><p class="dim">Store this password now; it is also kept encrypted and can be shown again.</p><div class="row2">' + sshField('User', '<input value="' + esc(user) + '" readonly>') + sshField('Password', '<input value="' + esc(pw) + '" readonly onclick="this.select()">') + '</div><div class="foot"><button class="btn pri" onclick="sshModalClose()">Done</button></div>');
}
async function siteSshPw(id){
  try { const r = await siteApi('GET', siteUrl('/ssh-users/' + id + '/password')); const u = siteView.sub.ssh.data.find(x => x.id === id); siteShowSecret('SSH password', u.username, r.password); }
  catch(e){ siteErr(e); }
}
function siteSshEdit(id){
  const u = siteView.sub.ssh.data.find(x => x.id === id);
  const bg = sshModal('<h3>Edit SSH user <span class="mono">' + esc(u.username) + '</span></h3>' + sshField('SSH keys', '<textarea id="seKeys" rows="5" class="mono">' + esc(u.ssh_keys || '') + '</textarea>')
    + '<label class="upd-toggle"><input type="checkbox" id="seNewPw"> Set a new random password</label>'
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="seGo">Save</button></div>');
  bg.querySelector('#seGo').onclick = async () => {
    const body = { ssh_keys: bg.querySelector('#seKeys').value }; if (bg.querySelector('#seNewPw').checked) body.password = '';
    try { const r = await siteApi('PUT', siteUrl('/ssh-users/' + id), body); sshModalClose(); if (r.password) siteShowSecret('New SSH password', u.username, r.password); else toast('Saved', 'success'); siteSubReload('ssh'); }
    catch(e){ siteErr(e, 'SSH user'); }
  };
}
async function siteSshDelete(id){
  try { await siteApi('DELETE', siteUrl('/ssh-users/' + id)); toast('SSH user deleted', 'success'); siteSubReload('ssh'); }
  catch(e){ siteErr(e, 'Delete'); }
}

/* ---- File Manager ---- */
function siteFmPath(){ return siteView.sub.fmPath || '/htdocs'; }
function siteTabFiles(s){
  const p = siteFmPath();
  const key = 'files:' + p;
  return siteSub(key, siteUrl('/files?path=' + encodeURIComponent(p)), (v) => {
    const crumbs = v.path.split('/').filter(Boolean);
    let bc = '<a href="#" onclick="event.preventDefault(); siteFmGo(\'/\')">~' + esc(s.user) + '</a>';
    let acc = '';
    for (const c of crumbs) { acc += '/' + c; bc += ' / <a href="#" onclick="event.preventDefault(); siteFmGo(\'' + esc(acc) + '\')">' + esc(c) + '</a>'; }
    const rows = v.items.map(it => {
      const full = (v.path === '/' ? '' : v.path) + '/' + it.name;
      const name = it.type === 'dir' ? '<a href="#" onclick="event.preventDefault(); siteFmGo(\'' + esc(full) + '\')">📁 ' + esc(it.name) + '</a>' : (it.type === 'file' ? '📄 ' : '🔗 ') + esc(it.name);
      const editable = it.type === 'file' && it.size <= 2 * 1024 * 1024;
      return '<tr><td><input type="checkbox" class="fmSel" data-path="' + esc(full) + '"></td><td>' + name + (it.symlink ? ' <span class="dim">→ ' + esc(it.target || '') + '</span>' : '') + '</td><td class="dim mono">' + (it.type === 'dir' ? '' : bkBytes(it.size)) + '</td><td class="dim">' + new Date(it.mtime).toLocaleString() + '</td><td class="dim mono">' + esc(it.mode) + '</td><td style="text-align:right;white-space:nowrap">'
        + (editable ? '<button class="btn small" onclick="siteFmEdit(\'' + esc(full) + '\')">Edit</button> ' : '') + (it.type === 'file' ? '<a class="btn small" href="' + siteUrl('/files/download?path=' + encodeURIComponent(full)) + '">Download</a> ' : '')
        + (/\.(zip|tar\.gz|tgz|tar\.zst|tar\.xz|tar\.bz2|tar)$/i.test(it.name) ? '<button class="btn small" onclick="siteFmOp({op:\'extract\', path:\'' + esc(full) + '\'})">Extract</button> ' : '')
        + '<button class="btn small" onclick="siteFmRename(\'' + esc(full) + '\', \'' + esc(it.name) + '\')">Rename</button> <button class="btn small" onclick="siteFmChmod(\'' + esc(full) + '\', \'' + esc(it.mode) + '\')">chmod</button></td></tr>';
    }).join('');
    siteView.afterRender = () => {
      const drop = document.getElementById('fmDrop'); if (!drop) return;
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); siteFmUpload(e.dataTransfer.files); });
      document.getElementById('fmFile').addEventListener('change', (e) => siteFmUpload(e.target.files));
    };
    return '<div class="upd-card" id="fmDrop"><div class="fm-bar"><div class="fm-bc">' + bc + '</div><div class="fm-actions">'
      + '<button class="btn small" onclick="siteFmMkdir()">New folder</button><button class="btn small" onclick="siteFmNewFile()">New file</button>'
      + '<label class="btn small" style="cursor:pointer">Upload <input id="fmFile" type="file" multiple style="display:none"></label>'
      + '<button class="btn small" onclick="siteFmDeleteSelected(this)">Delete selected</button><button class="btn small" onclick="siteSubReload(\'' + esc(key) + '\')">↻</button></div></div>'
      + '<table class="upd-table fm-table"><tr><th style="width:24px"></th><th>Name</th><th>Size</th><th>Modified</th><th>Mode</th><th></th></tr>' + (rows || '<tr><td colspan="6" class="dim">Empty directory</td></tr>') + '</table>'
      + '<div class="dim" style="font-size:13px;margin-top:8px">Operations run as <code>' + esc(s.user) + '</code> — what that user cannot read or write, this panel cannot either. Drop files anywhere on this card to upload.</div></div>';
  });
}
function siteFmGo(p){ siteView.sub.fmPath = p; renderSiteDetail(); }
async function siteFmOp(op, quiet){
  try { const r = await siteApi('POST', siteUrl('/files/op'), op); if (!quiet) toast('Done', 'success'); siteSubReload('files:' + siteFmPath()); return r; }
  catch(e){ siteErr(e, 'Files'); throw e; }
}
function siteFmPrompt(title, label, value, cb){
  const bg = sshModal('<h3>' + esc(title) + '</h3>' + sshField(label, '<input id="fmIn" value="' + esc(value || '') + '">') + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="fmGo">OK</button></div>');
  const go = () => { const v = bg.querySelector('#fmIn').value.trim(); if (!v) return; sshModalClose(); cb(v); };
  bg.querySelector('#fmGo').onclick = go; bg.querySelector('#fmIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
}
function siteFmMkdir(){ siteFmPrompt('New folder', 'Name', '', (n) => siteFmOp({ op: 'mkdir', path: siteFmPath(), name: n }).catch(() => {})); }
function siteFmNewFile(){ siteFmPrompt('New file', 'Name', '', (n) => siteFmOp({ op: 'touch', path: siteFmPath(), name: n }).catch(() => {})); }
function siteFmRename(p, cur){ siteFmPrompt('Rename', 'New name', cur, (n) => siteFmOp({ op: 'rename', path: p, name: n }).catch(() => {})); }
function siteFmChmod(p, cur){ siteFmPrompt('chmod ' + p, 'Mode (octal)', cur.replace(/^0/, ''), (m) => siteFmOp({ op: 'chmod', path: p, mode: m }).catch(() => {})); }
function siteFmDeleteSelected(btn){
  const sel = [...document.querySelectorAll('.fmSel:checked')].map(c => c.dataset.path);
  if (!sel.length) return toast('Select files first', 'warn');
  armConfirm(btn, '⚠ Delete ' + sel.length + ' item(s)?', () => siteFmOp({ op: 'delete', paths: sel }).catch(() => {}));
}
async function siteFmUpload(fileList){
  const files = [...fileList]; if (!files.length) return;
  for (const f of files) {
    toast('Uploading ' + f.name + '…');
    try {
      const r = await fetch(siteUrl('/files/upload?path=' + encodeURIComponent(siteFmPath()) + '&name=' + encodeURIComponent(f.name)), { method: 'POST', body: f });
      let j = {}; try { j = await r.json(); } catch(_) {}
      if (!r.ok) throw new Error(j.error || (r.status === 413 ? 'file too large for the proxy (nginx client_max_body_size)' : 'HTTP ' + r.status));
      toast('Uploaded ' + f.name + ' (' + bkBytes(j.size) + ')', 'success');
    } catch(e){ siteErr(e, 'Upload ' + f.name); }
  }
  siteSubReload('files:' + siteFmPath());
}
async function siteFmEdit(p){
  try {
    const r = await siteApi('POST', siteUrl('/files/op'), { op: 'read', path: p });
    const bg = sshModal('<h3 class="mono" style="font-size:16px">' + esc(p) + '</h3><textarea id="fmEd" class="site-code" spellcheck="false" rows="26">' + esc(r.content) + '</textarea><div class="foot"><span class="dim" style="margin-right:auto;font-size:14px">' + bkBytes(r.size) + ' · Ctrl+S saves</span><button class="btn" onclick="sshModalClose()">Close</button><button class="btn pri" id="fmSave">Save</button></div>');
    bg.classList.add('wide');
    const save = async () => { try { await siteApi('POST', siteUrl('/files/op'), { op: 'write', path: p, content: bg.querySelector('#fmEd').value }); toast('Saved ' + p, 'success'); } catch(e){ siteErr(e, 'Save'); } };
    bg.querySelector('#fmSave').onclick = save;
    bg.querySelector('#fmEd').addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
  } catch(e){ siteErr(e, 'Open'); }
}

/* ---- Cron ---- */
function siteTabCron(s){
  return siteSub('cron', siteUrl('/cron'), (v) => {
    const rows = v.jobs.map(j => '<tr><td class="mono">' + esc([j.minute, j.hour, j.day, j.month, j.weekday].join(' ')) + '</td><td class="mono" style="word-break:break-all">' + esc(j.command) + '</td><td style="text-align:right;white-space:nowrap"><button class="btn small" onclick="siteCronEdit(' + j.id + ')">Edit</button> <button class="btn small" onclick="armConfirm(this, \'⚠ Delete?\', () => siteCronDelete(' + j.id + '))">Delete</button></td></tr>').join('');
    return siteCard('Cron Jobs <span class="dim" style="font-weight:400;font-size:14px">' + esc(v.file) + '</span>',
      '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Jobs run as <code>' + esc(s.user) + '</code>. Output is discarded (MAILTO="") — redirect to a file inside the site if you need it.</p>'
      + '<table class="upd-table"><tr><th>Schedule</th><th>Command</th><th></th></tr>' + (rows || '<tr><td colspan="3" class="dim">No cron jobs</td></tr>') + '</table>'
      + '<div class="site-actions"><button class="btn pri" onclick="siteCronEdit(null)">Add cron job…</button></div>'
      + (v.on_disk ? '<details style="margin-top:10px"><summary class="dim" style="cursor:pointer;font-size:14.5px">File on disk</summary><pre class="site-code-pre">' + esc(v.on_disk) + '</pre></details>' : ''));
  });
}
function siteCronEdit(id){
  const j = id ? siteView.sub.cron.data.jobs.find(x => x.id === id) : { minute: '*', hour: '*', day: '*', month: '*', weekday: '*', command: '' };
  const f = (k, label) => '<div class="upd-field"><label>' + label + '</label><input id="cr_' + k + '" value="' + esc(j[k]) + '" class="mono"></div>';
  const bg = sshModal('<h3>' + (id ? 'Edit' : 'Add') + ' cron job</h3><div class="cron-grid">' + f('minute', 'Minute') + f('hour', 'Hour') + f('day', 'Day') + f('month', 'Month') + f('weekday', 'Weekday') + '</div>'
    + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 10px">' + ['@hourly', '@daily', '@weekly', '@monthly'].map(p => '<button class="chip" onclick="siteCronPreset(\'' + p + '\')">' + p + '</button>').join('') + '</div>'
    + sshField('Command', '<input id="cr_command" value="' + esc(j.command) + '" class="mono" placeholder="cd ~/htdocs/site && php artisan schedule:run">')
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="crGo">Save</button></div>');
  bg.querySelector('#crGo').onclick = async () => {
    const body = {}; for (const k of ['minute', 'hour', 'day', 'month', 'weekday', 'command']) body[k] = bg.querySelector('#cr_' + k).value;
    try { await siteApi(id ? 'PUT' : 'POST', siteUrl('/cron' + (id ? '/' + id : '')), body); sshModalClose(); toast('Cron job saved', 'success'); siteSubReload('cron'); }
    catch(e){ siteErr(e, 'Cron'); }
  };
}
function siteCronPreset(p){ const v = { '@hourly': ['0','*','*','*','*'], '@daily': ['0','0','*','*','*'], '@weekly': ['0','0','*','*','0'], '@monthly': ['0','0','1','*','*'] }[p]; ['minute','hour','day','month','weekday'].forEach((k, i) => { document.getElementById('cr_' + k).value = v[i]; }); }
async function siteCronDelete(id){
  try { await siteApi('DELETE', siteUrl('/cron/' + id)); toast('Cron job deleted', 'success'); siteSubReload('cron'); }
  catch(e){ siteErr(e, 'Cron'); }
}

/* ---- Logs ---- */
let siteLogTimer = null;
function siteTabLogs(s){
  return siteSub('logkinds', siteUrl('/logs'), (v) => {
    const cur = siteView.sub.logKind || (v.kinds[0] && v.kinds[0].key) || '';
    siteView.sub.logKind = cur;
    const opts = v.kinds.map(k => '<option value="' + esc(k.key) + '"' + (k.key === cur ? ' selected' : '') + '>' + esc(k.label) + (k.size != null ? ' (' + bkBytes(k.size) + ')' : ' (missing)') + '</option>').join('');
    if (cur && !siteView.sub.logData) siteLogFetch();
    siteView.afterRender = () => { const pre = document.getElementById('lgOut'); if (pre) pre.scrollTop = pre.scrollHeight; };
    const d = siteView.sub.logData;
    return '<div class="upd-card"><div class="fm-bar"><select id="lgKind" onchange="siteView.sub.logKind=this.value; siteView.sub.logData=null; siteLogFetch()">' + opts + '</select>'
      + '<select id="lgLines" onchange="siteLogFetch()">' + [100, 200, 500, 1000, 2000].map(n => '<option' + (n === (siteView.sub.logLines || 200) ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>'
      + '<input id="lgQ" type="search" placeholder="filter…" value="' + esc(siteView.sub.logQ || '') + '" onkeydown="if(event.key===\'Enter\') siteLogFetch()" style="flex:1;min-width:160px">'
      + '<label class="chip" style="display:flex;align-items:center;gap:6px;font-size:14px"><input type="checkbox" id="lgFollow" onchange="siteLogFollow(this.checked)"' + (siteLogTimer ? ' checked' : '') + '> follow</label>'
      + '<button class="btn small" onclick="siteLogFetch()">↻</button></div>'
      + '<pre id="lgOut" class="site-code-pre log">' + (d ? (d.error ? '⚠ ' + esc(d.error) : esc(d.lines.join('\n')) || '<span class="dim">(empty)</span>') : 'Loading…') + '</pre>'
      + (d && !d.error ? '<div class="dim" style="font-size:13px;margin-top:6px">' + esc(d.file) + ' · ' + bkBytes(d.size) + (d.truncated ? ' · showing the tail' : '') + '</div>' : '') + '</div>';
  });
}
async function siteLogFetch(){
  const kind = siteView.sub.logKind; if (!kind) return;
  const lines = document.getElementById('lgLines') ? Number(document.getElementById('lgLines').value) : (siteView.sub.logLines || 200);
  const q = document.getElementById('lgQ') ? document.getElementById('lgQ').value : (siteView.sub.logQ || '');
  siteView.sub.logLines = lines; siteView.sub.logQ = q;
  const [k, name] = kind.split('/');
  try { siteView.sub.logData = await siteApi('GET', siteUrl('/logs/' + encodeURIComponent(k) + '?lines=' + lines + (name ? '&name=' + encodeURIComponent(name) : '') + (q ? '&q=' + encodeURIComponent(q) : ''))); }
  catch(e){ siteView.sub.logData = { error: e.message }; }
  const pre = document.getElementById('lgOut');
  if (pre && document.activeElement && document.activeElement.id === 'lgQ') { const d = siteView.sub.logData; pre.innerHTML = d.error ? '⚠ ' + esc(d.error) : esc(d.lines.join('\n')); pre.scrollTop = pre.scrollHeight; return; }
  renderSiteDetail();
}
function siteLogFollow(on){ clearInterval(siteLogTimer); siteLogTimer = null; if (on) siteLogTimer = setInterval(() => { if (state.tab === 'sites' && siteView.tab === 'logs') siteLogFetch(); else siteLogFollow(false); }, 3000); }
