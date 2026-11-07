// ---- Transfer: move sites from this server to another SB SRV Manager (or receive them). Not
// clustering: the connection is made with a one-time transfer code and forgotten afterwards.
let trData = null, trLoading = false, trCode = null, trPoll = null;
async function loadTransfer(){
  trLoading = true;
  try { trData = await stApi('GET', 'api/cluster'); } catch(e){ trData = { error: e.message }; }
  trLoading = false;
  if (state.tab === 'transfer') renderTransfer(true);
  const busy = trData && ((trData.moves || []).some(m => m.state === 'running' || m.state === 'queued' || m.state === 'imported') || (trData.incoming || []).some(r => r.state === 'pending' || r.state === 'accepted'));
  clearTimeout(trPoll); if (busy) trPoll = setTimeout(loadTransfer, 2000);
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
  // incoming requests (this server as target) — need a decision
  const inc = trData.incoming || [];
  const pend = inc.filter(r => r.state === 'pending');
  if (inc.length) {
    h = '<div class="upd-card" style="margin-bottom:14px;border-top:3px solid ' + (pend.length ? 'var(--md-warning)' : 'var(--clp-border)') + '"><h3>📥 Incoming transfers' + (pend.length ? ' — ' + pend.length + ' waiting for you' : '') + '</h3><table class="upd-table"><tr><th>Site</th><th>From</th><th>Details</th><th></th></tr>'
      + inc.map(r => '<tr><td><b>' + esc(r.domain) + '</b></td><td>' + esc(r.from) + '</td><td class="dim" style="font-size:13.5px">' + esc(r.type) + (r.php ? ' · PHP ' + esc(r.php) : '') + (r.viaDns ? ' · DNS will be switched to this server' : ' · its tunnel moves here') + '<br>' + esc(new Date(r.at).toLocaleString()) + '</td>'
        + '<td style="text-align:right;white-space:nowrap">' + (r.state === 'pending' ? '<button class="btn small" onclick="armConfirm(this, \'Reject?\', () => trDecide(\'' + r.id + '\', \'reject\'))">Reject</button> <button class="btn small pri" onclick="trDecide(\'' + r.id + '\', \'accept\', this)">Accept</button>' : '<span class="upd-badge ' + (r.state === 'accepted' ? 'ok' : 'na') + '">' + esc(r.state) + (r.decidedBy ? ' by ' + esc(r.decidedBy) : '') + '</span>') + '</td></tr>').join('')
      + '</table></div>' + h;
  }
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
      + '<div style="margin:6px 0">' + (sites.length ? '<table class="upd-table"><tr><th style="width:24px"><input type="checkbox" onchange="document.querySelectorAll(\'.trSite\').forEach(x => { x.checked = this.checked; if (this.checked) trSel.add(x.value); else trSel.delete(x.value); }); renderTransfer(true)"></th><th>Site</th><th>Readiness on the target</th></tr>' + sites.map(d => { const c = trCheck && trCheck.sites.find(x => x.domain === d); return '<tr><td><input type="checkbox" class="trSite" value="' + esc(d) + '"' + (trSel.has(d) ? ' checked' : '') + ' onchange="trSelToggle(this)"></td><td><b>' + esc(d) + '</b>' + (c && c.type ? '<br><span class="dim" style="font-size:12.5px">' + esc(c.type) + (c.php ? ' · PHP ' + esc(c.php) : '') + (c.databases ? ' · ' + c.databases + ' DB' : '') + (c.viaDns ? ' · DNS switches to the target' : ' · tunnel moves') + '</span>' : '') + '</td><td style="font-size:13.5px">' + (!c ? '<span class="dim">not checked</span>' : c.ok ? '<span style="color:var(--md-success, #2e7d32)">✅ ready</span>' + (c.notes || []).map(n => '<div class="dim">ℹ ' + esc(n) + '</div>').join('') : c.problems.map(p => '<div style="color:var(--md-error-bright)">✗ ' + esc(p) + '</div>').join('') + (c.notes || []).map(n => '<div class="dim">ℹ ' + esc(n) + '</div>').join('')) + '</td></tr>'; }).join('') + '</table>' : '<span class="dim">No sites on this server to send.</span>') + '</div>'
      + '<p class="dim" style="font-size:13.5px;margin:4px 0">Each site moves with its files, databases, settings, secrets, SSH users and GitHub link; the target rebuilds and starts it, then takes over its tunnel or DNS. The copy here is stopped and kept. <b>Check readiness</b> first — Move unlocks for sites that are ready.</p>'
      + '<div class="site-actions" style="justify-content:space-between"><button class="btn" onclick="armConfirm(this, \'Close it?\', () => trForget(\'' + esc(peers[0].id) + '\'))">Close connection</button><span style="display:flex;gap:8px"><button class="btn" onclick="trPrecheck(this)">🔍 Check readiness</button><button class="btn pri" ' + (trReadySelected() ? '' : 'disabled title="check the selected sites first — only ready sites can move" ') + 'onclick="armConfirm(this, \'Move the checked sites now?\', () => trMove(this))">Move selected</button></span></div>';
  }
  h += '</div></div>';
  // history
  if ((trData.moves || []).length) {
    h += '<div class="upd-card" style="margin-top:14px"><h3>Transfers</h3>';
    for (const m of trData.moves) h += trProgressHtml(m);
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
// One transfer: bar, phase chips, elapsed time, the step log (open while it runs).
const TR_PHASES_SRC = [['approval', 'Target accepts'], ['preflight', 'Preflight'], ['pack', 'Pack'], ['upload', 'Upload'], ['import', 'Import on target'], ['cutover', 'Switch tunnel'], ['done', 'Done']];
const TR_PHASES_DST = [['receive', 'Receive'], ['decrypt', 'Decrypt'], ['restore', 'Restore & start'], ['wait-cutover', 'Take over tunnel'], ['done', 'Done']];
function trProgressHtml(m){
  const live = m.state === 'running' || m.state === 'queued' || m.state === 'imported';
  const failed = m.state === 'failed', done = m.state === 'done' || m.state === 'live';
  const pct = done ? 100 : (m.progress || 0);
  const secs = Math.round(((m.finished ? new Date(m.finished) : new Date()) - new Date(m.started)) / 1000);
  const el = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
  const phases = m.role === 'source' ? TR_PHASES_SRC : TR_PHASES_DST;
  const cur = phases.findIndex(([k]) => k === (done ? 'done' : m.phase));
  const chips = phases.map(([k, l], i) => '<span style="margin-right:10px;white-space:nowrap">' + (done || i < cur ? '✅' : i === cur ? (failed ? '❌' : '⏳') : '·') + ' ' + esc(l) + '</span>').join('');
  const color = failed ? 'var(--md-error-bright)' : done ? 'var(--md-success, #2e7d32)' : 'var(--md-primary)';
  return '<div style="border:1px solid var(--clp-border);border-radius:8px;padding:10px 12px;margin-top:10px">'
    + '<div style="display:flex;justify-content:space-between;gap:8px"><b>' + esc(m.domain || '…') + ' ' + (m.role === 'source' ? '→ ' + esc((m.peer || {}).name || '') : '← ' + esc(m.from || 'source')) + '</b><span class="dim mono">' + el + '</span></div>'
    + '<div style="height:10px;background:var(--clp-border);border-radius:5px;overflow:hidden;margin:8px 0 6px"><div style="height:100%;width:' + pct + '%;background:' + color + ';transition:width .6s"></div></div>'
    + '<div style="font-size:13.5px;margin-bottom:4px"><b>' + pct + '%</b> · ' + esc(failed ? 'FAILED — ' + (m.error || '') : done ? (m.role === 'source' ? 'done — the site runs on ' + ((m.peer || {}).name || 'the target') : 'done — the site runs here') : m.state === 'queued' ? 'waiting for the move before it' : (m.detail || m.phase || 'working')) + '</div>'
    + '<div style="font-size:13px">' + chips + '</div>'
    + '<details' + (live || failed ? ' open' : '') + ' style="margin-top:6px"><summary class="dim" style="cursor:pointer;font-size:13px">Log (' + (m.steps || []).length + ' steps)</summary><div class="mono" style="font-size:12px;white-space:pre-wrap;margin-top:4px;max-height:220px;overflow:auto">'
    + esc((m.steps || []).map(x => x.at.slice(11, 19) + '  ' + x.text).concat(m.remote && live ? (m.remote.steps || []).map(x => '        ' + x.text) : []).join('\n')) + '</div></details></div>';
}
async function trDecide(id, decision, btn){
  if (btn) btn.disabled = true;
  try { const r = await stApi('POST', 'api/cluster/requests/' + id + '/' + decision); toast((decision === 'accept' ? 'Accepted ' : 'Rejected ') + r.domain + (decision === 'accept' ? ' — the source starts sending it now' : ''), decision === 'accept' ? 'success' : 'warn'); loadTransfer(); }
  catch(e){ stErr(e, 'Transfer'); if (btn) btn.disabled = false; }
}
let trCheck = null; const trSel = new Set();
function trSelToggle(el){ if (el.checked) trSel.add(el.value); else trSel.delete(el.value); renderTransfer(true); }
// Move unlocks only when every selected site was checked and is ready
function trReadySelected(){ if (!trCheck || !trSel.size) return false; return [...trSel].every(d => { const c = trCheck.sites.find(x => x.domain === d); return c && c.ok; }); }
async function trPrecheck(btn){
  const domains = [...document.querySelectorAll('.trSite:checked')].map(x => x.value);
  if (!domains.length) return toast('Tick the sites to check', 'warn');
  domains.forEach(d => trSel.add(d));
  btn.disabled = true; btn.textContent = '⏳ Checking…';
  try { trCheck = await stApi('POST', 'api/cluster/precheck', { domains, peer: document.getElementById('trPeer').value });
    const ok = trCheck.sites.filter(s => s.ok).length;
    toast(ok + ' of ' + trCheck.sites.length + ' ready on ' + trCheck.target, ok === trCheck.sites.length ? 'success' : 'warn'); }
  catch(e){ stErr(e, 'Check'); }
  renderTransfer(true);
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
  const domains = [...document.querySelectorAll('.trSite:checked')].map(x => x.value).filter(d => { const c = trCheck && trCheck.sites.find(x => x.domain === d); return c && c.ok; });
  if (!domains.length) return toast('Check readiness first — only ready sites can move', 'warn');
  btn.disabled = true;
  try { await stApi('POST', 'api/cluster/move', { domains, peer: document.getElementById('trPeer').value }); toast('Transfer of ' + domains.length + ' site(s) started', 'success'); loadTransfer(); }
  catch(e){ stErr(e, 'Move'); btn.disabled = false; }
}
