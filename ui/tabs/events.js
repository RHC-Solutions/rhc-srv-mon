/* ------------------------------------------------------------------ events */
// Audit log viewer: filter bar (type / level / user / site / search), newest-first table with
// expandable details, "load older" paging by id, auto-refresh only while the tab is active.
let evItems = [], evNextBefore = null, evTypes = [], evSummary = null, evLoading = false, evOpen = new Set();
const evFilter = Object.assign({ type:'', level:'', user:'', site:'', q:'' }, state.evFilter || {});

function evQuery(extra){
  const p = new URLSearchParams();
  for (const k of ['type','level','user','site','q']) if (evFilter[k]) p.set(k, evFilter[k]);
  p.set('limit', '100');
  if (extra) for (const [k,v] of Object.entries(extra)) p.set(k, v);
  return 'api/events?' + p.toString();
}
async function refreshEvents(more){
  if (evLoading) return; evLoading = true;
  try {
    const [d, t, s] = await Promise.all([
      fetch(evQuery(more && evNextBefore ? { before: evNextBefore } : null)).then(r=>r.json()),
      fetch('api/events/types').then(r=>r.json()),
      fetch('api/events/summary').then(r=>r.json()),
    ]);
    if (d.error) throw new Error(d.error);
    evItems = more ? evItems.concat(d.items) : d.items;
    evNextBefore = d.nextBefore; evTypes = t; evSummary = s;
  } catch(e){ toast('Events: ' + e.message, 'error'); }
  finally { evLoading = false; }
  renderEvents();
}
function evSetFilter(k, v){ evFilter[k] = v; state.evFilter = evFilter; saveState(); evNextBefore = null; refreshEvents(); }
function evToggle(id){ if (evOpen.has(id)) evOpen.delete(id); else evOpen.add(id); renderEvents(); }
function evFmtTs(ts){ const d = new Date(ts); const now = Date.now(); const diff = (now - d.getTime())/1000;
  const rel = diff < 60 ? Math.floor(diff)+'s ago' : diff < 3600 ? Math.floor(diff/60)+'m ago' : diff < 86400 ? Math.floor(diff/3600)+'h ago' : Math.floor(diff/86400)+'d ago';
  return '<span title="' + esc(d.toLocaleString()) + '">' + esc(d.toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' })) + '</span> <span class="dim">' + rel + '</span>'; }

function renderEvents(){
  const view = document.getElementById('eventsview');
  document.getElementById('host').textContent = '';
  showBanner(null); setStatus([]);
  if (!evSummary && !evItems.length && !evLoading) { view.innerHTML = '<div class="upd-card">Loading…</div>'; refreshEvents(); return; }
  if (view.contains(document.activeElement) && ['INPUT','SELECT'].includes(document.activeElement.tagName)) return;   // don't clobber typing
  const s = evSummary || { last24h:{ info:0, warn:0, error:0, total:0 }, retentionDays: 90 };
  document.getElementById('updated').textContent = 'Last 24h: ' + s.last24h.total + ' events · ' + s.last24h.warn + ' warnings · ' + s.last24h.error + ' errors · retention ' + s.retentionDays + ' days';
  const users = [...new Set(evItems.map(e => e.user).filter(Boolean))].sort();
  const sites = [...new Set(evItems.map(e => e.site).filter(Boolean))].sort();
  const opt = (v, cur, label) => '<option value="' + esc(v) + '"' + (v===cur ? ' selected' : '') + '>' + esc(label || v) + '</option>';
  // type filter lists top-level groups (auth, updates, modules, …) plus the exact type currently chosen
  const groups = [...new Set(evTypes.map(t => t.type.split('.')[0]))].sort();
  let html = '<div class="upd-card ev-bar"><div class="ev-filters">'
    + '<select id="evType" onchange="evSetFilter(\'type\', this.value)"><option value="">All types</option>'
    + groups.map(g => opt(g + '.', evFilter.type, g + '.*')).join('')
    + (evFilter.type && !evFilter.type.endsWith('.') ? opt(evFilter.type, evFilter.type) : '') + '</select>'
    + '<select id="evLevel" onchange="evSetFilter(\'level\', this.value)"><option value="">All levels</option>' + ['info','warn','error'].map(l => opt(l, evFilter.level)).join('') + '</select>'
    + '<select id="evUser" onchange="evSetFilter(\'user\', this.value)"><option value="">All users</option>' + (evFilter.user && !users.includes(evFilter.user) ? opt(evFilter.user, evFilter.user) : '') + users.map(u => opt(u, evFilter.user)).join('') + '</select>'
    + (sites.length || evFilter.site ? '<select id="evSite" onchange="evSetFilter(\'site\', this.value)"><option value="">All sites</option>' + (evFilter.site && !sites.includes(evFilter.site) ? opt(evFilter.site, evFilter.site) : '') + sites.map(u => opt(u, evFilter.site)).join('') + '</select>' : '')
    + '<input id="evQ" type="search" placeholder="Search message / target / details…" value="' + esc(evFilter.q) + '" onkeydown="if(event.key===\'Enter\') evSetFilter(\'q\', this.value)" onsearch="evSetFilter(\'q\', this.value)">'
    + '<button class="btn small" onclick="refreshEvents()" title="Refresh">↻</button>'
    + (Object.values(evFilter).some(Boolean) ? '<button class="btn small" onclick="for (const k of Object.keys(evFilter)) evFilter[k]=\'\'; evSetFilter(\'q\',\'\')">Clear filters</button>' : '')
    + '</div></div>';
  html += '<div class="upd-card"><table class="upd-table ev-table"><thead><tr><th>When</th><th>Level</th><th>Type</th><th>User</th><th>Message</th><th>Target</th></tr></thead><tbody>';
  if (!evItems.length) html += '<tr><td colspan="6" class="dim">No events' + (Object.values(evFilter).some(Boolean) ? ' match these filters' : ' yet') + '.</td></tr>';
  for (const e of evItems) {
    const hasData = e.data != null && (typeof e.data !== 'object' || Object.keys(e.data).length);
    const open = evOpen.has(e.id);
    html += '<tr class="ev-row ev-' + esc(e.level) + (hasData ? ' ev-has-data' : '') + '"' + (hasData ? ' onclick="evToggle(' + e.id + ')"' : '') + '>'
      + '<td class="ev-ts">' + evFmtTs(e.ts) + '</td>'
      + '<td><span class="ev-level ' + esc(e.level) + '">' + esc(e.level) + '</span></td>'
      + '<td class="mono ev-type" onclick="event.stopPropagation(); evSetFilter(\'type\', \'' + esc(e.type) + '\')" title="Filter by this type">' + esc(e.type) + '</td>'
      + '<td>' + (e.user ? '<span class="ev-user" onclick="event.stopPropagation(); evSetFilter(\'user\', \'' + esc(e.user) + '\')" title="Filter by this user">' + esc(e.user) + '</span>' : '<span class="dim">–</span>') + (e.ip && e.ip !== '127.0.0.1' ? '<div class="dim mono ev-ip">' + esc(e.ip) + '</div>' : '') + '</td>'
      + '<td class="ev-msg">' + esc(e.message) + (hasData ? ' <span class="dim">' + (open ? '▾' : '▸') + '</span>' : '') + '</td>'
      + '<td class="mono dim ev-target">' + (e.site ? '<span class="ev-user" onclick="event.stopPropagation(); evSetFilter(\'site\', \'' + esc(e.site) + '\')">' + esc(e.site) + '</span> ' : '') + esc(e.target || '') + '</td></tr>';
    if (open) html += '<tr class="ev-detail"><td colspan="6"><pre>' + esc(typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2)) + '</pre></td></tr>';
  }
  html += '</tbody></table>'
    + (evNextBefore ? '<div style="text-align:center;margin-top:12px"><button class="btn small" onclick="refreshEvents(true)">Load older events</button></div>' : '')
    + '</div>';
  view.innerHTML = html;
}
