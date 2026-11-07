// ---- Self-repair: the OODA loop (Observe → Orient → Decide → Act), once a minute on the server.
let oodaData = null, oodaLoading = false, oodaAt = 0;
async function loadOoda(){
  oodaLoading = true;
  try { oodaData = await stApi('GET', 'api/ooda'); oodaAt = Date.now(); } catch(e){ oodaData = { error: e.message }; }
  oodaLoading = false;
  if (state.tab === 'ooda') renderOoda(true);
}
function renderOoda(fromLoad){
  plainTabHeader('Observe → Orient → Decide → Act, every minute · restarts and reloads only — never deletes data or changes config');
  const view = document.getElementById('oodaview');
  if (!fromLoad && Date.now() - oodaAt > 10000 && !oodaLoading) loadOoda();
  if (!oodaData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; return; }
  const d = oodaData;
  if (d.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(d.error) + '</div>'; return; }
  const st = d.state || {}, ob = st.observe || {}, inc = st.incidents || [];
  const on = d.config && d.config.enabled;
  const when = (t) => t ? esc(new Date(t).toLocaleString()) : '–';
  const pill = (txt, lvl) => '<span class="st ' + lvl + '" style="margin:0 6px 6px 0;display:inline-block">' + txt + '</span>';
  let h = '<div class="upd-card"><div class="site-card-hd"><h3>Self-repair</h3><span><button class="btn small" onclick="oodaRun(this)">Run a cycle now</button> <button class="btn small" onclick="loadOoda()">↻</button></span></div>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox"' + (on ? ' checked' : '') + ' onchange="oodaSet(this.checked)"><span class="slider"></span></label><label>' + (on ? 'On — repairs automatically' : '<b style="color:var(--md-error-bright)">Off</b> — observes and reports only') + '</label></div>'
    + '<div class="dim" style="font-size:14px">Last cycle: ' + when(st.lastCycle) + (st.durationMs != null ? ' (' + (st.durationMs / 1000).toFixed(1) + ' s)' : '') + ' · every ' + d.cycleSeconds + ' s · '
    + 'a problem must be seen twice in a row · at most ' + d.maxAttempts + ' repairs per item per hour (waits 5, then 15 min), then it gives up and alerts · sites stopped on purpose and sites set to "do not touch" are left alone. Per-site setting: a site\'s Overrides tab.</div>'
    + (st.error ? '<div class="site-why">⚠ ' + esc(st.error) + '</div>' : '') + '</div>';
  // Observe
  const disk = ob.disk ? ob.disk.pct + '% used' : '?';
  h += '<div class="upd-grid" style="margin-top:14px">'
    + '<div class="upd-card"><h3>① Observe</h3>'
    + pill('Kuma: ' + (ob.kumaMonitors != null ? ob.kumaMonitors + ' monitors, ' + ob.kumaDown + ' down' : 'unavailable'), ob.kumaDown ? 'bad' : 'ok')
    + pill('Sites: ' + (ob.sites || 0) + ', ' + (ob.sitesDown || 0) + ' down/degraded', ob.sitesDown ? 'bad' : 'ok')
    + pill('Failed units: ' + ((ob.failedUnits || []).length), (ob.failedUnits || []).length ? 'bad' : 'ok')
    + pill('Disk /: ' + disk, ob.disk && ob.disk.pct >= d.diskPct ? 'bad' : 'ok')
    + (ob.kumaError ? '<div class="dim" style="font-size:13.5px">Kuma: ' + esc(ob.kumaError) + '</div>' : '')
    + ((ob.errors || []).length ? '<div class="dim" style="font-size:13.5px">' + esc(ob.errors.join(' · ')) + '</div>' : '') + '</div>';
  // Orient + Decide
  h += '<div class="upd-card"><h3>② Orient · ③ Decide</h3>';
  if (!inc.length) h += '<p class="dim">Nothing is red. ✅</p>';
  else {
    h += '<table class="upd-table"><tr><th>Target</th><th>Evidence</th><th>Seen</th><th>Decision</th></tr>';
    for (const i of inc) h += '<tr><td class="mono" style="font-size:13px">' + esc(i.target) + '</td><td style="font-size:13.5px">' + esc(i.evidence) + '</td><td class="dim" style="font-size:13px;white-space:nowrap">' + i.cycles + '× since ' + esc(new Date(i.since).toLocaleTimeString()) + '</td>'
      + '<td style="font-size:13.5px">' + (i.acting ? '<b>' + esc(i.decision) + '</b>' + (i.result ? '<br>' + (i.result.ok ? '✅ ' : '❌ ') + esc(i.result.detail) : '') : '<span class="dim">' + esc(i.decision) + '</span>') + '</td></tr>';
    h += '</table>';
  }
  h += '</div></div>';
  // Act (history)
  const icon = { fixed: '✅', failed: '❌', 'gave-up': '🛑', resolved: '🟢' };
  h += '<div class="upd-card" style="margin-top:14px"><h3>④ Act — history</h3>';
  if (!(d.log || []).length) h += '<p class="dim">No repairs yet.</p>';
  else {
    h += '<table class="upd-table"><tr><th>When</th><th></th><th>Target</th><th>Action</th><th>Result</th></tr>';
    for (const l of d.log) h += '<tr><td class="dim" style="font-size:13px;white-space:nowrap">' + when(l.at) + '</td><td>' + (icon[l.phase] || '') + '</td><td class="mono" style="font-size:13px">' + esc(l.target || l.key) + (l.site ? '<br><a href="sites?d=' + esc(encodeURIComponent(l.site)) + '">' + esc(l.site) + '</a>' : '') + '</td>'
      + '<td style="font-size:13.5px">' + esc(l.action || l.phase) + (l.attempt ? ' <span class="dim">(attempt ' + l.attempt + ')</span>' : '') + (l.evidence ? '<br><span class="dim">' + esc(l.evidence) + '</span>' : '') + '</td><td style="font-size:13.5px">' + esc(l.text || '') + '</td></tr>';
    h += '</table>';
  }
  view.innerHTML = h + '</div>';
}
async function oodaSet(on){
  try { oodaData = await stApi('PUT', 'api/ooda', { enabled: on }); toast('Self-repair ' + (on ? 'on' : 'off'), on ? 'success' : 'warn'); renderOoda(true); }
  catch(e){ stErr(e, 'Self-repair'); loadOoda(); }
}
async function oodaRun(btn){
  btn.disabled = true; toast('Running a cycle…');
  try { oodaData = await stApi('POST', 'api/ooda/run'); oodaAt = Date.now(); renderOoda(true); toast('Cycle done', 'success'); }
  catch(e){ stErr(e, 'Self-repair'); }
  btn.disabled = false;
}
