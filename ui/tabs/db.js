/* ------------------------------------------------------------- postgresql */
function dbRow(db){
  const cache = db.cache_hit==null ? '–' : db.cache_hit.toFixed(1)+'%';
  const cacheCls = db.cache_hit==null ? '' : (db.cache_hit>=99?'good':(db.cache_hit>=90?'mid':'poor'));
  let beats = '';
  const pad = Math.max(0, 50 - db.beats.length);
  for (let i=0;i<pad;i++) beats += '<div class="beat"></div>';
  for (const b of db.beats) beats += '<div class="beat up" data-tip="'+new Date(b[0]*1000).toLocaleTimeString()+' — reachable"></div>';
  const pct = db.uptime24h==null ? '–' : (db.uptime24h>=99.95?'100%':db.uptime24h.toFixed(1)+'%');
  return '<div class="row">'
    + '<div class="stat"><span class="pill up">Up</span></div>'
    + '<div class="meta"><div class="name">'+esc(db.name)+'</div>'
    + '<div class="info">owner '+esc(db.owner)+' · ↻ '+Number(db.commits).toLocaleString()+' commits · ⚠ '+db.rollbacks+' rb</div></div>'
    + '<div class="beats">'+beats+'</div>'
    + '<div class="col">'+fmtMem(Number(db.size))+'</div>'
    + '<div class="col">'+db.conns+'</div>'
    + '<div class="col '+cacheCls+'" style="'+(cacheCls?'':'')+'">'+cache+'</div>'
    + '<div class="pct '+pctCls(db.uptime24h)+'">'+pct+'</div>'
    + '</div>';
}

function renderDb(){
  if (!lastDb) return;
  const d = lastDb;
  const banner = document.getElementById('banner');
  banner.style.display='flex';
  if (d.error) {
    banner.className='banner bad';
    banner.innerHTML = '<span class="ico">🔴</span> PostgreSQL unreachable <span style="margin-left:auto;font-size:13px;font-weight:400">'+esc(d.error)+'</span>';
  } else {
    banner.className='banner ok';
    banner.innerHTML = '<span class="ico">✅</span> PostgreSQL '+esc(d.version||'')+' Online '
      + '<span style="margin-left:auto;font-size:13px;font-weight:400;color:#9fd9b6">'
      + d.summary.databases+' databases · '+fmtMem(d.summary.total_size)+' · '
      + d.total_conns+'/'+d.max_connections+' conns</span>';
  }
  let html = '<div class="group"><h2>🐘 PostgreSQL <span class="dim">/var/run/postgresql/.s.PGSQL.5432</span></h2>';
  if (d.error) {
    html += '<div class="err">⚠ '+esc(d.error)+'</div>';
  } else {
    html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">Unix socket · cluster 17/main</div></div><div class="col" style="flex:0 0 auto">' + esc(d.version || '') + '</div></div>';
    html += '<div class="hdr"><div class="stat">Status</div><div class="meta">Database</div>'
      + '<div class="beats-h"></div><div class="col">Size</div><div class="col">Conns</div><div class="col">Cache</div><div class="pct" style="color:#6b7280">24h</div></div>';
    for (const db of d.databases) html += dbRow(db);
  }
  html += '</div>';
  // credentials
  if (d.credentials && d.credentials.length) {
    html += '<details class="creds"><summary>🔑 Connection credentials ('+d.credentials.length+' roles) — click to reveal</summary>'
      + '<div class="warnbox">⚠ Plaintext app passwords, recovered from each app\'s live config. PostgreSQL itself stores only irreversible SCRAM-SHA-256 hashes. This page is behind basic-auth + Cloudflare Access.</div>'
      + '<table><tr><th>Role</th><th>Database</th><th>Password</th><th>Source</th></tr>';
    d.credentials.forEach((c, ci) => {
      const pid = 'pw'+ci+'_'+Math.abs(hashStr(c.role+'|'+c.database));
      const pw = c.password || '';
      html += '<tr><td><code>'+esc(c.role)+'</code></td><td>'+esc(c.database)+'</td>'
        + '<td><div class="pwwrap"><span class="reveal" data-pw="'+pid+'">👁</span>'
        + '<code id="'+pid+'" data-real="'+esc(pw)+'">'+'•'.repeat(Math.min(16,pw.length))+'</code></div></td>'
        + '<td class="src">'+esc(c.source)+'</td></tr>';
    });
    html += '</table></details>';
  }

  // SQLite section
  if (d.sqlite) {
    html += '<div class="group" style="margin-top:18px"><h2>🗄️ SQLite <span class="dim">CloudPanel config</span></h2>';
    if (d.sqlite.error) {
      html += '<div class="err">⚠ ' + esc(d.sqlite.error) + '</div>';
    } else {
      html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">file</div></div><div class="col" style="flex:0 0 auto;word-break:break-all;font-size:11px;max-width:400px">' + esc(d.sqlite.path || '') + '</div></div>';
      html += '<div class="hdr"><div class="meta">Name</div><div class="col" style="flex:0 0 auto">Size</div></div>';
      html += '<div class="row"><div class="meta"><div class="name">CloudPanel DB</div><div class="info">' + d.sqlite.tables + ' tables · ' + d.sqlite.pageCount.toLocaleString() + ' pages</div></div><div class="col" style="flex:0 0 auto">' + fmtMem(d.sqlite.size) + '</div></div>';
    }
    html += '</div>';
  }

  // MariaDB section
  if (d.mariadb) {
    html += '<div class="group" style="margin-top:18px"><h2>🐬 MariaDB</h2>';
    if (d.mariadb.error) {
      html += '<div class="err">⚠ ' + esc(d.mariadb.error) + '</div>';
    } else {
      const upStr = d.mariadb.uptime ? fmtUp(d.mariadb.uptime * 1000) : '?';
      html += '<div class="row" style="background:#1a1d23;border-bottom:1px solid #2d3139"><div class="meta"><div class="name">Location</div><div class="info">TCP · up ' + upStr + '</div></div><div class="col" style="flex:0 0 auto">localhost:3306 · ' + esc(d.mariadb.version) + '</div></div>';
      if (d.mariadb.dbSizes && d.mariadb.dbSizes.length) {
        html += '<div class="hdr"><div class="meta">Database</div><div class="col" style="flex:0 0 auto">Size</div></div>';
        for (const db of d.mariadb.dbSizes) {
          html += '<div class="row"><div class="meta"><div class="name">' + esc(db.name) + '</div></div><div class="col" style="flex:0 0 auto">' + fmtMem((db.sizeMb || 0) * 1048576) + '</div></div>';
        }
      } else {
        html += '<div class="row"><div class="meta"><div class="name">(no user databases)</div><div class="info">only system schemas exist</div></div><div class="col" style="flex:0 0 auto">—</div></div>';
      }
    }
    html += '</div>';
  }

  document.getElementById('dbview').innerHTML = html;
  document.querySelectorAll('.reveal').forEach(el => el.addEventListener('click', () => {
    const code = document.getElementById(el.dataset.pw);
    const real = code.dataset.real;
    if (code.textContent.startsWith('•')) { code.textContent = real; el.textContent='🙈'; }
    else { code.textContent = '•'.repeat(Math.min(16,real.length)); el.textContent='👁'; }
  }));
}
