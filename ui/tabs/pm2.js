/* ---------------------------------------------------------------- pm2 (Monitor) */
function matches(p, user){
  if (state.f === 'up' && p.status !== 'online') return false;
  if (state.f === 'down' && p.status === 'online') return false;
  if (state.q){
    const q = state.q.toLowerCase();
    if (!p.name.toLowerCase().includes(q) && !user.toLowerCase().includes(q)) return false;
  }
  return true;
}

const HDR = '<div class="hdr"><div class="stat">Status</div><div class="meta">Service</div>'
  + '<div class="beats-h"></div><div class="col">CPU</div><div class="col">Mem</div><div class="col">↺</div><div class="pct" style="color:#6b7280">24h</div><div class="act"></div></div>';

function rowHtml(p, userLabel){
  const up = p.status === 'online';
  let beats = '';
  const pad = Math.max(0, 50 - p.beats.length);
  for (let i=0;i<pad;i++) beats += '<div class="beat"></div>';
  for (const b of p.beats) {
    const cls = b[1]===1?'up':(b[1]===2?'restart':'down');
    const lbl = b[1]===1?'up':(b[1]===2?'restarted':'down');
    beats += '<div class="beat '+cls+'" data-tip="'+new Date(b[0]*1000).toLocaleTimeString()+' — '+lbl+'"></div>';
  }
  const pct = p.uptime24h==null ? '–' : (p.uptime24h>=99.95?'100%':p.uptime24h.toFixed(1)+'%');
  const cpuCls = p.cpu>=80?'hot':(p.cpu>=40?'warm':'');
  const memCls = p.memory>=1073741824?'warm':'';
  const rstCls = p.restarts>=1000?'hot':(p.restarts>=50?'warm':'');
  const actions = up
    ? '<button class="btn small" onclick="pm2Action(\'stop\', \''+userLabel+'\', \''+esc(p.name)+'\')">⏹</button>'
    : '<button class="btn small" onclick="pm2Action(\'start\', \''+userLabel+'\', \''+esc(p.name)+'\')">▶</button>';
  return '<div class="row">'
    + '<div class="stat"><span class="pill '+(up?'up':'down')+'">'+(up?'Up':'Down')+'</span></div>'
    + '<div class="meta"><div class="name">'+esc(p.name)+'</div>'
    + '<div class="info">up '+fmtUp(p.uptime_ms)+(userLabel?' · '+esc(userLabel):'')+'</div></div>'
    + '<div class="beats">'+beats+'</div>'
    + '<div class="col '+cpuCls+'">'+p.cpu+'%</div>'
    + '<div class="col '+memCls+'">'+fmtMem(p.memory)+'</div>'
    + '<div class="col '+rstCls+'">'+p.restarts+'</div>'
    + '<div class="pct '+pctCls(p.uptime24h)+'">'+pct+'</div>'
    + '<div class="act">'+actions+'<button class="btn small" onclick="pm2Action(\'restart\', \''+userLabel+'\', \''+esc(p.name)+'\')">⟳</button></div>'
    + '</div>';
}

function render(){
  if (!lastData) return;
  const d = lastData;
  document.getElementById('host').textContent = d.hostname;
  document.getElementById('ivl').textContent = d.sample_interval_s;
  document.title = (d.summary.down ? '🔴 ' : '🟢 ') + d.summary.online + '/' + d.summary.total + ' · RHC SRV Manager · ' + d.hostname;
  document.getElementById('updated').textContent = 'Last updated: ' + new Date(d.generated_at).toLocaleString();
  if (state.tab !== 'pm2') return;
  if (d.summary.down === 0) {
    showBanner(null);
    setStatus([{ level:'ok', icon:'✅', text:'All systems operational', sub: d.summary.total + ' services · ' + fmtMem(d.summary.memory) }]);
  } else {
    showBanner('<span class="ico">🔴</span> ' + d.summary.down + ' service' + (d.summary.down>1?'s':'') + ' down <span style="margin-left:auto;font-size:15px;font-weight:400">'+d.summary.online+'/'+d.summary.total+' up</span>');
    setStatus([{ level:'bad', icon:'🔴', text: d.summary.down + ' down', sub: d.summary.online + '/' + d.summary.total + ' up' }]);
  }
  // chip labels with live counts
  document.querySelectorAll('.chip[data-f]').forEach(c => {
    const f = c.dataset.f;
    const n = f==='all' ? d.summary.total : (f==='up' ? d.summary.online : d.summary.down);
    c.textContent = (f==='all'?'All':(f==='up'?'Up':'Down')) + ' ' + n;
    c.classList.toggle('active', state.f === f);
  });
  document.getElementById('sort').value = state.sort;
  const stog = document.getElementById('sharedToggle');
  if (stog) stog.classList.toggle('active', !!state.sharedOnly);

  // Build set of app-names that run on multiple users (for "shared" toggle)
  const appUsers = {};
  for (const g of d.groups) for (const p of g.processes) {
    (appUsers[p.name] = appUsers[p.name] || new Set()).add(g.user);
  }
  const isShared = (name) => (appUsers[name] && appUsers[name].size >= 2);

  let html = '';
  if (state.sort === 'group') {
    for (const g of d.groups) {
      const procs = g.processes.filter(p => matches(p, g.user))
        .filter(p => !state.sharedOnly || isShared(p.name))
        .sort((a,b) => (a.status==='online') - (b.status==='online'));   // down first
      if (!procs.length && !g.error) continue;
      const up = g.processes.filter(p => p.status==='online').length;
      const down = g.processes.length - up;
      const counts = '<span class="pcounts">'
        + '<span class="up">'+up+' up</span>'
        + (down ? ' · <span class="down">'+down+' down</span>' : '')
        + ' · '+g.processes.length+' service'+(g.processes.length===1?'':'s')
        + '</span>';
      html += '<div class="group"><h2>'+esc(g.user)+counts+'<span class="dim">'+esc(g.pm2_home)+'</span></h2>';
      if (g.error) html += '<div class="err">⚠ daemon unreachable: '+esc(g.error)+'</div>';
      if (procs.length) html += HDR;
      for (const p of procs) html += rowHtml(p, null);
      html += '</div>';
    }
  } else {
    const all = [];
    for (const g of d.groups) for (const p of g.processes) {
      if (!matches(p, g.user)) continue;
      if (state.sharedOnly && !isShared(p.name)) continue;
      all.push({ p, u: g.user });
    }
    const cmp = {
      name:     (a,b) => a.p.name.localeCompare(b.p.name),
      cpu:      (a,b) => b.p.cpu - a.p.cpu,
      mem:      (a,b) => b.p.memory - a.p.memory,
      restarts: (a,b) => b.p.restarts - a.p.restarts,
      uptime:   (a,b) => (a.p.uptime24h ?? 101) - (b.p.uptime24h ?? 101),
    }[state.sort] || ((a,b)=>0);
    all.sort(cmp);
    if (all.length) {
      html += '<div class="group"><h2>All services<span class="dim">'+all.length+' shown</span></h2>' + HDR;
      for (const it of all) html += rowHtml(it.p, it.u);
      html += '</div>';
    }
  }
  if (!html) html = '<div class="group"><div class="err">No services match the current filter.</div></div>';
  document.getElementById('main').innerHTML = html;
}

document.getElementById('q').value = state.q;
document.getElementById('q').addEventListener('input', e => { state.q = e.target.value; saveState(); render(); });
document.querySelectorAll('.chip[data-f]').forEach(c =>
  c.addEventListener('click', () => { state.f = c.dataset.f; saveState(); render(); }));
document.getElementById('sort').addEventListener('change', e => { state.sort = e.target.value; saveState(); render(); });
document.getElementById('sharedToggle').addEventListener('click', () => {
  state.sharedOnly = !state.sharedOnly; saveState(); render();
});
async function pm2Action(action, user, app) {
  try {
    const r = await fetch('api/pm2/' + action + '/' + user + '/' + app, { method: 'POST' });
    const data = await r.json();
    if (data.success) toast(action + ' sent · ' + app, 'success');
    else toast('Error', 'error', { detail: data.output || 'unknown', duration: 10000 });
    refresh();
  } catch(e) { toast('Error: ' + e, 'error'); }
}
