/* ---- auth (session UI) ---- */
async function authInit(){
  try {
    const d = await fetch('api/auth/me').then(r => r.json());
    const bar = document.getElementById('userbar'); if (!bar) return;
    if (!d.user) { bar.innerHTML = ''; return; }
    bar.innerHTML = '<span class="who">👤 ' + esc(d.user) + (d.local ? ' <small>local access · no login</small>' : (d.sessions > 1 ? ' <small>' + d.sessions + ' sessions</small>' : '')) + '</span>'
      + (d.local ? '' : '<button class="upd-test-btn" onclick="authAccount()">🔐 Account</button><button class="upd-test-btn" onclick="authLogout()">Logout</button>');
  } catch(e){}
}
async function authLogout(){ try { await fetch('api/auth/logout', { method:'POST' }); } catch(e){} location.replace('login'); }
function authQrLib(){ return window.qrcode ? Promise.resolve() : new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }
function authAccount(){
  sshModal('<h3>🔐 Account</h3>'
    + '<div class="box"><b>Change password</b> — requires your current password and a fresh authenticator code.</div>'
    + '<div class="row2">' + sshField('Current password', '<input id="ac-cur" type="password" autocomplete="current-password">') + sshField('Authenticator code', '<input id="ac-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">') + '</div>'
    + '<div class="row2">' + sshField('New password', '<input id="ac-new" type="password" autocomplete="new-password">') + sshField('Repeat new password', '<input id="ac-new2" type="password" autocomplete="new-password">') + '</div>'
    + '<div class="foot" style="margin-bottom:18px"><button class="btn pri" onclick="authChangePw()">Change password</button></div>'
    + '<div class="box"><b>Reset authenticator</b> — enrol a new phone/app. The old one keeps working until the new code is confirmed.</div>'
    + '<div class="row2">' + sshField('Password', '<input id="am-pw" type="password" autocomplete="current-password">') + sshField('Current authenticator code', '<input id="am-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">') + '</div>'
    + '<div id="am-enrol"></div>'
    + '<div class="foot" style="margin-bottom:18px"><button class="btn" onclick="authMfaReset()">Generate new authenticator</button></div>'
    + '<div class="box"><b>Sessions</b> — sign out every other browser/device that is logged in as you.</div>'
    + '<div class="foot"><div class="left"><button class="btn danger" onclick="authKillOthers()">Sign out other sessions</button></div><button class="btn" onclick="sshModalClose()">Close</button></div>');
}
async function authPost(url, body){ const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body||{}) }); const d = await r.json().catch(() => ({})); if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status)); return d; }
async function authChangePw(){
  const v = (i) => document.getElementById(i).value;
  if (v('ac-new') !== v('ac-new2')) return toast('New passwords do not match', 'error');
  try { await authPost('api/auth/password', { current: v('ac-cur'), next: v('ac-new'), code: v('ac-code').trim() }); toast('Password changed', 'success'); ['ac-cur','ac-code','ac-new','ac-new2'].forEach(i => document.getElementById(i).value=''); }
  catch(e){ toast(e.message, 'error'); }
}
async function authMfaReset(){
  const v = (i) => document.getElementById(i).value;
  try {
    const d = await authPost('api/auth/mfa/reset', { password: v('am-pw'), code: v('am-code').trim() });
    let qr = '';
    try { await authQrLib(); const q = qrcode(0, 'M'); q.addData(d.uri); q.make(); qr = q.createImgTag(4, 6); } catch(e){}
    document.getElementById('am-enrol').innerHTML = '<div style="display:flex;gap:14px;align-items:center;margin-bottom:10px"><div style="background:#fff;padding:6px;border-radius:8px;line-height:0">' + qr + '</div><div style="flex:1;min-width:0"><div class="hint" style="font-size:14px;color:#9ca3af">Scan with the new authenticator, or enter the secret:</div><div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;word-break:break-all;background:#12141d;border-radius:6px;padding:6px 8px;margin:6px 0">' + esc(d.secret.replace(/(.{4})/g, '$1 ').trim()) + '</div>'
      + sshField('Code from the NEW app', '<input id="am-new" inputmode="numeric" maxlength="6" autocomplete="one-time-code">') + '<button class="btn pri" onclick="authMfaConfirm()">Confirm new authenticator</button></div></div>';
    document.getElementById('am-new').focus();
  } catch(e){ toast(e.message, 'error'); }
}
async function authMfaConfirm(){
  try { await authPost('api/auth/mfa/confirm', { code: document.getElementById('am-new').value.trim() }); toast('Authenticator replaced', 'success'); document.getElementById('am-enrol').innerHTML = '<div class="test-out ok">✅ New authenticator active. The old one no longer works.</div>'; }
  catch(e){ toast(e.message, 'error'); }
}
async function authKillOthers(){
  try { const r = await fetch('api/auth/sessions/others', { method:'DELETE' }); const d = await r.json(); if (d.error) throw new Error(d.error); toast('Other sessions signed out', 'success'); authInit(); } catch(e){ toast(e.message, 'error'); }
}
authInit();

