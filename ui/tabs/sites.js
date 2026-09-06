/* ---------------------------------------------------------------- sites */

let lastSites = null;

function renderSites(){
  if (!lastSites) return;
  const d = lastSites;
  document.getElementById('host').textContent = 'sites';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.generated_at ? new Date(d.generated_at).toLocaleString() : 'never') + ' · auto-refresh 5 min';

  const banner = document.getElementById('banner');
  banner.style.display='flex';
  const down = d.sites.filter(s => s.status === 'down').length;
  const degraded = d.sites.filter(s => s.status === 'degraded').length;
  const total = d.sites.length;
  if (down === 0 && degraded === 0) {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> All sites operational <span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'+total+' sites</span>';
  } else {
    banner.className='banner bad';
    const parts = [];
    if (down) parts.push(down + ' down');
    if (degraded) parts.push(degraded + ' degraded');
    banner.innerHTML = '<span class="ico">🔴</span> ' + parts.join(', ') + ' <span style="margin-left:auto;font-size:13px;font-weight:400">'+(total-down-degraded)+'/'+total+' ok</span>';
  }

  let html = '<div class="site-grid">';
  const sortOrder = { 'down': 0, 'degraded': 1, 'online': 2 };
  const sorted = [...d.sites].sort((a, b) => (sortOrder[a.status]||9) - (sortOrder[b.status]||9) || a.domain.localeCompare(b.domain));

  for (const s of sorted) {
    const typeLabel = s.type === 'nodejs' ? 'Node.js' : s.type === 'php' ? 'PHP' : s.type === 'static' ? 'Static' : s.type;
    const appVer = s.nodeVersion ? 'Node ' + s.nodeVersion : s.phpVersion ? 'PHP ' + s.phpVersion : '';
    const portInfo = s.nodePort ? ':' + s.nodePort : s.poolPort ? ':' + s.poolPort : '';
    const healthIcon = s.httpUp ? '✅' : (s.httpUp === false ? '❌' : '—');

    html += '<div class="site-card">';
    html += '<div class="top">';
    html += '<div class="domain">' + esc(s.domain) + '<span class="hint">' + esc(typeLabel) + '</span></div>';
    html += '<span class="badge ' + s.status + '">' + s.statusLabel + '</span>';
    html += '</div>';
    html += '<div class="meta">';
    html += '<span>Port: <span class="val">' + (portInfo || 'n/a') + '</span></span>';
    html += '<span>HTTP: <span class="val">' + healthIcon + '</span></span>';
    html += '<span>' + esc(appVer) + '</span>';
    html += '<span>Disk: <span class="val">' + esc(s.disk || '?') + '</span></span>';
    html += '</div>';

    if (s.pm2 && s.pm2.length) {
      html += '<div class="procs">';
      for (const p of s.pm2) {
        const pUp = p.status === 'online';
        const cpuMem = 'CPU ' + p.cpu + '% · ' + fmtMem(p.memory);
        html += '<div class="prow"><span class="pname">' + esc(p.name) + '</span>'
          + '<span class="pstat ' + (pUp?'up':'down') + '">' + (pUp?'🟢':'🔴') + ' ' + esc(p.status) + ' <span class="dim">' + cpuMem + '</span></span>'
          + '</div>';
      }
      html += '</div>';
    }

    html += '</div>';
  }
  html += '</div>';
  document.getElementById('sitesview').innerHTML = html;
}

