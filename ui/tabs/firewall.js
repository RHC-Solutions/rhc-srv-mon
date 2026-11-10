// ---- Firewall: ufw (state, default policies, logging, rules, what the public ports are exposed to)
// and fail2ban (service, jails and their settings, bans, how bans are enforced, recent log).
let fwData = null, fwLoading = false, fwBusy = false;
async function loadFirewall(){
  fwLoading = true;
  try { fwData = await stApi('GET', 'api/firewall'); } catch(e){ fwData = { error: e.message }; }
  fwLoading = false;
  if (state.tab === 'firewall') renderFirewall(true);
  // who the banned IPs are (shared cache with the Security tab)
  const ips = [...new Set(((fwData && fwData.fail2ban && fwData.fail2ban.jails) || []).flatMap(j => j.banned || []))].filter(ip => !secIntel[ip]).slice(0, 40);
  if (ips.length) { try { Object.assign(secIntel, await stApi('POST', 'api/security/intel', { ips })); } catch(_){} if (state.tab === 'firewall') renderFirewall(true); }
}
const fwPill = (text, kind) => '<span style="display:inline-block;padding:1px 9px;border-radius:10px;font-size:12.5px;font-weight:600;color:#fff;background:' + ({ ok: 'var(--md-success, #2e7d32)', bad: 'var(--md-error-bright)', warn: 'var(--md-warning)', dim: 'var(--md-on-surface-dis)' }[kind] || 'var(--md-on-surface-dis)') + '">' + esc(text) + '</span>';
const fwSel = (id, opts, cur, extra) => '<select id="' + id + '"' + (extra || '') + '>' + opts.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select>';
const FW_EXPO = { open: ['open to everyone', 'warn'], limited: ['open, rate-limited', 'warn'], restricted: ['listed sources only', 'ok'], blocked: ['blocked', 'ok'] };

function renderFirewall(fromLoad){
  plainTabHeader('ufw firewall and fail2ban on this server');
  const view = document.getElementById('firewallview');
  if (!fwData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!fwLoading) loadFirewall(); return; }
  if (!fromLoad && view.contains(document.activeElement) && ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  if (fwData.error) { view.innerHTML = '<div class="upd-card" style="color:var(--md-error-bright)">⚠ ' + esc(fwData.error) + '</div>'; return; }
  const u = fwData.ufw || {}, f = fwData.fail2ban || {};
  const st = [];
  if (u.installed) st.push({ level: u.active ? 'ok' : 'bad', text: 'ufw ' + (u.active ? 'on' : 'off') });
  if (f.installed) st.push({ level: f.up ? 'ok' : 'bad', text: 'fail2ban ' + (f.up ? 'running' : 'down') }, { level: 'info', text: (f.jails || []).reduce((a, j) => a + (j.banned || []).length, 0) + ' banned' });
  setStatus(st);
  let h = '';
  // warnings first — they are why someone opens this page
  const warns = [].concat(u.installed && !u.active ? ['ufw is off: every port that listens publicly is open to the whole internet.'] : [],
    u.installed && u.active && !u.adminSshCovered ? ['Not every admin IP has an SSH rule — save Settings → Whitelist once to add them.'] : [], f.warnings || []);
  if (warns.length) h += '<div class="upd-card" style="border-left:4px solid var(--md-warning);margin-bottom:14px">' + warns.map(w => '<p style="margin:4px 0">⚠ ' + esc(w) + '</p>').join('') + '</div>';
  h += fwUfwCard(u) + fwF2bCard(f);
  view.innerHTML = h;
}

// ------------------------------------------------------------------ ufw
function fwUfwCard(u){
  let h = '<div class="upd-card"><h3>Firewall (ufw) ' + (u.installed ? fwPill(u.active ? 'ON' : 'OFF', u.active ? 'ok' : 'bad') : '') + '</h3>';
  if (!u.installed) return h + '<p class="dim">ufw is not installed on this server.</p></div>';
  if (u.error) h += '<p style="color:var(--md-error-bright)">' + esc(u.error) + '</p>';
  h += '<p class="dim" style="margin:0 0 10px;font-size:14px">The panel and the sites are reached through Cloudflare tunnels (outgoing connections), so blocking incoming traffic never cuts them off. Admin IPs (Settings → Whitelist) always keep SSH.' + (u.active && !u.bootEnabled ? ' <b>ufw.service is not enabled — the firewall would be off after a reboot.</b>' : '') + '</p>';
  h += '<div class="site-actions" style="flex-wrap:wrap;gap:8px;align-items:flex-end">';
  h += u.active ? '<button class="btn" onclick="armConfirm(this, \'⚠ Click again: everything opens\', () => fwUfw(\'disable\'))">Switch off</button>'
                : '<button class="btn pri" onclick="armConfirm(this, \'Click again to switch on\', () => fwUfw(\'enable\'))">Switch on</button>';
  h += stField('Incoming (no rule matches)', fwSel('fwDefIn', [['deny', 'deny (drop)'], ['reject', 'reject'], ['allow', 'allow — no firewall']], u.defaults && u.defaults.incoming, ' onchange="fwDefault(\'incoming\', this)"'));
  h += stField('Routed', fwSel('fwDefRt', [['deny', 'deny'], ['reject', 'reject'], ['allow', 'allow']], u.defaults && u.defaults.routed, ' onchange="fwDefault(\'routed\', this)"'));
  h += stField('Outgoing', '<input value="allow (tunnels need it)" disabled>');
  h += stField('Logging', fwSel('fwLog', ['off', 'low', 'medium', 'high'], String(u.logging || 'off').replace(/^on \((\w+)\)$/, '$1'), ' onchange="fwLogging(this)"'));
  h += '</div>';
  // exposure
  const P = u.ports || [];
  if (P.length) {
    h += '<h4 style="margin:16px 0 6px">Public ports on this server</h4><table class="upd-table"><tr><th>Port</th><th>Process</th><th>Reachable</th></tr>';
    for (const p of P) { const [t, k] = FW_EXPO[p.state] || [p.state, 'dim']; h += '<tr><td class="mono">' + p.port + '/' + esc(p.proto) + '</td><td>' + esc(p.proc || '?') + '</td><td>' + fwPill(t, p.state === 'open' && !u.active ? 'bad' : k) + ' <span class="dim" style="font-size:13px">' + esc(p.why || '') + '</span></td></tr>'; }
    h += '</table>';
  }
  // rules
  const R = u.rules || [];
  h += '<h4 style="margin:16px 0 6px">Rules <span class="dim" style="font-weight:400">' + R.length + ' · first match wins</span></h4>';
  if (R.length) {
    h += '<table class="upd-table"><tr><th>#</th><th>Action</th><th>Port</th><th>From</th><th>Note</th><th></th></tr>';
    R.forEach((r, i) => {
      h += '<tr><td class="dim">' + (i + 1) + '</td><td>' + fwPill(r.action.toUpperCase() + (r.dir === 'out' ? ' OUT' : ''), r.action === 'allow' ? 'ok' : r.action === 'limit' ? 'warn' : 'bad') + '</td>'
        + '<td class="mono">' + esc(r.app || (r.port ? r.port + (r.proto ? '/' + r.proto : '') : 'all')) + (r.iface ? ' <span class="dim">on ' + esc(r.iface) + '</span>' : '') + '</td>'
        + '<td class="mono">' + esc(r.from === 'any' ? 'anywhere' : r.from) + '</td><td>' + esc(r.comment || '') + '</td>'
        + '<td style="text-align:right">' + (r.managed ? '<span class="dim" style="font-size:13px">Settings → Whitelist</span>' : '<button class="btn small" onclick="armConfirm(this, \'Delete?\', () => fwDelRule(' + i + '))">Delete</button>') + '</td></tr>';
    });
    h += '</table>';
  } else h += '<p class="dim" style="margin:0">No rules.</p>';
  // add
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:12px">'
    + stField('Action', fwSel('fwAct', [['allow', 'allow'], ['deny', 'deny'], ['reject', 'reject'], ['limit', 'limit (6 tries / 30 s)']], 'allow'))
    + stField('Port', '<input id="fwPort" class="mono" placeholder="443 · 6000:6010 · empty = all" style="max-width:190px">')
    + stField('Protocol', fwSel('fwProto', ['tcp', 'udp', 'any'], 'tcp'))
    + stField('From', '<input id="fwFrom" class="mono" placeholder="empty = anywhere · 203.0.113.0/24" style="max-width:230px">')
    + stField('Note', '<input id="fwNote" placeholder="optional" style="max-width:180px">')
    + '<button class="btn pri" style="margin-bottom:8px" onclick="fwAddRule(this)">Add rule</button></div>';
  return h + '</div>';
}
async function fwRun(btn, fn, okMsg){
  if (fwBusy) return; fwBusy = true; if (btn) btn.disabled = true;
  try { const r = await fn(); toast(okMsg, 'success', r && r.log ? { detail: r.log.join('\n'), duration: 8000 } : {}); }
  catch(e){ stErr(e, 'Firewall'); }
  fwBusy = false; if (btn) btn.disabled = false; fwData = null; loadFirewall();
}
function fwUfw(action){ fwRun(null, () => stApi('POST', 'api/firewall/ufw/' + action), action === 'enable' ? 'ufw is on' : 'ufw is off'); }
function fwDefault(dir, sel){ fwRun(sel, () => stApi('PUT', 'api/firewall/ufw/default', { direction: dir, policy: sel.value }), 'Default ' + dir + ': ' + sel.value); }
function fwLogging(sel){ fwRun(sel, () => stApi('PUT', 'api/firewall/ufw/logging', { level: sel.value }), 'Logging ' + sel.value); }
function fwDelRule(i){ const r = fwData.ufw.rules[i]; if (r) fwRun(null, () => stApi('POST', 'api/firewall/ufw/rules/delete', { spec: r.spec }), 'Rule deleted'); }
function fwAddRule(btn){
  const g = (id) => document.getElementById(id).value;
  fwRun(btn, () => stApi('POST', 'api/firewall/ufw/rules', { action: g('fwAct'), port: g('fwPort'), proto: g('fwProto'), from: g('fwFrom'), comment: g('fwNote') }), 'Rule added');
}

// ------------------------------------------------------------------ fail2ban
function fwF2bCard(f){
  let h = '<div class="upd-card" style="margin-top:14px"><h3>fail2ban ' + (f.installed ? fwPill(f.up ? 'RUNNING' : 'DOWN', f.up ? 'ok' : 'bad') : '') + (f.version ? ' <span class="dim" style="font-weight:400;font-size:13px">' + esc(f.version) + '</span>' : '') + '</h3>';
  if (!f.installed) return h + '<p class="dim">fail2ban is not installed on this server.</p></div>';
  if (f.error) h += '<p style="color:var(--md-error-bright)">' + esc(f.error) + '</p>';
  h += '<p class="dim" style="margin:0 0 10px;font-size:14px">Admin IPs are never banned. Changes made here go to <span class="mono">' + esc(f.file || '') + '</span> (read last, so it wins over jail.local), are tested before they apply, and are rolled back if fail2ban does not take them.</p>';
  h += '<div class="site-actions" style="flex-wrap:wrap;gap:8px;align-items:flex-end">'
    + stField('Bans enforced with', fwSel('fwBanAct', [['', 'jail.local default' + (f.panelBanaction ? '' : ' (' + (f.banaction || '?') + ')')], ['nftables', 'nftables'], ['ufw', 'ufw' + (f.ufwActive ? '' : ' — off!')], ['iptables', 'iptables']], f.panelBanaction || ''))
    + '<button class="btn" style="margin-bottom:8px" onclick="fwBanaction(this)">Apply</button>'
    + '<span style="flex:1"></span>'
    + '<button class="btn small" style="margin-bottom:8px" onclick="fwF2bSvc(this, \'reload\')">Reload</button>'
    + '<button class="btn small" style="margin-bottom:8px" onclick="armConfirm(this, \'Restart?\', () => fwF2bSvc(this, \'restart\'))">Restart</button>'
    + '<button class="btn small" style="margin-bottom:8px" onclick="armConfirm(this, \'Unban everyone?\', () => fwF2bSvc(this, \'unban-all\'))">Unban everyone</button></div>';
  const J = f.jails || [];
  J.forEach((j, i) => { h += fwJail(j, i); });
  // switch on another jail
  const av = (f.available || []).filter(a => a.filter);
  if (av.length) h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:14px">' + stField('Switch on another jail', fwSel('fwNewJail', av.map(a => a.name), av.some(a => a.name === 'recidive') ? 'recidive' : av[0].name)) + '<button class="btn" style="margin-bottom:8px" onclick="fwJailOn(this)">Switch on</button><span class="dim" style="font-size:13px;margin-bottom:12px">refused if its log file or filter is missing</span></div>';
  if (f.test && !f.test.ok && f.test.errors.length) h += '<details style="margin-top:12px"><summary class="dim">fail2ban config test: ' + f.test.errors.length + ' error line(s)</summary><pre class="mono" style="font-size:12.5px;white-space:pre-wrap">' + esc(f.test.errors.join('\n')) + '</pre></details>';
  if ((f.log || []).length) {
    h += '<details style="margin-top:8px"><summary class="dim">Recent fail2ban log (' + f.log.length + ')</summary><table class="upd-table" style="font-size:13px">';
    for (const l of f.log.slice().reverse()) h += '<tr><td class="mono dim" style="white-space:nowrap">' + esc(l.at || '') + '</td><td>' + (l.level === 'ERROR' ? fwPill('ERROR', 'bad') + ' ' : l.level === 'WARNING' ? fwPill('WARN', 'warn') + ' ' : '') + esc(l.text) + '</td></tr>';
    h += '</table></details>';
  }
  return h + '</div>';
}
function fwJail(j, i){
  const kind = { running: 'ok', broken: 'bad', 'not running': 'warn', stopped: 'dim' }[j.state] || 'dim';
  let h = '<div style="border-top:1px solid var(--md-divider);margin-top:12px;padding-top:10px">';
  h += '<h4 style="margin:0 0 6px">' + esc(j.name) + ' ' + fwPill(j.state, kind)
    + (j.state === 'running' ? ' <span class="dim" style="font-weight:400;font-size:13.5px">· ' + (j.currentlyBanned || 0) + ' banned now, ' + (j.totalBanned || 0) + ' in total · ' + (j.currentlyFailed || 0) + ' failing now</span>' : '')
    + (j.actions && j.actions.length ? ' <span class="dim" style="font-weight:400;font-size:13px">· bans via ' + esc(j.actions.join(', ')) + '</span>' : '') + '</h4>';
  if (j.why && j.why.length) h += '<p style="margin:0 0 6px;font-size:13.5px;color:var(--md-error-bright)">' + esc(j.why.join(' · ')) + '</p>';
  const v = (k) => j.panel && j.panel[k] != null ? j.panel[k] : (j[k] != null ? j[k] : '');
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">'
    + stField('Ban for', '<input id="fwJb' + i + '" class="mono" value="' + esc(v('bantime')) + '" placeholder="1h · 1d · -1 = forever" style="max-width:130px">')
    + stField('Within', '<input id="fwJf' + i + '" class="mono" value="' + esc(v('findtime')) + '" placeholder="10m" style="max-width:110px">')
    + stField('After failures', '<input id="fwJm' + i + '" class="mono" value="' + esc(v('maxretry')) + '" style="max-width:90px">')
    + '<button class="btn small" style="margin-bottom:8px" onclick="fwJailSave(this,' + i + ')"' + (j.state === 'broken' ? ' disabled' : '') + '>Save</button>'
    + (j.state === 'broken' || j.state === 'running' || j.state === 'not running' ? '<button class="btn small" style="margin-bottom:8px" onclick="armConfirm(this, \'' + (j.name.startsWith('sshd') && j.state === 'running' ? '⚠ SSH unprotected — sure?' : 'Switch off?') + '\', () => fwJailEnable(this,' + i + ', false))">Switch off</button>' : '')
    + (j.panel ? '<button class="btn small" style="margin-bottom:8px" title="remove what the panel set for this jail" onclick="armConfirm(this, \'Reset?\', () => fwJailReset(this,' + i + '))">Reset to file defaults</button>' : '')
    + '</div>';
  if (j.state === 'running') {
    h += '<div style="display:flex;gap:8px;margin:6px 0"><input id="fwBan' + i + '" class="mono" placeholder="ban an IP by hand" style="max-width:240px"><button class="btn small" onclick="fwBan(this,' + i + ')">Ban</button></div>';
    if ((j.banned || []).length) {
      h += '<table class="upd-table"><tr><th>IP</th><th>Who</th><th></th></tr>';
      j.banned.forEach((ip) => { h += '<tr><td class="mono">' + esc(ip) + '</td><td style="font-size:13.5px">' + secIntelLine(secIntel[ip]) + '</td><td style="text-align:right;white-space:nowrap"><button class="btn small" data-ip="' + esc(ip) + '" onclick="fwUnban(this,' + i + ')">Unban</button></td></tr>'; });
      h += '</table>';
    } else h += '<p class="dim" style="margin:0">Nobody banned right now.</p>';
  }
  return h + '</div>';
}
const fwJ = (i) => fwData.fail2ban.jails[i];
function fwJailSave(btn, i){
  const j = fwJ(i), g = (id) => document.getElementById(id).value.trim();
  fwRun(btn, () => stApi('PUT', 'api/firewall/fail2ban/jails/' + encodeURIComponent(j.name), { bantime: g('fwJb' + i), findtime: g('fwJf' + i), maxretry: g('fwJm' + i) }), j.name + ' saved');
}
function fwJailEnable(btn, i, on){ const j = fwJ(i); fwRun(btn, () => stApi('PUT', 'api/firewall/fail2ban/jails/' + encodeURIComponent(j.name), { enabled: on }), j.name + (on ? ' switched on' : ' switched off')); }
function fwJailReset(btn, i){ const j = fwJ(i); fwRun(btn, () => stApi('DELETE', 'api/firewall/fail2ban/jails/' + encodeURIComponent(j.name)), j.name + ': back to file defaults'); }
function fwJailOn(btn){ const n = document.getElementById('fwNewJail').value; toast('Switching on ' + n + '… (tested first)'); fwRun(btn, () => stApi('PUT', 'api/firewall/fail2ban/jails/' + encodeURIComponent(n), { enabled: true }), n + ' is running'); }
function fwBanaction(btn){ const c = document.getElementById('fwBanAct').value; toast('Applying… (restarts the jails; bans are restored)'); fwRun(btn, () => stApi('PUT', 'api/firewall/fail2ban/banaction', { choice: c || null }), 'Bans enforced with ' + (c || 'the jail.local default')); }
function fwF2bSvc(btn, a){ fwRun(btn, () => stApi('POST', 'api/firewall/fail2ban/service/' + a), { reload: 'fail2ban reloaded', restart: 'fail2ban restarted', 'unban-all': 'Everyone unbanned' }[a]); }
function fwBan(btn, i){ const j = fwJ(i), ip = document.getElementById('fwBan' + i).value.trim(); fwRun(btn, () => stApi('POST', 'api/firewall/fail2ban/' + encodeURIComponent(j.name) + '/ban', { ip }), 'Banned ' + ip); }
function fwUnban(btn, i){ const j = fwJ(i), ip = btn.dataset.ip; fwRun(btn, () => stApi('POST', 'api/firewall/fail2ban/' + encodeURIComponent(j.name) + '/unban', { ip }), 'Unbanned ' + ip); }
