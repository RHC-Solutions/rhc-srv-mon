#!/usr/bin/env node
/**
 * Proves the page assembled from ui/ is byte-identical to the literals in a reference
 * server.js (default: main's), and that no top-level identifier is declared in two ui files.
 *
 *   node scripts/check-page.js [reference-server.js]      # default: git show main:server.js
 *   node scripts/check-page.js --idents-only               # after UI edits: only the duplicate check
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { evalPages } = require('./extract-ui');
const pageLib = require('../lib/page');

let fail = false;
const identsOnly = process.argv.includes('--idents-only');

// 1. duplicate top-level identifiers across the concatenated files
const files = pageLib.jsFiles();
const seen = new Map();
for (const f of files) {
  for (const id of pageLib.topLevelIdents(fs.readFileSync(path.join(pageLib.UI_DIR, f), 'utf8'))) {
    if (seen.has(id) && seen.get(id) !== f) { console.error(`duplicate top-level identifier "${id}" in ${seen.get(id)} and ${f}`); fail = true; }
    seen.set(id, f);
  }
}
console.log(`${files.length} ui script file(s), ${seen.size} top-level identifiers${fail ? '' : ', no duplicates'}`);

// 2. the build parses (vm.Script inside build())
let built;
try { built = pageLib.build(); console.log(`built page: ${built.length} bytes`); }
catch (e) { console.error(e.message); process.exit(1); }

if (!identsOnly) {
  const ref = process.argv[2] && !process.argv[2].startsWith('--')
    ? fs.readFileSync(process.argv[2], 'utf8')
    : execFileSync('git', ['show', 'main:server.js'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 64 << 20 });
  const { PAGE, LOGIN_PAGE } = evalPages(ref);
  const cmp = (name, a, b) => {
    if (a === b) { console.log(`${name}: identical (${a.length} bytes)`); return; }
    fail = true;
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    console.error(`${name}: DIFFERS at byte ${i} (ref ${a.length} vs built ${b.length})\n  ref  : ${JSON.stringify(a.slice(i - 40, i + 60))}\n  built: ${JSON.stringify(b.slice(i - 40, i + 60))}`);
  };
  cmp('PAGE', PAGE, built);
  cmp('LOGIN_PAGE', LOGIN_PAGE, pageLib.loginPage());
}
process.exit(fail ? 1 : 0);
