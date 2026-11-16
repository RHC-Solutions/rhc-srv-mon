// ---- Self-repair: the OODA loop (Observe → Orient → Decide → Act), once a minute on the server.
let oodaData = null, oodaLoading = false, oodaAt = 0;
async function loadOoda(){
  oodaLoading = true;
  try { oodaData = await stApi('GET', 'api/ooda'); oodaAt = Date.now(); } catch(e){ oodaData = { error: e.message }; }
  oodaLoading = false;
  if (state.tab === 'ooda') renderOoda(true);
}
function renderOoda(fromLoad){
  plainTabHeader('Observe → Orient → Decide → Act, every minute · restarts, reloads and freeing CPU / memory / disk — never deletes data or changes config');
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
  h += resguardHtml(d.resguard);
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

// ---- Resource watchdog (lib/resguard.js): CPU / memory / disk every 15 s, frees resources under pressure.
function resguardHtml(g){
  if (!g) return '';
  const c = g.config || {}, st = g.state || {}, m = st.mem || {}, k = c.steps || {}, mode = st.mode || {};
  const mbs = (b) => b == null ? '?' : (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB');
  const lvl = (x) => ({ ok: 'ok', watch: 'warn', warn: 'warn' })[x] || 'bad';
  const pill = (txt, l) => '<span class="st ' + l + '" style="margin:0 6px 6px 0;display:inline-block">' + txt + '</span>';
  const num = (key, label, unit, w) => '<label style="white-space:nowrap;margin-right:14px">' + label + ' <input type="number" style="width:' + (w || 64) + 'px" value="' + esc(String(c[key])) + '" onchange="resguardSet({' + key + ': this.value})"> ' + unit + '</label>';
  const step = (key, label) => '<label style="white-space:nowrap;margin-right:14px"><input type="checkbox"' + (k[key] ? ' checked' : '') + ' onchange="resguardSet({steps:{' + key + ': this.checked}})"> ' + label + '</label>';
  let h = '<div class="upd-card" style="margin-top:14px"><div class="site-card-hd"><h3>Resource watchdog</h3><span class="dim" style="font-size:13px">every ' + g.tickSeconds + ' s · ' + (st.at ? esc(new Date(st.at).toLocaleTimeString()) : '–') + '</span></div>'
    + '<div class="upd-toggle"><label class="switch"><input type="checkbox"' + (c.enabled ? ' checked' : '') + ' onchange="resguardSet({enabled: this.checked})"><span class="slider"></span></label><label>' + (c.enabled ? 'On — frees CPU, memory and disk when they run short' : '<b style="color:var(--md-error-bright)">Off</b> — measures only') + '</label></div>'
    + pill('Memory: ' + (m.availPct != null ? m.availPct + '% available (' + mbs(m.avail) + ' of ' + mbs(m.total) + ')' : '?') + (st.psiMem ? ' · pressure ' + st.psiMem.avg10 + '%' : ''), lvl(mode.mem))
    + pill('Swap: ' + (m.swapTotal ? mbs(m.swapUsed) + ' of ' + mbs(m.swapTotal) : 'none'), m.swapTotal && m.swapUsed > m.swapTotal / 2 ? 'warn' : 'ok')
    + pill('CPU: ' + (st.cpu != null ? st.cpu + '%' : '?') + ' · load ' + (st.load || []).map(x => x.toFixed(1)).join(' ') + ' / ' + (st.cores || '?') + ' cores', lvl(mode.cpu))
    + pill('Disk /: ' + (st.disk ? st.disk.pct + '% (' + mbs(st.disk.freeBytes) + ' free)' : '?'), lvl(mode.disk))
    + (st.error ? '<div class="site-why">⚠ ' + esc(st.error) + '</div>' : '')
    + '<details style="margin-top:6px"><summary class="dim" style="cursor:pointer">Thresholds and steps</summary><div style="margin-top:8px;line-height:2.2">'
    + num('memAvailPct', 'Memory: act below', '% available', 56) + num('memPsi', 'or pressure ≥', '%', 56)
    + num('appMemMB', 'restart a site app above', 'MB', 76) + num('idleDevMinutes', 'dev processes idle ≥', 'min', 60) + '<br>'
    + num('cpuPct', 'CPU: act at ≥', '%', 56) + num('cpuMinutes', 'for', 'min', 56) + '<br>'
    + num('diskWarnPct', 'Disk: alert at', '%', 56) + num('diskPct', 'clean up at', '%', 56) + '<br>'
    + step('oomPriority', 'OOM killer takes dev tooling first') + step('helpers', 'kill language servers') + step('idleDev', 'stop idle remote Claude / MCP')
    + step('leakyApp', 'restart a site app over the memory limit') + step('renice', 'lower priority of dev/builds') + step('runawayApp', 'restart a site app stuck at 100% CPU') + step('diskExtra', 'journal / huge logs / old VS Code builds / apt')
    + '<div class="dim" style="font-size:13px">Never touched: root processes, the panel, sshd, nginx, databases. Site apps only via pm2 restart, at most once per 30 min each, and not when the site is stopped or self-repair is off for it.</div></div></details>';
  const tbl = (rows, title) => '<div style="flex:1;min-width:300px"><div class="dim" style="font-size:13px;margin:8px 0 4px">' + title + '</div><table class="upd-table">'
    + rows.map(p => '<tr><td class="mono" style="font-size:12.5px;white-space:nowrap">' + mbs(p.rss) + '</td><td class="mono" style="font-size:12.5px">' + p.cpu + '%</td><td style="font-size:12.5px">' + esc(p.user) + '</td><td class="mono dim" style="font-size:12px;word-break:break-all">' + esc(p.cmd) + '</td></tr>').join('') + '</table></div>';
  if (st.top) h += '<div style="display:flex;gap:14px;flex-wrap:wrap">' + tbl(st.top.mem || [], 'Top memory') + tbl(st.top.cpu || [], 'Top CPU (last 15 s, % of one core)') + '</div>';
  if ((g.log || []).length) h += '<div class="dim" style="font-size:13px;margin:10px 0 4px">What it did</div><table class="upd-table">'
    + g.log.slice(0, 15).map(l => '<tr><td class="dim" style="font-size:13px;white-space:nowrap">' + esc(new Date(l.at).toLocaleString()) + '</td><td>' + esc(l.kind) + '</td><td style="font-size:13px;white-space:pre-wrap">' + esc(l.text) + '</td></tr>').join('') + '</table>';
  return h + '</div>';
}
async function resguardSet(p){
  for (const k of Object.keys(p)) if (k !== 'steps' && k !== 'enabled') p[k] = Number(p[k]);
  try { oodaData = await stApi('PUT', 'api/ooda/resguard', p); oodaAt = Date.now(); renderOoda(true); toast('Resource watchdog saved', 'success'); }
  catch(e){ stErr(e, 'Resource watchdog'); loadOoda(); }
}
