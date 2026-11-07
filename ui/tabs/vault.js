// ---- Vault: encrypted passwords / tokens / keys / notes, plus the server's own secrets (read-only).
let vaultData = null, vaultLoading = false, vaultQ = '';
const vaultShown = {};   // 'e:<id>' | 's:<id>' → revealed secret, only after an explicit Show / Copy
const VAULT_KIND_LABEL = { password: 'Password', token: 'Token', 'api-key': 'API key', 'ssh-key': 'SSH key', certificate: 'Certificate', note: 'Note', other: 'Other' };
async function loadVault(){
  vaultLoading = true;
  try { vaultData = await stApi('GET', 'api/vault'); } catch(e){ vaultData = { error: e.message, entries: [], system: [] }; }
  vaultLoading = false;
  if (state.tab === 'vault') renderVault();
}
function renderVault(){
  plainTabHeader('Encrypted on this server (AES-256-GCM) · every reveal is recorded in the event log');
  const view = document.getElementById('vaultview');
  if (!vaultData) { view.innerHTML = '<div class="upd-card">Loading…</div>'; if (!vaultLoading) loadVault(); return; }
  if (view.contains(document.activeElement) && document.activeElement.id === 'vaultQ') { vaultRenderLists(); return; }
  view.innerHTML = '<div class="toolbar" style="margin-bottom:12px"><input id="vaultQ" type="search" placeholder="Search name, user, URL, tags…" value="' + esc(vaultQ) + '" oninput="vaultQ=this.value; vaultRenderLists()" autocomplete="off">'
    + '<button class="btn pri" onclick="vaultEdit(null)">＋ Add secret</button><button class="btn" onclick="vaultData=null; renderVault()">↻</button></div>'
    + '<div id="vaultLists"></div>';
  vaultRenderLists();
}
function vaultSecretCell(key, hasValue){
  if (!hasValue) return '<span class="dim">not set</span>';
  const v = vaultShown[key];
  return '<div style="display:flex;gap:6px;align-items:center"><input class="mono" readonly value="' + esc(v != null ? v : '••••••••••••') + '" style="flex:1;min-width:10em;font-size:13px" onclick="this.select()">'
    + '<button class="btn small" onclick="vaultToggle(\'' + esc(key) + '\')">' + (v != null ? 'Hide' : 'Show') + '</button>'
    + '<button class="btn small" onclick="vaultCopy(\'' + esc(key) + '\')">Copy</button></div>';
}
function vaultRenderLists(){
  const el = document.getElementById('vaultLists'); if (!el || !vaultData) return;
  const d = vaultData, q = vaultQ.trim().toLowerCase();
  const hit = (...xs) => !q || xs.join(' ').toLowerCase().includes(q);
  let h = '';
  if (d.error) h += '<div class="site-why">⚠ ' + esc(d.error) + '</div>';
  const entries = (d.entries || []).filter(e => hit(e.name, e.username, e.url, e.tags, e.kind));
  h += '<div class="upd-card"><h3>Secrets <span class="dim" style="font-weight:400">' + entries.length + '</span></h3>';
  if (!(d.entries || []).length) h += '<p class="dim">Nothing stored yet — <a href="#" onclick="vaultEdit(null);return false">add the first secret</a>.</p>';
  else if (!entries.length) h += '<p class="dim">No match.</p>';
  else {
    h += '<table class="upd-table"><tr><th>Name</th><th>Kind</th><th>Username</th><th>Secret</th><th>Updated</th><th></th></tr>';
    for (const e of entries) {
      h += '<tr><td><b>' + esc(e.name) + '</b>' + (e.url ? '<br><span class="mono dim" style="font-size:13px">' + (/^https?:\/\//.test(e.url) ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener noreferrer">' + esc(e.url) + '</a>' : esc(e.url)) + '</span>' : '')
        + (e.tags ? '<br>' + e.tags.split(',').map(t => '<span class="chip" style="font-size:12px;padding:1px 8px;margin:2px 4px 0 0;display:inline-block">' + esc(t.trim()) + '</span>').join('') : '') + '</td>'
        + '<td>' + esc(VAULT_KIND_LABEL[e.kind] || e.kind) + (e.hasNotes ? ' <span class="dim" title="has notes">📝</span>' : '') + '</td>'
        + '<td class="mono" style="font-size:13px">' + (e.username ? esc(e.username) + ' <button class="btn small" onclick="vaultCopyText(' + JSON.stringify(e.username).replace(/"/g, '&quot;') + ', \'Username\')">Copy</button>' : '') + '</td>'
        + '<td style="min-width:16em">' + vaultSecretCell('e:' + e.id, true) + '</td>'
        + '<td class="dim" style="font-size:13px;white-space:nowrap">' + esc(new Date(e.updated_at).toLocaleString()) + (e.updated_by ? '<br>' + esc(e.updated_by) : '') + '</td>'
        + '<td style="white-space:nowrap;text-align:right"><button class="btn small" onclick="vaultEdit(' + e.id + ')">Edit</button> <button class="btn small" onclick="armConfirm(this, \'Delete?\', () => vaultDelete(' + e.id + '))">Delete</button></td></tr>';
    }
    h += '</table>';
  }
  h += '</div>';
  const sys = (d.system || []).filter(s => hit(s.name, s.where, s.username, s.kind));
  h += '<div class="upd-card" style="margin-top:14px"><h3>System secrets <span class="dim" style="font-weight:400">' + sys.length + '</span></h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Credentials this server already uses, read from where they live — rotating one there is reflected here at once. Read-only; change them where they are managed.</p>';
  if (sys.length) {
    h += '<table class="upd-table"><tr><th>Name</th><th>Stored in</th><th>Username</th><th>Secret</th></tr>';
    for (const s of sys) {
      h += '<tr><td><b>' + esc(s.name) + '</b>' + (s.url ? '<br><a class="mono dim" style="font-size:13px" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a>' : '') + '</td>'
        + '<td class="dim" style="font-size:13.5px">' + (s.manage ? '<a href="' + esc(s.manage) + '">' + esc(s.where) + '</a>' : esc(s.where)) + '</td>'
        + '<td class="mono" style="font-size:13px">' + esc(s.username || '') + '</td>'
        + '<td style="min-width:16em">' + vaultSecretCell('s:' + s.id, s.present) + '</td></tr>';
    }
    h += '</table>';
  }
  el.innerHTML = h + '</div>';
}
async function vaultFetchSecret(key){
  if (vaultShown[key] != null) return vaultShown[key];
  const [t, id] = [key.slice(0, 1), key.slice(2)];
  const r = await stApi('GET', t === 'e' ? 'api/vault/' + encodeURIComponent(id) + '/secret' : 'api/vault/system/' + encodeURIComponent(id) + '/secret');
  vaultShown[key] = r.secret;
  return r.secret;
}
async function vaultToggle(key){
  if (vaultShown[key] != null) { delete vaultShown[key]; vaultRenderLists(); return; }
  try { await vaultFetchSecret(key); vaultRenderLists(); } catch(e){ stErr(e, 'Vault'); }
}
async function vaultCopyText(text, what){
  try { await navigator.clipboard.writeText(text); toast((what || 'Secret') + ' copied', 'success'); }
  catch(e){ toast('The browser refused clipboard access — use Show and copy by hand', 'error'); }
}
async function vaultCopy(key){
  try { const v = await vaultFetchSecret(key); await vaultCopyText(v); } catch(e){ stErr(e, 'Vault'); }
}
function vaultGenerate(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=_@', out = [], b = new Uint32Array(28);
  crypto.getRandomValues(b); for (const x of b) out.push(A[x % A.length]);
  const el = document.getElementById('vf-secret'); el.value = out.join(''); el.type = 'text';
}
async function vaultEdit(id){
  const e = id ? (vaultData.entries || []).find(x => x.id === id) : { kind: 'password' };
  if (!e) return;
  let notes = '';
  if (id && e.hasNotes) { try { notes = (await stApi('GET', 'api/vault/' + id + '/secret')).notes || ''; } catch(err){ return stErr(err, 'Vault'); } }
  sshModal('<h3>' + (id ? '✎ Edit secret' : '＋ Add secret') + '</h3>'
    + '<div class="row2">' + stField('Name', '<input id="vf-name" maxlength="120" value="' + esc(e.name || '') + '" placeholder="Hetzner robot login">')
    + stField('Kind', '<select id="vf-kind">' + (vaultData.kinds || Object.keys(VAULT_KIND_LABEL)).map(k => '<option value="' + k + '"' + (k === e.kind ? ' selected' : '') + '>' + esc(VAULT_KIND_LABEL[k] || k) + '</option>').join('') + '</select>') + '</div>'
    + '<div class="row2">' + stField('Username', '<input id="vf-user" autocomplete="off" value="' + esc(e.username || '') + '" placeholder="optional">')
    + stField('URL / host', '<input id="vf-url" value="' + esc(e.url || '') + '" placeholder="https://… (optional)">') + '</div>'
    + stField('Secret', '<div style="display:flex;gap:6px"><textarea id="vf-secret" rows="2" class="mono" autocomplete="off" spellcheck="false" style="flex:1" placeholder="' + (id ? 'leave empty to keep the stored secret' : 'password, token, key…') + '"></textarea><button class="btn small" type="button" onclick="vaultGenerate()" title="Generate a random 28-character password">Generate</button></div>', 'encrypted before it is stored')
    + stField('Notes', '<textarea id="vf-notes" rows="3" placeholder="optional — encrypted too">' + esc(notes) + '</textarea>')
    + stField('Tags', '<input id="vf-tags" value="' + esc(e.tags || '') + '" placeholder="comma separated, e.g. hosting, prod">')
    + '<div class="site-actions" style="justify-content:flex-end;gap:8px"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="vaultSave(' + (id || 'null') + ')">Save</button></div>');
}
async function vaultSave(id){
  const g = (x) => document.getElementById(x).value;
  const body = { name: g('vf-name'), kind: g('vf-kind'), username: g('vf-user'), url: g('vf-url'), notes: g('vf-notes'), tags: g('vf-tags') };
  if (g('vf-secret')) body.secret = g('vf-secret');
  try {
    await stApi(id ? 'PUT' : 'POST', 'api/vault' + (id ? '/' + id : ''), body);
    sshModalClose(); toast(id ? 'Secret updated' : 'Secret stored', 'success');
    if (id) delete vaultShown['e:' + id];
    vaultData = null; renderVault();
  } catch(e){ stErr(e, 'Vault'); }
}
async function vaultDelete(id){
  try { await stApi('DELETE', 'api/vault/' + id); delete vaultShown['e:' + id]; toast('Secret deleted', 'success'); vaultData = null; renderVault(); }
  catch(e){ stErr(e, 'Vault'); }
}
