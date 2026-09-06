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
    btn.textContent = t.original;
    btn.classList.remove('arm-confirm');
    _armed.delete(btn);
    try { onConfirm(); } catch(e) { toast('Error: '+e.message, 'error'); }
    return;
  }
  const original = btn.textContent;
  btn.textContent = armedLabel;
  btn.classList.add('arm-confirm');
  const timer = setTimeout(() => {
    btn.textContent = original;
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
function sshField(label, inner, hint){ return '<div class="upd-field"><label>' + label + '</label>' + inner + (hint ? '<span class="hint">' + hint + '</span>' : '') + '</div>'; }
// Each tab has its own URL (…/rhc-srv-mon/ssh, …/postgres, …). Slugs are single path
// segments so every relative URL in this page (api/…, login, ws/ssh) keeps resolving.
const TAB_SLUG = { pm2:'monitor', db:'postgres', updates:'updates', sites:'sites', modules:'modules', backup:'backups', ssh:'ssh' };
const SLUG_TAB = Object.assign(Object.fromEntries(Object.entries(TAB_SLUG).map(([k,v]) => [v,k])),
  { pm2:'pm2', services:'pm2', postgresql:'db', db:'db', backup:'backup', terminal:'ssh' });
function tabFromPath(){ const seg = (location.pathname.split('/').filter(Boolean).pop() || '').toLowerCase(); return SLUG_TAB[seg] || null; }
function setTab(tab, opts){
  opts = opts || {};
  if (!TAB_SLUG[tab]) tab = 'sites';
  state.tab = tab; saveState();
  if (!opts.noHistory && tabFromPath() !== tab) {
    try { history[opts.replace ? 'replaceState' : 'pushState']({ tab }, '', TAB_SLUG[tab] + location.search); } catch(e){}
  }
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===tab));
  document.getElementById('pm2view').style.display = tab==='pm2' ? '' : 'none';
  document.getElementById('dbview').style.display  = tab==='db'  ? '' : 'none';
  document.getElementById('updatesview').style.display = tab==='updates' ? '' : 'none';
  document.getElementById('sitesview').style.display = tab==='sites' ? '' : 'none';
  document.getElementById('modulesview').style.display = tab==='modules' ? '' : 'none';
  document.getElementById('backupview').style.display = tab==='backup' ? '' : 'none';
  document.getElementById('sshview').style.display = tab==='ssh' ? '' : 'none';
  document.body.classList.toggle('tab-ssh', tab==='ssh');
  if (tab==='pm2') render();
  else if (tab==='db') renderDb();
  else if (tab==='updates') renderUpdates();
  else if (tab==='sites') renderSites();
  else if (tab==='modules') renderModules();
  else if (tab==='backup') renderBackup();
  else if (tab==='ssh') renderSsh();
}

document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;   // let "open in new tab" use the real href
  e.preventDefault(); setTab(t.dataset.tab);
}));

async function refresh(){
  try { [lastData, lastDb, lastUpdates, lastSites, lastModules, lastBackup] = await Promise.all([
    fetch('api/status').then(r=>r.json()),
    fetch('api/db').then(r=>r.json()),
    fetch('api/updates').then(r=>r.json()),
    fetch('api/sites').then(r=>r.json()),
    fetch('api/modules').then(r=>r.json()),
    fetch('api/backup').then(r=>r.json()),
  ]); } catch(e){ return; }
  if (state.tab==='pm2') render();
  else if (state.tab==='db') renderDb();
  else if (state.tab==='updates') renderUpdates();
  else if (state.tab==='sites') renderSites();
  else if (state.tab==='modules') renderModules();
  else if (state.tab==='backup') renderBackup();
}
