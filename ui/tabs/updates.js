/* ---------------------------------------------------------------- updates */

let lastUpdates = null;

function renderUpdates(){
  if (!lastUpdates) return;
  const d = lastUpdates;
  document.getElementById('host').textContent = 'updates';
  document.getElementById('updated').textContent = 'Last checked: ' + (d.lastChecked ? new Date(d.lastChecked).toLocaleString() : 'never') + ' · hourly auto-check';
  showBanner(null);
  const avail = (d.components||[]).filter(c => c.updateAvailable).length;
  if (avail === 0) setStatus([{ level:'ok', icon:'✅', text:'All components up to date', sub: d.components.length + ' tracked' }]);
  else setStatus([{ level:'warn', icon:'🔄', text: avail + ' update' + (avail>1?'s':'') + ' available', sub: d.components.filter(c => !c.updateAvailable).length + '/' + d.components.length + ' up to date' }]);

  let html = '<div class="upd-grid">';

  // Left column: components table
  html += '<div class="upd-card" style="grid-column:1/-1">';
  const updCount = d.components.filter(c => c.updateAvailable && c.key !== 'node').length;
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Components</h3>';
  if (updCount) {
    html += '<button class="btn update" onclick="triggerUpdateAll()" style="font-size:12px;padding:4px 14px">⬆ Update All (' + updCount + ')</button>';
  }
  html += '</div>';
  html += '<table class="upd-table"><tr><th>Component</th><th>Current</th><th>Latest</th><th>Status</th><th></th></tr>';
  for (const c of d.components) {
    const hasUpdate = c.updateAvailable;
    const isRunning = c.updating;
    const statusBadge = !c.currentVersion ? '<span class="upd-badge na">not installed</span>'
      : isRunning ? '<span class="upd-badge" style="background:#5a4e1f;color:#f8a306">updating…</span>'
      : hasUpdate ? '<span class="upd-badge new">update available</span>'
      : '<span class="upd-badge ok">up to date</span>';
    const btnHtml = !c.currentVersion ? ''
      : isRunning ? '<button class="btn running" disabled>⏳ updating</button>'
      : c.key === 'node' ? '<button class="btn" disabled>via nvm/fnm/n</button>'
      : hasUpdate ? '<button class="btn update" onclick="triggerUpdate(\'' + c.key + '\')">⬆ Update</button>'
      : '<button class="btn" disabled>✓ latest</button>';
    html += '<tr>'
      + '<td><strong>' + esc(c.label) + '</strong></td>'
      + '<td>' + esc(c.currentVersion || '—') + '</td>'
      + '<td>' + esc(c.latestVersion || '—') + '</td>'
      + '<td>' + statusBadge + '</td>'
      + '<td style="text-align:right">' + btnHtml + '</td>'
      + '</tr>';
  }
  html += '</table></div>';

  // Per-user versions table
  const userKeys = Object.keys(d.users || {});
  if (userKeys.length) {
    const allCompKeys = d.components.map(c => c.key);
    let userOutdatedCount = 0;
    for (const u of userKeys) {
      const uv = d.users[u] || {};
      for (const c of d.components) {
        if (c.key === 'node') continue;
        const userV = uv[c.key] || null;
        if (userV && c.latestVersion && userV !== c.latestVersion) userOutdatedCount++;
      }
    }
    html += '<div class="upd-card" style="grid-column:1/-1">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
    html += '<h3 style="margin:0">By User <span style="font-weight:400;font-size:12px;color:#6b7280">' + userKeys.length + ' users</span></h3>';
    if (userOutdatedCount) {
      html += '<button class="btn update" onclick="triggerUpdateAllUsers()" style="font-size:12px;padding:4px 14px">⬆ Update All Users (' + userOutdatedCount + ')</button>';
    }
    html += '</div>';
    html += '<div style="overflow-x:auto"><table class="upd-table">';
    html += '<tr><th>User</th>';
    for (const c of d.components) {
      if (c.key === 'node') { html += '<th>' + esc(c.label) + '</th>'; continue; }
      html += '<th>' + esc(c.label) + '</th>';
    }
    html += '<th style="width:100px">Update</th></tr>';
    const sortedUsers = [...userKeys].sort();
    for (const u of sortedUsers) {
      const uv = d.users[u] || {};
      let hasOutdated = false;
      let innerCols = '';
      html += '<tr><td><strong>' + esc(u) + '</strong></td>';
      for (const c of d.components) {
        if (c.key === 'node') {
          const userV = uv[c.key] || null;
          html += '<td>' + esc(userV || '—') + '</td>';
          continue;
        }
        const userV = uv[c.key] || null;
        const latestC = d.components.find(x => x.key === c.key);
        const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
        if (isUpd) hasOutdated = true;
        if (userV) {
          html += '<td>' + esc(userV) + (isUpd ? ' <span class="upd-badge new">⬆ ' + esc(latestC.latestVersion) + '</span>' : ' <span class="upd-badge ok">✓</span>') + '</td>';
        } else {
          html += '<td><span class="upd-badge na">—</span></td>';
        }
      }
      html += '<td>';
      if (hasOutdated) {
        for (const c of d.components) {
          if (c.key === 'node') continue;
          const userV = uv[c.key] || null;
          const latestC = d.components.find(x => x.key === c.key);
          const isUpd = userV && latestC && latestC.latestVersion && userV !== latestC.latestVersion;
          if (isUpd) {
            html += '<button class="btn update small" style="margin:1px;font-size:11px" onclick="triggerUserUpdate(\'' + esc(u) + '\',\'' + c.key + '\')">⬆ ' + c.key + '</button> ';
          }
        }
      } else {
        html += '<span class="upd-badge ok" style="font-size:11px">✓ up to date</span>';
      }
      html += '</td>';
      html += '</tr>';
    }
    html += '</table></div></div>';
  }

  // Schedule card
  html += '<div class="upd-card">';
  html += '<h3>Schedule</h3>';
  const sched = d.schedule || {};
  html += '<div class="upd-toggle">'
    + '<label class="switch"><input type="checkbox" id="schedEnable" ' + (sched.enabled?'checked':'') + ' onchange="saveUpdatesConfig()"><span class="slider"></span></label>'
    + '<label>Auto-update</label></div>';
  html += '<div class="upd-field"><label>Time (24h)</label>'
    + '<div style="display:flex;gap:8px">'
    + '<input type="number" id="schedHour" min="0" max="23" value="' + (sched.hour||3) + '" style="width:70px" onchange="saveUpdatesConfig()">:<input type="number" id="schedMin" min="0" max="59" value="' + (sched.min||0) + '" style="width:70px" onchange="saveUpdatesConfig()">'
    + '</div><span class="hint">Server time — updates run within 2 min of this time</span></div>';
  html += '<div class="upd-field"><label>Components to auto-update</label><div class="upd-chk-grid">';
  for (const c of d.components) {
    const checked = !sched.components || sched.components.includes(c.key);
    html += '<label><input type="checkbox" class="sched-comp" data-key="' + c.key + '" ' + (checked?'checked':'') + ' onchange="saveUpdatesConfig()"> ' + c.label + (c.key === 'node' ? ' <span class="hint">(manual via nvm/fnm)</span>' : '') + '</label>';
  }
  html += '</div></div></div>';

  // Telegram card
  html += '<div class="upd-card">';
  html += '<h3>Telegram Notifications</h3>';
  const tel = d.telegram || {};
  html += '<div class="upd-toggle">'
    + '<label class="switch"><input type="checkbox" id="telEnable" ' + (tel.enabled?'checked':'') + ' onchange="saveUpdatesConfig()"><span class="slider"></span></label>'
    + '<label>Enabled</label></div>';
  html += '<div class="upd-field"><label>Bot Token</label><input type="password" id="telToken" value="' + esc(tel.botToken||'') + '" placeholder="123456:ABC-DEF1234ghIkl" onchange="saveUpdatesConfig()"></div>';
  html += '<div class="upd-field"><label>Chat ID</label><input type="text" id="telChatId" value="' + esc(tel.chatId||'') + '" placeholder="-123456789" onchange="saveUpdatesConfig()"></div>';
  html += '<div class="upd-chk-grid">'
    + '<label><input type="checkbox" id="telNotifyUpd" ' + (tel.notifyOnUpdate!==false?'checked':'') + ' onchange="saveUpdatesConfig()"> Notify when updates available</label>'
    + '<label><input type="checkbox" id="telNotifyDone" ' + (tel.notifyOnComplete!==false?'checked':'') + ' onchange="saveUpdatesConfig()"> Notify on update completion</label>'
    + '<label><input type="checkbox" id="telNotifyAuth" ' + (tel.notifyOnAuth!==false?'checked':'') + ' onchange="saveUpdatesConfig()"> Notify on web login attempts (failed / successful / lockout)</label>'
    + '</div>';
  html += '<button class="upd-test-btn" onclick="testTelegram()">📨 Test Telegram</button>';
  html += '</div>';

  // Update log
  html += '<div class="upd-card" style="grid-column:1/-1">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">';
  html += '<h3 style="margin:0">Update Log <span style="font-weight:400;font-size:12px;color:#6b7280">last ' + d.log.length + ' entries</span></h3>';
  html += '<button class="btn" onclick="clearUpdateLog()" style="font-size:11px;padding:3px 10px;background:#3a2020;color:#ff8088;border:none;border-radius:5px;cursor:pointer">🗑 Clear log</button>';
  html += '</div>';
  html += '<div class="upd-log">';
  if (!d.log.length) {
    html += '<div style="color:#6b7280;padding:10px 0;font-size:13px">No updates have been run yet.</div>';
  } else {
    for (const entry of d.log.slice().reverse()) {
      const icon = entry.success ? '✅' : '❌';
      const cls = entry.success ? '' : ' style="color:#ff8088"';
      html += '<div class="upd-log-entry">'
        + '<span class="time">' + new Date(entry.timestamp).toLocaleString() + '</span>'
        + '<span class="comp"' + cls + '>' + icon + ' ' + esc(entry.label) + '</span>'
        + '<span class="result">' + esc((entry.output||'').split('\n')[0].slice(0, 80)) + '</span>'
        + '</div>';
    }
  }
  html += '</div></div>';

  html += '</div>';
  document.getElementById('updatesview').innerHTML = html;
}

async function checkUpdates(){
  try {
    const res = await fetch('api/updates/check', { method: 'POST' });
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdate(key){
  // Optimistically show running state
  if (lastUpdates) {
    const c = lastUpdates.components.find(x => x.key === key);
    if (c) c.updating = true;
    renderUpdates();
  }
  try {
    const res = await fetch('api/updates/run/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUserUpdate(user, key){
  try {
    const res = await fetch('api/updates/run/' + user + '/' + key, { method: 'POST' });
    const result = await res.json();
    // Refresh updates data
    const res2 = await fetch('api/updates');
    lastUpdates = await res2.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdateAll(){
  try {
    await fetch('api/updates/run-all', { method: 'POST' });
    const res = await fetch('api/updates');
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

async function triggerUpdateAllUsers(){
  if (!confirm('Update every outdated tool for all users? Runs npm updates sequentially and may take a few minutes.')) return;
  try {
    await fetch('api/updates/run-all-users', { method: 'POST' });
    const res = await fetch('api/updates');
    lastUpdates = await res.json();
    if (state.tab === 'updates') renderUpdates();
  } catch(_){}
}

function saveUpdatesConfig(){
  if (!lastUpdates) return;
  const sched = {
    enabled: document.getElementById('schedEnable').checked,
    hour: parseInt(document.getElementById('schedHour').value) || 3,
    minute: parseInt(document.getElementById('schedMin').value) || 0,
    components: Array.from(document.querySelectorAll('.sched-comp:checked')).map(el => el.dataset.key),
  };
  const tel = {
    enabled: document.getElementById('telEnable').checked,
    botToken: document.getElementById('telToken').value,
    chatId: document.getElementById('telChatId').value,
    notifyOnUpdate: document.getElementById('telNotifyUpd').checked,
    notifyOnComplete: document.getElementById('telNotifyDone').checked,
    notifyOnAuth: document.getElementById('telNotifyAuth').checked,
  };
  fetch('api/updates/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: sched, telegram: tel }),
  });
  if (lastUpdates) {
    lastUpdates.schedule = sched;
    lastUpdates.telegram = tel;
  }
}

async function clearUpdateLog(){
  try {
    await fetch('api/updates/log', { method: 'DELETE' });
    if (lastUpdates) { lastUpdates.log = []; renderUpdates(); }
  } catch(_){}
}

async function testTelegram(){
  if (!lastUpdates || !lastUpdates.telegram) return;
  const tel = lastUpdates.telegram;
  if (!tel.botToken || !tel.chatId) { toast('Save bot token and chat ID first', 'warn'); return; }
  try {
    const res = await fetch('https://api.telegram.org/bot' + tel.botToken + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tel.chatId, text: '🔔 *RHC SRV Manager* — Telegram notification is working!', parse_mode: 'Markdown' }),
    });
    if (res.ok) toast('Test message sent — check your Telegram.', 'success');
    else { const j = await res.json(); toast('Telegram error: ' + (j.description || res.status), 'error'); }
  } catch(e){ toast('Telegram failed: ' + e.message, 'error'); }
}

