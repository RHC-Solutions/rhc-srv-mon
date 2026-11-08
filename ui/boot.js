// ---- boot: must stay last ----
// Top-bar server info next to the clock: IP · OS / CPU · RAM · disk (every 15 s).
(function srvInfo(){
  const el = document.getElementById('srvinfo'); if (!el) return;
  const gb = (b) => b >= 1e12 ? (b / 1e12).toFixed(1) + ' TB' : (b / 1073741824).toFixed(b >= 1e11 ? 0 : 1) + ' GB';
  const lvl = (pct) => pct >= 90 ? 'crit' : pct >= 75 ? 'hot' : '';
  async function tick(){
    try {
      const r = await fetch('api/sysinfo', { cache: 'no-store' }); if (!r.ok) return;
      const s = await r.json();
      const mp = Math.round(100 * s.mem.used / s.mem.total), dp = Math.round(100 * s.disk.used / s.disk.total);
      el.innerHTML = '<span><b class="mono">' + esc(s.ip || '–') + '</b><span class="os"> · ' + esc(s.os) + '</span></span>'
        + '<span>CPU <b class="' + lvl(s.cpu.usage || 0) + '">' + (s.cpu.usage != null ? s.cpu.usage + '%' : esc(String(s.cpu.load1))) + '</b> <span class="dim">(' + s.cpu.cores + ')</span>'
        + ' · RAM <b class="' + lvl(mp) + '">' + gb(s.mem.used) + '</b>/' + gb(s.mem.total)
        + ' · Disk <b class="' + lvl(dp) + '">' + gb(s.disk.used) + '</b>/' + gb(s.disk.total) + '</span>';
      el.title = s.hostname + ' · ' + s.os + ' · kernel ' + s.kernel + '\n' + s.cpu.model + ' × ' + s.cpu.cores + ' · load ' + s.cpu.load1 + '\nRAM ' + mp + '% · disk ' + dp + '% · up ' + Math.floor(s.uptime / 86400) + ' d';
    } catch(_){}
  }
  tick(); setInterval(tick, 15000);
})();
// Top-bar clock in the server's zone (data-tz is filled in when the page is built).
(function srvClock(){
  const el = document.getElementById('srvclock'); if (!el) return;
  let tz = el.dataset.tz; try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); } catch(e){ tz = undefined; }
  const fDate = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const fTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  let fOff; try { fOff = new Intl.DateTimeFormat('en-GB', { timeZone: tz, timeZoneName: 'shortOffset' }); } catch(e){ fOff = null; }
  const tick = () => {
    const d = new Date();
    const off = fOff ? ((fOff.formatToParts(d).find(p => p.type === 'timeZoneName') || {}).value || '') : '';
    el.innerHTML = '<b>' + esc(fTime.format(d)) + '</b><span>' + esc(fDate.format(d)) + '<span class="tzl"> · ' + esc((tz || 'local') + (off ? ' (' + off + ')' : '')) + '</span></span>';
  };
  tick(); setInterval(tick, 1000);
})();
// Incoming transfers waiting for a decision — noticed on every page within 5 s, no F5: a toast that
// opens the Transfer page, a count on its tab, a "(n)" in the window title; the Transfer page itself
// reloads when the waiting set changes.
(function transferWatch(){
  const seen = new Set(); let lastKey = null, first = true; const baseTitle = document.title;
  async function tick(){
    let p = [];
    try { const r = await fetch('api/cluster/pending', { cache: 'no-store' }); if (!r.ok) return; p = (await r.json()).pending || []; } catch(_){ return; }
    const tab = document.querySelector('.tab[data-tab="transfer"]');
    if (tab) {
      let b = tab.querySelector('.tr-pending');
      if (p.length) { if (!b) { b = document.createElement('span'); b.className = 'tr-pending'; tab.appendChild(b); } b.textContent = p.length; b.title = p.length + ' incoming transfer(s) waiting for Accept'; }
      else if (b) b.remove();
    }
    document.title = (p.length ? '(' + p.length + ') ' : '') + baseTitle;
    const fresh = p.filter(r => !seen.has(r.id)); p.forEach(r => seen.add(r.id));
    if (fresh.length) {
      const froms = [...new Set(fresh.map(r => r.from))].join(', ');
      const what = fresh.length === 1 ? fresh[0].domain : fresh.length + ' sites (' + fresh.slice(0, 3).map(r => r.domain).join(', ') + (fresh.length > 3 ? ', …' : '') + ')';
      if (!(first && state.tab === 'transfer')) {
        const el = toast('📥 ' + froms + ' wants to move ' + what + ' to this server — click to Accept or Reject', 'warn', { duration: 0 });
        if (el) { el.style.cursor = 'pointer'; el.querySelector('.body').addEventListener('click', () => { setTab('transfer'); el.querySelector('.x').click(); }); }
      }
    }
    first = false;
    const key = p.map(r => r.id).sort().join(',');
    if (key !== lastKey) { const changed = lastKey !== null; lastKey = key; if (changed && state.tab === 'transfer' && typeof loadTransfer === 'function') loadTransfer(); }
  }
  tick(); setInterval(tick, 5000);
})();
setTab(tabFromPath() || state.tab, { replace: true });
window.addEventListener('popstate', () => setTab(tabFromPath() || state.tab, { noHistory: true }));
refresh(); setInterval(refresh, 10000);
