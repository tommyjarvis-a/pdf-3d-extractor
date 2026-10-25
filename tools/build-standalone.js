#!/usr/bin/env node
'use strict';
// Builds pdf-3d-extractor-standalone.html: index.html with every <script src="..."> and <link rel="stylesheet"> inlined (single offline file).
//   node tools/build-standalone.js
const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// One pass over the original markup, so tag-like text inside inlined files (e.g. the integration notes in
// simple-mode.js / *.css header comments) is never re-matched.
const TAG = /<script src="([^"?]+)(?:\?[^"]*)?"><\/script>|<link rel="stylesheet" href="([^"?]+)(?:\?[^"]*)?" \/>/g;
let n = 0;
const html = src.replace(TAG, (m, js, css) => {
  n++;
  if (js) {
    const code = fs.readFileSync(path.join(ROOT, js), 'utf8').replace(/<(\/?)script/gi, '<\\$1script').replace(/<!--/g, '<\\!--');
    return `<script data-src="${js}">\n${code}\n</script>`;
  }
  const sheet = fs.readFileSync(path.join(ROOT, css), 'utf8').replace(/<(\/?)style/gi, '<\\$1style');
  return `<style data-href="${css}">\n${sheet}\n</style>`;
});
const left = (src.match(/<script[^>]*\ssrc=|<link[^>]*rel="stylesheet"/g) || []).length;
if (left !== n) throw new Error(`unresolved external script/stylesheet: ${left} tags, ${n} inlined`);
fs.writeFileSync(path.join(ROOT, 'pdf-3d-extractor-standalone.html'), html);
console.log('wrote pdf-3d-extractor-standalone.html', html.length, 'bytes,', n, 'files inlined');
