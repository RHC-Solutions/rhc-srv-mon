'use strict';
// The site's pm2 process definition: htdocs/<domain>/ecosystem.config.js (Settings › PM2).
// Every file access goes through the file manager helper, which runs AS THE SITE USER, so a symlink
// planted by the site cannot make the panel write outside the site. The definition is checked by
// loading it with node as the site user before it replaces the current one; the previous file is
// kept as ecosystem.config.js.bak.
const crypto = require('crypto');
const files = require('./files');
const { asUser } = require('./runtime');

const NAME = 'ecosystem.config.js';
const relDir = (site) => '/htdocs/' + site.domain;
const absDir = (site) => '/home/' + site.user + '/htdocs/' + site.domain;
const rel = (site, n) => relDir(site) + '/' + (n || NAME);

// Loads the file as the site user and returns its apps (env: names only, values can be secrets).
const CHECK_JS = 'const c=require(process.env.ECO);const a=Array.isArray(c)?c:(c&&c.apps);'
  + 'if(!Array.isArray(a)||!a.length)throw new Error("module.exports.apps must be a non-empty array");'
  + 'const o=a.map((x,i)=>{if(!x||!x.name||!x.script)throw new Error("app #"+(i+1)+" needs a name and a script");'
  + 'return{name:String(x.name),script:String(x.script),args:x.args==null?null:[].concat(x.args).join(" "),cwd:x.cwd||null,interpreter:x.interpreter||null,'
  + 'instances:x.instances==null?1:x.instances,exec_mode:x.exec_mode||"fork",max_memory_restart:x.max_memory_restart||null,'
  + 'autorestart:x.autorestart!==false,watch:!!x.watch,env:Object.keys(x.env||{})}});console.log("@@"+JSON.stringify(o))';
async function check(site, file) {
  const r = await asUser(site.user, 'ECO=' + JSON.stringify(file) + " node -e '" + CHECK_JS + "'", { timeout: 20_000, lines: 40 });
  const line = (r.output || '').split('\n').find((l) => l.startsWith('@@'));
  if (r.ok && line) { try { return { ok: true, apps: JSON.parse(line.slice(2)) }; } catch (_) {} }
  const msg = (r.output || '').split('\n').find((l) => /^\w*Error\b|Error:/.test(l)) || (r.output || 'node could not load it').split('\n').pop();
  return { ok: false, error: msg.trim().slice(0, 400), output: /^\[eval\]:1/.test(r.output || '') ? null : r.output };   // our own check failed: the message says it all
}

async function get(site) {
  let f = null;
  try { f = await files.op(site, { op: 'read', path: rel(site) }); }
  catch (e) { if (!/no such file/i.test(e.message)) throw e; }
  if (!f) return { exists: false, path: absDir(site) + '/' + NAME, content: '', apps: [] };
  const c = await check(site, absDir(site) + '/' + NAME);
  return { exists: true, path: absDir(site) + '/' + NAME, content: f.content, mtime: f.mtime, apps: c.ok ? c.apps : [], error: c.ok ? null : c.error };
}

// content → checked in a temp file next to the real one (relative requires and __dirname behave the
// same), then the real file is replaced. opts.ifMtime: refuse if the file changed since it was read.
async function save(site, content, opts) {
  opts = opts || {};
  if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('the file is empty'), { status: 400 });
  let cur = null;
  try { cur = await files.op(site, { op: 'read', path: rel(site) }); } catch (e) { if (!/no such file/i.test(e.message)) throw e; }
  if (opts.ifMtime && cur && cur.mtime !== opts.ifMtime) throw Object.assign(new Error(NAME + ' was changed since you opened it — reload and edit again'), { status: 409 });
  const tmpName = '.ecosystem.check-' + crypto.randomBytes(4).toString('hex') + '.js';
  await files.op(site, { op: 'write', path: rel(site, tmpName), content });
  let c;
  try { c = await check(site, absDir(site) + '/' + tmpName); }
  finally { await files.op(site, { op: 'delete', paths: [rel(site, tmpName)] }).catch(() => {}); }
  if (!c.ok) throw Object.assign(new Error('not saved — ' + c.error), { status: 400, detail: c.output });
  if (cur) await files.op(site, { op: 'write', path: rel(site, NAME + '.bak'), content: cur.content });
  await files.op(site, { op: 'write', path: rel(site), content });
  return { saved: true, backup: !!cur, apps: c.apps };
}

// pm2 reads the definition again (a plain restart keeps the old script/args/env) and the list is saved
// so a reboot brings up the same.
async function apply(site) {
  const r = await asUser(site.user, 'cd ' + JSON.stringify(absDir(site)) + ' && pm2 startOrRestart ' + NAME + ' --update-env && pm2 save --force', { timeout: 120_000, lines: 25 });
  return { ok: r.ok, output: r.output };
}

module.exports = { get, save, apply, NAME };
