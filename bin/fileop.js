#!/usr/bin/env node
// File-manager helper, spawned by lib/sites/files.js with the SITE USER's uid/gid so the kernel
// enforces what the panel may touch. Paths are additionally confined to --root (the user's home);
// anything resolving outside it (symlink escapes included) is refused.
//
//   fileop.js --root /home/u json          # one JSON op on stdin → JSON result on stdout
//   fileop.js --root /home/u download <p>  # file bytes on stdout
//   fileop.js --root /home/u upload <p>    # stdin → file (created 0660, umask 007 like the site's shell)
'use strict';
const fs = require('fs');
const path = require('path');

process.umask(0o007);
const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const ROOT = rootIdx >= 0 ? fs.realpathSync(args[rootIdx + 1]) : null;
const cmd = args.filter((_, i) => i !== rootIdx && i !== rootIdx + 1);
if (!ROOT) fail('missing --root');

const MAX_TEXT = 2 * 1024 * 1024;

function fail(msg, code) { process.stderr.write(JSON.stringify({ error: msg }) + '\n'); process.exit(code || 1); }
// Resolve a user-supplied path under ROOT. For paths that do not exist yet, resolve the parent.
function resolve(p, mustExist) {
  const rel = String(p || '/').replace(/\\/g, '/');
  if (rel.includes('\0')) throw new Error('invalid path');
  const joined = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (joined !== ROOT && !joined.startsWith(ROOT + '/')) throw new Error('path outside the site home');
  let real;
  try { real = fs.realpathSync(joined); }
  catch (e) {
    if (mustExist || e.code !== 'ENOENT') throw e;
    const parent = fs.realpathSync(path.dirname(joined));
    if (parent !== ROOT && !parent.startsWith(ROOT + '/')) throw new Error('path outside the site home');
    return path.join(parent, path.basename(joined));
  }
  if (real !== ROOT && !real.startsWith(ROOT + '/')) throw new Error('path resolves outside the site home');
  return real;
}
// Same confinement, but the final component is NOT followed (delete/rename/chmod act on a link itself).
function resolveNoFollow(p) {
  const rel = String(p || '/').replace(/\\/g, '/');
  if (rel.includes('\0')) throw new Error('invalid path');
  const joined = path.resolve(ROOT, '.' + path.posix.normalize('/' + rel));
  if (joined === ROOT) return ROOT;
  const parent = fs.realpathSync(path.dirname(joined));
  if (parent !== ROOT && !parent.startsWith(ROOT + '/')) throw new Error('path outside the site home');
  const abs = path.join(parent, path.basename(joined));
  fs.lstatSync(abs);   // must exist
  return abs;
}
// The home directory itself is never a target of rename/move/delete/chmod (its mode is managed by the panel).
function notRoot(abs) { if (abs === ROOT) throw new Error('refusing to modify the home directory itself'); return abs; }
const relOf = (abs) => '/' + path.relative(ROOT, abs);
const NAME_RE = /^[^/\0]{1,255}$/;
function checkName(n) { if (!NAME_RE.test(String(n)) || n === '.' || n === '..') throw new Error('invalid name'); return n; }

function entry(dir, name) {
  const p = path.join(dir, name);
  let st, lst;
  try { lst = fs.lstatSync(p); st = lst.isSymbolicLink() ? (() => { try { return fs.statSync(p); } catch (_) { return lst; } })() : lst; } catch (_) { return null; }
  const e = { name, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: st.mtime.toISOString(), mode: (st.mode & 0o7777).toString(8).padStart(4, '0'), uid: st.uid, gid: st.gid };
  if (lst.isSymbolicLink()) { e.symlink = true; try { e.target = fs.readlinkSync(p); } catch (_) {} }
  return e;
}

const ops = {
  list({ path: p }) {
    const dir = resolve(p, true);
    const items = fs.readdirSync(dir).map((n) => entry(dir, n)).filter(Boolean)
      .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: relOf(dir), items };
  },
  stat({ path: p }) { const abs = resolve(p, true); return Object.assign({ path: relOf(abs) }, entry(path.dirname(abs), path.basename(abs))); },
  mkdir({ path: p, name }) { const abs = path.join(resolve(p, true), checkName(name)); fs.mkdirSync(abs, { mode: 0o770 }); return { path: relOf(abs) }; },
  touch({ path: p, name }) { const abs = path.join(resolve(p, true), checkName(name)); fs.writeFileSync(abs, '', { flag: 'wx', mode: 0o660 }); return { path: relOf(abs) }; },
  rename({ path: p, name }) { const abs = notRoot(resolveNoFollow(p)); const to = path.join(path.dirname(abs), checkName(name)); if (fs.existsSync(to)) throw new Error('target exists'); fs.renameSync(abs, to); return { path: relOf(to) }; },
  move({ path: p, to }) { const abs = notRoot(resolveNoFollow(p)); const dest = path.join(resolve(to, true), path.basename(abs)); if (fs.existsSync(dest)) throw new Error('target exists'); fs.renameSync(abs, dest); return { path: relOf(dest) }; },
  delete({ paths }) {
    const done = [];
    for (const p of paths || []) { const abs = resolveNoFollow(p); if (abs === ROOT) throw new Error('refusing to delete the home directory'); if (fs.lstatSync(abs).isSymbolicLink()) fs.unlinkSync(abs); else fs.rmSync(abs, { recursive: true, force: false }); done.push(relOf(abs)); }
    return { deleted: done };
  },
  chmod({ path: p, mode, recursive }) {
    const abs = notRoot(resolveNoFollow(p)); const m = parseInt(String(mode), 8);
    if (!(m >= 0 && m <= 0o7777)) throw new Error('invalid mode');
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error('cannot chmod a symlink');
    const walk = (d) => { fs.chmodSync(d, m); if (recursive && fs.lstatSync(d).isDirectory()) for (const n of fs.readdirSync(d)) { const c = path.join(d, n); if (!fs.lstatSync(c).isSymbolicLink()) walk(c); } };
    walk(abs); return { path: relOf(abs), mode: m.toString(8) };
  },
  read({ path: p }) {
    const abs = resolve(p, true); const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
    if (st.size > MAX_TEXT) throw new Error('file larger than 2 MB — download it instead');
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) throw new Error('binary file — download it instead');
    return { path: relOf(abs), content: buf.toString('utf8'), size: st.size, mtime: st.mtime.toISOString() };
  },
  write({ path: p, content }) {
    const abs = resolve(p, false);
    if (Buffer.byteLength(String(content), 'utf8') > MAX_TEXT) throw new Error('content larger than 2 MB');
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs + '.rhc-tmp', String(content), { mode: 0o660 });
    if (existed) { try { fs.chmodSync(abs + '.rhc-tmp', fs.statSync(abs).mode & 0o7777); } catch (_) {} }
    fs.renameSync(abs + '.rhc-tmp', abs);
    return { path: relOf(abs), size: Buffer.byteLength(String(content), 'utf8') };
  },
  extract({ path: p }) {
    const abs = resolve(p, true);
    const { execFileSync } = require('child_process');
    const dir = path.dirname(abs);
    if (/\.zip$/i.test(abs)) execFileSync('unzip', ['-o', '-q', abs, '-d', dir], { timeout: 10 * 60_000 });
    else if (/\.(tar\.gz|tgz|tar\.zst|tar\.xz|tar\.bz2|tar)$/i.test(abs)) execFileSync('tar', ['-xf', abs, '-C', dir], { timeout: 10 * 60_000 });
    else throw new Error('not an archive I know how to extract');
    return { path: relOf(dir) };
  },
};

if (cmd[0] === 'json') {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { body += d; if (body.length > 4 * MAX_TEXT) fail('request too large'); });
  process.stdin.on('end', () => {
    let op; try { op = JSON.parse(body); } catch (_) { return fail('invalid JSON'); }
    if (!ops[op.op]) return fail('unknown op ' + op.op);
    try { process.stdout.write(JSON.stringify(ops[op.op](op)) + '\n'); } catch (e) { fail(e.code === 'EACCES' || e.code === 'EPERM' ? 'permission denied' : e.code === 'ENOENT' ? 'no such file or directory' : e.message); }
  });
} else if (cmd[0] === 'download') {
  try { const abs = resolve(cmd[1], true); if (!fs.statSync(abs).isFile()) fail('not a file'); fs.createReadStream(abs).on('error', (e) => fail(e.message)).pipe(process.stdout); }
  catch (e) { fail(e.message); }
} else if (cmd[0] === 'upload') {
  try {
    const abs = resolve(cmd[1], false);
    const tmp = abs + '.rhc-upload';
    const out = fs.createWriteStream(tmp, { mode: 0o660, flags: 'wx' });
    out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} fail(e.code === 'EACCES' ? 'permission denied' : e.message); });
    out.on('finish', () => { try { fs.renameSync(tmp, abs); process.stdout.write(JSON.stringify({ path: relOf(abs), size: out.bytesWritten }) + '\n'); } catch (e) { fail(e.message); } });
    process.stdin.pipe(out);
  } catch (e) { fail(e.message); }
} else fail('usage: fileop.js --root DIR json|download PATH|upload PATH', 2);
