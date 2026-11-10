// ---- Vault: encrypted passwords / tokens / keys / notes, plus the server's own secrets (read-only).
let vaultData = null, vaultLoading = false, vaultQ = '';
const vaultShown = {};   // 'e:<id>' | 's:<id>' → revealed secret, only after an explicit Show / Copy
// Filter + sort (remembered per browser in state.vault): kind, tag, sort key and direction.
const vaultView = Object.assign({ kind: '', tag: '', sort: 'name', dir: 1 }, state.vault || {});
function vaultSetView(patch){ Object.assign(vaultView, patch); state.vault = Object.assign({}, vaultView); saveState(); renderVault(); }
function vaultSortBy(key){ vaultSetView(vaultView.sort === key ? { dir: -vaultView.dir } : { sort: key, dir: key === 'updated' ? -1 : 1 }); }
function vaultTagsOf(e){ return String(e.tags || '').split(',').map(t => t.trim()).filter(Boolean); }
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
  const all = (vaultData.entries || []).concat(vaultData.system || []);
  const kinds = [...new Set(all.map(e => e.kind).filter(Boolean))].sort((a, b) => (VAULT_KIND_LABEL[a] || a).localeCompare(VAULT_KIND_LABEL[b] || b));
  const tags = [...new Set((vaultData.entries || []).flatMap(vaultTagsOf))].sort((a, b) => a.localeCompare(b));
  if (vaultView.kind && !kinds.includes(vaultView.kind)) vaultView.kind = '';
  if (vaultView.tag && !tags.includes(vaultView.tag)) vaultView.tag = '';
  const opt = (v, l, cur) => '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(l) + '</option>';
  const sorts = [['name:1', 'Name A → Z'], ['name:-1', 'Name Z → A'], ['updated:-1', 'Recently updated'], ['updated:1', 'Least recently updated'], ['kind:1', 'Kind'], ['username:1', 'Username']];
  view.innerHTML = '<div class="toolbar vault-bar" style="margin-bottom:12px"><input id="vaultQ" type="search" placeholder="Search name, user, URL, tags…" value="' + esc(vaultQ) + '" oninput="vaultQ=this.value; vaultRenderLists()" autocomplete="off">'
    + '<select title="Kind" onchange="vaultSetView({ kind: this.value })">' + opt('', 'All kinds', vaultView.kind) + kinds.map(k => opt(k, VAULT_KIND_LABEL[k] || k, vaultView.kind)).join('') + '</select>'
    + (tags.length ? '<select title="Tag" onchange="vaultSetView({ tag: this.value })">' + opt('', 'All tags', vaultView.tag) + tags.map(t => opt(t, '# ' + t, vaultView.tag)).join('') + '</select>' : '')
    + '<select title="Sort" onchange="const [s, d] = this.value.split(\':\'); vaultSetView({ sort: s, dir: Number(d) })">' + sorts.map(([v, l]) => opt(v, l, vaultView.sort + ':' + vaultView.dir)).join('') + '</select>'
    + (vaultView.kind || vaultView.tag || vaultQ ? '<button class="btn" onclick="vaultQ=\'\'; vaultSetView({ kind: \'\', tag: \'\' })" title="Clear search and filters">✕ Clear</button>' : '')
    + '<button class="btn pri" onclick="vaultEdit(null)">＋ Add secret</button><button class="btn" onclick="vaultData=null; renderVault()">↻</button></div>'
    + '<div id="vaultLists"></div>';
  vaultRenderLists();
}
function vaultSecretCell(key, hasValue){
  if (!hasValue) return '<span class="dim">not set</span>';
  const v = vaultShown[key];
  if (v != null && v.includes('\n')) return '<textarea class="mono" readonly rows="6" style="width:100%;min-width:16em;font-size:12px" onclick="this.select()">' + esc(v) + '</textarea>'
    + '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn small" onclick="vaultToggle(\'' + esc(key) + '\')">Hide</button><button class="btn small" onclick="vaultCopy(\'' + esc(key) + '\')">Copy</button></div>';
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
  const kindOk = (e) => !vaultView.kind || e.kind === vaultView.kind;
  const val = (e, k) => k === 'updated' ? (Date.parse(e.updated_at) || 0) : k === 'kind' ? (VAULT_KIND_LABEL[e.kind] || e.kind || '') : String(e[k] || '').toLowerCase();
  const byView = (a, b) => { const x = val(a, vaultView.sort), y = val(b, vaultView.sort); const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y)); return (c || String(a.name).localeCompare(String(b.name))) * (c ? vaultView.dir : 1); };
  const entries = (d.entries || []).filter(e => kindOk(e) && (!vaultView.tag || vaultTagsOf(e).includes(vaultView.tag)) && hit(e.name, e.username, e.url, e.tags, e.kind, VAULT_KIND_LABEL[e.kind])).sort(byView);
  const th = (k, l) => '<th class="sortable' + (vaultView.sort === k ? ' on' : '') + '" onclick="vaultSortBy(\'' + k + '\')" title="Sort by ' + l.toLowerCase() + '">' + l + (vaultView.sort === k ? (vaultView.dir > 0 ? ' ▲' : ' ▼') : '') + '</th>';
  h += '<div class="upd-card"><h3>Secrets <span class="dim" style="font-weight:400">' + entries.length + ((d.entries || []).length !== entries.length ? ' of ' + (d.entries || []).length : '') + '</span></h3>';
  if (!(d.entries || []).length) h += '<p class="dim">Nothing stored yet — <a href="#" onclick="vaultEdit(null);return false">add the first secret</a>.</p>';
  else if (!entries.length) h += '<p class="dim">No match.</p>';
  else {
    h += '<table class="upd-table"><tr>' + th('name', 'Name') + th('kind', 'Kind') + th('username', 'Username') + '<th>Secret</th>' + th('updated', 'Updated') + '<th></th></tr>';
    for (const e of entries) {
      h += '<tr><td><b>' + esc(e.name) + '</b>' + (e.url ? '<br><span class="mono dim" style="font-size:13px">' + (/^https?:\/\//.test(e.url) ? '<a href="' + esc(e.url) + '" target="_blank" rel="noopener noreferrer">' + esc(e.url) + '</a>' : esc(e.url)) + '</span>' : '')
        + (e.tags ? '<br>' + vaultTagsOf(e).map(t => '<span class="chip vault-tag' + (t === vaultView.tag ? ' on' : '') + '" role="button" tabindex="0" title="' + (t === vaultView.tag ? 'Show all tags' : 'Only #' + esc(t)) + '" onclick="vaultSetView({ tag: ' + (t === vaultView.tag ? '\'\'' : JSON.stringify(t).replace(/"/g, '&quot;')) + ' })" style="font-size:12px;padding:1px 8px;margin:2px 4px 0 0;display:inline-block">' + esc(t) + '</span>').join('') : '') + '</td>'
        + '<td>' + esc(VAULT_KIND_LABEL[e.kind] || e.kind) + (e.hasNotes ? ' <span class="dim" title="has notes">📝</span>' : '') + '</td>'
        + '<td class="mono" style="font-size:13px">' + (e.username ? esc(e.username) + ' <button class="btn small" onclick="vaultCopyText(' + JSON.stringify(e.username).replace(/"/g, '&quot;') + ', \'Username\')">Copy</button>' : '') + '</td>'
        + '<td style="min-width:16em">' + vaultSecretCell('e:' + e.id, true) + '</td>'
        + '<td class="dim" style="font-size:13px;white-space:nowrap">' + esc(new Date(e.updated_at).toLocaleString()) + (e.updated_by ? '<br>' + esc(e.updated_by) : '') + '</td>'
        + '<td style="white-space:nowrap;text-align:right"><button class="btn small" onclick="vaultEdit(' + e.id + ')">Edit</button> <button class="btn small" onclick="armConfirm(this, \'Delete?\', () => vaultDelete(' + e.id + '))">Delete</button></td></tr>';
    }
    h += '</table>';
  }
  h += '</div>';
  // system secrets have no tags: a tag filter hides them; kind/search/sort by name apply
  const sys = vaultView.tag ? [] : (d.system || []).filter(s => kindOk(s) && hit(s.name, s.where, s.username, s.kind, VAULT_KIND_LABEL[s.kind]))
    .sort((a, b) => (vaultView.sort === 'name' ? vaultView.dir : 1) * String(a.name).localeCompare(String(b.name)));
  h += '<div class="upd-card" style="margin-top:14px"><h3>System secrets <span class="dim" style="font-weight:400">' + sys.length + '</span></h3>'
    + '<p class="dim" style="margin:0 0 8px;font-size:14.5px">Credentials this server already uses, read from where they live — rotating one there is reflected here at once. Read-only; change them where they are managed.</p>';
  if (sys.length) {
    h += '<table class="upd-table"><tr><th>Name</th><th>Stored in</th><th>Username</th><th>Secret</th></tr>';
    for (const s of sys) {
      h += '<tr><td><b>' + esc(s.name) + '</b>' + (s.url ? '<br><a class="mono dim" style="font-size:13px" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a>' : '') + '</td>'
        + '<td class="dim" style="font-size:13.5px">' + (s.manage ? '<a href="' + esc(s.manage) + '">' + esc(s.where) + '</a>' : esc(s.where)) + '</td>'
        + '<td class="mono" style="font-size:13px">' + esc(s.username || '') + '</td>'
        + '<td style="min-width:16em">' + vaultSecretCell('s:' + s.id, s.present)
        + (s.settable ? '<div style="display:flex;gap:6px;margin-top:4px"><button class="btn small" onclick="armConfirm(this, \'Reset now?\', () => vaultSetSystemPassword(\'' + esc(s.id) + '\', false))">Reset password</button><button class="btn small" onclick="vaultSetSystemPassword(\'' + esc(s.id) + '\', true)">Set password…</button></div>' : '')
        + '</td></tr>';
    }
    h += '</table>';
  }
  el.innerHTML = h + '</div>';
}
function vaultAnnounceText(a){
  if (!a) return '';
  return a.sentTo && a.sentTo.length ? 'Sent to ' + a.sentTo.join(' and ') + '.' + (a.failed && a.failed.length ? ' Failed: ' + a.failed.join('; ') : '')
    : '⚠ Not sent: ' + ((a.failed && a.failed.length ? a.failed.join('; ') : a.note) || 'no channel');
}
async function vaultSetSystemPassword(id, ask){
  let pw = null;
  if (ask) {
    pw = await askModal({ title: 'Set password', label: 'New password (12+ characters, no spaces)', password: true, ok: 'Set password' });
    if (pw == null) return;
    if (pw.length < 12) return toast('At least 12 characters', 'error');
  }
  try {
    const r = await stApi('POST', 'api/vault/system/' + encodeURIComponent(id) + '/password', pw ? { password: pw } : {});
    delete vaultShown['s:' + id];
    sshModal('<h3>🔑 ' + esc(r.name) + '</h3>'
      + (r.username ? stField('Username', '<input class="mono" readonly value="' + esc(r.username) + '" onclick="this.select()">') : '')
      + stField(r.generated ? 'New password (generated)' : 'New password', '<input class="mono" readonly value="' + esc(r.password) + '" onclick="this.select()">', 'also kept in the Vault — Show it there any time')
      + '<p class="dim" style="font-size:14px">' + esc(vaultAnnounceText(r.announce)) + '</p>'
      + '<div class="foot"><button class="btn" onclick="vaultCopyText(' + JSON.stringify(r.password).replace(/"/g, '&quot;') + ')">Copy password</button><button class="btn pri" onclick="sshModalClose()">Done</button></div>');
    vaultData = null; loadVault();
  } catch(e){ stErr(e, 'Password'); }
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
    + stField('Secret', '<div style="display:flex;gap:6px"><textarea id="vf-secret" rows="2" class="mono" autocomplete="off" spellcheck="false" style="flex:1" placeholder="' + (id ? 'leave empty to keep the stored secret' : 'password, token, key…') + '"></textarea><span style="display:flex;flex-direction:column;gap:6px"><button class="btn small" type="button" onclick="vaultGenerate()" title="Generate a random 28-character password">Generate</button><button class="btn small" type="button" onclick="document.getElementById(\'vf-file\').click()" title="Read a key or certificate file (id_ed25519, id_rsa, .pem…) into the secret">Upload file…</button></span><input type="file" id="vf-file" hidden onchange="vaultReadFile(this.files[0]); this.value=\'\'"></div>', 'encrypted before it is stored · you can also drop a key file on the box')
    + stField('Notes', '<textarea id="vf-notes" rows="3" placeholder="optional — encrypted too">' + esc(notes) + '</textarea>')
    + stField('Tags', '<input id="vf-tags" value="' + esc(e.tags || '') + '" placeholder="comma separated, e.g. hosting, prod">')
    + '<div class="site-actions" style="justify-content:flex-end;gap:8px"><button class="btn" onclick="sshModalClose()">Cancel</button><button class="btn pri" onclick="vaultSave(' + (id || 'null') + ')">Save</button></div>');
  const ta = document.getElementById('vf-secret');
  if (ta) {
    ta.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); });
    ta.addEventListener('drop', (ev) => { const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f) { ev.preventDefault(); vaultReadFile(f); } });
  }
}
// A key/certificate file → the secret box (read in the browser; only the text is sent, encrypted at rest).
// Picks the kind and a name from the file when those are still empty.
// PEM keys say ENCRYPTED in the header; OpenSSH keys name their cipher inside the base64 body ("none" = no passphrase).
function vaultKeyEncrypted(t){
  if (/ENCRYPTED/.test(t)) return true;
  if (!/BEGIN OPENSSH PRIVATE KEY/.test(t)) return false;
  try { return !atob(t.split('-----')[2].replace(/\s/g, '')).slice(0, 40).includes('none'); } catch(e){ return false; }
}
function vaultReadFile(f){
  if (!f) return;
  if (f.size > 64 * 1024) return toast(f.name + ' is larger than 64 KB — not a key file?', 'error');
  const r = new FileReader();
  r.onerror = () => toast('Could not read ' + f.name, 'error');
  r.onload = () => {
    const t = String(r.result || '');
    if (/[\x00-\x08\x0e-\x1f]/.test(t)) return toast(f.name + ' is a binary file — the vault keeps text (PEM / OpenSSH keys, certificates, tokens)', 'error');
    document.getElementById('vf-secret').value = t.replace(/\r\n/g, '\n');
    const priv = /-----BEGIN (OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----/.test(t), pub = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+) [A-Za-z0-9+\/=]+/m.test(t.trim());
    const cert = /-----BEGIN CERTIFICATE-----/.test(t);
    const kind = document.getElementById('vf-kind'), name = document.getElementById('vf-name');
    if (priv || pub) kind.value = 'ssh-key'; else if (cert) kind.value = 'certificate';
    if (!name.value.trim()) name.value = f.name + (pub && !priv ? ' (public)' : '');
    const notes = document.getElementById('vf-notes');
    if (pub && !priv && !notes.value) { const c = t.trim().split(/\s+/)[2]; if (c) notes.value = 'comment: ' + c; }
    toast('Read ' + f.name + (priv ? ' — private key' + (vaultKeyEncrypted(t) ? ' (passphrase-protected)' : '') : pub ? ' — public key' : cert ? ' — certificate' : ''), 'success');
  };
  r.readAsText(f);
}
async function vaultSave(id){
  const g = (x) => document.getElementById(x).value;
  const body = { name: g('vf-name'), kind: g('vf-kind'), username: g('vf-user'), url: g('vf-url'), notes: g('vf-notes'), tags: g('vf-tags') };
  if (g('vf-secret')) body.secret = g('vf-secret');
  try {
    const r = await stApi(id ? 'PUT' : 'POST', 'api/vault' + (id ? '/' + id : ''), body);
    sshModalClose(); toast((id ? 'Secret updated' : 'Secret stored') + (r.announce ? ' · ' + vaultAnnounceText(r.announce) : ''), r.announce && !(r.announce.sentTo || []).length ? 'warn' : 'success');
    if (id) delete vaultShown['e:' + id];
    vaultData = null; renderVault();
  } catch(e){ stErr(e, 'Vault'); }
}
async function vaultDelete(id){
  try { await stApi('DELETE', 'api/vault/' + id); delete vaultShown['e:' + id]; toast('Secret deleted', 'success'); vaultData = null; renderVault(); }
  catch(e){ stErr(e, 'Vault'); }
}
