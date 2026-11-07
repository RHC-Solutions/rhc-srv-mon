// ---- App Store: AI agents, runtimes (all PHP / Node / Python versions…), databases, tools.
let asData = null, asLoading = false, asCat = 'agents', asPoll = null, asOpenJob = null;
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
async function asJobLog(id){
  try { const j = await stApi('GET', 'api/appstore/jobs/' + id); const el = document.getElementById('asLog' + id); if (el) { el.textContent = j.log.join('\n'); el.scrollTop = el.scrollHeight; } } catch(_){}
}
async function asRun(id, action, version, btn){
  if (btn) btn.disabled = true;
  try { const j = await stApi('POST', 'api/appstore/' + id + '/' + action, { version }); asOpenJob = j.id; toast(action + ' ' + j.name + (version !== 'latest' ? ' ' + version : '') + ' started', 'success'); loadAppStore(false); }
  catch(e){ stErr(e, 'App Store'); if (btn) btn.disabled = false; }
}
