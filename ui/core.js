// ---- shared helpers, state, tab routing, refresh loop (every tab file shares this scope) ----
function esc(t){ return String(t).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtMem(b){ if(!b) return '0 MB'; const mb=b/1048576; return mb>=1024 ? (mb/1024).toFixed(1)+' GB' : mb.toFixed(0)+' MB'; }
function fmtUp(ms){ if(ms==null) return '–'; const s=Math.floor(ms/1000);
  if(s<3600) return Math.floor(s/60)+'m'; if(s<86400) return Math.floor(s/3600)+'h';
  return Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h'; }
function pctCls(p){ return p==null?'':(p>=99?'good':(p>=90?'mid':'poor')); }

// In-page toast (replaces alert/window.alert/Notification — never opens a browser dialog)
function toast(msg, type, opts){
  const host = document.getElementById('toast-host'); if (!host) return;
  type = type || 'info';
  const o = opts || {};
  const ms = o.duration != null ? o.duration : (type==='error' ? 8000 : 4000);
  const ico = type==='success'?'✅':type==='error'?'❌':type==='warn'?'⚠️':'ℹ️';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  let inner = '<span class="ico">'+ico+'</span><div class="body">'+esc(msg||'');
  if (o.detail) inner += '<pre>'+esc(o.detail)+'</pre>';
  inner += '</div><span class="x" title="dismiss">×</span>';
  el.innerHTML = inner;
  const close = () => { el.classList.add('fade'); setTimeout(() => el.remove(), 250); };
  el.querySelector('.x').addEventListener('click', close);
  host.appendChild(el);
  if (ms > 0) setTimeout(close, ms);
  return el;
}

// Two-step inline confirm (replaces window.confirm — never opens a browser dialog)
const _armed = new WeakMap();
function armConfirm(btn, armedLabel, onConfirm){
  if (!btn) return;
  if (_armed.has(btn)) {            // Second click → execute
    const t = _armed.get(btn);
    clearTimeout(t.timer);
    btn.innerHTML = t.original;
    btn.classList.remove('arm-confirm');
    _armed.delete(btn);
    try { onConfirm(); } catch(e) { toast('Error: '+e.message, 'error'); }
    return;
  }
  const original = btn.innerHTML;     // innerHTML, so icon buttons get their icon back
  btn.textContent = armedLabel;
  btn.classList.add('arm-confirm');
  const timer = setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('arm-confirm');
    _armed.delete(btn);
  }, 5000);
  _armed.set(btn, { original, timer });
}

let lastData = null, lastDb = null;
const state = Object.assign({
  q:'', f:'all', sort:'group', tab:'sites',
  sharedOnly:false,
  modSort:'severity', modFilter:'all', modQ:'', modShowDetailLog:false
}, JSON.parse(localStorage.getItem('pm2ui') || '{}'));
function saveState(){ localStorage.setItem('pm2ui', JSON.stringify(state)); }

function hashStr(s){ let h=0; for(let i=0;i<s.length;i++){ h=(h*31+s.charCodeAt(i))|0; } return h; }

/* ---- fetch: 401 → login ---- */
(function(){ const f = window.fetch; window.fetch = function(u, o){ return f(u, o).then(r => { if (r.status === 401 && typeof u === 'string' && u.indexOf('api/') === 0 && u.indexOf('api/auth/') !== 0) { location.replace('login'); throw new Error('unauthenticated'); } return r; }); }; })();
/* ---- modals ---- */
function sshModal(html){
  sshModalClose();
  const bg = document.createElement('div'); bg.className = 'ssh-modal-bg'; bg.id = 'ssh-modal';
  bg.innerHTML = '<div class="ssh-modal">' + html + '</div>';
  bg.addEventListener('mousedown', (e) => { if (e.target === bg) sshModalClose(); });
  document.body.appendChild(bg);
  const f = bg.querySelector('input,select,textarea'); if (f) setTimeout(() => f.focus(), 30);
  return bg;
}
function sshModalClose(){ const m = document.getElementById('ssh-modal'); if (m) m.remove(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('ssh-modal')) sshModalClose(); });
// Ask for one value without window.prompt — the panel never opens a browser dialog, because they
// block the page, cannot be styled or dismissed by clicking away, and look nothing like the rest of
// it. Resolves with the value, or null if the modal was cancelled, dismissed or escaped; callers
// must handle null, since every exit from the modal now goes through it.
function askModal(opts){
  opts = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    function finish(v){
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      sshModalClose();
      resolve(v);
    }
    const bg = sshModal('<h3>' + esc(opts.title || '') + '</h3>'
      + sshField(opts.label || '', '<input id="askV"' + (opts.password ? ' type="password"' : '') + ' value="' + esc(opts.value || '') + '"' + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>', opts.hint || '')
      + '<div class="foot"><button class="btn" id="askNo">Cancel</button><button class="btn pri" id="askYes">' + esc(opts.ok || 'OK') + '</button></div>');
    const inp = bg.querySelector('#askV');
    bg.querySelector('#askYes').onclick = () => finish(inp.value);
    bg.querySelector('#askNo').onclick = () => finish(null);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(inp.value); });
    // sshModal closes itself on a backdrop click and the global Escape handler closes it too; both
    // would otherwise leave this promise pending forever, with the caller still waiting on it.
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) finish(null); });
    document.addEventListener('keydown', onKey);
  });
}
function sshField(label, inner, hint){ return '<div class="upd-field"><label>' + label + '</label>' + inner + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; }
// Each tab has its own URL (…/rhc-admin/ssh, …/Databases, …). Slugs are single path
// segments so every relative URL in this page (api/…, login, ws/ssh) keeps resolving.
// Compact status pills on the subtitle line (right side). items: [{ level: ok|warn|bad|info, text, sub }].
// Green/amber states never use the big banner any more; call showBanner() only for real outages.
function setStatus(items){
  const el = document.getElementById('statuses'); if (!el) return;
  el.innerHTML = (items || []).map(i => '<span class="st ' + esc(i.level || 'info') + '">' + (i.icon ? i.icon + ' ' : '') + esc(i.text) + (i.sub ? ' <span class="sub">' + esc(i.sub) + '</span>' : '') + '</span>').join('');
}
function showBanner(html){ const b = document.getElementById('banner'); if (html) { b.style.display = 'flex'; b.className = 'banner bad'; b.innerHTML = html; } else b.style.display = 'none'; }
// One entry per tab: URL slug, view element, render (on tab switch) and onRefresh (every 10 s
// while the tab is active — omitted for tabs that fetch their own data on their own schedule).
const TABS = {
  sites:   { slug:'sites',    label:'Sites',      view:'sitesview',   render: () => renderSites(),   onRefresh: () => { if (!siteView.domain) renderSitesList(); } },
  pm2:     { slug:'monitor',  label:'Monitor',    view:'pm2view',     render: () => { render(); renderKuma(); }, onRefresh: () => { render(); renderKuma(); } },
  db:      { slug:'Databases', label:'Databases', view:'dbview',      render: () => renderDb(),      onRefresh: () => renderDb() },
  updates: { slug:'updates',  label:'Updates',    view:'updatesview', render: () => renderUpdates(), onRefresh: () => renderUpdates() },
  modules: { slug:'modules',  label:'Modules',    view:'modulesview', render: () => renderModules(), onRefresh: () => renderModules() },
  backup:  { slug:'backups',  label:'Backups',    view:'backupview',  render: () => renderBackup(),  onRefresh: () => renderBackup() },
  ssh:     { slug:'ssh',      label:'SSH',        view:'sshview',     render: () => renderSsh() },
  certs:   { slug:'certificates', label:'Certificates', view:'certsview', render: () => renderCertsTab() },
  security:{ slug:'security', label:'Security',   view:'securityview', render: () => renderSecurity() },
  firewall:{ slug:'firewall', label:'Firewall',   view:'firewallview', render: () => renderFirewall() },
  appstore:{ slug:'appstore', label:'App Store',  view:'appstoreview', render: () => renderAppStore() },
  transfer:{ slug:'transfer', label:'Transfer',   view:'transferview', render: () => renderTransfer(), onRefresh: () => renderTransfer() },
  ooda:    { slug:'self-repair', label:'Self-repair', view:'oodaview', render: () => renderOoda(), onRefresh: () => renderOoda() },
  vault:   { slug:'vault',    label:'Vault',      view:'vaultview',   render: () => renderVault() },
  tunnels: { slug:'tunnels',  label:'Tunnels',    view:'tunnelsview', render: () => renderTunnelsTab() },
  events:  { slug:'events',   label:'Events',     view:'eventsview',  render: () => renderEvents(),  onRefresh: () => refreshEvents() },
  settings:{ slug:'settings', label:'Settings',   view:'settingsview',render: () => renderSettings() },
};
const TAB_SLUG = Object.fromEntries(Object.entries(TABS).map(([k, v]) => [k, v.slug]));
const SLUG_TAB = Object.assign(Object.fromEntries(Object.entries(TAB_SLUG).map(([k,v]) => [v,k])),
  { pm2:'pm2', services:'pm2', databases:'db', postgres:'db', postgresql:'db', db:'db', backup:'backup', terminal:'ssh', certs:'certs', certificate:'certs', tunnel:'tunnels', ooda:'ooda', repair:'ooda', 'app-store':'appstore', fail2ban:'firewall', ufw:'firewall' });
function tabFromPath(){ const seg = (location.pathname.split('/').filter(Boolean).pop() || '').toLowerCase(); return SLUG_TAB[seg] || null; }
function setTab(tab, opts){
  opts = opts || {};
  if (!TABS[tab]) tab = 'sites';
  state.tab = tab; saveState();
  if (!opts.noHistory && tabFromPath() !== tab) {
    try { history[opts.replace ? 'replaceState' : 'pushState']({ tab }, '', TAB_SLUG[tab] + location.search); } catch(e){}
  } else if (opts.fromBar && location.search) {
    try { history.pushState({ tab }, '', TAB_SLUG[tab]); } catch(e){}   // clicking the tab again leaves any sub-view (site detail)
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  const title = document.getElementById('pagetitle'); if (title) title.textContent = TABS[tab].label || tab;
  const cur = document.getElementById('menu-cur'), act = document.querySelector('.sidenav .tab.active span');
  if (cur && act) cur.textContent = act.textContent;
  menuOpen(false);
  for (const [k, t] of Object.entries(TABS)) { const el = document.getElementById(t.view); if (el) el.style.display = k===tab ? '' : 'none'; }
  TABS[tab].render();
}

// Narrow screens: the sidebar is a drop-down panel behind the ☰ button (a sideways-scrolling strip
// of 16 icons hid most of the menu with no sign that there was more).
function menuOpen(open){
  const nav = document.getElementById('sidenav'), btn = document.getElementById('menu-btn');
  if (!nav || !btn) return;
  nav.classList.toggle('open', open); btn.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('menu-open', open);
}
(function(){
  const btn = document.getElementById('menu-btn'), nav = document.getElementById('sidenav');
  if (!btn || !nav) return;
  btn.addEventListener('click', (e) => { e.stopPropagation(); menuOpen(!nav.classList.contains('open')); });
  document.addEventListener('click', (e) => { if (nav.classList.contains('open') && !nav.contains(e.target)) menuOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('open')) { menuOpen(false); btn.focus(); } });
  matchMedia('(min-width:901px)').addEventListener('change', (m) => { if (m.matches) menuOpen(false); });
})();

// Left menu → Panel: restart / stop the panel itself. A restart shows its progress step by step
// (code check → restart → waiting for the new process → reload); "back" means a *new* process
// answers (its pid differs), not the old one still finishing its last second.
function panelSteps(steps, cur, note){
  const el = document.getElementById('panel-steps'); if (!el) return;
  el.innerHTML = steps.map((t, i) => '<li class="' + (i < cur ? 'done' : i === cur ? 'now' : 'todo') + '">'
    + '<span class="ps-ico">' + (i < cur ? '✓' : i === cur ? '<span class="ag-spin"></span>' : '•') + '</span>' + t + '</li>').join('')
    + (note ? '<li class="note">' + note + '</li>' : '');
}
async function panelCtl(action, force){
  if (action === 'stop') {
    try { await stApi('POST', 'api/panel/stop'); } catch(e){ return /HTTP 404/.test(e.message) ? toast('The running panel is older than this button — on the server as root: sbctl stop', 'warn', { duration: 15000 }) : stErr(e, 'Panel'); }
    toast('Panel stopping. Start it again on the server as root: sbctl start', 'warn', { duration: 60000 });
    return;
  }
  const steps = ['Checking the code', 'Restarting the panel', 'Waiting for it to come back', 'Reloading this page'];
  let before = null; try { before = (await stApi('GET', 'api/panel')).pid; } catch(_){}
  sshModal('<h3>Restarting the panel</h3><ul class="panel-steps" id="panel-steps"></ul>'
    + '<p class="dim" id="panel-elapsed" style="margin:10px 0 0;font-size:13px"></p>');
  const t0 = Date.now(), tick = setInterval(() => { const e = document.getElementById('panel-elapsed'); if (e) e.textContent = Math.round((Date.now() - t0) / 1000) + ' s'; }, 500);
  const done = () => clearInterval(tick);
  panelSteps(steps, force ? 1 : 0);
  try { await stApi('POST', 'api/panel/restart', force ? { force: true } : {}); }
  catch(e){
    done();
    if (e.detail) {
      panelSteps(steps, 0, '❌ ' + esc(e.message) + '<pre class="mono" style="white-space:pre-wrap;font-size:12px;margin:8px 0 0">' + esc(e.detail) + '</pre>');
      document.getElementById('panel-steps').insertAdjacentHTML('afterend', '<div class="foot"><button class="btn" onclick="sshModalClose()">Close</button><button class="btn danger" onclick="panelCtl(\'restart\', true)" title="restart even though the check failed — the panel may not come back">Restart anyway</button></div>');
    } else if (/HTTP 404|^not found/i.test(e.message)) {
      panelSteps(steps, 0, '❌ The running panel is older than this button, so it cannot restart itself. Once, on the server as root: <code>sbctl restart</code> — from then on this button works.');
      document.getElementById('panel-steps').insertAdjacentHTML('afterend', '<div class="foot"><button class="btn pri" onclick="sshModalClose()">OK</button></div>');
    } else { sshModalClose(); stErr(e, 'Panel'); }
    return;
  }
  panelSteps(steps, 2);
  while (Date.now() - t0 < 90000) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const r = await fetch('api/panel', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); if (!before || j.pid !== before) break; }
      else if (r.status === 401 || r.status === 403) break;     // up, just asking for a login
    } catch(_){}
  }
  done();
  if (Date.now() - t0 >= 90000) { panelSteps(steps, 2, '⚠ Not back after 90 s — on the server: <code>sbctl status</code> / <code>sbctl logs</code>'); return; }
  panelSteps(steps, 3);
  setTimeout(() => location.reload(), 600);
}

// Menu order: the ⇅ button next to "Server" switches the sidebar into reorder mode — drag an item
// (mouse or touch) or move the focused one with ↑/↓. Saved per browser in state.navOrder.
const NAV_DEFAULT = [...document.querySelectorAll('.sidenav .tab')].map(t => t.dataset.tab);
function navApply(order){
  const box = document.querySelector('.sidenav .tabs'); if (!box) return;
  const by = {}; box.querySelectorAll('.tab').forEach(t => { by[t.dataset.tab] = t; });
  const seq = (order || []).filter(k => by[k]).concat(NAV_DEFAULT.filter(k => !(order || []).includes(k)));
  seq.forEach(k => box.appendChild(by[k]));
}
function navSave(){
  topnavRender();
  const cur = [...document.querySelectorAll('.sidenav .tab')].map(t => t.dataset.tab);
  if (cur.join() === NAV_DEFAULT.join()) delete state.navOrder; else state.navOrder = cur;
  saveState();
}
// Top bar: the pages pinned with ☆ in the left menu's reorder mode, in left-menu order (state.topPins).
function topnavRender(){
  const top = document.getElementById('topnav'); if (!top) return;
  const pins = new Set(state.topPins || []);
  top.innerHTML = '';
  document.querySelectorAll('.sidenav .tab').forEach(t => {
    const on = pins.has(t.dataset.tab);
    const pin = t.querySelector('.pin-top');
    if (pin) { pin.classList.toggle('on', on); pin.textContent = on ? '★' : '☆'; pin.title = on ? 'Remove from the top bar' : 'Add to the top bar'; pin.setAttribute('aria-pressed', String(on)); }
    if (!on) return;
    const a = document.createElement('a');
    a.className = 'tab' + (t.dataset.tab === state.tab ? ' active' : ''); a.href = t.getAttribute('href'); a.dataset.tab = t.dataset.tab;
    a.textContent = (t.querySelector('span:not(.pin-top)') || t).textContent;
    a.addEventListener('click', (e) => { if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); setTab(a.dataset.tab, { fromBar: true }); });
    top.appendChild(a);
  });
}
function topPinToggle(tab){
  const pins = new Set(state.topPins || []);
  if (pins.has(tab)) pins.delete(tab); else pins.add(tab);
  state.topPins = [...pins]; saveState(); topnavRender();
}
function navEditing(on){
  const nav = document.getElementById('sidenav'); if (!nav) return;
  nav.classList.toggle('reorder', on);
  document.getElementById('nav-edit-bar').hidden = !on;
  document.getElementById('nav-edit').setAttribute('aria-pressed', String(on));
  nav.querySelectorAll('.tab').forEach(t => t.setAttribute('aria-roledescription', on ? 'movable item' : ''));
  if (!on) navSave();
}
(function(){
  const nav = document.getElementById('sidenav'), box = nav && nav.querySelector('.tabs');
  if (!box) return;
  if (Array.isArray(state.navOrder)) navApply(state.navOrder);
  box.querySelectorAll('.tab').forEach(t => { const p = document.createElement('span'); p.className = 'pin-top'; p.setAttribute('role', 'button'); t.appendChild(p); });
  topnavRender();
  document.getElementById('nav-edit').addEventListener('click', () => navEditing(!nav.classList.contains('reorder')));
  document.getElementById('nav-done').addEventListener('click', () => navEditing(false));
  document.getElementById('nav-reset').addEventListener('click', () => { navApply(NAV_DEFAULT); navSave(); });
  // While reordering, a click never navigates (capture phase beats the tab's own handler).
  box.addEventListener('click', (e) => {
    if (!nav.classList.contains('reorder')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const pin = e.target.closest('.pin-top'); if (pin) topPinToggle(pin.closest('.tab').dataset.tab);
  }, true);
  box.addEventListener('keydown', (e) => {
    if (!nav.classList.contains('reorder')) return;
    const t = e.target.closest('.tab'); if (!t) return;
    if (e.key === 'ArrowUp' && t.previousElementSibling) { box.insertBefore(t, t.previousElementSibling); }
    else if (e.key === 'ArrowDown' && t.nextElementSibling) { box.insertBefore(t.nextElementSibling, t); }
    else if (e.key === ' ' || e.key === '*') { topPinToggle(t.dataset.tab); e.preventDefault(); return; }
    else if (e.key === 'Escape' || e.key === 'Enter') { navEditing(false); }
    else return;
    e.preventDefault(); t.focus(); navSave();
  });
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (!nav.classList.contains('reorder') || e.button !== 0) return;
    const t = e.target.closest('.tab'); if (!t || e.target.closest('.pin-top')) return;
    e.preventDefault(); drag = { t, id: e.pointerId };
    t.classList.add('dragging'); t.setPointerCapture(e.pointerId);
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    for (const o of box.querySelectorAll('.tab')) {
      if (o === drag.t) continue;
      const r = o.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) {
        box.insertBefore(drag.t, e.clientY < r.top + r.height / 2 ? o : o.nextElementSibling);
        break;
      }
    }
    // keep the dragged item visible when the list scrolls (phone drop-down)
    const nr = nav.getBoundingClientRect();
    if (e.clientY < nr.top + 30) nav.scrollTop -= 8; else if (e.clientY > nr.bottom - 30) nav.scrollTop += 8;
  });
  const end = (e) => { if (!drag || e.pointerId !== drag.id) return; drag.t.classList.remove('dragging'); drag = null; navSave(); };
  box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
})();

document.querySelectorAll('.sidenav .tab').forEach(t => t.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;   // let "open in new tab" use the real href
  e.preventDefault(); setTab(t.dataset.tab, { fromBar: true });
}));

// Each feed on its own: one failing endpoint (an error page, an expired session, a timeout) used to
// throw all six away, which left the Sites tab on "Loading…" for good with no word of why.
let refreshErrors = {};
async function refresh(){
  const get = (url) => fetch(url).then(async (r) => {
    let j; try { j = await r.json(); } catch(e){ throw new Error(url + ': HTTP ' + r.status + ', not JSON'); }
    if (!r.ok) throw new Error(url + ': ' + ((j && j.error) || 'HTTP ' + r.status));
    return j;
  });
  const [st, db, up, si, mo, bk] = await Promise.allSettled(['api/status', 'api/db', 'api/updates', 'api/sites', 'api/modules', 'api/backup'].map(get));
  refreshErrors = {};
  const take = (res, key, ok) => { if (res.status === 'fulfilled' && (!ok || ok(res.value))) return res.value; refreshErrors[key] = res.status === 'rejected' ? res.reason.message : key + ': unexpected answer'; return undefined; };
  lastData = take(st, 'status') || lastData;
  lastDb = take(db, 'db') || lastDb;
  lastUpdates = take(up, 'updates') || lastUpdates;
  lastSites = take(si, 'sites', (v) => v && Array.isArray(v.sites)) || lastSites;
  lastModules = take(mo, 'modules') || lastModules;
  lastBackup = take(bk, 'backup') || lastBackup;
  if (Object.keys(refreshErrors).length) console.warn('refresh:', refreshErrors);
  const t = TABS[state.tab]; if (t && t.onRefresh) t.onRefresh();
}
