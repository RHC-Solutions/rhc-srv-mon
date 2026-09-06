#!/usr/bin/env node
// Rough static cross-reference: which top-level identifiers of lib/*.js + server.js are used
// in other files. Guides the require()/module.exports wiring after the mechanical split.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const files = ['server.js', ...fs.readdirSync(path.join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)];

function strip(src) {
  // remove block/line comments and string/template literals (approximate; regex literals stay)
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}
const declRe = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:let|const|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?(?:\s*,\s*[A-Za-z_$][\w$]*(?:\s*=[^,;\n]*)?)*)/gm;
const decls = {}, used = {}, text = {};
for (const f of files) {
  const s = strip(fs.readFileSync(path.join(root, f), 'utf8'));
  text[f] = s;
  const d = new Set();
  let m;
  while ((m = declRe.exec(s))) {
    if (m[1]) d.add(m[1]);
    else if (m[2].startsWith('{')) m[2].slice(1, -1).split(',').forEach(x => { const n = x.split(':').pop().trim(); if (n) d.add(n); });
    else m[2].split(',').forEach(x => d.add(x.trim().split(/[\s=]/)[0]));
  }
  decls[f] = d;
  used[f] = new Set(s.match(/[A-Za-z_$][\w$]*/g) || []);
}
const owner = Object.create(null);
for (const f of files) for (const id of decls[f]) (owner[id] = owner[id] || []).push(f);
const dup = Object.entries(owner).filter(([, fs]) => fs.length > 1);
if (dup.length) console.log('declared in several files:', dup.map(([id, fs]) => id + ' (' + fs.join(', ') + ')').join('; '), '\n');
for (const f of files) {
  const needs = {};
  for (const id of used[f]) {
    if (decls[f].has(id) || !owner[id]) continue;
    for (const g of owner[id]) (needs[g] = needs[g] || []).push(id);
  }
  console.log(f);
  for (const [g, ids] of Object.entries(needs).sort()) console.log('   from ' + g.padEnd(18) + ids.sort().join(', '));
}
