#!/usr/bin/env node
'use strict';
// Builds pdf-3d-extractor-standalone.html: index.html with every <script src="..."> inlined (single offline file).
//   node tools/build-standalone.js
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace(/<script src="([^"?]+)(\?[^"]*)?"><\/script>/g, (m, src) => {
  const js = fs.readFileSync(path.join(ROOT, src), 'utf8').replace(/<(\/?)script/gi, '<\\$1script').replace(/<!--/g, '<\\!--');
  return `<script data-src="${src}">\n${js}\n</script>`;
});
if (/<script src=/.test(html)) throw new Error('unresolved external script');
fs.writeFileSync(path.join(ROOT, 'pdf-3d-extractor-standalone.html'), html);
console.log('wrote pdf-3d-extractor-standalone.html', html.length, 'bytes');
