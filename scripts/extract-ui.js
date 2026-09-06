#!/usr/bin/env node
/**
 * One-off extraction of the inline dashboard from the pre-split server.js into ui/.
 *
 *   node scripts/extract-ui.js <old-server.js> [--write]
 *
 * The old file held the whole front-end as two template literals (`PAGE`, `LOGIN_PAGE`)
 * with every backslash doubled. Copying the text would silently change escapes, so the
 * literals are sliced out and *evaluated* (never require()d — that would start a server)
 * to get the exact bytes the browser used to receive. `evalPages()` is reused by
 * scripts/check-page.js to prove the rebuilt page is byte-identical.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function sliceLiteral(src, name) {
  const start = src.indexOf('const ' + name + ' = `');
  if (start < 0) throw new Error(name + ' not found');
  const open = src.indexOf('`', start);
  // The literal ends at the first "`;" that is followed by a newline — neither page has a
  // nested backtick-semicolon-newline anywhere else.
  const end = src.indexOf('`;\n', open + 1);
  if (end < 0) throw new Error(name + ' end not found');
  return src.slice(open, end + 1);
}

function evalPages(src) {
  const out = {};
  for (const name of ['PAGE', 'LOGIN_PAGE']) {
    const lit = sliceLiteral(src, name);
    out[name] = vm.runInNewContext(lit, {}, { filename: name });
  }
  return out;
}

// Split PAGE into shell / css / js. Markers are placed exactly where the content was so
// the rebuild is `shell.replace('{{css}}', css).replace('{{js}}', js)`.
function splitPage(page) {
  const styleOpen = page.indexOf('<style>\n');
  const styleClose = page.indexOf('</style>', styleOpen);
  const scriptOpen = page.lastIndexOf('<script>\n');
  const scriptClose = page.lastIndexOf('</script>');
  if ([styleOpen, styleClose, scriptOpen, scriptClose].some(i => i < 0)) throw new Error('PAGE markers not found');
  const css = page.slice(styleOpen + '<style>\n'.length, styleClose);
  const js = page.slice(scriptOpen + '<script>\n'.length, scriptClose);
  const shell = page.slice(0, styleOpen + '<style>\n'.length) + '{{css}}' + page.slice(styleClose, scriptOpen + '<script>\n'.length) + '{{js}}' + page.slice(scriptClose);
  return { shell, css, js };
}

module.exports = { evalPages, splitPage, sliceLiteral };

if (require.main === module) {
  const file = process.argv[2];
  const write = process.argv.includes('--write');
  if (!file) { console.error('usage: extract-ui.js <old-server.js> [--write]'); process.exit(2); }
  const src = fs.readFileSync(file, 'utf8');
  const { PAGE, LOGIN_PAGE } = evalPages(src);
  const { shell, css, js } = splitPage(PAGE);
  console.log(`PAGE ${PAGE.length} bytes → shell ${shell.length}, css ${css.length}, js ${js.length}; LOGIN_PAGE ${LOGIN_PAGE.length}`);
  if (!write) return;
  const uiDir = path.join(__dirname, '..', 'ui');
  fs.mkdirSync(uiDir, { recursive: true });
  fs.writeFileSync(path.join(uiDir, 'index.html'), shell);
  fs.writeFileSync(path.join(uiDir, 'app.css'), css);
  fs.writeFileSync(path.join(uiDir, 'app.js'), js);
  fs.writeFileSync(path.join(uiDir, 'login.html'), LOGIN_PAGE);
  console.log('wrote ui/index.html ui/app.css ui/app.js ui/login.html');
}
