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
setTab(tabFromPath() || state.tab, { replace: true });
window.addEventListener('popstate', () => setTab(tabFromPath() || state.tab, { noHistory: true }));
refresh(); setInterval(refresh, 10000);
