/* ----------------------------------------------------------------- modules */

let lastModules = null;

function modSeverityRank(s){ return s==='major'?3:s==='minor'?2:s==='patch'?1:0; }

function renderModules(){
  const view = document.getElementById('modulesview');
  if (!lastModules) { view.innerHTML = '<div class="mod-empty">Loading…</div>'; return; }
  const d = lastModules;
  const active = d.activeUpdates || {};
  const isUpdating = (dir) => !!active[dir];

  document.getElementById('host').textContent = '';
  const ts = d.generated_at ? new Date(d.generated_at).toLocaleString() : 'never';
  let stamp = 'Last scan: ' + ts + ' · refresh every 6h';
  if (d.scanInProgress) {
    const sp = d.scanProgress || {};
    stamp = 'Scanning… ' + (sp.done||0) + '/' + (sp.total||'?') + (sp.current ? ' · ' + sp.current : '');
  }
  const activeCount = Object.keys(active).length;
  if (activeCount) stamp += ' · ' + activeCount + ' update' + (activeCount>1?'s':'') + ' running…';
  if (d.updateAllRunning && d.updateAllProgress) {
    const up = d.updateAllProgress;
    stamp += ' · Update-all ' + (up.done||0) + '/' + (up.total||'?') + (up.current ? ' · ' + up.current : '');
  }
  document.getElementById('updated').textContent = stamp;

  showBanner(null);
  const s = d.summary || {};
  const totalOutdated = s.outdatedTotal || 0;
  if (!d.generated_at) setStatus([{ level:'info', icon:'⏳', text:'First module scan running', sub:'versions come from the npm registry — a few minutes' }]);
  else if (totalOutdated === 0) setStatus([{ level:'ok', icon:'✅', text:'All modules up to date', sub:(s.projects||0)+' projects scanned' }]);
  else {
    const parts = [];
    if (s.major) parts.push(s.major + ' major');
    if (s.minor) parts.push(s.minor + ' minor');
    if (s.patch) parts.push(s.patch + ' patch');
    setStatus([{ level:'warn', icon:'📦', text: totalOutdated + ' outdated dependencies', sub: parts.join(' · ') }]);
  }

  // Summary stats grid (Observe)
  let html = '<div class="mod-summary">';
  html += '<div class="mod-stat"><div class="v">'+(s.projects||0)+'</div><div class="l">Projects</div></div>';
  html += '<div class="mod-stat ok"><div class="v">'+((s.projects||0)-(s.projectsOutdated||0))+'</div><div class="l">Up to date</div></div>';
  html += '<div class="mod-stat major"><div class="v">'+(s.major||0)+'</div><div class="l">Major bumps</div></div>';
  html += '<div class="mod-stat minor"><div class="v">'+(s.minor||0)+'</div><div class="l">Minor</div></div>';
  html += '<div class="mod-stat patch"><div class="v">'+(s.patch||0)+'</div><div class="l">Patch</div></div>';
  if (s.errors) html += '<div class="mod-stat err"><div class="v">'+s.errors+'</div><div class="l">Scan errors</div></div>';
  html += '</div>';

  // Auto-update card (settings + last-pass status)
  const au = d.autoUpdate || { enabled:false, hour:3, min:0, severities:['patch'], autoFix:true, excludedDirs:[], excludedPackages:[], notifyTelegram:false, notifyOnFailureOnly:true };
  const auLog = (d.autoUpdateLog || []).slice();
  const lastAu = auLog.length ? auLog[auLog.length-1] : null;
  const auRunning = !!d.autoUpdateRunning;
  const tel = (d.telegramAvailable !== undefined) ? d.telegramAvailable : true; // hint
  html += '<div class="auto-card '+(au.enabled?'':'disabled')+'">';
  html += '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:12px">';
  html += '<h3 style="margin:0;font-size:17px;font-weight:700">🤖 Auto Update</h3>';
  html += '<label class="switch" title="Master switch"><input type="checkbox" id="auEnabled" '+(au.enabled?'checked':'')+'><span class="slider"></span></label>';
  html += '<span class="hint" style="font-size:14px">'+(au.enabled?'Enabled — runs at '+String(au.hour).padStart(2,'0')+':'+String(au.min).padStart(2,'0')+' server time':'Disabled')+'</span>';
  if (lastAu) {
    const fail = lastAu.projectsFailed || 0;
    const ok = lastAu.projectsSucceeded || 0;
    const upd = lastAu.packagesUpdated || 0;
    html += '<span class="auto-stat" style="margin-left:auto" title="Last pass">last pass <span class="v">'+new Date(lastAu.timestamp).toLocaleString()+'</span> · ✅ <span class="v">'+ok+'</span> · ❌ <span class="v">'+fail+'</span> · 📦 <span class="v">'+upd+'</span></span>';
  } else {
    html += '<span class="auto-stat" style="margin-left:auto">no auto-update has run yet</span>';
  }
  html += '</div>';

  html += '<div class="auto-row"><label>Run at</label>';
  html += '<input type="number" id="auHour" min="0" max="23" value="'+au.hour+'">:';
  html += '<input type="number" id="auMin" min="0" max="59" value="'+au.min+'">';
  html += '<span class="hint">server time, ±2 min window</span></div>';

  html += '<div class="auto-row"><label>Severities</label>';
  for (const sev of ['patch','minor','major']) {
    const ch = au.severities.includes(sev)?'checked':'';
    html += '<label style="display:flex;align-items:center;gap:6px;font-weight:500"><input type="checkbox" class="auSev" data-sev="'+sev+'" '+ch+'> <span class="sev '+sev+'">'+sev+'</span></label>';
  }
  html += '<span class="hint" style="margin-left:auto">patch is safest (semver guarantees backwards compat)</span></div>';

  html += '<div class="auto-row"><label class="switch"><input type="checkbox" id="auAutoFix" '+(au.autoFix?'checked':'')+'><span class="slider"></span></label>';
  html += '<label for="auAutoFix">Auto-fix common npm errors</label>';
  html += '<span class="hint">retry with <code style="background:#12141d;padding:1px 6px;border-radius:4px">--force</code> on ERESOLVE; resync lockfile on EUSAGE; one retry on network errors; pnpm build scripts (ERR_PNPM_IGNORED_BUILDS) are always approved + rebuilt</span></div>';

  html += '<div class="auto-row"><label class="switch"><input type="checkbox" id="auNotify" '+(au.notifyTelegram?'checked':'')+'><span class="slider"></span></label>';
  html += '<label for="auNotify">Telegram notify</label>';
  html += '<label style="display:flex;align-items:center;gap:6px;font-weight:500"><input type="checkbox" id="auFailOnly" '+(au.notifyOnFailureOnly?'checked':'')+'> failures only</label>';
  html += '<span class="hint">uses bot config from the Updates tab</span></div>';

  html += '<div class="auto-row" style="flex-direction:column;align-items:stretch"><label style="margin-bottom:6px">Excluded packages <span class="hint">never auto-update these (comma-separated, e.g. <code style="background:#12141d;padding:1px 6px;border-radius:4px">next, react, react-dom</code>)</span></label>';
  html += '<input type="text" id="auExclPkgs" value="'+esc((au.excludedPackages||[]).join(', '))+'" placeholder="next, react, react-dom"></div>';

  // Excluded projects
  const auProjects = (d.projects||[]).slice().sort((a,b) => a.user.localeCompare(b.user) || a.relDir.localeCompare(b.relDir));
  if (auProjects.length) {
    html += '<div class="auto-row" style="flex-direction:column;align-items:stretch"><label style="margin-bottom:6px">Excluded projects <span class="hint">tick to skip a project from auto-update</span></label>';
    html += '<div class="auto-projlist">';
    for (const p of auProjects) {
      const ch = (au.excludedDirs||[]).includes(p.dir)?'checked':'';
      html += '<label><input type="checkbox" class="auExclDir" data-dir="'+esc(p.dir)+'" '+ch+'><span style="color:#6b7280;font-size:13px;font-family:ui-monospace,Menlo,Consolas,monospace">'+esc(p.relDir)+'</span></label>';
    }
    html += '</div></div>';
  }

  html += '<div class="auto-row" style="margin-top:6px"><button class="btn" id="auSave" style="background:#5cdd8b;color:#0b2818;padding:8px 16px;font-size:14px">💾 Save settings</button>';
  html += '<button class="btn" id="auRunNow" '+(auRunning?'disabled':'')+' style="padding:8px 16px;font-size:14px">'+(auRunning?'⏳ running…':'⏱ Run now (one pass)')+'</button>';
  html += '<span class="hint" id="auRunHint" style="margin-left:auto"></span></div>';
  html += '</div>';

  // Toolbar (Orient): filter chips + search + refresh
  html += '<div class="mod-card"><div class="head">';
  html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1">';
  html += '<input id="modQ" type="search" placeholder="Filter package, project, user…" value="'+esc(state.modQ||'')+'" style="background:#12141d;border:1px solid #2a2f40;color:#e9e9e9;border-radius:10px;padding:8px 12px;font-size:15px;outline:none;flex:1 1 220px;min-width:160px">';
  for (const f of [['all','All'],['major','Major'],['minor','Minor'],['patch','Patch']]) {
    const cls = (state.modFilter===f[0])?'chip active'+(f[0]==='major'?' down-chip':''):'chip';
    html += '<button class="'+cls+'" data-modf="'+f[0]+'">'+f[1]+'</button>';
  }
  html += '</div>';
  const upAllRunning = !!d.updateAllRunning;
  const upAllBusy = upAllRunning || d.scanInProgress || activeCount > 0;
  let upAllLabel;
  if (upAllRunning) {
    const up = d.updateAllProgress || {};
    upAllLabel = '⏳ Updating ' + (up.done||0) + '/' + (up.total||'?') + '…';
  } else {
    upAllLabel = '⬆ Update all' + (totalOutdated ? ' (' + totalOutdated + ')' : '');
  }
  const upAllDisabled = upAllBusy || totalOutdated === 0;
  html += '<button class="btn" id="modUpdateAll" '+(upAllDisabled?'disabled':'')+' title="Update every outdated package in every scanned project to @latest" style="padding:7px 14px;font-size:14px;background:#3a2d10;color:#f8a306;border-color:#5a4e1f">'+upAllLabel+'</button>';
  html += '<button class="btn" id="modRefresh" '+(d.scanInProgress?'disabled':'')+' style="padding:7px 14px;font-size:14px">'+(d.scanInProgress?'⏳ Scanning…':'🔄 Rescan')+'</button>';
  html += '</div>';

  // Outdated table (Decide)
  const rows = (d.outdated||[]).slice();
  const q = (state.modQ||'').toLowerCase();
  let filtered = rows.filter(r => {
    if (state.modFilter !== 'all' && r.severity !== state.modFilter) return false;
    if (q) {
      const hay = (r.package+' '+r.user+' '+r.relDir+' '+(r.pkgName||'')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmps = {
    severity: (a,b) => modSeverityRank(b.severity)-modSeverityRank(a.severity)
                     || a.user.localeCompare(b.user)
                     || a.package.localeCompare(b.package),
    user:     (a,b) => a.user.localeCompare(b.user) || a.package.localeCompare(b.package),
    package:  (a,b) => a.package.localeCompare(b.package),
    project:  (a,b) => a.relDir.localeCompare(b.relDir) || a.package.localeCompare(b.package),
  };
  filtered.sort(cmps[state.modSort] || cmps.severity);

  if (!filtered.length) {
    html += '<div class="mod-empty">'+(rows.length?'No matches.':'No outdated dependencies in scanned projects.')+'</div>';
  } else {
    html += '<div style="overflow-x:auto"><table class="mod-table">';
    const hdr = (k,l) => '<th data-modsort="'+k+'" class="'+(state.modSort===k?'active':'')+'">'+l+(state.modSort===k?' ▾':'')+'</th>';
    html += '<tr>'+hdr('severity','Sev')+hdr('package','Package')+'<th>Installed</th><th>Wanted</th><th>Latest</th>'+hdr('user','User')+hdr('project','Project')+'<th>PM</th><th style="width:130px;text-align:right"></th></tr>';
    for (const r of filtered) {
      const sev = r.severity || 'none';
      const isDev = (r.type||'').includes('dev');
      const pm = r.pm || 'npm';
      const cmd = pm === 'npm'
        ? "sudo -u " + r.user + " sh -c 'cd " + r.dir + " && npm install " + r.package + "@latest'"
        : "sudo -u " + r.user + " sh -c 'cd " + r.dir + " && " + pm + " add " + r.package + "@latest'";
      const updating = isUpdating(r.dir);
      const upBtn = updating
        ? '<button class="mod-cmd" disabled style="opacity:.6">⏳ updating…</button>'
        : '<button class="mod-cmd" data-update-pkg="'+esc(r.package)+'" data-update-dir="'+esc(r.dir)+'" data-update-user="'+esc(r.user)+'" title="Run: '+esc(pm)+' install '+esc(r.package)+'@latest" style="background:#1f4e34;color:#5cdd8b;border-color:#2e6e4a">⬆ Update</button>';
      const cpyBtn = '<button class="mod-cmd" data-cmd="'+esc(cmd)+'" title="Copy command">📋</button>';
      html += '<tr>'
        + '<td><span class="sev '+sev+'">'+(r.severity||'—')+'</span></td>'
        + '<td><span class="mod-pkg'+(isDev?' dev':'')+'">'+esc(r.package)+'</span>'+(isDev?' <span style="color:#6b7280;font-size:12px;text-transform:uppercase">dev</span>':'')+'</td>'
        + '<td class="mod-ver">'+esc(r.current||'—')+'</td>'
        + '<td class="mod-ver">'+esc(r.wanted||'—')+'</td>'
        + '<td class="mod-ver new">'+esc(r.latest||'—')+'</td>'
        + '<td>'+esc(r.user)+'</td>'
        + '<td><span class="mod-path" title="'+esc(r.dir)+'">'+esc(r.relDir)+'</span></td>'
        + '<td style="color:#6b7280;font-size:12.5px;text-transform:uppercase">'+esc(pm)+'</td>'
        + '<td style="text-align:right;white-space:nowrap">'+upBtn+' '+cpyBtn+'</td>'
        + '</tr>';
    }
    html += '</table></div>';
  }
  html += '</div>';

  // Per-project breakdown (Act): list every scanned project so you know what was looked at
  const projects = (d.projects||[]).slice().sort((a,b) => {
    const ao = a.outdated ? Object.keys(a.outdated).length : 0;
    const bo = b.outdated ? Object.keys(b.outdated).length : 0;
    return bo - ao || a.user.localeCompare(b.user) || a.relDir.localeCompare(b.relDir);
  });
  if (projects.length) {
    html += '<div class="mod-card"><h3>Scanned Projects <span style="font-weight:400;font-size:14px;color:#6b7280">'+projects.length+' total</span></h3>';
    html += '<div style="overflow-x:auto"><table class="mod-table">';
    html += '<tr><th>User</th><th>Project</th><th>Path</th><th>PM</th><th>Deps</th><th>Outdated</th><th>Last scan</th><th style="text-align:right"></th></tr>';
    for (const p of projects) {
      const od = p.outdated ? Object.keys(p.outdated).length : 0;
      const odLabel = p.error
        ? '<span class="sev major" title="'+esc(p.error)+'">err</span>'
        : (od ? '<span class="sev minor">'+od+'</span>' : '<span class="sev patch">0</span>');
      const updating = isUpdating(p.dir);
      const allBtn = updating
        ? '<button class="mod-cmd" disabled style="opacity:.6">⏳ updating…</button>'
        : (od ? '<button class="mod-cmd" data-update-all="'+esc(p.dir)+'" data-update-user="'+esc(p.user)+'" data-update-count="'+od+'" title="Update all '+od+' outdated packages to @latest" style="background:#3a2d10;color:#f8a306;border-color:#5a4e1f">⬆ Update all ('+od+')</button>'
              : '');
      html += '<tr>'
        + '<td>'+esc(p.user)+'</td>'
        + '<td><span class="mod-pkg">'+esc(p.pkgName||'—')+'</span>'+(p.pkgVersion?' <span style="color:#6b7280;font-size:12.5px">'+esc(p.pkgVersion)+'</span>':'')+'</td>'
        + '<td><span class="mod-path" title="'+esc(p.dir)+'">'+esc(p.relDir)+'</span></td>'
        + '<td style="color:#6b7280;font-size:12.5px;text-transform:uppercase">'+esc(p.pm||'npm')+'</td>'
        + '<td>'+(p.depCount||0)+'</td>'
        + '<td>'+odLabel+'</td>'
        + '<td><span style="color:#6b7280;font-size:13px">'+(p.scannedAt? new Date(p.scannedAt).toLocaleString() : '—')+'</span></td>'
        + '<td style="text-align:right">'+allBtn+'</td>'
        + '</tr>';
    }
    html += '</table></div></div>';
  }

  // Recent updates log
  const log = (d.updateLog || []).slice().reverse();
  const detail = !!state.modShowDetailLog;
  html += '<div class="mod-card"><div class="head"><h3 style="margin:0">Recent Updates <span style="font-weight:400;font-size:14px;color:#6b7280">'+log.length+' entries</span></h3>';
  html += '<div style="display:flex;gap:8px;align-items:center">';
  if (log.length) html += '<button class="btn" id="modDetailToggle" title="Show full command output for each update" style="font-size:12.5px;padding:4px 10px;'+(detail?'background:#1f3a4e;color:#7cc7ff;border-color:#2e5a6e':'')+'">'+(detail?'▾ Detailed log':'▸ Show detailed log')+'</button>';
  if (log.length) html += '<button class="btn" id="modClearLog" style="font-size:12.5px;padding:4px 10px;background:#3a2020;color:#ff8088">🗑 Clear</button>';
  html += '</div>';
  html += '</div>';
  if (!log.length) {
    html += '<div class="mod-empty">No updates have been run yet.</div>';
  } else if (detail) {
    // Detailed view: full package list, attempt chain, auto-fix note, and raw command output.
    for (const e of log) {
      const icon = e.success ? '✅' : '❌';
      const cls = e.success ? 'ok' : 'fail';
      const dur = e.duration_ms ? Math.round(e.duration_ms/1000)+'s' : '';
      const allPkgs = (e.packages||[]).join(', ');
      html += '<div class="upd-log-detail '+cls+'">';
      html += '<div class="top"><span class="ic">'+icon+'</span>'
        + '<span class="when">'+new Date(e.timestamp).toLocaleString()+'</span>'
        + '<strong>'+esc(e.user)+'</strong> · <span style="color:#9ca3af;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">'+esc(e.relDir)+'</span>'
        + (e.pm?' <span style="color:#6b7280;font-size:12.5px;text-transform:uppercase">'+esc(e.pm)+'</span>':'')
        + (dur?'<span class="auto-stat" style="margin-left:auto">⏱ <span class="v">'+dur+'</span></span>':'')
        + '</div>';
      if (allPkgs) html += '<div class="att">📦 '+esc(allPkgs)+'</div>';
      if (e.attempts && e.attempts.length) {
        html += '<div class="att">🔁 '+e.attempts.map(a => esc(a.strategy)+(a.success?'✓':'✗')+(a.error?'('+esc(a.error)+')':'')).join(' → ')+'</div>';
      }
      if (e.autoFix) html += '<div class="att">🔧 auto-fix: '+esc(e.autoFix)+'</div>';
      if (e.error) html += '<div class="att" style="color:#ff8088">⚠ '+esc(e.error)+'</div>';
      const out = (e.output||'').trim();
      if (out) html += '<pre>'+esc(out)+'</pre>';
      else if (!e.error) html += '<div class="att" style="color:#6b7280">(no command output captured)</div>';
      html += '</div>';
    }
  } else {
    html += '<div class="upd-log">';
    for (const e of log) {
      const icon = e.success ? '✅' : '❌';
      const colorStyle = e.success ? '' : ' style="color:#ff8088"';
      const dur = e.duration_ms ? Math.round(e.duration_ms/1000)+'s' : '';
      const pkgs = (e.packages||[]).slice(0,4).join(', ') + ((e.packages||[]).length>4 ? ' +'+((e.packages||[]).length-4)+' more' : '');
      html += '<div class="upd-log-entry">'
        + '<span class="time">' + new Date(e.timestamp).toLocaleString() + '</span>'
        + '<span class="comp"' + colorStyle + '>' + icon + ' ' + esc(e.user) + ' · ' + esc(e.relDir) + '</span>'
        + '<span class="result" title="'+esc((e.output||e.error||'').slice(0,2000))+'">'+esc(pkgs)+(dur?' · '+dur:'')+(e.error?' · '+esc(e.error):'')+'</span>'
        + '</div>';
    }
    html += '</div>';
  }
  html += '</div>';

  // Auto-update log (newest first)
  const auReversed = auLog.slice().reverse();
  html += '<div class="mod-card"><div class="head"><h3 style="margin:0">🤖 Auto-Update Log <span style="font-weight:400;font-size:14px;color:#6b7280">'+auReversed.length+' pass'+(auReversed.length===1?'':'es')+'</span></h3>';
  if (auReversed.length) html += '<button class="btn" id="auClearLog" style="font-size:12.5px;padding:4px 10px;background:#3a2020;color:#ff8088">🗑 Clear</button>';
  html += '</div>';
  if (!auReversed.length) {
    html += '<div class="mod-empty">No auto-update passes have run yet. Use <strong>Run now</strong> above to test.</div>';
  } else {
    for (const pass of auReversed) {
      const ok = pass.projectsSucceeded || 0;
      const fail = pass.projectsFailed || 0;
      const att = pass.projectsAttempted || 0;
      const upd = pass.packagesUpdated || 0;
      const fixes = pass.autoFixesApplied || 0;
      const dur = pass.duration_ms ? Math.round(pass.duration_ms/1000)+'s' : '';
      const triggeredIcon = pass.triggeredBy === 'manual' ? '👆 manual' : '⏰ scheduled';
      const overallIcon = fail === 0 ? '✅' : (ok === 0 ? '❌' : '⚠️');
      html += '<div class="au-log-entry"><div class="top">';
      html += '<span class="ic">'+overallIcon+'</span>';
      html += '<span class="when">'+new Date(pass.timestamp).toLocaleString()+'</span>';
      html += '<span class="hint">'+triggeredIcon+'</span>';
      html += '<span class="summary-pills">';
      html += '<span class="auto-stat">attempted <span class="v">'+att+'</span></span>';
      if (ok)    html += '<span class="auto-stat" style="color:#5cdd8b">✅ <span class="v">'+ok+'</span></span>';
      if (fail)  html += '<span class="auto-stat" style="color:#ff8088">❌ <span class="v">'+fail+'</span></span>';
      if (upd)   html += '<span class="auto-stat">📦 <span class="v">'+upd+'</span> pkgs</span>';
      if (fixes) html += '<span class="auto-stat">🔧 <span class="v">'+fixes+'</span> fixes</span>';
      if (dur)   html += '<span class="auto-stat">⏱ <span class="v">'+dur+'</span></span>';
      html += '</span></div>';
      const visibleResults = (pass.results||[]).filter(r => !r.skipped || (state.modShowSkipped));
      if (visibleResults.length) {
        html += '<details><summary>'+visibleResults.length+' project result'+(visibleResults.length===1?'':'s')+'</summary>';
        for (const r of visibleResults) {
          const cls = r.skipped ? '' : (r.success ? 'ok' : 'fail');
          const ic = r.skipped ? '⏭' : (r.success ? '✅' : '❌');
          html += '<div class="child '+cls+'">';
          html += '<div>'+ic+' <strong>'+esc(r.user)+'</strong> · <span style="color:#9ca3af;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px">'+esc(r.relDir)+'</span>';
          if (r.skipped) html += ' — <em style="color:#6b7280">skipped: '+esc(r.reason||'')+'</em>';
          html += '</div>';
          if (!r.skipped) {
            const pkgList = (r.packages||[]).slice(0,8).join(', ') + ((r.packages||[]).length>8 ? ' +'+((r.packages||[]).length-8)+' more' : '');
            html += '<div class="att">📦 '+esc(pkgList)+(r.duration_ms?' · '+Math.round(r.duration_ms/1000)+'s':'')+'</div>';
            if (r.attempts && r.attempts.length) {
              html += '<div class="att">🔁 '+r.attempts.map(a => esc(a.strategy) + (a.success?'✓':'✗')+(a.error?'('+esc(a.error)+')':'')).join(' → ')+'</div>';
            }
            if (r.autoFix) html += '<div class="att">🔧 auto-fix: '+esc(r.autoFix)+'</div>';
            if (!r.success && r.finalError) html += '<div class="att" style="color:#ff8088">⚠ '+esc(r.finalError)+'</div>';
            if (!r.success && r.outputTail) html += '<pre>'+esc(r.outputTail)+'</pre>';
          }
          html += '</div>';
        }
        html += '</details>';
      }
      html += '</div>';
    }
  }
  html += '</div>';

  view.innerHTML = html;

  // Wire interactive elements
  const mq = document.getElementById('modQ');
  if (mq) mq.addEventListener('input', e => { state.modQ = e.target.value; saveState(); renderModules(); });
  view.querySelectorAll('[data-modf]').forEach(b => b.addEventListener('click', () => { state.modFilter = b.dataset.modf; saveState(); renderModules(); }));
  view.querySelectorAll('[data-modsort]').forEach(t => t.addEventListener('click', () => { state.modSort = t.dataset.modsort; saveState(); renderModules(); }));
  view.querySelectorAll('[data-cmd]').forEach(b => b.addEventListener('click', () => {
    const txt = b.dataset.cmd;
    if (navigator.clipboard) navigator.clipboard.writeText(txt).then(() => {
      const old = b.textContent; b.textContent = '✓'; setTimeout(() => b.textContent = old, 1200);
    });
  }));
  view.querySelectorAll('[data-update-pkg]').forEach(b => b.addEventListener('click', () => {
    triggerModuleUpdate(b.dataset.updateDir, b.dataset.updateUser, [b.dataset.updatePkg]);
  }));
  view.querySelectorAll('[data-update-all]').forEach(b => b.addEventListener('click', () => {
    const n = b.dataset.updateCount;
    armConfirm(b, '⚠ Click again to confirm · ' + n + ' pkg' + (n==='1'?'':'s'),
      () => triggerModuleUpdate(b.dataset.updateAll, b.dataset.updateUser, []));
  }));
  const mr = document.getElementById('modRefresh');
  if (mr) mr.addEventListener('click', () => triggerModulesRescan());
  const mua = document.getElementById('modUpdateAll');
  if (mua) mua.addEventListener('click', () => {
    const n = totalOutdated;
    armConfirm(mua, '⚠ Click again · update '+n+' pkg'+(n===1?'':'s')+' across all projects',
      () => triggerUpdateAllModules());
  });
  const mdt = document.getElementById('modDetailToggle');
  if (mdt) mdt.addEventListener('click', () => { state.modShowDetailLog = !state.modShowDetailLog; saveState(); renderModules(); });
  const cl = document.getElementById('modClearLog');
  if (cl) cl.addEventListener('click', () => armConfirm(cl, '⚠ Click again to clear', async () => {
    await fetch('api/modules/log', { method: 'DELETE' });
    if (lastModules) lastModules.updateLog = [];
    renderModules();
    toast('Update log cleared', 'info');
  }));

  // Auto-update wiring
  const auSaveBtn = document.getElementById('auSave');
  if (auSaveBtn) auSaveBtn.addEventListener('click', () => saveAutoUpdateConfig());
  const auRunNow = document.getElementById('auRunNow');
  if (auRunNow) auRunNow.addEventListener('click', () => armConfirm(auRunNow, '⚠ Click again to run', () => runAutoUpdateNow()));
  const auClearLog = document.getElementById('auClearLog');
  if (auClearLog) auClearLog.addEventListener('click', () => armConfirm(auClearLog, '⚠ Click again to clear', async () => {
    await fetch('api/modules/auto/log', { method: 'DELETE' });
    if (lastModules) lastModules.autoUpdateLog = [];
    renderModules();
    toast('Auto-update log cleared', 'info');
  }));

}


function readAutoUpdateForm() {
  const view = document.getElementById('modulesview');
  const get = (id) => view.querySelector('#'+id);
  const en = get('auEnabled');
  const hr = get('auHour');
  const mn = get('auMin');
  const af = get('auAutoFix');
  const nt = get('auNotify');
  const fo = get('auFailOnly');
  const ep = get('auExclPkgs');
  const sevs = Array.from(view.querySelectorAll('.auSev')).filter(c => c.checked).map(c => c.dataset.sev);
  const exDirs = Array.from(view.querySelectorAll('.auExclDir')).filter(c => c.checked).map(c => c.dataset.dir);
  const exPkgs = (ep ? ep.value : '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  return {
    enabled: en ? en.checked : false,
    hour: hr ? parseInt(hr.value, 10) : 3,
    min:  mn ? parseInt(mn.value, 10) : 0,
    severities: sevs.length ? sevs : ['patch'],
    autoFix: af ? af.checked : true,
    notifyTelegram: nt ? nt.checked : false,
    notifyOnFailureOnly: fo ? fo.checked : true,
    excludedPackages: exPkgs,
    excludedDirs: exDirs,
  };
}

async function saveAutoUpdateConfig() {
  try {
    const cfg = readAutoUpdateForm();
    const res = await fetch('api/modules/auto/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const j = await res.json();
    if (!res.ok) { toast('Save failed: ' + (j.error || res.status), 'error'); return; }
    if (lastModules) lastModules.autoUpdate = j.autoUpdate;
    renderModules();
    toast('Auto-update settings saved', 'success');
  } catch (e) { toast('Error: ' + e.message, 'error'); }
}

async function runAutoUpdateNow() {
  // Persist current form state first so the pass uses the latest config
  await saveAutoUpdateConfig();
  toast('Auto-update pass started…', 'info');
  if (lastModules) lastModules.autoUpdateRunning = true;
  if (state.tab === 'modules') renderModules();
  ensureModulesPoll(true);
  try {
    const r = await fetch('api/modules/auto/run-now', { method: 'POST' });
    const j = await r.json();
    if (!r.ok) { toast('Run failed: ' + (j.error || r.status), 'error'); return; }
    if (j.skipped) { toast('Skipped: ' + (j.reason || 'unknown'), 'warn'); return; }
    const s = j.summary || {};
    const msg = '✅ ' + (s.projectsSucceeded||0) + ' / ❌ ' + (s.projectsFailed||0) + ' · 📦 ' + (s.packagesUpdated||0) + ' pkgs · ⏱ ' + Math.round((s.duration_ms||0)/1000) + 's';
    toast('Auto-update pass complete · ' + msg, (s.projectsFailed > 0 ? 'warn' : 'success'));
    // Refresh state
    try {
      const m = await fetch('api/modules').then(r => r.json());
      lastModules = m;
    } catch(_) {}
    if (state.tab === 'modules') renderModules();
  } catch(e) { toast('Error: ' + e.message, 'error'); }
}

let modulesPollTimer = null;
function ensureModulesPoll(active) {
  if (active && !modulesPollTimer) {
    modulesPollTimer = setInterval(async () => {
      try {
        const m = await fetch('api/modules').then(r => r.json());
        lastModules = m;
        if (state.tab === 'modules') renderModules();
        const stillActive = m.scanInProgress || m.autoUpdateRunning || m.updateAllRunning || (m.activeUpdates && Object.keys(m.activeUpdates).length);
        if (!stillActive) { clearInterval(modulesPollTimer); modulesPollTimer = null; }
      } catch(_) {}
    }, 3000);
  }
}

async function triggerModulesRescan(){
  try {
    const r = await fetch('api/modules/check', { method:'POST' });
    if (!r.ok && r.status !== 202) {
      const e = await r.json().catch(()=>({}));
      toast(e.error || 'Rescan failed', 'error');
      return;
    }
    if (lastModules) lastModules.scanInProgress = true;
    if (state.tab === 'modules') renderModules();
    ensureModulesPoll(true);
    toast('Rescan started', 'info');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

async function triggerModuleUpdate(dir, user, packages){
  // Optimistically mark this dir as updating
  if (lastModules) {
    lastModules.activeUpdates = lastModules.activeUpdates || {};
    lastModules.activeUpdates[dir] = { user, packages, startedAt: new Date().toISOString() };
  }
  if (state.tab === 'modules') renderModules();
  ensureModulesPoll(true);
  try {
    const res = await fetch('api/modules/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dir, user, packages: packages || [] }),
    });
    const result = await res.json();
    // Refresh state immediately
    try {
      const m = await fetch('api/modules').then(r => r.json());
      lastModules = m;
    } catch(_) {}
    if (state.tab === 'modules') renderModules();
    if (result.success) {
      const pkgs = (result.packages||[]).join(', ');
      toast('Update succeeded' + (pkgs ? ' · ' + pkgs : ''), 'success');
    } else {
      const out = (result.output || '').split('\n').slice(-6).join('\n');
      toast('Update failed: ' + (result.error || 'unknown'), 'error', { detail: out, duration: 12000 });
    }
  } catch(e) {
    toast('Error: '+e.message, 'error');
    // Clear the optimistic state
    if (lastModules && lastModules.activeUpdates) delete lastModules.activeUpdates[dir];
    if (state.tab === 'modules') renderModules();
  }
}

async function triggerUpdateAllModules(){
  try {
    const r = await fetch('api/modules/update-all', { method:'POST' });
    if (!r.ok && r.status !== 202) {
      const e = await r.json().catch(()=>({}));
      toast(e.error || 'Update all failed to start', 'error');
      return;
    }
    if (lastModules) lastModules.updateAllRunning = true;
    if (state.tab === 'modules') renderModules();
    ensureModulesPoll(true);
    toast('Updating all outdated packages…', 'info');
  } catch(e) { toast('Error: '+e.message, 'error'); }
}

