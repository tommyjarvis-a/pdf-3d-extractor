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
  // Chunked variant for big inputs (the app's buildSTEPAP214 returns an array of line-aligned string chunks above
  // ~256 MB, past V8's max string length). inputs: array of (string | string[] | null). Returns an array of string
  // chunks for new Blob(chunks); no single string larger than the biggest input chunk is ever built.
  // Entity ids of input k are shifted by the max id of inputs 0..k-1 (put the small fitted file first: its ids stay).
  function mergeSTEPChunks(inputs, opts) {
    opts = opts || {}; let offset = 0, header = null; const out = [];
    for (const inp of inputs) {
      if (!inp) continue; const chunks = Array.isArray(inp) ? inp : [inp]; if (!chunks.length) continue;
      // phase: 0 = before DATA;, 1 = inside DATA, 2 = after ENDSEC. carry = incomplete last line of the previous chunk
      let phase = 0, carry = '', hdr = '', maxId = offset, inStr = false;
      const feed = (text, last) => {
        let s = carry + text; carry = '';
        if (!last) { const k = s.lastIndexOf('\n'); if (k < 0) { carry = s; return; } carry = s.slice(k + 1); s = s.slice(0, k + 1); }
        if (phase === 0) { const m = /(^|\s)DATA;/.exec(s); if (!m) { hdr += s; return; } const at = m.index + m[1].length; hdr += s.slice(0, at); s = s.slice(at + 5); phase = 1; }
        if (phase === 1) {
          const e = s.indexOf('ENDSEC;'); const body = e >= 0 ? s.slice(0, e) : s; if (e >= 0) phase = 2;
          const r = scanData(body, offset, inStr); inStr = r.inStr; if (r.maxId > maxId) maxId = r.maxId; if (r.text.trim()) out.push(r.text.replace(/^\s*\n?/, ''));
        }
      };
      for (let i = 0; i < chunks.length; i++) { feed(String(chunks[i]), false); chunks[i] = null; }
      feed('', true);
      if (phase === 0) throw new Error('STEP merge: no DATA section');
      if (header === null) header = hdr;
      if (out.length && !/\n$/.test(out[out.length - 1])) out.push('\n');
      offset = Math.max(offset, maxId);
    }
    if (header === null) throw new Error('STEP merge: no input');
    return [fixHeader(header, opts).replace(/\s*$/, '\n') + 'DATA;\n', ...out, 'ENDSEC;\nEND-ISO-10303-21;\n'];
  }
  // shift '#n' references (outside quoted strings) of a DATA-section fragment made of whole lines
  function scanData(text, offset, inStr) {
    const n = text.length; let i = 0;
    inStr = !!inStr; let maxId = 0, seg = 0; const out = [];
    while (i < n) {
      const c = text.charCodeAt(i);
      if (inStr) { if (c === 39) { if (text.charCodeAt(i + 1) === 39) i++; else inStr = false; } i++; continue; }
      if (c === 39) { inStr = true; i++; continue; }
      if (c === 35) { let j = i + 1, v = 0; while (j < n) { const d = text.charCodeAt(j) - 48; if (d < 0 || d > 9) break; v = v * 10 + d; j++; }
        if (j > i + 1) { const id = v + offset; if (id > maxId) maxId = id; if (offset) { out.push(text.slice(seg, i), '#' + id); seg = j; } i = j; continue; } }
      i++;
    }
    out.push(text.slice(seg)); return { text: out.join(''), maxId, inStr };
  }
  function fixHeader(header, opts) {
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    if (opts.description) header = header.replace(/FILE_DESCRIPTION\s*\([\s\S]*?\);/, `FILE_DESCRIPTION((${q(opts.description)}),'2;1');`);
    if (opts.fileName) header = header.replace(/FILE_NAME\s*\([\s\S]*?\);\s*(?=FILE_SCHEMA)/, `FILE_NAME(${q(opts.fileName)},${q(opts.timeStamp || new Date().toISOString().slice(0, 19))},(${q(opts.author || '')}),(''),${q(opts.preprocessor || '3D PDF Geometry Extractor')},'Open CASCADE 7.6','');\n`);
    return header;
  }
  const api = { mergeSTEP, mergeSTEPChunks, scan };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDF3DStepMerge = api;
})(typeof self !== 'undefined' ? self : this);
