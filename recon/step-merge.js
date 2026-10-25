/* step-merge.js - concatenate the DATA sections of several ISO-10303-21 (STEP) files into one file.
 * Entity ids of every file after the first are shifted past the previous maximum; '#n' inside quoted strings
 * (e.g. PRC labels like 'part/BrepModel#7') is left untouched. Each input keeps its own products/contexts, so the
 * result holds one independent product per input body. Part of pdf-3d-extractor (MIT). */
(function (root) {
  'use strict';
  // returns {header, data, maxId}; data = text between 'DATA;' and its 'ENDSEC;' with ids shifted by `offset`
  function scan(text, offset) {
    const n = text.length; let i = 0, inStr = false, maxId = 0; const out = []; let seg = 0;
    let header = null, dataStart = -1, dataEnd = -1;
    // locate DATA; outside strings
    while (i < n) {
      const c = text.charCodeAt(i);
      if (inStr) { if (c === 39) { if (text.charCodeAt(i + 1) === 39) i++; else inStr = false; } i++; continue; }
      if (c === 39) { inStr = true; i++; continue; }
      if (c === 68 && text.startsWith('DATA;', i) && (i === 0 || /\s/.test(text[i - 1]))) { header = text.slice(0, i); dataStart = i + 5; break; }
      i++;
    }
    if (dataStart < 0) throw new Error('STEP merge: no DATA section');
    i = dataStart; seg = dataStart; inStr = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (inStr) { if (c === 39) { if (text.charCodeAt(i + 1) === 39) i++; else inStr = false; } i++; continue; }
      if (c === 39) { inStr = true; i++; continue; }
      if (c === 69 && text.startsWith('ENDSEC;', i)) { dataEnd = i; break; }
      if (c === 35) { // '#'
        let j = i + 1, v = 0; while (j < n) { const d = text.charCodeAt(j) - 48; if (d < 0 || d > 9) break; v = v * 10 + d; j++; }
        if (j > i + 1) { const id = v + offset; if (id > maxId) maxId = id; if (offset) { out.push(text.slice(seg, i), '#' + id); seg = j; } i = j; continue; }
      }
      i++;
    }
    if (dataEnd < 0) throw new Error('STEP merge: unterminated DATA section');
    out.push(text.slice(seg, dataEnd));
    return { header, data: out.join(''), maxId };
  }
  // texts: array of STEP strings. opts.fileName / opts.description replace FILE_NAME / FILE_DESCRIPTION in the first header.
  function mergeSTEP(texts, opts) {
    opts = opts || {}; let offset = 0, header = null; const parts = [];
    for (const t of texts) { if (!t) continue; const s = scan(t, offset); if (header === null) header = s.header; parts.push(s.data.replace(/^\s*\n?/, '').replace(/\s*$/, '\n')); offset = Math.max(offset, s.maxId); }
    if (header === null) throw new Error('STEP merge: no input');
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    if (opts.description) header = header.replace(/FILE_DESCRIPTION\s*\([\s\S]*?\);/, `FILE_DESCRIPTION((${q(opts.description)}),'2;1');`);
    if (opts.fileName) header = header.replace(/FILE_NAME\s*\([\s\S]*?\);\s*(?=FILE_SCHEMA)/, `FILE_NAME(${q(opts.fileName)},${q(opts.timeStamp || new Date().toISOString().slice(0, 19))},(${q(opts.author || '')}),(''),${q(opts.preprocessor || '3D PDF Geometry Extractor')},'Open CASCADE 7.6','');\n`);
    return header.replace(/\s*$/, '\n') + 'DATA;\n' + parts.join('') + 'ENDSEC;\nEND-ISO-10303-21;\n';
  }
  const api = { mergeSTEP, scan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDF3DStepMerge = api;
})(typeof self !== 'undefined' ? self : this);
