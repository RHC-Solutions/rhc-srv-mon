/* ---------------------------------------------------------------- backups */
let lastBackup = null;
function bkBytes(n){ if(!n) return '0 B'; const u=['B','KB','MB','GB','TB']; let i=0; n=Number(n); while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(i?1:0)+' '+u[i]; }
function scopeChk(id,label,on){ return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="'+id+'" '+(on?'checked':'')+'> '+label+'</label>'; }

function renderBackup(){
  const view = document.getElementById('backupview');
  if (!lastBackup){ view.innerHTML = '<div class="upd-card">Loading…</div>'; return; }
  // don't clobber a field the user is mid-edit on during the 10s auto-refresh
  if (view.contains(document.activeElement) && ['INPUT','SELECT','TEXTAREA'].includes((document.activeElement.tagName||''))) return;
  const d = lastBackup, sc = d.scope||{}, sch = d.schedule||{}, lr = d.lastRun;
  document.getElementById('host').textContent = 'backups';
  document.getElementById('updated').textContent = 'Wasabi · ' + (sch.enabled ? 'daily at ' + String(sch.hour).padStart(2,'0') + ':' + String(sch.minute).padStart(2,'0') : 'schedule off') + ' · keep ' + (d.retentionDays||14) + ' days';
  showBanner(null);
  setStatus(d.running ? [{ level:'info', icon:'⏳', text:'Backup running' }]
    : lr ? [{ level: lr.success ? 'ok' : 'bad', icon: lr.success ? '✅' : '🔴', text: lr.success ? 'Last backup ok' : 'Last backup failed', sub: new Date(lr.finishedAt).toLocaleString() + ' · ' + bkBytes(lr.bytes) }]
    : [{ level:'info', text:'No backup yet' }]);
  let html = '';

  html += '<div class="upd-card" style="grid-column:1/-1">';
  html += '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">';
  html += '<h3 style="margin:0">💾 Backup to Wasabi</h3>';
  html += '<span style="font-size:12px;color:#6b7280">remote:rhcsolutions/web01-backups · s3.eu-central-1.wasabisys.com</span>';
  html += '<div style="margin-left:auto;display:flex;gap:8px">';
  if (d.running) html += '<button class="btn running" disabled>⏳ backing up…</button>';
  else html += '<button class="btn update" id="bkRun">▶ Back up now</button>';
  html += '<button class="btn" id="bkList">↻ List remote</button>';
  html += '</div></div>';
  if (lr){
    html += '<div style="margin-top:10px;font-size:13px">';
    html += '<span class="upd-badge '+(lr.success?'ok':'na')+'">'+(lr.success?'✓ last backup ok':'⚠ last backup had errors')+'</span> ';
    html += '<span style="color:#9ca3af"> '+new Date(lr.finishedAt||lr.startedAt).toLocaleString()+' · '+lr.itemCount+' items · '+bkBytes(lr.bytes)+' · '+Math.round((lr.duration_ms||0)/1000)+'s · '+esc(lr.trigger)+'</span>';
    if (lr.errors && lr.errors.length) html += '<ul style="margin:6px 0 0;color:#f87171">'+lr.errors.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>';
    html += '</div>';
  } else { html += '<div style="margin-top:10px;color:#9ca3af;font-size:13px">No backups run yet.</div>'; }
  html += '</div>';

  html += '<div class="upd-card" style="grid-column:1/-1;margin-top:14px">';
  html += '<h3 style="margin:0 0 10px">What to back up</h3>';
  const av = d.available || { databases: [], sites: [] };
  const pgSel = Array.isArray(sc.pgDatabases) ? sc.pgDatabases : null;
  const siteSel = Array.isArray(sc.siteDomains) ? sc.siteDomains : null;
  const box = '<div style="background:#12141d;border:1px solid #232838;border-radius:8px;padding:12px">';
  const sub = '<div style="margin:8px 0 0 22px;display:flex;flex-direction:column;gap:4px;font-size:12.5px;max-height:220px;overflow:auto">';
  const mono = 'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px';
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin-bottom:14px">';
  // Postgres
  html += box + scopeChk('bkScopePg','<strong>Postgres databases</strong> <span class="hint">pg_dump -Fc, one file per DB</span>',sc.postgres);
  html += sub + '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="bkPgAll" '+(pgSel?'':'checked')+'> all databases ('+av.databases.length+')</label>';
  for (const db of av.databases) html += '<label style="display:flex;gap:6px;align-items:center;margin-left:16px"><input type="checkbox" class="bkPgDb" data-db="'+esc(db)+'" '+(!pgSel||pgSel.includes(db)?'checked':'')+' '+(pgSel?'':'disabled')+'> <span style="'+mono+'">'+esc(db)+'</span></label>';
  html += '</div></div>';
  // Sites
  html += box + scopeChk('bkScopeSites','<strong>CloudPanel site files</strong> <span class="hint">tar+zstd · excludes node_modules, .next, .git, caches</span>',sc.sites);
  html += sub + '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="bkSitesAll" '+(siteSel?'':'checked')+'> all sites ('+av.sites.length+')</label>';
  for (const st of av.sites) html += '<label style="display:flex;gap:6px;align-items:center;margin-left:16px"><input type="checkbox" class="bkSite" data-domain="'+esc(st.domain)+'" '+(!siteSel||siteSel.includes(st.domain)?'checked':'')+' '+(siteSel?'':'disabled')+'> '+esc(st.domain)+' <span class="hint" style="'+mono+'">'+esc(st.user||'')+'</span></label>';
  html += '</div></div>';
  // Configs
  html += box + scopeChk('bkScopeCfg','<strong>App + system configs</strong> <span class="hint">/etc/nginx, systemd units, rclone.conf, this app</span>',sc.configs);
  html += sub;
  html += scopeChk('bkCfgClp','CloudPanel database <span class="hint">db.sq3 snapshot: sites, users, vhosts</span>',sc.cloudpanelDb!==false);
  html += scopeChk('bkCfgCron','crontabs <span class="hint">/var/spool/cron/crontabs, /etc/cron.d, /etc/crontab</span>',sc.crontabs!==false);
  html += scopeChk('bkCfgPm2','PM2 process lists <span class="hint">~/.pm2/dump.pm2 for root + every site user</span>',sc.pm2!==false);
  html += scopeChk('bkCfgF2b','fail2ban config <span class="hint">/etc/fail2ban</span>',sc.fail2ban!==false);
  html += '</div></div>';
  // Extra paths
  html += box + '<strong>Extra paths</strong> <span class="hint">one absolute path per line → extra/extra.tar.zst</span>';
  html += '<textarea id="bkExtraPaths" rows="6" spellcheck="false" style="width:100%;box-sizing:border-box;margin-top:8px;'+mono+';background:#0b0d14;color:#e5e7eb;border:1px solid #2a2f3d;border-radius:6px;padding:6px" placeholder="/etc/letsencrypt&#10;/opt/some-app/config">'+esc((sc.extraPaths||[]).join('\n'))+'</textarea>';
  html += '<div class="hint" style="font-size:11.5px;margin-top:4px">missing paths are reported in the run errors, never fatal · /proc, /sys, /dev, /run, /tmp are refused</div>';
  html += '</div>';
  html += '</div>';
  html += '<h3 style="margin:0 0 10px">Schedule &amp; retention</h3>';
  html += '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">';
  html += '<label class="switch"><input type="checkbox" id="bkSchedEnable" '+(sch.enabled?'checked':'')+'><span class="slider"></span></label><span>Daily at</span>';
  html += '<input id="bkSchedHour" type="number" min="0" max="23" value="'+(sch.hour!=null?sch.hour:3)+'" style="width:56px">:';
  html += '<input id="bkSchedMin" type="number" min="0" max="59" value="'+(sch.minute!=null?sch.minute:30)+'" style="width:56px">';
  html += '<span style="margin-left:14px">Keep</span> <input id="bkRetention" type="number" min="1" max="365" value="'+(d.retentionDays!=null?d.retentionDays:14)+'" style="width:64px"> <span>days</span>';
  html += '<button class="btn update" id="bkSave" style="margin-left:auto">Save</button>';
  html += '</div></div>';

  // per-site backups: one row per site, last ad-hoc run, "Back up now" (files only; DB dumps come with the Databases slice)
  {
    const sites = (d.available && d.available.sites) || [];
    const lastFor = (dom) => (d.log || []).slice().reverse().find(e => e.site === dom);
    html += '<div class="upd-card" style="grid-column:1/-1;margin-top:14px"><div class="site-card-hd"><h3 style="margin:0">Back up a single site</h3><span class="dim" style="font-size:12px">files under htdocs (node_modules, .next, cache… excluded) → Wasabi <code>' + esc((d.lastRun && d.lastRun.stamp ? '' : '') + 'web01-backups/&lt;stamp&gt;-&lt;domain&gt;') + '</code>, same retention</span></div>'
      + '<table class="upd-table bk-sites"><tr><th>Site</th><th>Type</th><th>Last site backup</th><th></th></tr>';
    for (const st of sites.slice().sort((a, b) => a.domain.localeCompare(b.domain))) {
      const l = lastFor(st.domain);
      html += '<tr><td><b>' + esc(st.domain) + '</b> <span class="dim">' + esc(st.user || '') + '</span></td><td>' + esc(st.type || '') + '</td><td>'
        + (l ? new Date(l.finishedAt).toLocaleString() + ' · ' + bkBytes(l.bytes) + ' · ' + (l.success ? '<span class="upd-badge ok">ok</span>' : '<span class="upd-badge err" title="' + esc((l.errors||[]).join('; ')) + '">failed</span>') : '<span class="dim">never</span>') + '</td>'
        + '<td style="text-align:right"><button class="btn small bk-site-run" data-domain="' + esc(st.domain) + '"' + (d.running ? ' disabled' : '') + '>' + (d.running ? '⏳' : '▶ Back up now') + '</button></td></tr>';
    }
    if (!sites.length) html += '<tr><td colspan="4" class="dim">No sites</td></tr>';
    html += '</table></div>';
  }

  if (window._bkRemote){
    html += '<div class="upd-card" style="grid-column:1/-1;margin-top:14px"><h3 style="margin:0 0 8px">In Wasabi ('+window._bkRemote.length+')</h3>';
    html += '<div style="font-size:12.5px;color:#cbd5e1;max-height:220px;overflow:auto">'+(window._bkRemote.length?window._bkRemote.map(n=>'<div>📁 '+esc(n)+'</div>').join(''):'<span style="color:#6b7280">none yet</span>')+'</div></div>';
  }
  if (d.log && d.log.length){
    html += '<div class="upd-card" style="grid-column:1/-1;margin-top:14px"><h3 style="margin:0 0 8px">Recent runs</h3><table class="upd-table"><tr><th>When</th><th>Trigger</th><th>Scope</th><th>Items</th><th>Size</th><th>Duration</th><th>Status</th></tr>';
    for (const e of d.log.slice().reverse().slice(0,20)){
      html += '<tr><td>'+new Date(e.finishedAt||e.startedAt).toLocaleString()+'</td><td>'+esc(e.trigger)+'</td><td>'+(e.site ? '<span class="mono">'+esc(e.site)+'</span>' : 'full')+'</td><td>'+e.itemCount+'</td><td>'+bkBytes(e.bytes)+'</td><td>'+Math.round((e.duration_ms||0)/1000)+'s</td><td>'+(e.success?'<span class="upd-badge ok">✓</span>':'<span class="upd-badge na" title="'+esc((e.errors||[]).join('; '))+'">⚠</span>')+'</td></tr>';
    }
    html += '</table></div>';
  }

  view.innerHTML = html;
  document.querySelectorAll('.bk-site-run').forEach(b => b.addEventListener('click', () => armConfirm(b, '⚠ Click again to back up', () => runSiteBackupNow(b.dataset.domain))));
  const run = document.getElementById('bkRun');
  if (run) run.addEventListener('click', () => armConfirm(run, '⚠ Click again to start', runBackupNow));
  const save = document.getElementById('bkSave');
  if (save) save.addEventListener('click', saveBackupConfig);
  const list = document.getElementById('bkList');
  if (list) list.addEventListener('click', loadRemoteList);
  // "all" toggles enable/disable the per-item pickers
  for (const pair of [['bkPgAll','.bkPgDb'],['bkSitesAll','.bkSite']]) {
    const all = document.getElementById(pair[0]);
    if (all) all.addEventListener('change', () => { for (const c of view.querySelectorAll(pair[1])) { c.disabled = all.checked; if (all.checked) c.checked = true; } });
  }
}
async function runBackupNow(){
  try { const r = await fetch('api/backup/run',{method:'POST'}); const j = await r.json();
    if (j.error) toast(j.error,'error'); else toast('Backup started','success');
    setTimeout(refresh, 1500);
  } catch(e){ toast('Error: '+e,'error'); }
}
function saveBackupConfig(){
  const pgAll = document.getElementById('bkPgAll'), siteAll = document.getElementById('bkSitesAll');
  const body = {
    schedule: { enabled: document.getElementById('bkSchedEnable').checked,
      hour: parseInt(document.getElementById('bkSchedHour').value)||0,
      minute: parseInt(document.getElementById('bkSchedMin').value)||0 },
    retentionDays: parseInt(document.getElementById('bkRetention').value)||14,
    scope: { postgres: document.getElementById('bkScopePg').checked,
      sites: document.getElementById('bkScopeSites').checked,
      configs: document.getElementById('bkScopeCfg').checked,
      pgDatabases: (pgAll && !pgAll.checked) ? Array.from(document.querySelectorAll('.bkPgDb')).filter(c=>c.checked).map(c=>c.dataset.db) : null,
      siteDomains: (siteAll && !siteAll.checked) ? Array.from(document.querySelectorAll('.bkSite')).filter(c=>c.checked).map(c=>c.dataset.domain) : null,
      cloudpanelDb: document.getElementById('bkCfgClp').checked,
      crontabs: document.getElementById('bkCfgCron').checked,
      pm2: document.getElementById('bkCfgPm2').checked,
      fail2ban: document.getElementById('bkCfgF2b').checked,
      extraPaths: document.getElementById('bkExtraPaths').value.split('\n').map(x=>x.trim()).filter(Boolean) },
  };
  fetch('api/backup/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(()=>toast('Saved','success'));
  if (lastBackup){ lastBackup.schedule=Object.assign({},lastBackup.schedule,body.schedule); lastBackup.retentionDays=body.retentionDays; lastBackup.scope=body.scope; }
}
async function loadRemoteList(){
  toast('Listing Wasabi…');
  try { const r = await fetch('api/backup/remote'); window._bkRemote = await r.json(); renderBackup(); } catch(e){ toast('Error: '+e,'error'); }
}


async function runSiteBackupNow(domain){
  try {
    const r = await fetch('api/backup/site/' + encodeURIComponent(domain), { method:'POST' });
    const j = await r.json(); if (!r.ok) return toast(j.error || 'Failed', 'error');
    toast('Site backup started: ' + domain, 'success'); setTimeout(refresh, 1500);
  } catch(e){ toast('Error: ' + e, 'error'); }
}
