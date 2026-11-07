'use strict';
// Per-server branding: an optional logo image (DATA_DIR/brand-logo) shown in the top bar, on the
// sign-in page and as the favicon, replacing the built-in SVG mark. Set from Settings → General
// (a URL the server downloads once — the browser never hotlinks a third-party host).
// Served at /brand-logo, public (the sign-in page needs it before anyone is signed in).
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');

const FILE = path.join(DATA_DIR, 'brand-logo');
const META = FILE + '.json';
const MAX = 2 * 1024 * 1024;
const TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/gif': 1, 'image/webp': 1, 'image/svg+xml': 1 };

let memo = null;
function logo() {
  if (memo && memo.checked > Date.now() - 5000) return memo.value;
  let value = null;
  try { const m = JSON.parse(fs.readFileSync(META, 'utf8')); const st = fs.statSync(FILE); value = { type: m.type, source: m.source, v: Math.floor(st.mtimeMs) }; } catch (_) {}
  memo = { value, checked: Date.now() };
  return value;
}

async function setFromUrl(url) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(url || '')) throw Object.assign(new Error('logo URL must start with http:// or https://'), { status: 400 });
  const r = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
  if (!r.ok) throw Object.assign(new Error('logo download failed: HTTP ' + r.status), { status: 400 });
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!TYPES[type]) throw Object.assign(new Error('not an image (' + (type || 'no content type') + ')'), { status: 400 });
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX) throw Object.assign(new Error('logo larger than 2 MB'), { status: 400 });
  fs.writeFileSync(FILE, buf, { mode: 0o644 });
  fs.writeFileSync(META, JSON.stringify({ type, source: url, bytes: buf.length, at: new Date().toISOString() }));
  memo = null;
  return logo();
}

// Uploaded file (Settings → Logo → Upload). The type is taken from the bytes, not from what the
// browser claims, and must be one of the same image types a URL may deliver.
function sniff(buf) {
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.slice(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length > 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = buf.slice(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}
function setFromUpload(base64, name) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw Object.assign(new Error('empty file'), { status: 400 });
  if (buf.length > MAX) throw Object.assign(new Error('logo larger than 2 MB'), { status: 400 });
  const type = sniff(buf);
  if (!type) throw Object.assign(new Error('not a PNG, JPEG, GIF, WebP or SVG image'), { status: 400 });
  fs.writeFileSync(FILE, buf, { mode: 0o644 });
  fs.writeFileSync(META, JSON.stringify({ type, source: 'upload: ' + String(name || 'file').replace(/[^\w .()-]/g, '_').slice(0, 80), bytes: buf.length, at: new Date().toISOString() }));
  memo = null;
  return logo();
}

function clear() { for (const f of [FILE, META]) { try { fs.unlinkSync(f); } catch (_) {} } memo = null; }

function serve(req, res) {
  const l = logo();
  if (!l) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('no logo'); }
  res.writeHead(200, { 'Content-Type': l.type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff',
    ...(l.type === 'image/svg+xml' ? { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}) });
  fs.createReadStream(FILE).pipe(res);
}

// Rewrites a built page: the inline SVG mark → <img>, plus a favicon. Pages reference the logo
// relatively ("brand-logo?v=…") so a path prefix in front of the panel (/srvman/) keeps working.
const MARK = /<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="2" width="28" height="28" rx="7"[\s\S]*?<\/svg>/;
function apply(html, px) {
  const l = logo();
  if (!l) return html;
  const src = 'brand-logo?v=' + l.v;
  return html.replace(MARK, '<img src="' + src + '" alt="" style="height:' + px + 'px;width:auto;flex-shrink:0">')
    .replace('</head>', '<link rel="icon" href="' + src + '" type="' + l.type + '">\n</head>');
}

module.exports = { logo, setFromUrl, setFromUpload, clear, serve, apply };
