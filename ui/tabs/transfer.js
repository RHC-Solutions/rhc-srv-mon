// ---- Transfer: move sites from this server to another SB SRV Manager (or receive them). Not
// clustering: the connection is made with a one-time transfer code and forgotten afterwards.
let trData = null, trLoading = false, trCode = null, trPoll = null;
async function loadTransfer(){
  trLoading = true;
  try { trData = await stApi('GET', 'api/cluster'); } catch(e){ trData = { error: e.message }; }
  trLoading = false;
  if (state.tab === 'transfer') renderTransfer(true);
  const busy = trData && (trData.moves || []).some(m => m.state === 'running' || m.state === 'queued');
  clearTimeout(trPoll); if (busy) trPoll = setTimeout(loadTransfer, 4000);
}
function renderTransfer(fromLoad){
  plainTabHeader('Move sites to another server — a one-time connection, not a cluster');
  const view = document.getElementById('transferview');
  if (!trData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!trLoading) loadTransfer(); return; }
  if (!fromLoad && view.contains(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  if (trData.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(trData.error) + '</div>'; return; }
  const s = trData.self, when = (t) => t ? esc(new Date(t).toLocaleString()) : '–';
  const peers = (trData.peers || []);
  const sites = trData.localSites || [];
  let h = '<p class="dim" style="margin:0 0 12px;font-size:14.5px">Two servers, two roles: on the <b>target</b> (the server that gets the sites) create a transfer code; on the <b>source</b> (the server the sites are on now) paste it and pick the sites. The connection is temporary and closes by itself when the transfer is done.</p>';
  h += '<div class="upd-grid">';
  // TARGET
  h += '<div class="upd-card" style="border-top:3px solid var(--md-primary)"><h3>🎯 Target · receive sites here</h3>'
    + '<ol style="margin:0 0 8px 18px;padding:0;font-size:14.5px"><li>Create a transfer code (valid 1 hour, one use).</li><li>Copy it and paste it on the <b>source</b> server\'s Transfer page.</li></ol>'
    + (trCode ? '<textarea class="mono" readonly rows="4" style="width:100%;font-size:12px" onclick="this.select()">' + esc(trCode.code) + '</textarea><div class="dim" style="font-size:13px">valid until ' + when(trCode.expires) + ' · <a href="#" onclick="vaultCopyText(trCode.code, \'Transfer code\');return false">copy</a></div>' : '')
    + '<div class="site-actions"><button class="btn pri" onclick="trMakeCode(this)">Create transfer code</button></div>'
    + (/^https:\/\/xfer-/.test(s.url || '') ? '<p class="dim" style="font-size:13px;margin:6px 0 0">Codes point to <span class="mono">' + esc(s.url) + '</span> — the transfer address outside Cloudflare Access.</p>'
      : !s.accessClientId ? '<div class="site-why" style="font-size:13.5px;margin-top:8px">This panel is behind Cloudflare Access, which the source server cannot pass. Create a <b>transfer address</b> first — a hostname that answers only the signed transfer API (the panel stays protected):<div class="site-actions"><button class="btn small pri" onclick="trMakeEndpoint(this)">Create transfer address</button></div></div>' : '')
    + '</div>';
  // SOURCE
  h += '<div class="upd-card" style="border-top:3px solid var(--md-warning)"><h3>📦 Source · send sites from here</h3>';
  if (!peers.length) h += '<ol style="margin:0 0 8px 18px;padding:0;font-size:14.5px"><li>Paste the transfer code from the <b>target</b> server.</li><li>Connect, tick the sites, Move.</li></ol>'
    + '<textarea id="trJoin" class="mono" rows="3" style="width:100%;font-size:12px" placeholder="sbt1.…"></textarea><div class="site-actions"><button class="btn pri" onclick="trConnect(this)">Connect</button></div>';
  else {
    h += '<p style="margin:0 0 6px">Connected to target <b>' + esc(peers.map(p => p.name).join(', ')) + '</b>' + (peers[0].expires ? ' <span class="dim">(closes ' + when(peers[0].expires) + ' at the latest)</span>' : '') + '</p>'
      + (peers.length > 1 ? stField('Target', '<select id="trPeer">' + peers.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</select>') : '<input type="hidden" id="trPeer" value="' + esc(peers[0].id) + '">')
      + '<div style="margin:6px 0">' + (sites.length ? sites.map(d => '<label style="display:block"><input type="checkbox" class="trSite" value="' + esc(d) + '"> ' + esc(d) + '</label>').join('') : '<span class="dim">No sites on this server to send.</span>') + '</div>'
      + '<p class="dim" style="font-size:13.5px;margin:4px 0">Each site moves with its files, databases, settings, secrets, SSH users and GitHub link; the target rebuilds and starts it, then takes over its tunnel — no DNS change. The copy here is stopped and kept. Sites move one after another.</p>'
      + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="armConfirm(this, \'Close it?\', () => trForget(\'' + esc(peers[0].id) + '\'))">Close connection</button><button class="btn pri" onclick="armConfirm(this, \'Move the checked sites now?\', () => trMove(this))">Move selected</button></div>';
  }
  h += '</div></div>';
  // history
  if ((trData.moves || []).length) {
    h += '<div class="upd-card" style="margin-top:14px"><h3>Transfers</h3>';
    for (const m of trData.moves) h += '<details' + (m.state === 'running' ? ' open' : '') + ' style="margin-top:6px"><summary><b>' + esc(m.domain || '?') + '</b> ' + (m.role === 'source' ? '→ ' + esc((m.peer || {}).name || '') : '← ' + esc(m.from || '')) + ' · ' + esc(m.state) + (m.progress != null && m.state === 'running' ? ' ' + m.progress + '%' : '') + ' · ' + when(m.started) + '</summary>'
      + '<div class="mono" style="font-size:12.5px;white-space:pre-wrap;margin-top:6px">' + esc((m.steps || []).map(x => x.at.slice(11, 19) + '  ' + x.text).join('\n')) + '</div></details>';
    h += '</div>';
  }
  // this server (needed on both ends)
  h += '<details class="upd-card" style="margin-top:14px"' + (s.url && s.accessClientId ? '' : '') + '><summary style="cursor:pointer"><b>Advanced</b> <span class="dim">— this server\'s name, panel URL (' + esc(s.url || 'set automatically') + ') and Cloudflare Access service token</span></summary><div class="row2" style="margin-top:8px">'
    + stField('Name', '<input id="trName" value="' + esc(s.name) + '">')
    + stField('Panel URL', '<input id="trUrl" value="' + esc(s.url) + '" placeholder="https://' + esc(location.host) + location.pathname.replace(/[^/]*$/, '') + '">', 'how the other server reaches this panel') + '</div>'
    + '<p class="dim" style="margin:6px 0;font-size:14px">The panel is behind Cloudflare Access, so the other server needs a service token to reach it: Cloudflare Zero Trust → Access → <b>Service auth</b> → create a token, and add a policy with action <b>Service Auth</b> for it to this panel\'s Access application. Only needed on the server that <b>receives</b> (it is handed over inside the transfer code).</p><div class="row2">'
    + stField('Access client ID', '<input id="trAid" value="' + esc(s.accessClientId) + '" placeholder="xxxx.access">')
    + stField('Access client secret', '<input id="trAsec" type="password" autocomplete="new-password" placeholder="' + (s.hasAccessSecret ? '•••••••• (stored — leave empty to keep)' : 'secret') + '">') + '</div>'
    + '<div class="site-actions"><button class="btn" onclick="trSaveSelf()">Save</button></div></details>';
  view.innerHTML = h;
}
async function trSaveSelf(){
  const g = (id) => document.getElementById(id).value;
  const body = { name: g('trName'), url: g('trUrl'), accessClientId: g('trAid') };
  if (g('trAsec')) body.accessClientSecret = g('trAsec');
  try { await stApi('PUT', 'api/cluster/self', body); toast('Saved', 'success'); trData = null; loadTransfer(); } catch(e){ stErr(e, 'Transfer'); }
}
// The panel URL is where this browser has the panel open (https://host/<prefix>/) — set it on first use.
async function trEnsureUrl(){
  if (trData && trData.self && trData.self.url) return;
  const url = location.origin + location.pathname.replace(/[^/]*$/, '');
  await stApi('PUT', 'api/cluster/self', { url });
  if (trData && trData.self) trData.self.url = url;
}
async function trMakeEndpoint(btn){
  if (btn) btn.disabled = true; toast('Creating the transfer address…');
  try { const r = await stApi('POST', 'api/cluster/endpoint'); toast('Transfer address ready: ' + r.url, 'success', { detail: r.steps.join('\n'), duration: 12000 }); trData = null; loadTransfer(); }
  catch(e){ stErr(e, 'Transfer address'); if (btn) btn.disabled = false; }
}
async function trMakeCode(btn){
  if (btn) btn.disabled = true;
  try { await trEnsureUrl(); trCode = await stApi('POST', 'api/cluster/join-code'); toast('Transfer code created — paste it on the source server', 'success'); loadTransfer(); }
  catch(e){ stErr(e, 'Transfer code'); if (btn) btn.disabled = false; }
}
async function trConnect(btn){
  btn.disabled = true;
  try { await trEnsureUrl(); const r = await stApi('POST', 'api/cluster/join-with', { code: document.getElementById('trJoin').value.trim() }); toast('Connected to ' + r.joined, 'success'); trData = null; loadTransfer(); }
  catch(e){ stErr(e, 'Connect'); btn.disabled = false; }
}
async function trForget(id){ try { await stApi('DELETE', 'api/cluster/peers/' + id); toast('Connection closed', 'success'); loadTransfer(); } catch(e){ stErr(e, 'Close'); } }
async function trMove(btn){
  const domains = [...document.querySelectorAll('.trSite:checked')].map(x => x.value);
  if (!domains.length) return toast('Tick at least one site', 'warn');
  btn.disabled = true;
  try { await stApi('POST', 'api/cluster/move', { domains, peer: document.getElementById('trPeer').value }); toast('Transfer of ' + domains.length + ' site(s) started', 'success'); loadTransfer(); }
  catch(e){ stErr(e, 'Move'); btn.disabled = false; }
}
