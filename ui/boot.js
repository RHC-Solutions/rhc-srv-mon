// ---- boot: must stay last ----
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
