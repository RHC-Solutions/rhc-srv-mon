'use strict';
// Country flags as images (GET /flag/<cc>, behind the login like every page). Windows draws flag
// emoji as two letters, so the UI shows real images. Each flag is fetched once from flagcdn.com by
// the server and kept in DATA_DIR/.flags/ — the browser never talks to a third party.
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const DIR = path.join(DATA_DIR, '.flags');
const SOURCE = (cc) => 'https://flagcdn.com/w40/' + cc + '.png';
const pending = new Map();

async function file(cc) {
  const f = path.join(DIR, cc + '.png');
  if (fs.existsSync(f)) return f;
  if (!pending.has(cc)) {
    pending.set(cc, (async () => {
      const r = await fetch(SOURCE(cc), { signal: AbortSignal.timeout(10_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || buf.length < 8 || !buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('no flag for ' + cc);
      fs.mkdirSync(DIR, { recursive: true, mode: 0o755 });
      const tmp = f + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, buf, { mode: 0o644 }); fs.renameSync(tmp, f);
      return f;
    })().finally(() => pending.delete(cc)));
  }
  return pending.get(cc);
}

async function serve(req, res, url) {
  const cc = String(url.slice('/flag/'.length)).toLowerCase().replace(/\.png$/, '');
  if (!/^[a-z]{2}$/.test(cc)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no such flag'); }
  try {
    const f = await file(cc);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=2592000', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(f).pipe(res);
  } catch (_) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('no flag'); }
}

module.exports = { serve };
