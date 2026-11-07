// ---- Cluster: other SB SRV Manager servers, join codes, moving sites between servers.
let clData = null, clLoading = false, clCode = null, clPoll = null;
async function loadCluster(){
  clLoading = true;
  try { clData = await stApi('GET', 'api/cluster'); } catch(e){ clData = { error: e.message }; }
  clLoading = false;
  if (state.tab === 'cluster') renderCluster(true);
  const running = clData && (clData.moves || []).some(m => m.state === 'running');
  clearTimeout(clPoll); if (running) clPoll = setTimeout(loadCluster, 4000);
}
function renderCluster(fromLoad){
  plainTabHeader('Several servers, one panel each — move sites with their settings, data and tunnel between them');
  const view = document.getElementById('clusterview');
  if (!clData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!clLoading) loadCluster(); return; }
  if (!fromLoad && view.contains(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  if (clData.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(clData.error) + '</div>'; return; }
  const s = clData.self, when = (t) => t ? esc(new Date(t).toLocaleString()) : '–';
  let h = '<div class="upd-grid">';
  h += '<div class="upd-card"><h3>This server</h3><div class="row2">'
    + stField('Name', '<input id="clName" value="' + esc(s.name) + '">')
    + stField('Panel URL', '<input id="clUrl" value="' + esc(s.url) + '" placeholder="https://' + esc(location.host) + location.pathname.replace(/[^/]*$/, '') + '">', 'how other servers reach this panel') + '</div>'
    + '<p class="dim" style="margin:6px 0;font-size:14px">The panel is behind Cloudflare Access. For other servers to get through: Cloudflare Zero Trust → Access → <b>Service auth</b> → create a service token, then add a policy with action <b>Service Auth</b> for that token to this panel\'s Access application. Paste the token here — it is handed to servers that join.</p><div class="row2">'
    + stField('Access client ID', '<input id="clAid" value="' + esc(s.accessClientId) + '" placeholder="xxxx.access">')
    + stField('Access client secret', '<input id="clAsec" type="password" autocomplete="new-password" placeholder="' + (s.hasAccessSecret ? '•••••••• (stored — leave empty to keep)' : 'secret') + '">') + '</div>'
    + '<div class="dim" style="font-size:13.5px">Server id <span class="mono">' + esc(s.id) + '</span> · panel version <span class="mono">' + esc(clData.version || '?') + '</span></div>'
    + '<div class="site-actions"><button class="btn pri" onclick="clSaveSelf()">Save</button></div></div>';
  h += '<div class="upd-card"><h3>Add a server</h3><p class="dim" style="margin:0 0 8px;font-size:14.5px">On one server create a join code, on the other paste it. The code is valid for one hour and one use; it carries a fresh key only these two servers share.</p>'
    + (clCode ? '<textarea class="mono" readonly rows="4" style="width:100%;font-size:12px" onclick="this.select()">' + esc(clCode.code) + '</textarea><div class="dim" style="font-size:13px">valid until ' + when(clCode.expires) + ' · <a href="#" onclick="vaultCopyText(clCode.code, \'Join code\');return false">copy</a></div>' : '')
    + '<div class="site-actions"><button class="btn" onclick="clMakeCode()">Create join code</button></div>'
    + stField('Join with a code from another server', '<textarea id="clJoin" class="mono" rows="3" style="width:100%;font-size:12px" placeholder="sbj1.…"></textarea>')
    + '<div class="site-actions"><button class="btn pri" onclick="clJoinWith(this)">Join</button></div></div></div>';
  // members
  const peers = clData.peers || [];
  h += '<div class="upd-card" style="margin-top:14px"><h3>Members <span class="dim" style="font-weight:400">' + peers.length + '</span></h3>';
  if (!peers.length) h += '<p class="dim">No other servers yet.</p>';
  else {
    h += '<table class="upd-table"><tr><th>Server</th><th>Version</th><th>Sites</th><th>Last contact</th><th></th></tr>';
    for (const p of peers) h += '<tr><td><b>' + esc(p.name) + '</b><br><a class="dim mono" style="font-size:13px" href="' + esc(p.url) + '" target="_blank" rel="noopener">' + esc(p.url) + '</a></td><td class="mono">' + esc(p.version || '?') + '</td>'
      + '<td style="font-size:13.5px">' + (p.sites || []).map(x => esc(x.domain) + ' <span class="dim">(' + esc(x.status || '?') + ')</span>').join('<br>') + '</td>'
      + '<td style="font-size:13.5px">' + when(p.lastSeen) + (p.lastError ? '<br><span style="color:var(--md-error-bright)">' + esc(p.lastError) + '</span>' : '') + '</td>'
      + '<td style="white-space:nowrap"><button class="btn small" onclick="clRefresh(\'' + esc(p.id) + '\', this)">Check</button> <button class="btn small" onclick="armConfirm(this, \'Remove?\', () => clRemove(\'' + esc(p.id) + '\'))">Remove</button></td></tr>';
    h += '</table>';
  }
  h += '</div>';
  // move
  h += '<div class="upd-card" style="margin-top:14px"><h3>Move a site</h3><p class="dim" style="margin:0 0 8px;font-size:14.5px">Moves the site\'s files, databases, settings, secrets, SSH users and GitHub link; the target rebuilds the runtime and starts it, then takes over the site\'s <b>tunnel</b> — traffic switches without a DNS change. The copy here is stopped and kept until you delete it.</p>';
  if (!peers.length) h += '<p class="dim">Add a server first.</p>';
  else h += '<div class="row2">' + stField('Site', '<select id="clSite">' + (clData.localSites || []).map(d => '<option>' + esc(d) + '</option>').join('') + '</select>') + stField('To', '<select id="clPeer">' + peers.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select>') + '</div>'
    + '<div class="site-actions"><button class="btn pri" onclick="armConfirm(this, \'Move it now?\', () => clMove(this))">Move</button></div>';
  for (const m of clData.moves || []) {
    h += '<details' + (m.state === 'running' ? ' open' : '') + ' style="margin-top:8px"><summary><b>' + esc(m.domain || '?') + '</b> ' + (m.role === 'source' ? '→ ' + esc((m.peer || {}).name || '') : '← ' + esc(m.from || '')) + ' · ' + esc(m.state) + (m.progress != null && m.state === 'running' ? ' ' + m.progress + '%' : '') + ' · ' + when(m.started) + '</summary>'
      + '<div class="mono" style="font-size:12.5px;white-space:pre-wrap;margin-top:6px">' + esc((m.steps || []).map(x => x.at.slice(11, 19) + '  ' + x.text).join('\n')) + '</div></details>';
  }
  view.innerHTML = h + '</div>';
}
async function clSaveSelf(){
  const g = (id) => document.getElementById(id).value;
  const body = { name: g('clName'), url: g('clUrl'), accessClientId: g('clAid') };
  if (g('clAsec')) body.accessClientSecret = g('clAsec');
  try { await stApi('PUT', 'api/cluster/self', body); toast('Saved', 'success'); clData = null; loadCluster(); } catch(e){ stErr(e, 'Cluster'); }
}
async function clMakeCode(){ try { clCode = await stApi('POST', 'api/cluster/join-code'); renderCluster(true); } catch(e){ stErr(e, 'Join code'); } }
async function clJoinWith(btn){
  btn.disabled = true;
  try { const r = await stApi('POST', 'api/cluster/join-with', { code: document.getElementById('clJoin').value.trim() }); toast('Joined ' + r.joined, 'success'); clData = null; loadCluster(); }
  catch(e){ stErr(e, 'Join'); btn.disabled = false; }
}
async function clRefresh(id, btn){ btn.disabled = true; try { await stApi('POST', 'api/cluster/peers/' + id + '/refresh'); toast('Reachable', 'success'); } catch(e){ stErr(e, 'Check'); } loadCluster(); }
async function clRemove(id){ try { await stApi('DELETE', 'api/cluster/peers/' + id); toast('Removed', 'success'); loadCluster(); } catch(e){ stErr(e, 'Remove'); } }
async function clMove(btn){
  btn.disabled = true;
  try { await stApi('POST', 'api/cluster/move', { domain: document.getElementById('clSite').value, peer: document.getElementById('clPeer').value }); toast('Move started', 'success'); loadCluster(); }
  catch(e){ stErr(e, 'Move'); btn.disabled = false; }
}
