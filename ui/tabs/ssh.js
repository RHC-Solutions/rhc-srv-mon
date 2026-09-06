/* ================================================================ SSH tab */
let sshData = null;                 // last /api/ssh payload
const sshSess = new Map();          // tabId -> { id, hostId, label, term, fit, ws, el, status, host, user, port }
let sshActive = null;
let sshLibPromise = null;
let sshPollTimer = null;
let sshTabSeq = 0;
const sshEnc = new TextEncoder();

function sshLoadLib(){
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (sshLibPromise) return sshLibPromise;
  const base = 'https://cdn.jsdelivr.net/npm/@xterm/';
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'xterm@5.5.0/css/xterm.min.css'; document.head.appendChild(css);
  const load = (src) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => bad(new Error('failed to load ' + src)); document.head.appendChild(s); });
  sshLibPromise = load(base + 'xterm@5.5.0/lib/xterm.min.js')
    .then(() => Promise.all([load(base + 'addon-fit@0.10.0/lib/addon-fit.min.js'), load(base + 'addon-web-links@0.11.0/lib/addon-web-links.min.js')]))
    .catch((e) => { sshLibPromise = null; throw e; });
  return sshLibPromise;
}

async function renderSsh(){
  try { sshData = await fetch('api/ssh').then(r => r.json()); } catch(e){ return; }
  document.getElementById('host').textContent = '';
  showBanner(null); setStatus([]);
  document.getElementById('updated').textContent = sshData.hosts.length + ' host' + (sshData.hosts.length===1?'':'s') + ' · ' + (sshData.sessions||[]).length + ' running session' + ((sshData.sessions||[]).length===1?'':'s') + ' · sessions survive refresh and restarts, close them with ×';
  sshRenderHosts();
  sshRenderInstalls();
  sshAdoptServerSessions();
  const src = sshData.source || {};
  document.getElementById('ssh-side-ft').innerHTML = 'source: <b>' + esc(src.host || '') + '</b> · node ' + esc(src.node || '') + (src.git ? ' · ' + esc(src.git) : '')
    + '<br>' + sshData.hosts.length + ' host' + (sshData.hosts.length===1?'':'s') + ' · ' + (sshData.sessions||[]).length + ' running session' + ((sshData.sessions||[]).length===1?'':'s') + ((sshData.sessions||[]).some(x => !x.attached) ? ' (' + (sshData.sessions||[]).filter(x => !x.attached).length + ' detached)' : '')
    + (sshData.helperOk ? '' : '<br><span style="color:#ff8088">⚠ pty helper missing</span>');
  if (sshSess.size) sshRenderTabs();
  const running = (sshData.installs||[]).some(j => j.status === 'running');
  if (running && !sshPollTimer) sshPollTimer = setInterval(() => { if (state.tab === 'ssh') renderSsh(); }, 2000);
  if (!running && sshPollTimer) { clearInterval(sshPollTimer); sshPollTimer = null; }
}

function sshRenderHosts(){
  const box = document.getElementById('ssh-hostlist'); if (!box || !sshData) return;
  const q = (document.getElementById('ssh-q').value || '').toLowerCase();
  const openHosts = new Set([...sshSess.values()].filter(s => s.status === 'open').map(s => s.hostId));
  let hosts = sshData.hosts.slice().sort((a,b) => (a.group||'').localeCompare(b.group||'') || (a.name||'').localeCompare(b.name||''));
  if (q) hosts = hosts.filter(h => ((h.name||'') + ' ' + (h.host||'') + ' ' + (h.user||'') + ' ' + (h.group||'') + ' ' + (h.notes||'')).toLowerCase().includes(q));
  if (!hosts.length) { box.innerHTML = '<div class="ssh-grp" style="padding-top:16px">' + (sshData.hosts.length ? 'no match' : 'no hosts yet — add one ↑') + '</div>'; return; }
  let html = '', lastGrp = null;
  for (const h of hosts) {
    const g = h.group || 'Ungrouped';
    if (g !== lastGrp) { html += '<div class="ssh-grp">' + esc(g) + '</div>'; lastGrp = g; }
    html += '<div class="ssh-host" onclick="sshConnect(\'' + h.id + '\')" title="' + esc((h.user||'root') + '@' + h.host + ':' + (h.port||22) + (h.notes ? ' — ' + h.notes : '')) + '">'
      + '<span class="dot' + (openHosts.has(h.id) ? ' on' : '') + '"' + (h.color ? ' style="background:' + esc(h.color) + '"' : '') + '></span>'
      + '<span class="nm">' + ((h.protocol||'ssh') === 'vnc' ? '🖵 ' : (h.protocol||'ssh') === 'rdp' ? '🪟 ' : '') + esc(h.name) + '<small>' + ((h.protocol||'ssh') === 'vnc' ? 'vnc ' + esc(String(h.vncHost||'127.0.0.1')) + ':' + (h.vncPort||5901) + ' · via ' : (h.protocol||'ssh') === 'rdp' ? 'rdp ' + esc(String(h.rdpHost||h.host)) + ':' + (h.rdpPort||3389) + ' · ' : '') + esc((h.user||'root') + '@' + h.host) + (h.port && h.port != 22 ? ':' + h.port : '') + (h.auth === 'password' ? ' · pw' : '') + (h.becomeRoot && (h.user||'root') !== 'root' ? ' · sudo -i' : '') + '</small></span>'
      + (h.monitor ? '<span class="mon" title="rhc-srv-mon installed ' + esc(h.monitor.installedAt||'') + ' (port ' + h.monitor.port + ')">📊</span>' : '')
      + '<span class="acts">'
      + '<button title="Who is logged in on this host" onclick="event.stopPropagation();sshSessionsDialog(\'' + h.id + '\')">👥</button>'
      + '<button title="Install rhc-srv-mon on this host" onclick="event.stopPropagation();sshInstallDialog(\'' + h.id + '\')">📦</button>'
      + '<button title="Edit" onclick="event.stopPropagation();sshEditHost(\'' + h.id + '\')">✎</button>'
      + '</span></div>';
  }
  box.innerHTML = html;
}

/* ---- terminal tabs ---- */
function sshRenderTabs(){
  const bar = document.getElementById('ssh-tabbar'); if (!bar) return;
  let html = '';
  for (const s of sshSess.values()) {
    html += '<div class="ssh-tab' + (s.id === sshActive ? ' active' : '') + (sshLayout() > 1 && sshPanes.includes(s.id) ? ' shown' : '') + '" data-id="' + s.id + '" onclick="sshActivate(\'' + s.id + '\')" onauxclick="if(event.button===1){event.preventDefault();sshCloseTab(\'' + s.id + '\')}" ondblclick="sshRenameTab(\'' + s.id + '\')" title="' + esc(s.target || '') + '">'
      + '<span class="st ' + s.status + '"></span><span class="tt">' + esc(s.label) + '</span>'
      + '<button class="x" title="Close tab" onclick="event.stopPropagation();sshCloseTab(\'' + s.id + '\')">×</button></div>';
  }
  html += '<div class="ssh-tab plus" title="Ad-hoc connection (user@host)" onclick="sshAdhocDialog()">＋</div><div class="sp"></div>';
  const lay = sshLayout();
  html += '<div class="tools">' + (sshSess.size ? '<button onclick="sshDuplicateTab()" title="Open another tab to the same host">⧉ Duplicate</button><button onclick="sshCloseAll()" title="Close all tabs (ends the sessions)">Close all</button>' : '')
    + [[1,'▭','Single terminal (tabs)'],[2,'▭▭','2 side by side'],[3,'▭▭▭','3 side by side'],[4,'⊞','2 × 2 grid']].map(([n,ic,tt]) => '<button class="lay' + (lay===n?' on':'') + '" title="' + tt + '" onclick="sshSetLayout(' + n + ')">' + ic + '</button>').join('')
    + '<button onclick="sshSettingsDialog()" title="Terminal settings: font, size, colors, keys">⚙</button></div>';
  bar.innerHTML = html;
  document.getElementById('ssh-empty').style.display = sshSess.size ? 'none' : '';
}
/* ---- split layouts: sshPanes[i] = session id shown in pane i (layout 1 = classic tabs) ---- */
let sshPanes = [], sshFocusPane = 0;
function sshLayout(){ if (window.innerWidth < 820) return 1; try { const n = parseInt(localStorage.getItem('rhc-ssh-layout') || '1'); return [1,2,3,4].includes(n) ? n : 1; } catch(e){ return 1; } }
let sshResizeT = null;
window.addEventListener('resize', () => { clearTimeout(sshResizeT); sshResizeT = setTimeout(() => { if (sshSess.size) { sshRenderPanes(); sshRenderTabs(); } }, 150); });
function sshSideToggle(){ const s = document.querySelector('.ssh-side'); if (s && window.innerWidth < 820) s.classList.toggle('collapsed'); }
function sshSetLayout(n){
  try { localStorage.setItem('rhc-ssh-layout', String(n)); } catch(e){}
  const ids = [...sshSess.keys()];
  const order = [sshActive, ...sshPanes, ...ids].filter((v, i, a) => v && sshSess.has(v) && a.indexOf(v) === i);
  sshPanes = order.slice(0, n); while (sshPanes.length < n) sshPanes.push(null);
  sshFocusPane = Math.max(0, sshPanes.indexOf(sshActive));
  sshRenderPanes(); sshRenderTabs();
}
function sshRenderPanes(){
  const n = sshLayout(), box = document.getElementById('ssh-terms');
  box.className = 'ssh-terms' + (n > 1 ? ' multi layout-' + n : '');
  box.querySelectorAll('.ssh-empty-pane').forEach(e => e.remove());
  if (n === 1) {
    for (const s of sshSess.values()) { s.el.classList.toggle('active', s.id === sshActive); s.el.classList.remove('shown', 'focused'); s.el.style.order = ''; }
  } else {
    if (sshPanes.length !== n) sshSetLayout(n);
    for (const s of sshSess.values()) {
      const i = sshPanes.indexOf(s.id);
      s.el.classList.remove('active'); s.el.classList.toggle('shown', i >= 0); s.el.classList.toggle('focused', i >= 0 && i === sshFocusPane);
      s.el.style.order = i >= 0 ? String(i) : '';
    }
    sshPanes.forEach((id, i) => { if (!id || !sshSess.has(id)) { const e = document.createElement('div'); e.className = 'ssh-empty-pane'; e.style.order = String(i); e.textContent = 'empty pane ' + (i + 1) + ' — click here, then a host on the left'; e.onclick = () => { sshFocusPane = i; sshRenderPanes(); }; if (i === sshFocusPane) e.style.borderColor = '#5cdd8b'; box.appendChild(e); } });
  }
  document.getElementById('ssh-empty').style.display = sshSess.size ? 'none' : '';
  requestAnimationFrame(() => { for (const s of sshSess.values()) if (s.el.classList.contains('active') || s.el.classList.contains('shown')) { try { if (s.kind !== 'vnc') s.fit.fit(); } catch(e){} } });
}
function sshActivate(id, opts){
  opts = opts || {};
  sshActive = id;
  const n = sshLayout();
  if (n > 1) {
    if (sshPanes.length !== n) { sshPanes = sshPanes.slice(0, n); while (sshPanes.length < n) sshPanes.push(null); }
    let i = sshPanes.indexOf(id);
    if (i < 0) { i = sshPanes.indexOf(null); if (i < 0 || opts.replaceFocused) i = sshFocusPane; sshPanes[i] = id; }
    sshFocusPane = i;
  }
  sshRenderPanes(); sshRenderTabs();
  const s = sshSess.get(id);
  if (s && !opts.noFocus) requestAnimationFrame(() => { try { if (s.kind === 'vnc') s.rfb && s.rfb.focus(); else { s.fit.fit(); s.term.focus(); } } catch(e){} });
}
function sshPaneSolo(id){ sshSetLayout(1); sshActivate(id); }
function sshRenameTab(id){
  const s = sshSess.get(id); if (!s) return;
  const n = prompt('Tab name', s.label); if (n && n.trim()) { s.label = n.trim().slice(0, 60); const b = s.el.querySelector('.pane-hd .pl'); if (b) b.textContent = s.label; sshRenderTabs(); }
}
function sshDuplicateTab(){ const s = sshSess.get(sshActive); if (!s) return; if (s.hostId) sshConnect(s.hostId); else sshConnectAdhoc(s.adhoc); }
function sshCloseAll(){ for (const id of [...sshSess.keys()]) sshCloseTab(id); }
function sshCloseTab(id){
  const s = sshSess.get(id); if (!s) return;
  if (s.kind === 'vnc') {                      // a VNC viewer has no server-side session; an RDP one does
    s.status = 'dead';
    try { s.rfb && s.rfb.disconnect(); } catch(e){}
    if (s.rdpDisplay) fetch('api/ssh/rdp/' + s.rdpDisplay, { method:'DELETE' }).catch(() => {});
    s.el.remove(); sshSess.delete(id);
    const pv = sshPanes.indexOf(id); if (pv >= 0) { const hidden = [...sshSess.keys()].find(k => !sshPanes.includes(k)); sshPanes[pv] = hidden || null; }
    if (sshActive === id) { const rest = sshPanes.filter(Boolean).concat([...sshSess.keys()]); sshActive = rest.length ? rest[0] : null; }
    if (sshActive) sshActivate(sshActive); else sshRenderPanes();
    sshRenderTabs(); sshRenderHosts();
    return;
  }
  const wasLive = s.status !== 'dead' && !s.superseded;
  s.status = 'dead'; clearTimeout(s.retryTimer);
  // × ends the session on the server (a refresh / closed browser only detaches it)
  try { if (wasLive && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t:'close' })); else if (wasLive && s.sid) fetch('api/ssh/sessions/' + encodeURIComponent(s.sid), { method:'DELETE' }).catch(() => {}); } catch(e){}
  try { if (s.ws && s.ws.readyState <= 1) setTimeout(() => { try { s.ws.close(); } catch(e){} }, 150); } catch(e){}
  try { s.term.dispose(); } catch(e){}
  s.el.remove(); sshSess.delete(id);
  const pi = sshPanes.indexOf(id); if (pi >= 0) { const hidden = [...sshSess.keys()].find(k => !sshPanes.includes(k)); sshPanes[pi] = hidden || null; }
  if (sshActive === id) { const rest = sshPanes.filter(Boolean).concat([...sshSess.keys()]); sshActive = rest.length ? rest[0] : null; }
  if (sshActive) sshActivate(sshActive); else sshRenderPanes();
  sshRenderTabs(); sshRenderHosts();
}

async function sshConnect(hostId){
  const h = sshData && sshData.hosts.find(x => x.id === hostId); if (!h) return toast('Unknown host', 'error');
  if ((h.protocol || 'ssh') === 'vnc') return sshOpenVncTab(h);
  if ((h.protocol || 'ssh') === 'rdp') return sshOpenRdpTab(h);
  await sshOpenTab({ hostId, label: h.name, target: (h.user||'root') + '@' + h.host, query: 'id=' + encodeURIComponent(hostId) });
}
/* ---- VNC viewer (noVNC over the /ws/vnc bridge) ---- */
let novncPromise = null;
function sshLoadNoVnc(){
  if (window.__RFB) return Promise.resolve(window.__RFB);
  if (novncPromise) return novncPromise;
  novncPromise = import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.6.0/lib/rfb.js')
    .then((m) => { window.__RFB = m.default; return window.__RFB; })
    .catch((e) => { novncPromise = null; throw new Error('cannot load the VNC client library (' + e.message + ')'); });
  return novncPromise;
}
async function sshOpenVncTab(h){
  let RFB, cred;
  try { RFB = await sshLoadNoVnc(); } catch(e){ return toast(e.message, 'error', { duration: 9000 }); }
  try { cred = await siteApi('GET', 'api/ssh/hosts/' + h.id + '/vnc'); } catch(e){ return toast('VNC: ' + e.message, 'error'); }
  const id = 't' + (++sshTabSeq);
  const target = (cred.target.tunnel ? 'ssh → ' : '') + cred.target.host + ':' + cred.target.port;
  const el = document.createElement('div'); el.className = 'ssh-term vnc'; el.dataset.id = id;
  el.innerHTML = '<div class="pane-hd"><b class="pl">🖵 ' + esc(h.name) + '</b><span class="pt">' + esc(target) + '</span><span class="sp"></span>'
    + '<button title="Send Ctrl+Alt+Del" onclick="sshVncCad(\'' + id + '\')">⌨</button>'
    + '<button title="Fit / 1:1" onclick="sshVncScale(\'' + id + '\')">⤢</button>'
    + '<button title="Show only this pane" onclick="sshPaneSolo(\'' + id + '\')">▭</button>'
    + '<button title="Close viewer" onclick="sshCloseTab(\'' + id + '\')">×</button></div><div class="pane-body vnc-body"></div>';
  el.addEventListener('mousedown', () => { if (sshActive !== id) sshActivate(id, { noFocus: true }); }, true);
  document.getElementById('ssh-terms').appendChild(el);
  const s = { id, hostId: h.id, kind: 'vnc', label: h.name, target, el, rfb: null, status: 'connecting', fit: { fit(){} } };
  sshSess.set(id, s);
  if (window.innerWidth < 820) { const side = document.querySelector('.ssh-side'); if (side) side.classList.add('collapsed'); }
  sshActivate(id);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = proto + location.host + new URL('ws/vnc', location.href).pathname + '?id=' + encodeURIComponent(h.id);
  try {
    const rfb = new RFB(el.querySelector('.vnc-body'), url, { credentials: { password: cred.password || '' }, wsProtocols: ['binary'] });
    rfb.viewOnly = !!cred.viewOnly; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#0c0e16';
    rfb.addEventListener('connect', () => { s.status = 'open'; sshRenderTabs(); sshRenderHosts(); });
    rfb.addEventListener('disconnect', (e) => { s.status = 'dead'; sshRenderTabs(); sshVncNote(s, (e.detail && e.detail.clean) ? 'Disconnected.' : 'Connection lost — the VNC server may not be running, or the port is wrong.'); });
    rfb.addEventListener('credentialsrequired', () => { const pw = prompt('VNC password for ' + h.name); if (pw != null) rfb.sendCredentials({ password: pw }); else rfb.disconnect(); });
    rfb.addEventListener('securityfailure', (e) => sshVncNote(s, 'VNC authentication failed' + (e.detail && e.detail.reason ? ': ' + e.detail.reason : '') + ' — check the password in the host settings.'));
    s.rfb = rfb;
  } catch(e){ s.status = 'dead'; sshVncNote(s, 'Could not start the viewer: ' + e.message); }
  sshRenderTabs();
}
function sshVncNote(s, msg){
  const body = s.el.querySelector('.vnc-body'); if (!body) return;
  let bar = s.el.querySelector('.vnc-note');
  if (!bar) { bar = document.createElement('div'); bar.className = 'vnc-note'; s.el.appendChild(bar); }
  bar.innerHTML = esc(msg) + ' <button class="upd-test-btn" onclick="sshVncRetry(\'' + s.id + '\')">Reconnect</button>';
}
function sshVncRetry(id){
  const s = sshSess.get(id); if (!s) return;
  const h = sshData && sshData.hosts.find(x => x.id === s.hostId);
  sshCloseTab(id);
  if (h) sshOpenVncTab(h);
}
function sshVncCad(id){ const s = sshSess.get(id); if (s && s.rfb) { s.rfb.sendCtrlAltDel(); toast('Ctrl+Alt+Del sent', 'success'); } }
function sshVncScale(id){ const s = sshSess.get(id); if (s && s.rfb) { s.rfb.scaleViewport = !s.rfb.scaleViewport; toast(s.rfb.scaleViewport ? 'Scaled to fit' : '1:1 (scroll to pan)', 'info'); } }
async function sshConnectAdhoc(a){
  if (!a || !a.host) return;
  await sshOpenTab({ hostId: null, adhoc: a, label: (a.user||'root') + '@' + a.host, target: (a.user||'root') + '@' + a.host + ':' + (a.port||22), query: 'host=' + encodeURIComponent(a.host) + '&user=' + encodeURIComponent(a.user||'root') + '&port=' + encodeURIComponent(a.port||22) });
}
async function sshOpenTab(o){
  try { await sshLoadLib(); } catch(e){ return toast('Cannot load terminal library: ' + e.message, 'error'); }
  const id = 't' + (++sshTabSeq);
  const el = document.createElement('div'); el.className = 'ssh-term'; el.dataset.id = id;
  el.innerHTML = '<div class="pane-hd"><b class="pl">' + esc(o.label) + '</b><span class="pt">' + esc(o.target || '') + '</span><span class="sp"></span><button title="Show only this terminal" onclick="sshPaneSolo(\'' + id + '\')">⤢</button><button title="Close tab (ends the session)" onclick="sshCloseTab(\'' + id + '\')">×</button></div><div class="pane-body"></div>';
  el.addEventListener('mousedown', () => { if (sshActive !== id) sshActivate(id, { noFocus: true }); }, true);
  document.getElementById('ssh-terms').appendChild(el);
  const pref = sshPrefs();
  const term = new Terminal({ cursorBlink: !!pref.cursorBlink, cursorStyle: pref.cursorStyle, fontSize: pref.fontSize, fontFamily: pref.fontFamily, scrollback: 10000, allowProposedApi: true, rightClickSelectsWord: false, theme: sshThemeFor(pref) });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch(e){}
  term.open(el.querySelector('.pane-body'));
  const s = { id, hostId: o.hostId, adhoc: o.adhoc || null, label: o.label, target: o.target, term, fit, el, ws: null, status: 'connecting', sid: o.sid || null };
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); sshPasteText(s); });
  sshSess.set(id, s);
  if (window.innerWidth < 820) { const side = document.querySelector('.ssh-side'); if (side) side.classList.add('collapsed'); }
  sshActivate(id);
  try { fit.fit(); } catch(e){}
  sshWsConnect(s, o.query);
  term.onData(d => { if (s.ws && s.ws.readyState === 1) s.ws.send(sshEnc.encode(d)); });
  term.onBinary(d => { if (s.ws && s.ws.readyState === 1) { const b = new Uint8Array(d.length); for (let i=0;i<d.length;i++) b[i] = d.charCodeAt(i) & 255; s.ws.send(b); } });
  term.onResize(({cols, rows}) => { if (s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify({ t:'resize', cols, rows })); });
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown') return true;
    const k = (ev.key || '').toLowerCase(), ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
    // Windows style: Ctrl+C copies when text is selected (otherwise ^C goes to the remote), Ctrl+V pastes
    // (text, or a file/screenshot -> upload), Ctrl+Z is swallowed unless the Unix behaviour is chosen.
    if (ctrl && k === 'c') { const sel = term.getSelection(); if (sel || ev.shiftKey) { if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {}); term.clearSelection(); return false; } return true; }
    if (ctrl && k === 'insert') { const sel = term.getSelection(); if (sel && navigator.clipboard) navigator.clipboard.writeText(sel).catch(() => {}); return false; }
    if (ctrl && k === 'v') return false;                                   // let the browser paste -> xterm gets text, our paste handler gets files
    if (!ev.ctrlKey && ev.shiftKey && k === 'insert') { sshPasteText(s); return false; }
    if (ctrl && !ev.shiftKey && k === 'z' && sshPrefs().ctrlZ !== 'suspend') return false;
    if (ctrl && ev.shiftKey && k === 'w') { sshCloseTab(s.id); return false; }
    return true;
  });
}
function sshWsConnect(s, query){
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const base = new URL('ws/ssh', location.href).pathname;
  const cols = s.term.cols || 120, rows = s.term.rows || 32;
  const ws = new WebSocket(proto + location.host + base + '?' + query + '&cols=' + cols + '&rows=' + rows);
  ws.binaryType = 'arraybuffer';
  s.ws = ws; s.status = 'connecting'; sshRenderTabs();
  const dead = s.el.querySelector('.ssh-deadbar'); if (dead) dead.remove();
  ws.onopen = () => { s.status = 'open'; s.retry = 0; sshRenderTabs(); sshRenderHosts(); try { s.fit.fit(); ws.send(JSON.stringify({ t:'resize', cols: s.term.cols, rows: s.term.rows })); } catch(e){} };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      let m = null; try { m = JSON.parse(ev.data); } catch(e){ return; }
      if (m.t === 'hello') { s.sid = m.id; s.target = m.target || s.target; if (m.reattach) s.replaying = true; }
      else if (m.t === 'superseded') { s.superseded = true; sshSessionEnded(s, null, 'this session was taken over by another browser window'); }
      else if (m.t === 'replayed') { s.replaying = false; try { s.fit.fit(); ws.send(JSON.stringify({ t:'resize', cols: s.term.cols, rows: s.term.rows })); } catch(e){} }
      else if (m.t === 'hb') { try { ws.send('{"t":"hb"}'); } catch(e){} }
      else if (m.t === 'note') { try { s.term.write('\r\n\x1b[90m── ' + m.msg + ' ──\x1b[0m\r\n'); } catch(e){} }
      else if (m.t === 'exit') { s.exited = true; sshSessionEnded(s, m.code, m.error); }
      return;
    }
    s.term.write(new Uint8Array(ev.data));
  };
  ws.onerror = () => {};
  ws.onclose = (ev) => {
    if (s.ws !== ws || s.status === 'dead') return;
    // Abnormal close (1006: Cloudflare/proxy cut, laptop sleep, wifi change) and we know our
    // server-side session id -> the pty is still alive on the server; re-attach to it.
    if (!ev.wasClean && s.sid) return sshLostTransport(s, ev.code);
    if (!s.sid && ev.code === 1006) return sshDiagnoseHandshake(s, query, ev.code);
    sshSessionEnded(s, null, ev.code === 1006 ? 'connection lost (WebSocket ' + ev.code + ')' : null);
  };
}
// The WebSocket never opened (no 'hello'): ask the same URL over plain HTTP so the server can
// tell us why (proxy not forwarding the upgrade, unknown host, session expired, …).
async function sshDiagnoseHandshake(s, query, code){
  let why = 'connection failed (WebSocket ' + code + ')';
  try {
    const r = await fetch(new URL('ws/ssh', location.href).pathname + '?' + query, { cache: 'no-store', headers: { 'X-Diag': '1' } });
    if (r.status === 401) { location.reload(); return; }
    const j = await r.json().catch(() => null);
    if (j && j.error && r.status !== 200) why += ' — ' + j.error;
    else if (r.status === 200) why += ' — the server is reachable but the WebSocket upgrade did not get through (proxy / Cloudflare in between?)';
  } catch(e){ why += ' — server unreachable (' + e.message + ')'; }
  sshSessionEnded(s, null, why);
}
function sshPasteText(s){
  if (!navigator.clipboard || !navigator.clipboard.readText) return toast('Clipboard access needs https', 'error');
  navigator.clipboard.readText().then(t => { if (t && s.ws && s.ws.readyState === 1) s.ws.send(sshEnc.encode(t)); }).catch(() => {});
}
function sshLostTransport(s, code){
  s.status = 'reconnecting'; s.retry = (s.retry || 0) + 1; sshRenderTabs(); sshRenderHosts();
  if (s.retry === 1) { try { s.term.write('\r\n\x1b[33m── connection lost (WebSocket ' + code + ') — reconnecting… ──\x1b[0m\r\n'); } catch(e){} }
  const delay = Math.min(15000, 500 * Math.pow(2, s.retry - 1));   // 0.5s, 1s, 2s … 15s (≈10 min total, matches the server grace period)
  clearTimeout(s.retryTimer);
  s.retryTimer = setTimeout(() => sshTryReattach(s, code), delay);
}
async function sshTryReattach(s, code){
  if (s.status !== 'reconnecting') return;
  if (navigator.onLine === false) return sshLostTransport(s, code);
  let alive = null;
  try {
    const r = await fetch('api/ssh/sessions/' + encodeURIComponent(s.sid), { cache: 'no-store' });
    if (r.status === 401) { location.reload(); return; }
    alive = r.ok;
  } catch(e){ alive = null; }
  if (alive === false) return sshSessionEnded(s, null, 'connection lost (WebSocket ' + code + ') — the session expired on the server');
  if (alive === null) { if ((s.retry || 0) >= 45) return sshSessionEnded(s, null, 'connection lost (WebSocket ' + code + ') — server unreachable'); return sshLostTransport(s, code); }
  sshWsConnect(s, 'attach=' + encodeURIComponent(s.sid));
}
// Network back / tab visible again: don't wait for the backoff timer.
function sshRetryNow(){ for (const s of sshSess.values()) if (s.status === 'reconnecting') { clearTimeout(s.retryTimer); sshTryReattach(s, 1006); } }
window.addEventListener('online', sshRetryNow);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sshRetryNow(); });
function sshSessionEnded(s, code, error){
  if (s.status === 'dead') return;
  s.status = 'dead'; sshRenderTabs(); sshRenderHosts();
  const msg = error ? error : ('session closed' + (code != null ? ', exit code ' + code : ''));
  try { s.term.write('\r\n\x1b[90m── ' + msg + ' ──\x1b[0m\r\n'); } catch(e){}
  const bar = document.createElement('div'); bar.className = 'ssh-deadbar';
  bar.innerHTML = '<span>⏹ ' + esc(msg) + '</span><span style="flex:1"></span>' + (s.sid && !s.exited ? '<button class="re" onclick="sshReattach(\'' + s.id + '\')">↻ Re-attach</button>' : '') + '<button class="' + (s.sid && !s.exited ? '' : 're') + '" onclick="sshReconnect(\'' + s.id + '\')">' + (s.sid && !s.exited ? 'New session' : '↻ Reconnect') + '</button><button onclick="sshCloseTab(\'' + s.id + '\')">Close tab</button>';
  s.el.appendChild(bar);
}
function sshReattach(id){
  const s = sshSess.get(id); if (!s || !s.sid) return;
  const dead = s.el.querySelector('.ssh-deadbar'); if (dead) dead.remove();
  s.status = 'connecting'; s.exited = false; sshWsConnect(s, 'attach=' + encodeURIComponent(s.sid)); s.term.focus();
}
function sshReconnect(id){
  const s = sshSess.get(id); if (!s) return;
  clearTimeout(s.retryTimer); s.sid = null; s.retry = 0;
  s.term.reset();
  const q = s.hostId ? 'id=' + encodeURIComponent(s.hostId) : 'host=' + encodeURIComponent(s.adhoc.host) + '&user=' + encodeURIComponent(s.adhoc.user||'root') + '&port=' + encodeURIComponent(s.adhoc.port||22);
  sshWsConnect(s, q); s.term.focus();
}
// keep the active terminal sized to its pane
new ResizeObserver(() => { if (state.tab !== 'ssh') return; for (const s of sshSess.values()) if (s.el.classList.contains('active') || s.el.classList.contains('shown')) { try { s.fit.fit(); } catch(e){} } }).observe(document.getElementById('ssh-terms'));
// Re-open tabs for sessions that are still running on the server (after F5, a new browser, …).
const sshAdopting = new Set(); let sshAdoptedOnce = false;
async function sshAdoptServerSessions(){
  const list = (sshData && sshData.sessions) || [];
  const first = !sshAdoptedOnce; sshAdoptedOnce = true;
  const have = new Set([...sshSess.values()].map(s => s.sid).filter(Boolean));
  for (const srv of list) {
    // first render after a page load takes everything back (the previous page's sockets may still look
    // attached for a moment); later renders only pick up sessions nobody is attached to
    if (have.has(srv.id) || sshAdopting.has(srv.id) || (srv.attached && sshAdoptedOnce)) continue;
    sshAdopting.add(srv.id);
    try { await sshOpenTab({ hostId: srv.hostId, adhoc: srv.hostId ? null : sshAdhocFromTarget(srv.target), label: srv.label, target: srv.target, sid: srv.id, query: 'attach=' + encodeURIComponent(srv.id) }); } catch(e){}
    sshAdopting.delete(srv.id);
  }
}
function sshAdhocFromTarget(t){ const m = String(t||'').match(/^(.+)@([^:\s]+)(?::(\d+))?/); return m ? { user: m[1], host: m[2], port: m[3] ? parseInt(m[3]) : 22 } : null; }
// Files / images: drag & drop onto the terminal, or Ctrl+V with a file / screenshot in the clipboard.
(function(){
  const box = document.getElementById('ssh-terms'); if (!box) return;
  const hasFiles = (dt) => dt && dt.types && [...dt.types].includes('Files');
  box.addEventListener('dragover', (e) => { if (hasFiles(e.dataTransfer)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; box.classList.add('drop'); } });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('drop'); });
  box.addEventListener('drop', (e) => { box.classList.remove('drop'); if (!e.dataTransfer || !e.dataTransfer.files.length) return; e.preventDefault(); sshUploadFiles(sshSess.get(sshActive), [...e.dataTransfer.files]); });
  box.addEventListener('paste', (e) => { const cd = e.clipboardData; if (!cd || !cd.files || !cd.files.length) return; e.preventDefault(); e.stopPropagation(); sshUploadFiles(sshSess.get(sshActive), [...cd.files]); }, true);
})();
async function sshUploadFiles(s, files){
  if (!s || !s.sid || s.status !== 'open') return toast('No connected terminal to upload to', 'error');
  const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB';
  for (const f of files) {
    let name = f.name || '';
    if (!name || /^image\.(png|jpe?g|gif|webp)$/i.test(name)) { const d = new Date(), pad = (x) => String(x).padStart(2, '0'); name = 'paste-' + d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.' + (((f.type||'').split('/')[1] || 'bin').replace('jpeg','jpg')); }
    toast('Uploading ' + name + ' (' + mb(f.size) + ') to ' + s.target + '…', 'success');
    try {
      const r = await fetch('api/ssh/sessions/' + encodeURIComponent(s.sid) + '/upload?name=' + encodeURIComponent(name), { method:'POST', headers:{ 'Content-Type':'application/octet-stream' }, body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) { toast('Upload failed: ' + (j.error || r.status), 'error'); continue; }
      const quoted = /[\s'"()\[\]&;$\x60\\]/.test(j.path) ? "'" + j.path.replace(/'/g, "'\\''") + "'" : j.path;
      if (s.ws && s.ws.readyState === 1) s.ws.send(sshEnc.encode(quoted + ' '));
      toast('Uploaded → ' + j.path, 'success');
    } catch(e){ toast('Upload failed: ' + e.message, 'error'); }
  }
}
/* ---- terminal appearance / key preferences (per browser, localStorage) ---- */
const SSH_PREF_KEY = 'rhc-ssh-term-prefs';
const SSH_THEMES = {
  dark:      { name:'RHC dark', background:'#0c0e16', foreground:'#e9e9e9', cursor:'#5cdd8b', selectionBackground:'#2a2f40', black:'#1e2230', brightBlack:'#6b7280', green:'#5cdd8b', yellow:'#f8a306', red:'#ff8088', blue:'#7aa2f7', magenta:'#c678dd', cyan:'#56b6c2' },
  putty:     { name:'PuTTY classic', background:'#000000', foreground:'#bbbbbb', cursor:'#00ff00', selectionBackground:'#444444', black:'#000000', red:'#bb0000', green:'#00bb00', yellow:'#bbbb00', blue:'#0000bb', magenta:'#bb00bb', cyan:'#00bbbb', white:'#bbbbbb', brightBlack:'#555555', brightBlue:'#5555ff' },
  campbell:  { name:'Windows Terminal (Campbell)', background:'#0c0c0c', foreground:'#cccccc', cursor:'#ffffff', selectionBackground:'#3a3a3a', black:'#0c0c0c', red:'#c50f1f', green:'#13a10e', yellow:'#c19c00', blue:'#0037da', magenta:'#881798', cyan:'#3a96dd', white:'#cccccc', brightBlack:'#767676', brightRed:'#e74856', brightGreen:'#16c60c', brightYellow:'#f9f1a5', brightBlue:'#3b78ff', brightMagenta:'#b4009e', brightCyan:'#61d6d6', brightWhite:'#f2f2f2' },
  monokai:   { name:'Monokai', background:'#272822', foreground:'#f8f8f2', cursor:'#f8f8f0', selectionBackground:'#49483e', black:'#272822', red:'#f92672', green:'#a6e22e', yellow:'#f4bf75', blue:'#66d9ef', magenta:'#ae81ff', cyan:'#a1efe4', white:'#f8f8f2', brightBlack:'#75715e' },
  dracula:   { name:'Dracula', background:'#282a36', foreground:'#f8f8f2', cursor:'#f8f8f2', selectionBackground:'#44475a', black:'#21222c', red:'#ff5555', green:'#50fa7b', yellow:'#f1fa8c', blue:'#bd93f9', magenta:'#ff79c6', cyan:'#8be9fd', white:'#f8f8f2', brightBlack:'#6272a4' },
  solarized: { name:'Solarized dark', background:'#002b36', foreground:'#839496', cursor:'#93a1a1', selectionBackground:'#073642', black:'#073642', red:'#dc322f', green:'#859900', yellow:'#b58900', blue:'#268bd2', magenta:'#d33682', cyan:'#2aa198', white:'#eee8d5', brightBlack:'#586e75' },
  light:     { name:'Light', background:'#fafafa', foreground:'#1f2328', cursor:'#0969da', selectionBackground:'#c8e1ff', black:'#24292f', red:'#cf222e', green:'#116329', yellow:'#9a6700', blue:'#0969da', magenta:'#8250df', cyan:'#1b7c83', white:'#6e7781', brightBlack:'#57606a' },
};
const SSH_FONTS = ['ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace', 'Consolas, monospace', '"Cascadia Mono", "Cascadia Code", monospace', '"JetBrains Mono", monospace', '"Fira Code", monospace', '"Source Code Pro", monospace', '"Ubuntu Mono", monospace', '"Courier New", monospace'];
const SSH_PREF_DEFAULTS = { theme:'dark', fontSize:13, fontFamily: SSH_FONTS[0], bg:'', fg:'', cursorStyle:'block', cursorBlink:true, ctrlZ:'ignore' };
function sshPrefs(){ try { return Object.assign({}, SSH_PREF_DEFAULTS, JSON.parse(localStorage.getItem(SSH_PREF_KEY) || '{}')); } catch(e){ return Object.assign({}, SSH_PREF_DEFAULTS); } }
function sshThemeFor(p){ const t = Object.assign({}, SSH_THEMES[p.theme] || SSH_THEMES.dark); delete t.name; if (p.bg) t.background = p.bg; if (p.fg) t.foreground = p.fg; return t; }
function sshApplyPrefs(p){
  try { localStorage.setItem(SSH_PREF_KEY, JSON.stringify(p)); } catch(e){}
  for (const s of sshSess.values()) { try { s.term.options.theme = sshThemeFor(p); s.term.options.fontSize = p.fontSize; s.term.options.fontFamily = p.fontFamily; s.term.options.cursorStyle = p.cursorStyle; s.term.options.cursorBlink = !!p.cursorBlink; s.fit.fit(); } catch(e){} }
  const box = document.getElementById('ssh-terms'); if (box) box.style.background = sshThemeFor(p).background;
}
function sshSettingsDialog(){
  const p = sshPrefs(), th = sshThemeFor(p);
  const themeOpts = Object.entries(SSH_THEMES).map(([k,t]) => '<option value="' + k + '"' + (p.theme===k?' selected':'') + '>' + t.name + '</option>').join('');
  const fontOpts = SSH_FONTS.map(f => '<option value="' + esc(f) + '"' + (p.fontFamily===f?' selected':'') + '>' + esc(f.split(',')[0].replace(/"/g,'')) + '</option>').join('');
  const custom = SSH_FONTS.includes(p.fontFamily) ? '' : p.fontFamily;
  const sel = (id, opts, cur) => '<select id="' + id + '" onchange="sshPrefLive()">' + opts.map(([v,l]) => '<option value="' + v + '"' + (String(cur)===v?' selected':'') + '>' + l + '</option>').join('') + '</select>';
  sshModal('<h3>⚙ Terminal settings</h3>'
    + '<div class="row2">' + sshField('Font', '<select id="stp-font" onchange="document.getElementById(\'stp-font-custom\').value=\'\';sshPrefLive()">' + fontOpts + '</select>') + sshField('Custom font (CSS font-family)', '<input id="stp-font-custom" value="' + esc(custom) + '" placeholder="e.g. &quot;Cascadia Code&quot;, monospace" oninput="sshPrefLive()">', 'must be installed on your PC') + '</div>'
    + '<div class="row3">' + sshField('Font size', '<input id="stp-size" type="number" min="8" max="32" value="' + p.fontSize + '" oninput="sshPrefLive()">') + sshField('Cursor', sel('stp-cursor', [['block','Block'],['underline','Underline'],['bar','Bar']], p.cursorStyle)) + sshField('Cursor blink', sel('stp-blink', [['1','On'],['0','Off']], p.cursorBlink ? '1' : '0')) + '</div>'
    + '<div class="row3">' + sshField('Color theme', '<select id="stp-theme" onchange="sshPrefLive()">' + themeOpts + '</select>')
    + sshField('Background', '<div style="display:flex;gap:8px;align-items:center"><input id="stp-bg" type="color" value="' + esc(p.bg || th.background) + '" oninput="document.getElementById(\'stp-bg-on\').checked=true;sshPrefLive()" style="width:44px;padding:0;height:30px"><label style="font-size:12px;display:flex;gap:4px;align-items:center"><input type="checkbox" id="stp-bg-on"' + (p.bg?' checked':'') + ' onchange="sshPrefLive()"> override</label></div>')
    + sshField('Text', '<div style="display:flex;gap:8px;align-items:center"><input id="stp-fg" type="color" value="' + esc(p.fg || th.foreground) + '" oninput="document.getElementById(\'stp-fg-on\').checked=true;sshPrefLive()" style="width:44px;padding:0;height:30px"><label style="font-size:12px;display:flex;gap:4px;align-items:center"><input type="checkbox" id="stp-fg-on"' + (p.fg?' checked':'') + ' onchange="sshPrefLive()"> override</label></div>') + '</div>'
    + sshField('Ctrl+Z', sel('stp-ctrlz', [['ignore','Windows style — does nothing (never suspends the remote program)'],['suspend','Unix style — sends ^Z (suspend; resume with fg)']], p.ctrlZ))
    + '<div class="box" style="font-size:12px;line-height:1.6"><b>Keys</b> · Ctrl+C: copy when text is selected, otherwise ^C to the remote · Ctrl+V: paste text, or upload a file / screenshot from the clipboard · Ctrl+Shift+C / Ctrl+Shift+V: always copy / paste · Ctrl+Insert / Shift+Insert: copy / paste · Ctrl+Shift+W: close tab · right-click: paste<br><b>Files</b> · drag &amp; drop onto the terminal or Ctrl+V → uploaded to <code>~/rhc-uploads/</code> on the remote host, path typed into the terminal (e.g. for Claude Code).</div>'
    + '<div class="foot"><div class="left"><button class="btn" onclick="try{localStorage.removeItem(\'' + SSH_PREF_KEY + '\')}catch(e){};sshApplyPrefs(sshPrefs());sshModalClose();sshSettingsDialog()">Reset to defaults</button></div><button class="btn pri" onclick="sshModalClose()">Done</button></div>');
}
function sshPrefLive(){
  const g = (i) => document.getElementById(i); if (!g('stp-font')) return;
  const p = sshPrefs(), custom = g('stp-font-custom').value.trim();
  p.fontFamily = custom || g('stp-font').value; p.fontSize = Math.max(8, Math.min(32, parseInt(g('stp-size').value) || 13));
  p.cursorStyle = g('stp-cursor').value; p.cursorBlink = g('stp-blink').value === '1'; p.theme = g('stp-theme').value;
  p.bg = g('stp-bg-on').checked ? g('stp-bg').value : ''; p.fg = g('stp-fg-on').checked ? g('stp-fg').value : ''; p.ctrlZ = g('stp-ctrlz').value;
  sshApplyPrefs(p);
}


function sshEditHost(id){
  const h = (id && sshData && sshData.hosts.find(x => x.id === id)) || { name:'', group:'', host:'', port:22, user:'root', auth:'key', identityFile:'', notes:'', protocol:'ssh' };
  const proto = h.protocol || 'ssh';
  const isVnc = proto === 'vnc', isRdp = proto === 'rdp';
  const groups = [...new Set((sshData ? sshData.hosts : []).map(x => x.group).filter(Boolean))];
  sshModal('<h3>' + (id ? '✎ Edit host' : '＋ Add host') + '</h3>'
    + '<div class="row2">' + sshField('Name', '<input id="shf-name" value="' + esc(h.name) + '" placeholder="web02 (prod)">')
    + sshField('Group', '<input id="shf-group" list="shf-groups" value="' + esc(h.group||'') + '" placeholder="Production"><datalist id="shf-groups">' + groups.map(g => '<option value="' + esc(g) + '">').join('') + '</datalist>') + '</div>'
    + '<div class="row3">' + sshField('Host / IP', '<input id="shf-host" value="' + esc(h.host) + '" placeholder="203.0.113.10">')
    + sshField('Port', '<input id="shf-port" type="number" min="1" max="65535" value="' + (h.port||22) + '">')
    + sshField('User', '<input id="shf-user" value="' + esc(h.user||'root') + '">') + '</div>'
    + '<div class="row2">' + sshField('Authentication', '<select id="shf-auth" onchange="document.getElementById(\'shf-pwwrap\').style.display=this.value===\'password\'?\'\':\'none\'"><option value="key"' + (h.auth!=='password'?' selected':'') + '>SSH key (default keys / file below)</option><option value="password"' + (h.auth==='password'?' selected':'') + '>Password</option></select>')
    + sshField('Identity file', '<input id="shf-ident" value="' + esc(h.identityFile||'') + '" placeholder="/root/.ssh/id_ed25519 (optional)">') + '</div>'
    + '<div id="shf-pwwrap" style="display:' + (h.auth==='password'?'':'none') + '">' + sshField('Password', '<input id="shf-pw" type="password" autocomplete="new-password" placeholder="' + (h.hasPassword ? '•••••••• (stored — leave blank to keep)' : 'password') + '">', 'Stored in ssh-hosts.json (mode 600, gitignored). Typed automatically at the ssh prompt; sudo prompts are left to you.') + '</div>'
    + '<div class="row2">' + sshField('Opens as', '<select id="shf-proto" onchange="sshProtoChanged(this.value)"><option value="ssh"' + (proto==='ssh'?' selected':'') + '>SSH terminal</option><option value="vnc"' + (proto==='vnc'?' selected':'') + '>VNC viewer (desktop)</option><option value="rdp"' + (proto==='rdp'?' selected':'') + '>RDP viewer (Windows desktop)</option></select>', 'the SSH settings above are still used by the terminal and by a tunnelled VNC viewer')
    + sshField('Notes', '<input id="shf-notes" value="' + esc(h.notes||'') + '" placeholder="optional">') + '</div>'
    + '<div id="shf-rdpwrap" style="display:' + (isRdp?'':'none') + '">'
      + '<div class="box">The panel runs an RDP client on <b>this</b> server and streams its screen to the browser — the target must be reachable from here on the RDP port.</div>'
      + '<div class="row3">' + sshField('RDP address', '<input id="shf-rdphost" value="' + esc(h.rdpHost||'') + '" placeholder="same as the host above">')
      + sshField('RDP port', '<input id="shf-rdpport" type="number" min="1" max="65535" value="' + (h.rdpPort||3389) + '">')
      + sshField('Screen size', '<input id="shf-rdpgeom" value="' + esc(h.rdpGeometry||'1280x800') + '">') + '</div>'
      + '<div class="row3">' + sshField('Windows user', '<input id="shf-rdpuser" value="' + esc(h.rdpUser||'') + '" placeholder="Administrator">')
      + sshField('Domain', '<input id="shf-rdpdomain" value="' + esc(h.rdpDomain||'') + '" placeholder="optional">')
      + sshField('Password', '<input id="shf-rdppw" type="password" autocomplete="new-password" placeholder="' + (h.hasRdpPassword ? '•••••••• (stored)' : 'password') + '">') + '</div>'
      + sshField('Security', '<select id="shf-rdpsec"><option value="auto"' + ((h.rdpSecurity||'auto')==='auto'?' selected':'') + '>Negotiate (default)</option><option value="nla"' + (h.rdpSecurity==='nla'?' selected':'') + '>NLA</option><option value="tls"' + (h.rdpSecurity==='tls'?' selected':'') + '>TLS</option><option value="rdp"' + (h.rdpSecurity==='rdp'?' selected':'') + '>Legacy RDP</option></select>')
      + '</div>'
    + '<div id="shf-vncwrap" style="display:' + (isVnc?'':'none') + '">'
      + '<div class="row3">' + sshField('VNC address', '<input id="shf-vnchost" value="' + esc(h.vncHost||'127.0.0.1') + '" placeholder="127.0.0.1">', 'as seen from the target')
      + sshField('VNC port', '<input id="shf-vncport" type="number" min="1" max="65535" value="' + (h.vncPort||5901) + '">', ':1 = 5901, :2 = 5902')
      + sshField('VNC password', '<input id="shf-vncpw" type="password" autocomplete="new-password" placeholder="' + (h.hasVncPassword ? '•••••••• (stored)' : 'vnc password') + '">') + '</div>'
      + '<label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer;margin-bottom:8px"><input type="checkbox" id="shf-vnctunnel"' + (h.vncTunnel === false ? '' : ' checked') + ' style="accent-color:#5cdd8b"> Reach it through SSH (<code>ssh -W</code>) — required for a server bound to localhost, and nothing is exposed to the network</label>'
      + '<label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer"><input type="checkbox" id="shf-vncview"' + (h.vncViewOnly ? ' checked' : '') + ' style="accent-color:#5cdd8b"> View only (no keyboard or mouse)</label>'
      + '</div>'
    + sshField('After login', '<label style="display:flex;gap:8px;align-items:center;font-size:13px;cursor:pointer"><input type="checkbox" id="shf-root"' + (h.becomeRoot ? ' checked' : '') + ' style="accent-color:#5cdd8b"> Become root (<code>sudo -i</code>) — for non-root users; a sudo password prompt is answered with the stored password, or type it</label>')
    + '<div id="shf-test"></div>'
    + '<div class="foot"><div class="left">' + (id ? '<button class="btn danger" onclick="sshDeleteHost(\'' + id + '\')">Delete</button>' : '') + (id ? '<button class="btn" onclick="sshTestHost(\'' + id + '\')">🔌 Test connection</button>' : '') + (id ? '<button class="btn" onclick="sshDeployVncDialog(\'' + id + '\')" title="Install a VNC server on this host">🖵 Deploy VNC</button>' : '') + '</div>'
    + '<button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="sshSaveHost(' + (id ? '\'' + id + '\'' : 'null') + ')">' + (id ? 'Save' : 'Add host') + '</button></div>');
}
function sshReadHostForm(){
  const v = (i) => document.getElementById(i).value;
  const o = { name: v('shf-name'), group: v('shf-group'), host: v('shf-host').trim(), port: parseInt(v('shf-port')) || 22, user: v('shf-user').trim() || 'root', auth: v('shf-auth'), identityFile: v('shf-ident').trim(), notes: v('shf-notes'), becomeRoot: document.getElementById('shf-root').checked };
  const pw = document.getElementById('shf-pw').value; if (pw) o.password = pw;
  o.protocol = v('shf-proto');
  if (o.protocol === 'rdp') {
    o.rdpHost = v('shf-rdphost').trim();
    o.rdpPort = parseInt(v('shf-rdpport')) || 3389;
    o.rdpGeometry = v('shf-rdpgeom').trim() || '1280x800';
    o.rdpUser = v('shf-rdpuser').trim();
    o.rdpDomain = v('shf-rdpdomain').trim();
    o.rdpSecurity = v('shf-rdpsec');
    const rp = document.getElementById('shf-rdppw').value; if (rp) o.rdpPassword = rp;
  }
  if (o.protocol === 'vnc') {
    o.vncHost = v('shf-vnchost').trim() || '127.0.0.1';
    o.vncPort = parseInt(v('shf-vncport')) || 5901;
    o.vncTunnel = document.getElementById('shf-vnctunnel').checked;
    o.vncViewOnly = document.getElementById('shf-vncview').checked;
    const vp = document.getElementById('shf-vncpw').value; if (vp) o.vncPassword = vp;
  }
  return o;
}
async function sshSaveHost(id){
  const o = sshReadHostForm();
  if (!o.host) return toast('Host is required', 'error');
  try {
    const r = await fetch(id ? 'api/ssh/hosts/' + id : 'api/ssh/hosts', { method: id ? 'PUT' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(o) });
    const d = await r.json();
    if (!r.ok || d.error) return toast(d.error || 'Save failed', 'error');
    toast(id ? 'Host saved' : 'Host added', 'success'); sshModalClose(); renderSsh();
  } catch(e){ toast('Error: ' + e, 'error'); }
}
async function sshDeleteHost(id){
  const h = sshData.hosts.find(x => x.id === id);
  if (!confirm('Delete host "' + (h ? h.name : id) + '"?')) return;
  try { await fetch('api/ssh/hosts/' + id, { method: 'DELETE' }); toast('Host deleted', 'success'); sshModalClose(); renderSsh(); } catch(e){ toast('Error: ' + e, 'error'); }
}
async function sshTestHost(id){
  const box = document.getElementById('shf-test'); if (!box) return;
  // save first so the test uses what is on screen
  const o = sshReadHostForm();
  box.innerHTML = '<div class="test-out">connecting…</div>';
  try {
    const r0 = await fetch('api/ssh/hosts/' + id, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(o) });
    const d0 = await r0.json(); if (d0.error) { box.innerHTML = '<div class="test-out bad">' + esc(d0.error) + '</div>'; return; }
    const r = await fetch('api/ssh/hosts/' + id + '/test', { method: 'POST' });
    const d = await r.json();
    box.innerHTML = '<div class="test-out ' + (d.ok ? 'ok' : 'bad') + '">' + (d.ok ? '✅ connected in ' + d.ms + ' ms\n' : '❌ failed after ' + d.ms + ' ms\n') + esc(d.output || '') + '</div>';
    renderSsh();
  } catch(e){ box.innerHTML = '<div class="test-out bad">' + esc(String(e)) + '</div>'; }
}
function sshAdhocDialog(){
  sshModal('<h3>＋ Ad-hoc connection</h3>'
    + '<div class="row3">' + sshField('Host / IP', '<input id="sha-host" placeholder="203.0.113.10">') + sshField('Port', '<input id="sha-port" type="number" value="22">') + sshField('User', '<input id="sha-user" value="root">') + '</div>'
    + '<div class="box">Uses this server\'s default SSH keys; a password prompt, if any, is answered in the terminal. Not saved — use <b>＋ Add host</b> to keep it.</div>'
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="sshAdhocGo()">Connect</button></div>');
  document.getElementById('sha-host').addEventListener('keydown', e => { if (e.key === 'Enter') sshAdhocGo(); });
}
function sshAdhocGo(){
  const host = document.getElementById('sha-host').value.trim(); if (!host) return;
  const a = { host, port: parseInt(document.getElementById('sha-port').value) || 22, user: document.getElementById('sha-user').value.trim() || 'root' };
  sshModalClose(); sshConnectAdhoc(a);
}

/* ---- remote install ---- */
function sshInstallDialog(id, retryJob){
  const h = sshData && sshData.hosts.find(x => x.id === id); if (!h) return;
  const src = sshData.source || {};
  // retry: start from the settings of the failed run; tick Overwrite when that is what it tripped on
  const po = (retryJob && retryJob.opts) || {};
  const pc = po.copy || {};
  const on = (v, dflt) => (v === undefined ? dflt : !!v);
  const dirExists = !!(retryJob && /already exists/i.test(retryJob.error || ''));
  const chk = (i, label, on, hint) => '<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:6px 0;cursor:pointer"><input type="checkbox" id="' + i + '"' + (on ? ' checked' : '') + ' style="accent-color:#5cdd8b;margin-top:3px"><span>' + label + (hint ? '<br><span style="font-size:11px;color:#6b7280">' + hint + '</span>' : '') + '</span></label>';
  sshModal('<h3>📦 Install rhc-srv-mon on ' + esc(h.name) + '</h3>'
    + (retryJob ? '<div class="box" style="border-color:#ff808866"><b style="color:#ff8088">Retrying the install from ' + esc((retryJob.startedAt||'').slice(0,16).replace('T',' ')) + '</b>' + (retryJob.error ? '<br>' + esc(retryJob.error) : '') + (dirExists ? '<br>“Overwrite existing install” has been ticked for you.' : '') + '</div>' : '')
    + '<div class="box">Copies <b>server.js</b> from this server (' + esc(src.host||'') + (src.git ? ', ' + esc(src.git) : '') + ') to <b>' + esc((h.user||'root') + '@' + h.host) + '</b> over SSH, installs Node.js ≥ ' + (src.minNode||20) + ' and pm2 if missing, and starts it under pm2 with your settings. Needs root on the target — or a user with passwordless sudo, or the sudo password below.' + (h.monitor ? '<br>Already installed there on ' + esc((h.monitor.installedAt||'').slice(0,16).replace('T',' ')) + ' (port ' + h.monitor.port + ') — this will update it.' : '') + '</div>'
    + '<div class="row3">' + sshField('Install dir', '<input id="shi-dir" value="' + esc(po.appDir || (h.monitor ? h.monitor.appDir : '/opt/rhc-srv-mon')) + '">') + sshField('Port', '<input id="shi-port" type="number" value="' + (po.port || (h.monitor ? h.monitor.port : (src.port||8899))) + '">') + sshField('pm2 name', '<input id="shi-name" value="' + esc(po.appName || 'rhc-srv-mon') + '">') + '</div>'
    + '<div style="font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin:4px 0 2px">Copy settings from this server</div>'
    + chk('shi-c-modules', 'Modules auto-update + cleanup schedule', on(pc.modules, true), 'severities, time, Telegram flags, cleanup targets — not the project scan')
    + chk('shi-c-updates', 'Updates tab schedule (Node.js, CLI tools)', on(pc.updates, true))
    + chk('shi-c-telegram', 'Telegram bot token + chat id', on(pc.telegram, true), 'so the target notifies the same chat')
    + chk('shi-c-backups', 'Backups schedule + scope + retention', on(pc.backups, true), 'per-DB / per-site selections are reset to "all"; needs rclone remote configured on the target')
    + chk('shi-c-ssh', 'SSH host list (this tab, incl. stored passwords)', on(pc.sshHosts, true))
    + chk('shi-c-auth', 'Login users + authenticator (MFA)', retryJob ? !!pc.auth : !h.monitor, 'same username / password / authenticator entry works on the target; active sessions are not copied')
    + '<div style="font-size:12px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 2px">Options</div>'
    + chk('shi-privnode', 'Private Node.js ' + esc((src.node||'v22').split('.')[0]) + '.x inside the install dir (system Node.js untouched — pick this for FreePBX / appliances / hosts where other apps depend on node)', on(po.privateNode, true), 'pm2 is installed into that private prefix too')
    + chk('shi-node', 'Otherwise: install Node.js ' + esc((src.node||'v22').split('.')[0]) + '.x system-wide via NodeSource if missing/too old', on(po.installNode, true))
    + chk('shi-pm2', 'Install pm2 globally if missing', on(po.installPm2, true))
    + chk('shi-over', 'Overwrite existing install (update in place, keeps its history/data files)', dirExists || (retryJob ? !!po.overwrite : !!h.monitor))
    + ((h.user||'root') !== 'root' ? '<div class="box" style="border-color:#f8a30666;margin-top:8px"><b style="color:#f8a306">⚠ ' + esc(h.user) + ' is not root.</b> The installer needs root on the target: enter the sudo password of <b>' + esc(h.user) + '</b> below (it is sent once through SUDO_ASKPASS and never stored or logged). Leave it empty only if the user has passwordless sudo.'
      + sshField('sudo password for ' + esc(h.user), '<input id="shi-sudo" type="password" autocomplete="new-password" placeholder="' + esc(h.user) + ' sudo password">') + '</div>' : '')
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="sshInstallGo(\'' + id + '\')">🚀 Install</button></div>');
}
async function sshInstallGo(id){
  const g = (i) => document.getElementById(i);
  const opts = { appDir: g('shi-dir').value.trim(), port: parseInt(g('shi-port').value) || 8899, appName: g('shi-name').value.trim(),
    installNode: g('shi-node').checked, installPm2: g('shi-pm2').checked, overwrite: g('shi-over').checked, privateNode: g('shi-privnode').checked,
    sudoPassword: g('shi-sudo') ? g('shi-sudo').value : '',
    copy: { modules: g('shi-c-modules').checked, updates: g('shi-c-updates').checked, telegram: g('shi-c-telegram').checked, backups: g('shi-c-backups').checked, sshHosts: g('shi-c-ssh').checked, auth: !!(g('shi-c-auth') && g('shi-c-auth').checked) } };
  try {
    const r = await fetch('api/ssh/install', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ hostId: id, opts }) });
    const d = await r.json();
    if (!r.ok || d.error) return toast(d.error || 'Install failed to start', 'error');
    sshModalClose(); toast('Install started', 'success'); window._sshOpenJob = d.jobId; await renderSsh(); sshInstallsDialog();
  } catch(e){ toast('Error: ' + e, 'error'); }
}
const sshJobLogs = new Map();
function sshInstallsDialog(){
  const bg = sshModal('<h3>📦 rhc-srv-mon installs</h3><div class="ssh-installs" id="ssh-installs"><div class="mod-empty">No installs yet — use 📦 on a host to install rhc-srv-mon there.</div></div>'
    + '<div class="foot"><div class="left"><button class="btn" id="ssh-inst-clear">🗑 Clear history</button></div><button class="btn pri" onclick="sshModalClose()">Close</button></div>');
  const m = bg && bg.querySelector('.ssh-modal'); if (m) m.classList.add('wide');
  const c = bg && bg.querySelector('#ssh-inst-clear');
  if (c) c.addEventListener('click', () => armConfirm(c, '⚠ Click again to clear', sshClearInstalls));
  sshRenderInstalls();
}
// Forget finished installs (a running one keeps its entry until it ends).
async function sshClearInstalls(){
  try {
    const r = await fetch('api/ssh/installs', { method:'DELETE' });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Failed', 'error');
    toast(d.removed ? 'Cleared ' + d.removed + ' install' + (d.removed === 1 ? '' : 's') : 'Nothing to clear', 'success');
    sshJobLogs.clear(); window._sshOpenJob = null;
    await renderSsh();
  } catch(e){ toast('Error: ' + e, 'error'); }
}
async function sshForgetInstall(id){
  try {
    const r = await fetch('api/ssh/install/' + id, { method:'DELETE' });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Failed', 'error');
    sshJobLogs.delete(id); if (window._sshOpenJob === id) window._sshOpenJob = null;
    await renderSsh();
  } catch(e){ toast('Error: ' + e, 'error'); }
}
// Retry: reopen the install dialog with the failed job's settings. The sudo password is deliberately
// never stored, and most failures need a change anyway (tick Overwrite, enter the password).
function sshRetryInstall(id){
  const j = (sshData.installs || []).find(x => x.id === id); if (!j) return;
  if (!(sshData.hosts || []).some(h => h.id === j.hostId)) return toast('That host no longer exists', 'error');
  if (j.kind === 'vnc') return sshDeployVncDialog(j.hostId);
  sshInstallDialog(j.hostId, j);
}
function sshInstallsBadge(){
  const b = document.getElementById('ssh-inst-btn'); if (!b || !sshData) return;
  const jobs = sshData.installs || [], running = jobs.filter(j => j.status === 'running').length, failed = jobs.filter(j => j.status === 'failed').length;
  b.innerHTML = '📦' + (running ? '<span class="bd">⏳' + running + '</span>' : '') + (!running && failed ? '<span class="bd" style="color:#ff8088">✖' + failed + '</span>' : '') + (!running && !failed && jobs.length ? '<span class="bd">' + jobs.length + '</span>' : '');
  b.title = jobs.length ? jobs.length + ' install' + (jobs.length === 1 ? '' : 's') + (running ? ' · ' + running + ' running' : '') + (failed ? ' · ' + failed + ' failed' : '') + ' — click to open' : 'rhc-srv-mon install history / running installs';
}
async function sshRenderInstalls(){
  sshInstallsBadge();
  const box = document.getElementById('ssh-installs'); if (!box || !sshData) return;
  const jobs = (sshData.installs || []).slice(0, 12);
  if (!jobs.length) return;
  // fetch logs for running + expanded jobs
  await Promise.all(jobs.filter(j => j.status === 'running' || window._sshOpenJob === j.id || sshJobLogs.has(j.id)).map(async j => {
    try { const d = await fetch('api/ssh/install/' + j.id).then(r => r.json()); if (d && d.log) sshJobLogs.set(j.id, d.log); } catch(e){}
  }));
  box.innerHTML = jobs.map(j => {
    const st = j.status === 'running' ? '<span class="upd-badge new">⏳ running' + (j.step ? ' · ' + esc(j.step) : '') + '</span>' : j.status === 'ok' ? '<span class="upd-badge ok">✅ installed</span>' : '<span class="upd-badge err">❌ failed</span>';
    const log = sshJobLogs.get(j.id);
    const open = j.status === 'running' || window._sshOpenJob === j.id;
    return '<div class="ssh-inst"><div class="top"><b>' + (j.kind === 'vnc' ? '🖵' : '📦') + ' ' + esc(j.hostName || j.target) + '</b>' + st + '</div>'
      + '<div class="meta">' + esc(j.target) + ' → ' + esc(j.kind === 'vnc' ? 'VNC :' + j.opts.display + ' (' + j.opts.geometry + ', ' + j.opts.desktop + ')' + (j.result ? ' → port ' + j.result.port : '') : (j.opts ? j.opts.appDir + ' :' + j.opts.port : '')) + ' · ' + esc((j.startedAt||'').slice(0,16).replace('T',' ')) + (j.finishedAt ? ' · ' + Math.round((new Date(j.finishedAt) - new Date(j.startedAt))/1000) + 's' : '') + (j.error ? '<br><span style="color:#ff8088">' + esc(j.error) + '</span>' : '') + '</div>'
      + (open && log ? '<pre id="ssh-log-' + j.id + '">' + log.map(l => '<span class="t">' + esc(l.t.slice(11,19)) + '</span> <span class="' + esc(l.k) + '">' + esc(l.m) + '</span>').join('\n') + '</pre>' : '')
      + '<div class="acts">'
      + (open ? (j.status === 'running' ? '' : '<button class="upd-test-btn" onclick="window._sshOpenJob=null;sshRenderInstalls()">Hide log</button>')
              : '<button class="upd-test-btn" onclick="window._sshOpenJob=\'' + j.id + '\';sshRenderInstalls()">Show log (' + (j.logLines||0) + ' lines)</button>')
      + (j.status === 'running' ? '' : '<button class="upd-test-btn" onclick="sshRetryInstall(\'' + j.id + '\')" title="Open the install dialog again with these settings">↻ ' + (j.status === 'ok' ? 'Install again' : 'Retry') + '</button>'
        + '<button class="upd-test-btn" onclick="armConfirm(this, \'⚠ Forget?\', () => sshForgetInstall(\'' + j.id + '\'))" title="Remove this entry from the history">✕</button>')
      + '</div></div>';
  }).join('');
  for (const pre of box.querySelectorAll('pre')) pre.scrollTop = pre.scrollHeight;
}



/* ---- sessions viewer: this panel's terminals + the logins on each host ---- */
let sshSessView = { hostId: null, data: null, loading: false, error: null };
function sshSessionsDialog(hostId){
  sshSessView = { hostId: hostId || null, data: null, loading: false, error: null };
  const bg = sshModal('<h3>👥 SSH sessions</h3><div id="ssh-sess-body"></div>'
    + '<div class="foot"><div class="left"><button class="btn" onclick="sshSessRender(true)">↻ Refresh</button></div><button class="btn pri" onclick="sshModalClose()">Close</button></div>');
  const m = bg && bg.querySelector('.ssh-modal'); if (m) m.classList.add('wide');
  sshSessRender(!!hostId);
}
// Local sessions come from the /api/ssh payload; remote logins need a live ssh probe per host, so
// they are only fetched when a host is picked (never polled).
async function sshSessRender(fetchRemote){
  const box = document.getElementById('ssh-sess-body'); if (!box) return;
  if (fetchRemote && sshSessView.hostId) {
    sshSessView.loading = true; sshSessView.error = null; box.innerHTML = sshSessHtml();
    try { sshSessView.data = await siteApi('GET', 'api/ssh/hosts/' + sshSessView.hostId + '/sessions'); }
    catch(e){ sshSessView.error = e.message; sshSessView.data = null; }
    sshSessView.loading = false;
  }
  box.innerHTML = sshSessHtml();
}
function sshSessHtml(){
  const local = (sshData && sshData.sessions) || [];
  let h = '<div class="upd-card" style="margin:0 0 12px"><div class="site-card-hd"><h3 style="margin:0;font-size:14px">Terminals open in this panel</h3><span class="dim" style="font-size:12px">' + local.length + ' session' + (local.length === 1 ? '' : 's') + ' — they keep running on the server until closed here</span></div>';
  if (!local.length) h += '<p class="dim" style="margin:0">No open terminals.</p>';
  else {
    h += '<table class="upd-table"><tr><th>Target</th><th>Label</th><th>Started</th><th>State</th><th></th></tr>';
    for (const s of local) {
      h += '<tr><td class="mono">' + esc(s.target) + '</td><td>' + esc(s.label || '') + '</td><td class="dim">' + esc(String(s.startedAt || '').slice(0, 16).replace('T', ' ')) + '</td>'
        + '<td>' + (s.attached ? '<span class="upd-badge ok">attached</span>' : '<span class="upd-badge na">detached' + (s.detachedAt ? ' ' + esc(String(s.detachedAt).slice(11, 16)) : '') + '</span>') + '</td>'
        + '<td style="text-align:right"><button class="upd-test-btn" onclick="armConfirm(this, \'⚠ Close?\', () => sshCloseSessionFromDialog(\'' + s.id + '\'))">Close</button></td></tr>';
    }
    h += '</table>';
  }
  h += '</div>';
  const hosts = (sshData && sshData.hosts) || [];
  h += '<div class="upd-card" style="margin:0"><div class="site-card-hd"><h3 style="margin:0;font-size:14px">Logins on a host</h3>'
    + '<select onchange="sshSessView.hostId=this.value||null; sshSessView.data=null; sshSessRender(true)"><option value="">— pick a host —</option>'
    + hosts.map(x => '<option value="' + esc(x.id) + '"' + (x.id === sshSessView.hostId ? ' selected' : '') + '>' + esc(x.name) + '</option>').join('') + '</select></div>';
  if (!sshSessView.hostId) h += '<p class="dim" style="margin:0">Pick a host to run <code>who</code> and <code>ss</code> on it over SSH. Nothing is polled — this only runs when you ask.</p>';
  else if (sshSessView.loading) h += '<p class="dim" style="margin:0">Asking the host…</p>';
  else if (sshSessView.error) h += '<p style="margin:0;color:#ff8088">⚠ ' + esc(sshSessView.error) + '</p>';
  else if (sshSessView.data) {
    const d = sshSessView.data;
    h += '<p class="dim" style="margin:0 0 8px;font-size:12.5px">' + esc(d.target) + ' · checked ' + esc(String(d.checkedAt).slice(11, 19)) + '</p>';
    h += '<table class="upd-table"><tr><th>User</th><th>TTY</th><th>From</th><th>Since</th><th>Idle</th><th>PID</th><th></th></tr>';
    for (const s of d.sessions) {
      h += '<tr><td><b>' + esc(s.user) + '</b>' + (s.fromPanel ? ' <span class="upd-badge na" title="connected from this server — probably this panel">this panel</span>' : '') + '</td><td class="mono">' + esc(s.tty || s.type || '—') + '</td><td class="mono">' + esc(s.from || '') + '</td><td class="dim">' + esc(s.since) + '</td><td class="dim">' + esc(s.idle || '') + '</td><td class="mono dim">' + (s.pid || '') + '</td>'
        + '<td style="text-align:right">' + (s.pid ? '<button class="upd-test-btn" onclick="armConfirm(this, \'⚠ Disconnect?\', () => sshDisconnectRemote(' + s.pid + '))">Disconnect</button>' : '') + '</td></tr>';
    }
    if (!d.sessions.length) h += '<tr><td colspan="7" class="dim">No interactive logins.</td></tr>';
    h += '</table>';
    const extra = (d.connections || []).filter(c => !d.sessions.some(s => s.pid === c.pid));
    if (extra.length) {
      h += '<div class="dim" style="font-size:12px;margin-top:10px">Other connections on port 22 (sftp, scp, port forwards):</div><table class="upd-table"><tr><th>Peer</th><th>PID</th><th></th></tr>';
      for (const c of extra) h += '<tr><td class="mono">' + esc(c.peer) + '</td><td class="mono dim">' + c.pid + '</td><td style="text-align:right"><button class="upd-test-btn" onclick="armConfirm(this, \'⚠ Disconnect?\', () => sshDisconnectRemote(' + c.pid + '))">Disconnect</button></td></tr>';
      h += '</table>';
    }
    h += '<div class="dim" style="font-size:11.5px;margin-top:8px">Disconnecting hangs up that login\'s sshd process. Your own session shows up here too — closing it drops you.</div>';
  }
  return h + '</div>';
}
async function sshCloseSessionFromDialog(id){
  try { await fetch('api/ssh/sessions/' + id, { method:'DELETE' }); sshCloseTab(id); await renderSsh(); sshSessRender(false); toast('Terminal closed', 'success'); }
  catch(e){ toast('Error: ' + e, 'error'); }
}
async function sshDisconnectRemote(pid){
  try {
    const r = await siteApi('POST', 'api/ssh/hosts/' + sshSessView.hostId + '/sessions/' + pid + '/disconnect');
    toast('Disconnected pid ' + r.pid, 'success');
  } catch(e){ toast('Disconnect failed: ' + e.message, 'error', { duration: 9000 }); }
  sshSessRender(true);
}


/* ---- deploy a VNC server on a host ---- */
function sshDeployVncDialog(id){
  const h = sshData && sshData.hosts.find(x => x.id === id); if (!h) return;
  const used = (sshData.hosts || []).filter(x => x.vnc && x.id !== id).map(x => x.vnc.display);
  let disp = h.vnc ? h.vnc.display : 1;
  while (used.includes(disp)) disp++;
  const bg = sshModal('<h3>🖵 Deploy a VNC server on ' + esc(h.name) + '</h3>'
    + '<div class="box">Installs a VNC server (tigervnc) on <b>' + esc((h.user||'root') + '@' + h.host) + '</b>, writes a password file and a <code>rhc-vnc@:N</code> systemd service, and starts it <b>bound to localhost</b>. Nothing is exposed to the network — this panel reaches the desktop through the same SSH connection.'
    + (h.vnc ? '<br>Already deployed here on ' + esc(String(h.vnc.deployedAt).slice(0,16).replace('T',' ')) + ' as display :' + h.vnc.display + ' — running this again re-deploys it.' : '') + '</div>'
    + '<div class="row3">' + sshField('Display', '<input id="dv-disp" type="number" min="1" max="99" value="' + disp + '">', 'port ' + (5900 + disp) + ' on the target')
    + sshField('Run as user', '<input id="dv-user" value="' + esc(h.vnc ? h.vnc.user : (h.user || 'root')) + '">', 'the desktop session owner')
    + sshField('Screen size', '<input id="dv-geom" value="1280x800">') + '</div>'
    + '<div class="row2">' + sshField('Desktop', '<select id="dv-desktop"><option value="xfce">XFCE (installs it if missing — several minutes)</option><option value="none">None — bare X (xterm if available)</option></select>')
    + sshField('VNC password', '<input id="dv-pw" placeholder="leave empty to generate">', 'VNC passwords are truncated to 8 characters by the protocol') + '</div>'
    + '<label class="upd-toggle"><input type="checkbox" id="dv-link" checked style="accent-color:#5cdd8b"> Make this host open as a VNC viewer afterwards</label>'
    + ((h.user||'root') !== 'root' ? sshField('sudo password for ' + esc(h.user), '<input id="dv-sudo" type="password" autocomplete="new-password" placeholder="needed unless ' + esc(h.user) + ' has passwordless sudo">') : '')
    + '<div class="foot"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" id="dv-go">🚀 Deploy</button></div>');
  bg.querySelector('#dv-disp').addEventListener('input', (e) => { const f = bg.querySelector('#dv-disp').parentElement.querySelector('.hint'); if (f) f.textContent = 'port ' + (5900 + (parseInt(e.target.value) || 1)) + ' on the target'; });
  bg.querySelector('#dv-go').onclick = async () => {
    const g = (i) => { const el = bg.querySelector('#' + i); return el ? el.value : ''; };
    const body = { display: parseInt(g('dv-disp')) || 1, vncUser: g('dv-user').trim(), geometry: g('dv-geom').trim(), desktop: g('dv-desktop'),
      password: g('dv-pw').trim() || undefined, createHost: bg.querySelector('#dv-link').checked, sudoPassword: g('dv-sudo') };
    try {
      const r = await siteApi('POST', 'api/ssh/hosts/' + id + '/deploy-vnc', body);
      sshModalClose();
      toast('Deploying — password ' + r.password + ' (also stored on the host entry)', 'success', { duration: 12000 });
      window._sshOpenJob = r.jobId;
      await renderSsh(); sshInstallsDialog();
    } catch(e){ toast('Deploy failed to start: ' + e.message, 'error', { duration: 9000 }); }
  };
}

function sshProtoChanged(v){
  const vw = document.getElementById('shf-vncwrap'), rw = document.getElementById('shf-rdpwrap');
  if (vw) vw.style.display = v === 'vnc' ? '' : 'none';
  if (rw) rw.style.display = v === 'rdp' ? '' : 'none';
}
/* ---- RDP viewer: the panel runs the RDP client and streams its screen as VNC ---- */
async function sshOpenRdpTab(h){
  let RFB;
  try { RFB = await sshLoadNoVnc(); } catch(e){ return toast(e.message, 'error', { duration: 9000 }); }
  toast('Starting the RDP session…');
  let sess;
  try { sess = await siteApi('POST', 'api/ssh/hosts/' + h.id + '/rdp'); }
  catch(e){ return toast('RDP: ' + e.message, 'error', { duration: 12000 }); }
  const id = 't' + (++sshTabSeq);
  const el = document.createElement('div'); el.className = 'ssh-term vnc'; el.dataset.id = id;
  el.innerHTML = '<div class="pane-hd"><b class="pl">🪟 ' + esc(h.name) + '</b><span class="pt">' + esc(sess.target) + ' · display :' + sess.display + '</span><span class="sp"></span>'
    + '<button title="Send Ctrl+Alt+Del" onclick="sshVncCad(\'' + id + '\')">⌨</button>'
    + '<button title="Client log" onclick="sshRdpLog(\'' + id + '\')">📄</button>'
    + '<button title="Fit / 1:1" onclick="sshVncScale(\'' + id + '\')">⤢</button>'
    + '<button title="Show only this pane" onclick="sshPaneSolo(\'' + id + '\')">▭</button>'
    + '<button title="Close (ends the RDP session)" onclick="sshCloseTab(\'' + id + '\')">×</button></div><div class="pane-body vnc-body"></div>';
  el.addEventListener('mousedown', () => { if (sshActive !== id) sshActivate(id, { noFocus: true }); }, true);
  document.getElementById('ssh-terms').appendChild(el);
  const s = { id, hostId: h.id, kind: 'vnc', rdpDisplay: sess.display, label: h.name, target: sess.target, el, rfb: null, status: 'connecting', fit: { fit(){} } };
  sshSess.set(id, s);
  sshActivate(id);
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = proto + location.host + new URL('ws/vnc', location.href).pathname + '?id=' + encodeURIComponent(sess.id);
  try {
    const rfb = new RFB(el.querySelector('.vnc-body'), url, { credentials: { password: sess.password }, wsProtocols: ['binary'] });
    rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#0c0e16';
    rfb.addEventListener('connect', () => { s.status = 'open'; sshRenderTabs(); sshRenderHosts(); });
    rfb.addEventListener('disconnect', async () => {
      s.status = 'dead'; sshRenderTabs();
      let why = '';
      try { const d = await siteApi('GET', 'api/ssh/rdp/' + sess.display + '/log'); if (d.error) why = ' — ' + d.error; } catch(e){}
      sshVncNote(s, 'The RDP session ended' + why + (why ? '' : ' — open 📄 for the client log.'));
    });
    s.rfb = rfb;
  } catch(e){ s.status = 'dead'; sshVncNote(s, 'Could not start the viewer: ' + e.message); }
  sshRenderTabs();
}
async function sshRdpLog(id){
  const s = sshSess.get(id); if (!s || !s.rdpDisplay) return;
  try {
    const d = await siteApi('GET', 'api/ssh/rdp/' + s.rdpDisplay + '/log');
    sshModal('<h3>🪟 RDP client log <span class="dim" style="font-weight:400;font-size:12px">' + esc(d.target) + '</span></h3>'
      + (d.error ? '<div class="box" style="border-color:#5a1f25;color:#ff8088">' + esc(d.error) + '</div>' : '')
      + '<pre class="site-code-pre" style="max-height:50vh">' + esc((d.log || []).join('\n') || '(nothing logged yet)') + '</pre>'
      + '<div class="foot"><button class="btn pri" onclick="sshModalClose()">Close</button></div>');
  } catch(e){ toast('Log: ' + e.message, 'error'); }
}
