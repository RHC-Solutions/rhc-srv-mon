/* ---------------------------------------------------------------- updates */

let lastUpdates = null;

function renderUpdates(){
  if (!lastUpdates) return;
  const d = lastUpdates;
  document.getElementById('host').textContent = '';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.lastChecked ? new Date(d.lastChecked).toLocaleString() : 'never') + ' · hourly auto-check';
  showBanner(null);
  const avail = (d.components||[]).filter(c => c.updateAvailable).length;
  if (avail === 0) setStatus([{ level:'ok', icon:'✅', text:'All components up to date', sub: d.components.length + ' tracked' }]);
  else setStatus([{ level:'warn', icon:'🔄', text: avail + ' update' + (avail>1?'s':'') + ' available', sub: d.components.filter(c => !c.updateAvailable).length + '/' + d.components.length + ' up to date' }]);

  let html = '<div class="upd-grid">';

  // Left column: components table
  html += '<div class="upd-card" style="grid-column:1/-1">';
  const updCount = d.components.filter(c => c.updateAvailable && !c.git).length;
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Components</h3><span style="display:flex;gap:8px;align-items:center">';
  html += '<span class="dim" style="font-size:13px">checked ' + (d.lastChecked ? esc(new Date(d.lastChecked).toLocaleString()) : 'never') + '</span>';
  html += '<button class="btn" onclick="checkUpdatesNow(this)" style="font-size:14px;padding:4px 14px" title="check every component now — OS packages, Node.js, tools and the panel against GitHub">' + (updChecking ? '⏳ Checking…' : '⟳ Check now') + '</button>';
  if (updCount) {
    html += '<button class="btn update" onclick="triggerUpdateAll()" style="font-size:14px;padding:4px 14px">⬆ Update All (' + updCount + ')</button>';
  }
  html += '</span>';
  html += '</div>';
  html += '<table class="upd-table"><tr><th>Component</th><th>Current</th><th>Latest</th><th>Status</th><th></th></tr>';
  for (const c of d.components) {
    const hasUpdate = c.updateAvailable;
    const isRunning = c.updating;
    const statusBadge = !c.currentVersion ? '<span class="upd-badge na">not installed</span>'
      : isRunning ? '<span class="upd-badge" style="background:var(--md-warn-container);color:var(--md-warning)">updating…</span>'
      : c.git && c.error ? '<span class="upd-badge na" title="' + esc(c.error) + '">cannot check</span>'
      : hasUpdate ? '<span class="upd-badge new">' + (c.git ? c.behind + ' new commit' + (c.behind > 1 ? 's' : '') + ' on GitHub' : 'update available') + '</span>'
      : '<span class="upd-badge ok">up to date</span>';
    const btnHtml = !c.currentVersion ? ''
      : isRunning ? '<button class="btn running" disabled>⏳ updating</button>'
      : hasUpdate && c.git ? '<button class="btn update" onclick="armConfirm(this, \'⬆ Pull and restart the panel?\', () => triggerPanelUpdate())" title="git pull from GitHub, check the code, restart the panel (rolls back if it does not come up)">⬆ Update from GitHub</button>'
      : hasUpdate ? '<button class="btn update" onclick="triggerUpdate(\'' + c.key + '\')">⬆ Update</button>'
      : c.git ? '<button class="btn" onclick="checkUpdatesNow(this)" title="fetch from GitHub now; ⬆ Update from GitHub appears when there are new commits">⟳ Check GitHub</button>'
      : '<button class="btn" disabled>✓ latest</button>';
    // Node.js is the runtime everything else here needs, and the panel is this app: neither is removable.
    const rmHtml = (!c.currentVersion || isRunning || c.key === 'node' || c.git) ? ''
      : ' <button class="btn danger small upd-remove" data-comp="' + c.key + '" data-label="' + esc(c.label) + '" title="npm rm -g — uninstall ' + esc(c.label) + ' system-wide">🗑 Remove</button>';
    html += '<tr>'
      + '<td><strong>' + esc(c.label) + '</strong></td>'
      + '<td>' + esc(c.currentVersion || '—') + '</td>'
      + '<td>' + esc(c.latestVersion || '—') + '</td>'
      + '<td>' + statusBadge + '</td>'
      + '<td style="text-align:right;white-space:nowrap">' + btnHtml + rmHtml + '</td>'
      + '</tr>';
  }
  html += '</table></div>';

  // Per-user versions table
  const userKeys = Object.keys(d.users || {});
  const userComps = d.components.filter(c => !c.git);
  if (userKeys.length) {
    const allCompKeys = userComps.map(c => c.key);
    let userOutdatedCount = 0;
    for (const u of userKeys) {
      const uv = d.users[u] || {};
      for (const c of userComps) {
        if (c.key === 'node') continue;
        const userV = uv[c.key] || null;
        if (userV && c.latestVersion && userV !== c.latestVersion) userOutdatedCount++;
      }
    }
    html += '<div class="upd-card" style="grid-column:1/-1">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
    html += '<h3 style="margin:0">By User <span style="font-weight:400;font-size:14px;color:var(--md-on-surface-dis)">' + userKeys.length + ' users</span></h3>';
    const aur = lastUpdates.allUsersRun;
    if (aur && aur.running) {
      html += '<span class="dim" style="font-size:14px">⏳ Updating ' + aur.done + '/' + aur.total + (aur.current ? ' · ' + esc(aur.current) : '') + '</span>';
    } else if (userOutdatedCount) {
      html += '<button class="btn update" onclick="armConfirm(this, \'⬆ Update all users?\', () => triggerUpdateAllUsers())" style="font-size:14px;padding:4px 14px" title="Runs npm updates for every user, sequentially — it can take a few minutes">⬆ Update All Users (' + userOutdatedCount + ')</button>';
    }
    html += '</div>';
    html += '<div style="overflow-x:auto"><table class="upd-table">';
    html += '<tr><th>User</th>';
    for (const c of userComps) {
      if (c.key === 'node') { html += '<th>' + esc(c.label) + '</th>'; continue; }
      html += '<th>' + esc(c.label) + '</th>';
    }
    html += '<th style="width:100px">Update</th></tr>';
    const sortedUsers = [...userKeys].sort();
    for (const u of sortedUsers) {
      const uv = d.users[u] || {};
      let hasOutdated = false;
      let innerCols = '';
      html += '<tr><td><strong>' + esc(u) + '</strong></td>';
      for (const c of userComps) {
        if (c.key === 'node') {
          const userV = uv[c.key] || null;
          html += '<td>' + esc(userV || '—') + '</td>';
          continue;
        }
        const userV = uv[c.key] || null;
        const latestC = userComps.find(x => x.key === c.key);
        const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
        if (isUpd) hasOutdated = true;
        if (userV) {
          html += '<td>' + esc(userV) + (isUpd ? ' <span class="upd-badge new">⬆ ' + esc(latestC.latestVersion) + '</span>' : ' <span class="upd-badge ok">✓</span>') + '</td>';
        } else if (c.agent) {
          html += '<td><button class="btn small" style="font-size:12.5px" title="install ' + esc(c.label) + ' for ' + esc(u) + '" onclick="agentDeploy(\'' + c.key + '\', [\'' + esc(u) + '\'], this)">＋ Install</button></td>';
        } else {
          html += '<td><span class="upd-badge na">—</span></td>';
        }
      }
      html += '<td>';
      if (hasOutdated) {
        for (const c of userComps) {
          if (c.key === 'node') continue;
          const userV = uv[c.key] || null;
          const latestC = userComps.find(x => x.key === c.key);
          const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
          if (isUpd) {
            html += '<button class="btn update small" style="margin:1px;font-size:12.5px" onclick="triggerUserUpdate(\'' + esc(u) + '\',\'' + c.key + '\')">⬆ ' + c.key + '</button> ';
          }
        }
      } else {
        html += '<span class="upd-badge ok" style="font-size:12.5px">✓ up to date</span>';
      }
      // one remove control per component this user actually has (refused server-side
      // when the user sits on the shared system npm prefix — that is a system-wide removal)
      for (const c of userComps) {
        if (c.key === 'node' || !uv[c.key]) continue;
        html += ' <button class="btn danger small upd-remove" data-user="' + esc(u) + '" data-comp="' + c.key + '" data-label="' + esc(c.label) + '" style="margin:1px" title="npm rm -g ' + esc(c.label) + ' for ' + esc(u) + '">🗑 ' + c.key + '</button>';
      }
      html += '</td>';
      html += '</tr>';
    }
    html += '</table></div></div>';
  }

  // Schedule card
  html += '<div class="upd-card">';
  html += '<h3>Schedule</h3>';
  const sched = d.schedule || {};
  html += '<div class="upd-toggle">'
    + '<label class="switch"><input type="checkbox" id="schedEnable" ' + (sched.enabled?'checked':'') + ' onchange="saveUpdatesConfig()"><span class="slider"></span></label>'
    + '<label>Auto-update</label></div>';
  html += '<div class="upd-field"><label>Time (24h)</label>'
    + '<div style="display:flex;gap:8px">'
    + '<input type="number" id="schedHour" min="0" max="23" value="' + (sched.hour||3) + '" style="width:70px" onchange="saveUpdatesConfig()">:<input type="number" id="schedMin" min="0" max="59" value="' + (sched.min||0) + '" style="width:70px" onchange="saveUpdatesConfig()">'
    + '</div><span class="hint">Server time — updates run within 2 min of this time</span></div>';
  html += '<div class="upd-field"><label>Components to auto-update</label><div class="upd-chk-grid">';
  for (const c of d.components) {
    const checked = !sched.components || sched.components.includes(c.key);
    html += '<label><input type="checkbox" class="sched-comp" data-key="' + c.key + '" ' + (checked?'checked':'') + ' onchange="saveUpdatesConfig()"> ' + c.label + '</label>';
  }
  html += '</div></div></div>';

  html += '<div class="upd-card"><h3>Notifications</h3><p class="dim" style="margin:0">Telegram and Slack settings moved to the <a href="settings" onclick="event.preventDefault(); setTab(\'settings\', { fromBar: true })">⚙️ Settings</a> tab.</p></div>';

  // AI agents
  html += '<div class="upd-card" style="grid-column:1/-1" id="agentsCard">' + agentsCardHtml() + '</div>';

  // Update log
  html += '<div class="upd-card" style="grid-column:1/-1">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Update Log <span style="font-weight:400;font-size:14px;color:var(--md-on-surface-dis)">last ' + d.log.length + ' entries</span></h3>';
  html += '<button class="btn" onclick="clearUpdateLog()" style="font-size:12.5px;padding:3px 10px;background:var(--md-error-container);color:var(--md-error-bright);border:none;border-radius:5px;cursor:pointer">🗑 Clear log</button>';
  html += '</div>';
  html += '<div class="upd-log">';
  if (!d.log.length) {
    html += '<div style="color:var(--md-on-surface-dis);padding:10px 0;font-size:15px">No updates have been run yet.</div>';
  } else {
    for (const entry of d.log.slice().reverse()) {
      const icon = entry.success ? '✅' : '❌';
      const cls = entry.success ? '' : ' style="color:var(--md-error-bright)"';
      html += '<div class="upd-log-entry">'
        + '<span class="time">' + new Date(entry.timestamp).toLocaleString() + '</span>'
        + '<span class="comp"' + cls + '>' + icon + ' ' + esc(entry.label) + '</span>'
        + '<span class="result">' + esc((entry.output||'').split('\n')[0].slice(0, 80)) + '</span>'
        + '</div>';
    }
  }
  html += '</div></div>';

  html += '</div>';
  document.getElementById('updatesview').innerHTML = html;
  // Uninstalling is destructive and has no undo, so it goes through the same two-step
  // arm/confirm the rest of the panel uses instead of a browser dialog.
  document.querySelectorAll('.upd-remove').forEach(b => b.addEventListener('click', () => {
    const who = b.dataset.user ? ' for ' + b.dataset.user : ' system-wide';
    armConfirm(b, '⚠ Click again to remove', () => triggerRemove(b.dataset.comp, b.dataset.user || null, b.dataset.label + who));
  }));
}

// ---- AI agents: catalog of the major coding CLIs + custom ones; track (= component above), deploy per user
let agData = null, agLoading = false, agPoll = null;
function agentsCardHtml(){
  let h = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px"><h3 style="margin:0">AI agents</h3><button class="btn" style="font-size:14px;padding:4px 14px" onclick="agentAddCustom()">＋ Custom agent</button></div>';
  if (!agData) { if (!agLoading) loadAgents(); return h + '<p class="dim">Loading…</p>'; }
  if (agData.error) return h + '<p style="color:var(--md-error-bright)">⚠ ' + esc(agData.error) + '</p>';
  h += '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Tracked agents appear above as components (versions per user, update, remove). <b>Deploy</b> installs an agent for root or any site/SSH user — npm agents into the user\'s own ~/.npm-global, script agents with their vendor installer.</p>';
  h += '<table class="upd-table"><tr><th>Agent</th><th>From</th><th>Tracked</th><th></th></tr>';
  for (const a of agData.agents) {
    h += '<tr><td><b>' + esc(a.label) + '</b> <span class="dim">· ' + esc(a.vendor || 'custom') + '</span><br><span class="mono dim" style="font-size:12.5px">' + esc(a.bin) + '</span></td>'
      + '<td class="mono" style="font-size:12.5px">' + esc(a.pkg ? 'npm ' + a.pkg : a.installCmd || '') + '</td>'
      + '<td>' + (a.always ? '<span class="dim">always</span>' : a.custom ? '<span class="dim">yes (custom)</span>' : '<label class="switch"><input type="checkbox"' + (a.tracked ? ' checked' : '') + ' onchange="agentTrack(\'' + a.key + '\', this.checked)"><span class="slider"></span></label>') + '</td>'
      + '<td style="text-align:right;white-space:nowrap"><button class="btn small" onclick="agentDeployDialog(\'' + a.key + '\')">Deploy…</button>' + (a.custom ? ' <button class="btn small" onclick="armConfirm(this, \'Remove?\', () => agentRemoveCustom(\'' + a.key + '\'))">Remove</button>' : '') + '</td></tr>';
  }
  h += '</table>';
  for (const j of agData.jobs || []) h += '<div class="dim" style="font-size:13.5px;margin-top:6px">' + (j.state === 'running' ? '⏳ ' : '') + esc(j.label) + ' → ' + esc(j.users.join(', ')) + ': ' + (j.state === 'running' ? 'installing' + (j.current ? ' for ' + esc(j.current) : '') + '…' : j.results.map(r => esc(r.user) + ' ' + (r.ok ? '✅ ' + esc(r.version || '') : '❌')).join(' · ')) + '</div>';
  return h;
}
function agRender(){ const el = document.getElementById('agentsCard'); if (el) el.innerHTML = agentsCardHtml(); }
async function loadAgents(){
  agLoading = true;
  try { agData = await stApi('GET', 'api/agents'); } catch(e){ agData = { error: e.message }; }
  agLoading = false; agRender();
  clearTimeout(agPoll);
  if (agData && (agData.jobs || []).some(j => j.state === 'running')) agPoll = setTimeout(async () => { await loadAgents(); if (!(agData.jobs || []).some(j => j.state === 'running')) checkUpdates(); }, 4000);
}
async function agentTrack(key, on){
  const keys = agData.agents.filter(a => !a.always && !a.custom && (a.key === key ? on : a.tracked)).map(a => a.key);
  try { await stApi('PUT', 'api/agents/tracked', { keys }); toast(on ? 'Tracking — versions appear after the next check' : 'No longer tracked', 'success'); await loadAgents(); setTimeout(checkUpdates, 1500); } catch(e){ stErr(e, 'Agents'); }
}
function agentDeployDialog(key){
  const a = agData.agents.find(x => x.key === key);
  sshModal('<h3>Deploy ' + esc(a.label) + '</h3><p class="dim" style="font-size:14px">Install (or bring to the latest version) for:</p>'
    + agData.users.map(u => '<label style="display:block"><input type="checkbox" class="agU" value="' + esc(u) + '"' + (u === 'root' ? '' : '') + '> ' + esc(u) + (u === 'root' ? ' <span class="dim">(system-wide)</span>' : '') + '</label>').join('')
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="agentDeploy(\'' + key + '\', [...document.querySelectorAll(\'.agU:checked\')].map(x => x.value), this)">Deploy</button></div>');
}
async function agentDeploy(key, users, btn){
  if (!users.length) return toast('Pick at least one user', 'warn');
  if (btn) btn.disabled = true;
  try { const j = await stApi('POST', 'api/agents/' + key + '/deploy', { users }); sshModalClose(); toast('Deploying ' + j.label + ' for ' + users.join(', ') + '…', 'success'); loadAgents(); }
  catch(e){ stErr(e, 'Deploy'); if (btn) btn.disabled = false; }
}
function agentAddCustom(){
  sshModal('<h3>＋ Custom AI agent</h3>'
    + '<div class="row2">' + stField('Name', '<input id="caLabel" placeholder="My agent">') + stField('Command', '<input id="caBin" placeholder="myagent" class="mono">', 'the program it installs') + '</div>'
    + stField('npm package', '<input id="caPkg" class="mono" placeholder="@scope/my-agent (or leave empty and give an install command)">')
    + stField('Install command', '<input id="caInst" class="mono" placeholder="curl -fsSL https://example.com/install.sh | bash">', 'runs as the user; used when there is no npm package')
    + '<div class="row2">' + stField('Update command', '<input id="caUpd" class="mono" placeholder="myagent update (optional)">') + stField('Version flag', '<input id="caVer" class="mono" value="--version">') + '</div>'
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="agentSaveCustom(this)">Add</button></div>');
}
async function agentSaveCustom(btn){
  const g = (id) => document.getElementById(id).value.trim();
  btn.disabled = true;
  try { const a = await stApi('POST', 'api/agents/custom', { label: g('caLabel'), bin: g('caBin'), pkg: g('caPkg'), installCmd: g('caInst'), updateCmd: g('caUpd'), verFlag: g('caVer') }); sshModalClose(); toast(a.label + ' added — Deploy it to users', 'success'); loadAgents(); setTimeout(checkUpdates, 1500); }
  catch(e){ stErr(e, 'Custom agent'); btn.disabled = false; }
}
async function agentRemoveCustom(key){ try { await stApi('DELETE', 'api/agents/custom/' + key); toast('Removed from the list (installed copies stay)', 'success'); loadAgents(); setTimeout(checkUpdates, 1500); } catch(e){ stErr(e, 'Remove'); } }
let updChecking = false;
async function checkUpdatesNow(btn){
  if (updChecking) return;
  updChecking = true; if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }
  toast('Checking for updates…');
  try {
    const res = await fetch('api/updates/check', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'HTTP ' + res.status);
    lastUpdates = d;
    const avail = (d.components || []).filter(c => c.updateAvailable);
    toast(avail.length ? avail.length + ' update' + (avail.length > 1 ? 's' : '') + ' available: ' + avail.map(c => c.label).join(', ') : 'Everything is up to date', avail.length ? 'warn' : 'success', { duration: 8000 });
  } catch(e){ toast('Check failed: ' + e.message, 'error'); }
  updChecking = false;
  if (state.tab === 'updates') renderUpdates();
}
async function checkUpdates(){
  try {
    const res = await fetch('api/updates/check', { method: 'POST' });
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdate(key){
  // Optimistically show running state
  if (lastUpdates) {
    const c = lastUpdates.components.find(x => x.key === key);
    if (c) c.updating = true;
    renderUpdates();
  }
  try {
    const res = await fetch('api/updates/run/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

// The panel pulls its new code and restarts itself, so this page goes away for a few seconds: wait for
// it to answer again, then reload so the browser runs the new UI too.
async function triggerPanelUpdate(){
  if (lastUpdates) {
    const c = lastUpdates.components.find(x => x.key === 'panel');
    if (c) c.updating = true;
    renderUpdates();
  }
  let result;
  try {
    const res = await fetch('api/updates/run/panel', { method: 'POST' });
    result = await res.json();
  } catch(e){ return toast('Panel update failed: ' + e.message, 'error'); }
  if (result.error || result.success === false) {
    toast('Panel update failed', 'error', { detail: result.error || result.output, duration: 20000 });
    try { const r2 = await fetch('api/updates'); lastUpdates = await r2.json(); } catch(_){}
    if (state.tab === 'updates') renderUpdates();
    return;
  }
  if (/^already up to date/.test(result.output || '')) {
    toast('Panel ' + result.output, 'success');
    try { const r2 = await fetch('api/updates'); lastUpdates = await r2.json(); } catch(_){}
    if (state.tab === 'updates') renderUpdates();
    return;
  }
  toast('Updated from GitHub — restarting the panel…', 'info', { detail: result.output, duration: 15000 });
  await new Promise(r => setTimeout(r, 6000));
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('api/updates', { cache: 'no-store' }); if (r.ok) return location.reload(); } catch(_){}
    await new Promise(r => setTimeout(r, 3000));
  }
  toast('The panel has not come back yet — reload the page in a minute', 'warn', { duration: 30000 });
}

async function triggerUserUpdate(user, key){
  try {
    const res = await fetch('api/updates/run/' + user + '/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

// Uninstall a component: npm rm -g, system-wide or for one user's own npm prefix.
async function triggerRemove(key, user, label){
  try {
    const url = 'api/updates/remove/' + (user ? encodeURIComponent(user) + '/' : '') + encodeURIComponent(key);
    const res = await fetch(url, { method: 'POST' });
    const result = await res.json();
    if (result && result.error) toast(result.error, 'error');
    else if (result && result.success === false) toast('Removal of ' + label + ' failed', 'error', { detail: result.output });
    else toast('Removed ' + label, 'success');
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(e){ toast('Error: ' + e, 'error'); }
}

async function triggerUpdateAll(){
  try {
    await fetch('api/updates/run-all', { method: 'POST' });
    const res = await fetch('api/updates');
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

// Confirmed by arming the button that calls this (see renderUpdates) rather than by a browser dialog.
async function triggerUpdateAllUsers(){
  try {
    const r = await fetch('api/updates/run-all-users', { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast('Update all users: ' + (j.error || 'HTTP ' + r.status), 'warn');
    toast('Updating ' + j.count + ' tool(s) across users in the background…', 'info');
    pollUpdateAllUsers();
  } catch(e){ toast('Update all users failed: ' + e.message, 'error'); }
}
// The batch runs server-side; follow it through GET api/updates until it finishes.
async function pollUpdateAllUsers(){
  let run = null;
  try { const res = await fetch('api/updates'); lastUpdates = await res.json(); run = lastUpdates.allUsersRun; } catch(_){}
  if (state.tab === 'updates') renderUpdates();
  if (run && run.running) return setTimeout(pollUpdateAllUsers, 3000);
  if (run && run.finishedAt) toast('Update all users: ' + run.ok + '/' + run.total + ' updated' + (run.failed.length ? ', ' + run.failed.length + ' failed' : ''),
    run.failed.length ? 'warn' : 'success', run.failed.length ? { detail: run.failed.join('\n'), duration: 20000 } : {});
}

function saveUpdatesConfig(){
  if (!lastUpdates) return;
  const sched = {
    enabled: document.getElementById('schedEnable').checked,
    hour: parseInt(document.getElementById('schedHour').value) || 3,
    minute: parseInt(document.getElementById('schedMin').value) || 0,
    components: Array.from(document.querySelectorAll('.sched-comp:checked')).map(el => el.dataset.key),
  };
  fetch('api/updates/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: sched }),
  });
  if (lastUpdates) {
    lastUpdates.schedule = sched;
  }
}

async function clearUpdateLog(){
  try {
    await fetch('api/updates/log', { method: 'DELETE' });
    if (lastUpdates) { lastUpdates.log = []; renderUpdates(); }
  } catch(_){}
}


