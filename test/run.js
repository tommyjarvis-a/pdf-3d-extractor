#!/usr/bin/env node
'use strict';
/*
 * Headless regression test for the PDF 3D Geometry Extractor (no dependencies).
 *
 *   node test/run.js [corpusDir] [--only=g01,r01] [--update] [--exports] [--identity]
 *
 * Loads the browser scripts in index.html order into a Node vm context with a minimal DOM stub,
 * then drives the public API window.CAD3DExtractor (loadPDFBuffer / activateStream / getState).
 * Always runs: bundled sample PDF, a synthetic PDF with embedded CAD attachments, chunked-text helpers.
 * With a corpus dir (or $PDF3D_CORPUS): every *.pdf is decoded and compared with test/expect.json
 * (streams, decode path and triangles per stream; with a "lastLoad" object also window.PDF3D.lastLoad right after the
 * load: each key the entry gives, e.g. status, reasonCode, attachments); --update rewrites expect.json from this run. A corpus file with no
 * expect.json entry fails, and so does one that decodes to 0 triangles unless its entry has "allowZeroTris": true.
 * A corpus dir with no matching *.pdf fails. Without a corpus only the built-in checks run and the last line says so.
 * --exports also builds every exporter on the sample, checks that PDF3D.exportFormat writes the same bytes into a
 * writable (streamed, no Blob created) as its download Blob for every format, and builds a merged Parasolid .x_t for
 * each corpus file. --identity runs that writable-vs-download check on every corpus file too (slow).
 * Every loaded PDF with embedded files (1.6.2): each lastLoad.attachmentDetails[i] goes through PDF3D.saveAttachment(i) both
 * ways (download Blob and a streamed writable: same bytes, <= 1 MiB Uint8Array writes, no Blob, close/abort left to the
 * caller); an entry with an error must give ATTACHMENT_UNREADABLE both ways. An expect.json entry may pin
 * "attachmentSha256": [sha256 | null per attachment] (from tools/make-damaged-fixtures.js; null = unreadable on purpose).
 * Every corpus file (1.6.2): no raw JavaScript error text (DataView, Cannot read properties...) in lastLoad detail / message /
 * damaged, and lastLoad.trisParsed >= tris on 'ok' loads.
 * $NX_PDF (or <corpus>/../nx2512-input.pdf) must give 37,196 triangles.
 */
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2); const flag = (n) => args.find((a) => a.startsWith('--' + n));
const only = (flag('only') || '').split('=')[1]; const update = !!flag('update'); const doExports = !!flag('exports'); const identity = !!flag('identity');
const corpus = args.find((a) => !a.startsWith('--')) || process.env.PDF3D_CORPUS || '';

function loadApp() {
  const noop = () => {};
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : el()), apply: () => el(), set: () => true });
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener: noop, body: el(), documentElement: el() };
  const window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, requestAnimationFrame: () => 0, alert: (m) => { window.__alerts.push(m); }, __alerts: [],
    matchMedia: () => ({ matches: false, media: '', addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }) };   // simple-mode.js / export-flow.js read media queries at load
  const ctx = { window, self: window, document, console, setTimeout, clearTimeout, setInterval, clearInterval, TextDecoder, TextEncoder, Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : undefined, Response: typeof Response !== 'undefined' ? Response : undefined,
    URL, atob, btoa, performance, crypto: globalThis.crypto, alert: window.alert, matchMedia: window.matchMedia, requestAnimationFrame: () => 0 };
  ctx.globalThis = ctx; vm.createContext(ctx);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map((m) => m[1]);
  for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), ctx, { filename: s });
  if (!window.CAD3DExtractor) throw new Error('window.CAD3DExtractor not exposed');
  return { api: window.CAD3DExtractor, window, scripts, ctx };
}

let failures = 0; const rows = [];
const check = (ok, msg) => { if (!ok) { failures++; console.log('  FAIL ' + msg); } return ok; };

// PDF3D.exportFormat: download Blob vs streamed writable, byte for byte, with the Blob constructor counted during the
// writable run (must stay 0)
async function exportIdentity(window, ctx, label) {
  const formats = [['xt'], ['step'], ['stl'], ['stl', { encoding: 'ascii' }], ['obj'], ['iges'], ['raw']];
  for (const [fmt, extra] of formats) {
    const name = fmt + (extra ? '-' + extra.encoding : '');
    // keep the check under ~1 GB per file (Node holds the download Blob in memory): XT from its estimate, the text
    // formats from the triangle count (STEP ~550, ASCII STL ~330, OBJ ~170 B per triangle at most)
    const tris = window.CAD3DExtractor.getState().parts.filter((p) => p.visible).reduce((n, p) => n + p.faces.length, 0);
    const guess = fmt === 'xt' ? ((await window.PDF3D.estimateBytes('xt')) || 0) : fmt === 'step' ? tris * 550 : (fmt === 'stl' && extra) ? tris * 330 : fmt === 'obj' ? tris * 170 : 0;
    if (guess > 1e9) { console.log(`  ${label} ${name}: about ${Math.round(guess / 1e6)} MB (over 1 GB, writable check skipped)`); continue; }
    const d = await window.PDF3D.exportFormat(fmt, { ...extra });
    if (!d || !d.blob) { console.log(`  ${label} ${name}: ${d ? d.status + ' ' + (d.reason || '') : 'no result'} (no file, skipped)`); continue; }
    if (d.blob.size > 1e9) { console.log(`  ${label} ${name}: ${d.blob.size} B (over 1 GB, writable check skipped)`); continue; }
    const hw = require('crypto').createHash('sha256'); for await (const c of d.blob.stream()) hw.update(c);
    const want = { length: d.blob.size, sha: hw.digest('hex') }; d.blob = null;
    const hg = require('crypto').createHash('sha256'); let gotLen = 0; let writes = 0, maxWrite = 0;
    const writable = { write: async (u8) => { check(Object.prototype.toString.call(u8) === '[object Uint8Array]', `${label} ${name}: write() got ${Object.prototype.toString.call(u8)}`); writes++; maxWrite = Math.max(maxWrite, u8.length); hg.update(u8); gotLen += u8.length; } };
    const RealBlob = ctx.Blob; let blobs = 0;
    ctx.Blob = function (...a) { blobs++; return new RealBlob(...a); };
    let w; try { w = await window.PDF3D.exportFormat(fmt, { ...extra, writable }); } finally { ctx.Blob = RealBlob; }
    const same = gotLen === want.length && hg.digest('hex') === want.sha;
    check(w && w.delivery === 'picker' && w.blob === null && w.size === want.length, `${label} ${name}: writable result ${w && w.status} ${w && w.delivery} size ${w && w.size}`);
    check(same, `${label} ${name}: writable bytes differ (${gotLen} vs ${want.length} B)`);
    check(blobs === 0, `${label} ${name}: ${blobs} Blob(s) created on the writable path`);
    check(maxWrite <= (1 << 22), `${label} ${name}: a single write of ${maxWrite} B`);
    console.log(`  ${label} ${name}: ${want.length} B ${same ? 'identical' : 'DIFFERENT'}, ${writes} writes (max ${maxWrite} B), Blobs on writable path: ${blobs}`);
  }
}

// PDF3D.saveAttachment (1.6.2): every attachment of the loaded PDF, download Blob vs streamed writable, byte for byte
const sha256 = (u8) => require('crypto').createHash('sha256').update(u8).digest('hex');
async function attachmentRoundTrip(window, ctx, label, expSha) {
  const det = ((window.PDF3D && window.PDF3D.lastLoad) || {}).attachmentDetails || []; const MiB = 1 << 20; const shas = [];
  if (expSha) check(expSha.length === det.length, `${label}: ${det.length} attachments, expect.json attachmentSha256 lists ${expSha.length}`);
  for (let i = 0; i < det.length; i++) {
    const d = det[i]; const tag = `${label} attachment ${i} ${JSON.stringify(d.name)}`;
    const dl = await window.PDF3D.saveAttachment(i);
    const h = require('crypto').createHash('sha256'); let got = 0, writes = 0, maxWrite = 0, badType = 0, closed = 0, aborted = 0;
    const writable = { write: async (u8) => { if (Object.prototype.toString.call(u8) !== '[object Uint8Array]') badType++; writes++; maxWrite = Math.max(maxWrite, u8.length); h.update(u8); got += u8.length; },
      close: async () => { closed++; }, abort: async () => { aborted++; } };
    const RealBlob = ctx.Blob; let blobs = 0; ctx.Blob = function (...a) { blobs++; return new RealBlob(...a); };
    let pk; try { pk = await window.PDF3D.saveAttachment(i, { writable }); } finally { ctx.Blob = RealBlob; }
    check(closed === 0 && aborted === 0, `${tag}: saveAttachment called close()/abort() (${closed}/${aborted})`);
    check(dl.name === d.fileName && pk.name === d.fileName && dl.mime === d.mime && pk.mime === d.mime, `${tag}: name/mime ${dl.name}/${dl.mime} vs details ${d.fileName}/${d.mime}`);
    if (d.error) {
      for (const [r, how] of [[dl, 'download'], [pk, 'picker']]) check(r.status === 'error' && r.reasonCode === 'ATTACHMENT_UNREADABLE' && r.blob === null && r.delivery === how && typeof r.errorName === 'string' && r.quota === false,
        `${tag} (${how}): unreadable entry gave ${r.status} ${r.reasonCode} ${r.errorName} ${r.quota}`);
      check(writes === 0, `${tag}: unreadable entry wrote ${writes} pieces`);
      shas.push(null); console.log(`  ${tag}: ATTACHMENT_UNREADABLE both ways (${d.error}; errorName ${dl.errorName})`); continue;
    }
    let dsha = null;
    if (check(dl.status === 'ok' && dl.delivery === 'download' && dl.blob && dl.size === d.size && dl.blob.size === d.size, `${tag}: download ${dl.status} ${dl.reasonCode} ${dl.delivery} size ${dl.size} (details ${d.size})`)) {
      check(dl.blob.type === (d.mime || 'application/octet-stream'), `${tag}: Blob type ${dl.blob.type}`); dsha = sha256(new Uint8Array(await dl.blob.arrayBuffer())); }
    const psha = h.digest('hex');
    check(pk.status === 'ok' && pk.delivery === 'picker' && pk.blob === null && pk.size === d.size && got === d.size, `${tag}: picker ${pk.status} ${pk.reasonCode} ${pk.delivery} size ${pk.size}/${got} (details ${d.size})`);
    check(blobs === 0 && badType === 0 && maxWrite <= MiB && writes === Math.ceil(d.size / MiB), `${tag}: picker made ${blobs} Blob(s), ${badType} non-Uint8Array writes, ${writes} writes (max ${maxWrite} B)`);
    check(dsha === psha, `${tag}: download and picker bytes differ`);
    if (expSha && expSha[i] !== undefined) check(psha === expSha[i], `${tag}: sha256 ${psha.slice(0, 16)}... expected ${String(expSha[i]).slice(0, 16)}...`);
    shas.push(psha); console.log(`  ${tag}: ${d.size} B ${dsha === psha ? 'identical both ways' : 'DIFFERENT'}${expSha ? (psha === expSha[i] ? ', = source' : ', SOURCE MISMATCH') : ''}, ${writes} writes (max ${maxWrite} B), Blobs on picker path ${blobs}, fileName ${JSON.stringify(d.fileName)}, mime ${d.mime}, isCAD ${d.isCAD}`);
    if (d.size > MiB) { // cancelling after the first piece: the cancelled shape, nothing more written
      const ac = new AbortController(); let w2 = 0; const r = await window.PDF3D.saveAttachment(i, { writable: { write: async () => { w2++; ac.abort(); } }, signal: ac.signal });
      check(r.status === 'cancelled' && r.reasonCode === 'cancelled' && w2 === 1, `${tag}: abort after the first piece gave ${r.status} after ${w2} writes`); }
  }
  return shas;
}
// saveAttachment error paths (on the loaded PDF's first readable attachment)
async function attachmentErrorPaths(window) {
  const det = window.PDF3D.lastLoad.attachmentDetails; const i = det.findIndex((d) => !d.error);
  for (const bad of [det.length, -1, '0', 1.5, undefined]) { const r = await window.PDF3D.saveAttachment(bad);
    check(r.status === 'error' && r.reasonCode === 'ATTACHMENT_UNREADABLE' && r.errorName === 'RangeError' && r.quota === false && r.blob === null, `saveAttachment(${JSON.stringify(bad)}): ${r.status} ${r.reasonCode} ${r.errorName}`); }
  const thrower = (name) => ({ write: async () => { throw Object.assign(new Error(name === 'QuotaExceededError' ? 'The disk is full.' : 'write refused'), { name }); } });
  for (const name of ['QuotaExceededError', 'NotAllowedError', 'TypeError']) { const r = await window.PDF3D.saveAttachment(i, { writable: thrower(name) });
    check(r.status === 'error' && r.reasonCode === 'WRITE_FAILED' && r.errorName === name && r.quota === (name === 'QuotaExceededError') && r.delivery === 'picker' && r.blob === null && r.size === null && r.name === det[i].fileName,
      `saveAttachment WRITE_FAILED ${name}: ${JSON.stringify({ ...r, blob: undefined })}`); }
  const ac = new AbortController(); ac.abort(); let w = 0;
  const r = await window.PDF3D.saveAttachment(i, { writable: { write: async () => { w++; } }, signal: ac.signal });
  check(r.status === 'cancelled' && r.reasonCode === 'cancelled' && w === 0, `saveAttachment with an aborted signal: ${r.status} after ${w} writes`);
  console.log('saveAttachment error paths: RangeError x5, WRITE_FAILED x3 (quota only for QuotaExceededError), pre-aborted signal -> cancelled');
}

async function decodeFile(api, file) {
  const u8 = new Uint8Array(fs.readFileSync(file)); const t0 = Date.now();
  await api.loadPDFBuffer(u8, path.basename(file));
  const lastLoad = api.getLastLoad ? api.getLastLoad() : null;   // outcome of the load itself, before other streams are activated
  const st = api.getState(); const streams = [];
  for (let i = 0; i < st.streams.length; i++) {
    await api.activateStream(i); const s = api.getState();
    const tris = s.parts.reduce((n, p) => n + p.faces.length, 0);
    const p = s.streams[i].parsed || {};
    streams.push({ format: s.streams[i].subtype, decodePath: p.decodePath || '?', parts: s.parts.length, tris, wires: (s.wires || []).length, warning: (p.warnings || [])[0] || '' });
    s.streams[i].parsed = null; // free memory between streams
  }
  return { streams, attachments: (st.attachments || []).map((a) => a.name), lastLoad, ms: Date.now() - t0 };
}

function syntheticAttachmentPDF(names) {
  const step = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'; names = names || ['bracket.step'];
  const objs = [`<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [${names.map((n, i) => `(${n}) ${4 + 2 * i} 0 R`).join(' ')}] >> >> >>`,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'];
  names.forEach((n, i) => objs.push(`<< /Type /Filespec /F (${n}) /UF (${n}) /EF << /F ${5 + 2 * i} 0 R >> >>`, `<< /Type /EmbeddedFile /Length ${step.length} >>\nstream\n${step}\nendstream`));
  let out = '%PDF-1.7\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  const { api, window, scripts, ctx } = loadApp(); let corpusRan = 0;
  console.log(`app ${window.CAD3DExtractorVersion} scripts: ${scripts.join(', ')}`);

  // 1. bundled sample
  { const r = await decodeFile(api, path.join(ROOT, 'sample-cad-assembly-3d.pdf')); const t = r.streams.reduce((n, s) => n + s.tris, 0);
    console.log(`sample: ${r.streams.length} streams, ${t} tris`); check(r.streams.length >= 1 && t > 0, 'bundled sample produced no geometry');
    if (doExports) { await api.activateStream(0);
      for (const k of ['buildParasolidXT', 'buildSTEPAP214', 'buildASCIISTL', 'buildWavefrontOBJ', 'buildBinarySTL']) { const o = api[k](); const len = Array.isArray(o) ? o.reduce((n, c) => n + c.length, 0) : (o.length || o.byteLength || 0); check(len > 100, k + ' empty'); console.log(`  ${k}: ${len}`); }
      await exportIdentity(window, ctx, 'sample'); } }

  // 2. embedded CAD attachment, no 3D annotation
  { const tmp = path.join(require('os').tmpdir(), 'pdf3d-attach-test.pdf'); fs.writeFileSync(tmp, syntheticAttachmentPDF());
    const r = await decodeFile(api, tmp); console.log(`attachment pdf: streams ${r.streams.length}, attachments ${r.attachments.join(', ')}`);
    check(r.streams.length === 0 && r.attachments.includes('bracket.step'), 'embedded STEP attachment not offered');
    await attachmentRoundTrip(window, ctx, 'attachment pdf'); await attachmentErrorPaths(window);
    // attachmentDetails[].isCAD (1.6.2): exactly these 19 extensions, any case
    const cad = ['stp', 'step', 'igs', 'iges', 'jt', 'x_t', 'x_b', 'sat', 'sab', '3dxml', 'stl', 'prt', 'catpart', 'catproduct', 'sldprt', 'sldasm', 'ipt', 'iam', 'vds'];
    const flip = (e) => e.split('').map((c, k) => (k % 2 ? c.toUpperCase() : c)).join('');
    const yes = cad.flatMap((e) => [`a.${e}`, `B.${e.toUpperCase()}`, `c.${flip(e)}`]);
    const no = ['d.obj', 'e.dwg', 'f.glb', 'g.txt', 'h.x_t.bak', 'stp', 'i.stpz', 'j.CATDrawing', 'k.pdf', 'l.3dm'];
    fs.writeFileSync(tmp, syntheticAttachmentPDF([...yes, ...no])); await decodeFile(api, tmp);
    const det = window.PDF3D.lastLoad.attachmentDetails; const wrong = det.filter((d) => d.isCAD !== yes.includes(d.name)).map((d) => d.name);
    check(det.length === yes.length + no.length && !wrong.length, `isCAD wrong for ${wrong.join(', ')} (${det.length} attachments)`);
    console.log(`isCAD: ${det.filter((d) => d.isCAD).length} of ${yes.length} CAD names (19 extensions x lower / UPPER / mixed case) and 0 of ${no.length} others`); }

  // 3. corpus
  if (corpus) {
    const expFile = path.join(__dirname, 'expect.json'); const expect = fs.existsSync(expFile) ? JSON.parse(fs.readFileSync(expFile, 'utf8')) : {};
    const files = fs.readdirSync(corpus).filter((f) => f.endsWith('.pdf') && (!only || only.split(',').some((o) => f.startsWith(o)))).sort();
    check(files.length > 0, `no *.pdf in ${corpus}${only ? ' matching --only=' + only : ''}`);
    const nx = process.env.NX_PDF || path.join(corpus, '..', 'nx2512-input.pdf');
    for (const f of files) {
      let r; try { r = await decodeFile(api, path.join(corpus, f)); } catch (e) { r = { error: e.message, streams: [], attachments: [] }; }
      const got = r.streams.map((s) => [s.format, s.decodePath, s.tris]); const exp = expect[f];
      let ok = !r.error; corpusRan++;
      if (!exp && !update) ok = check(false, `${f}: no entry in test/expect.json (run with --update to add one)`) && ok;
      const totalTris = r.streams.reduce((n, s) => n + s.tris, 0);
      if (!r.error && !totalTris && !(exp && exp.allowZeroTris)) ok = check(false, `${f}: 0 triangles (set "allowZeroTris": true in its expect.json entry if that is expected)`) && ok;
      if (exp && !update) ok = check(JSON.stringify(got) === JSON.stringify(exp.streams), `${f}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp.streams)}`) && ok;
      const ll = r.lastLoad || {};
      // 1.6.2: decoder runtime errors are never shown raw (Tester 1.6.1: "Offset is outside the bounds of the DataView")
      { const shown = [ll.detail, ll.message, ll.damaged].filter(Boolean).join(' | ');
        ok = check(!/DataView|typed array|out of bounds|Cannot read propert|is not a function|is not iterable|Invalid array length/i.test(shown), `${f}: raw runtime error text in lastLoad: ${shown.slice(0, 200)}`) && ok;
        if (ll.status === 'ok') ok = check(ll.trisParsed >= ll.tris, `${f}: lastLoad.trisParsed ${ll.trisParsed} < tris ${ll.tris}`) && ok; }
      if (!r.error && (ll.attachmentDetails || []).length) { const f0 = failures; await attachmentRoundTrip(window, ctx, f, exp && !update ? exp.attachmentSha256 : undefined); if (failures > f0) ok = false; }
      if (exp && exp.lastLoad && !update) for (const k of Object.keys(exp.lastLoad))
        ok = check(JSON.stringify(ll[k]) === JSON.stringify(exp.lastLoad[k]), `${f}: lastLoad.${k} ${JSON.stringify(ll[k])} expected ${JSON.stringify(exp.lastLoad[k])}`) && ok;
      if (update) {   // keep (and refresh) the lastLoad keys an entry pins; pin status/reasonCode for a new file that does not load ok
        const keys = exp && exp.lastLoad ? Object.keys(exp.lastLoad) : !exp && ll.status && ll.status !== 'ok' ? ['status', 'reasonCode'] : [];
        expect[f] = { ...(exp && exp.allowZeroTris ? { allowZeroTris: true } : {}), streams: got,
          ...(keys.length ? { lastLoad: Object.fromEntries(keys.map((k) => [k, ll[k] === undefined ? null : ll[k]])) } : {}),
          ...(exp && exp.attachmentSha256 ? { attachmentSha256: exp.attachmentSha256 } : {}) };
      }
      if (r.error) check(false, `${f}: ${r.error}`);
      if (doExports && !r.error) {   // Parasolid .x_t for every file: the stream the UI would show first with geometry
        const si = r.streams.findIndex((s) => s.tris > 0);
        if (si >= 0) { await api.activateStream(si); let len = 0, st = null;
          try { const o = api.buildParasolidXT({ brepMode: 'merged', blob: true }); for (const c of (Array.isArray(o) ? o : [o])) len += typeof c === 'string' ? c.length : (c.size || c.byteLength || 0); st = api.getLastXTStats(); }
          catch (e) { ok = check(false, `${f}: buildParasolidXT ${e.code || ''} ${e.message}`) && false; }
          if (st) { ok = check(len > 100 && st.faces > 0, `${f}: XT empty (${len} B, ${st.faces} faces)`) && ok;
            r.xt = `XT ${st.bodyType} ${st.faces} faces ${len} B`; console.log(`  ${f}: ${r.xt}`); }
          if (identity) await exportIdentity(window, ctx, f);
          const s = api.getState(); if (s.streams[si]) s.streams[si].parsed = null; }
      }
      rows.push(`| ${f} | ${ok ? 'PASS' : 'FAIL'} | ${r.streams.length} | ${r.streams.map((s) => s.decodePath).join(', ')} | ${r.streams.map((s) => s.tris).join(' + ')} | ${r.ms || '-'} | ${(r.streams.find((s) => s.warning) || {}).warning || r.error || ''}${r.xt ? ' ' + r.xt : ''} |`.replace(/\n/g, ' '));
      console.log(rows[rows.length - 1].slice(0, 220));
    }
    if (fs.existsSync(nx) && (!only || only.includes('nx'))) { const r = await decodeFile(api, nx); const t = r.streams.reduce((n, s) => n + s.tris, 0);
      console.log(`NX ${path.basename(nx)}: ${t} tris`); check(t === 37196, `NX: ${t} tris, expected 37196`); }
    if (update) { fs.writeFileSync(expFile, JSON.stringify(expect, null, 1) + '\n'); console.log('wrote ' + expFile); }
    fs.writeFileSync(path.join(require('os').tmpdir(), 'pdf3d-test-table.md'), '| file | result | streams | decode path | tris | ms | first warning |\n|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n');
  }
  if (failures) console.log(`${failures} FAILURE(S)`);
  else if (!corpus) console.log('OK: built-in checks only (no corpus given: 0 corpus files checked; pass a corpus dir or set PDF3D_CORPUS)');
  else console.log(`ALL OK (${corpusRan} corpus files)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
