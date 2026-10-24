#!/usr/bin/env node
'use strict';
/*
 * Headless regression test for the PDF 3D Geometry Extractor (no dependencies).
 *
 *   node test/run.js [corpusDir] [--only=g01,r01] [--update] [--exports]
 *
 * Loads the browser scripts in index.html order into a Node vm context with a minimal DOM stub,
 * then drives the public API window.CAD3DExtractor (loadPDFBuffer / activateStream / getState).
 * Always runs: bundled sample PDF, a synthetic PDF with embedded CAD attachments, chunked-text helpers.
 * With a corpus dir (or $PDF3D_CORPUS): every *.pdf is decoded and compared with test/expect.json
 * (streams, decode path and triangles per stream); --update rewrites expect.json from this run.
 * $NX_PDF (or <corpus>/../nx2512-input.pdf) must give 37,196 triangles.
 */
const fs = require('fs'); const path = require('path'); const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2); const flag = (n) => args.find((a) => a.startsWith('--' + n));
const only = (flag('only') || '').split('=')[1]; const update = !!flag('update'); const doExports = !!flag('exports');
const corpus = args.find((a) => !a.startsWith('--')) || process.env.PDF3D_CORPUS || '';

function loadApp() {
  const noop = () => {};
  const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : el()), apply: () => el(), set: () => true });
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener: noop, body: el(), documentElement: el() };
  const window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, requestAnimationFrame: () => 0, alert: (m) => { window.__alerts.push(m); }, __alerts: [] };
  const ctx = { window, self: window, document, console, setTimeout, clearTimeout, TextDecoder, TextEncoder, Blob: typeof Blob !== 'undefined' ? Blob : undefined,
    DecompressionStream: typeof DecompressionStream !== 'undefined' ? DecompressionStream : undefined, Response: typeof Response !== 'undefined' ? Response : undefined,
    URL, atob, btoa, performance, crypto: globalThis.crypto, alert: window.alert, requestAnimationFrame: () => 0 };
  ctx.globalThis = ctx; vm.createContext(ctx);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"?]+)/g)].map((m) => m[1]);
  for (const s of scripts) vm.runInContext(fs.readFileSync(path.join(ROOT, s), 'utf8'), ctx, { filename: s });
  if (!window.CAD3DExtractor) throw new Error('window.CAD3DExtractor not exposed');
  return { api: window.CAD3DExtractor, window, scripts };
}

let failures = 0; const rows = [];
const check = (ok, msg) => { if (!ok) { failures++; console.log('  FAIL ' + msg); } return ok; };

async function decodeFile(api, file) {
  const u8 = new Uint8Array(fs.readFileSync(file)); const t0 = Date.now();
  await api.loadPDFBuffer(u8, path.basename(file));
  const st = api.getState(); const streams = [];
  for (let i = 0; i < st.streams.length; i++) {
    await api.activateStream(i); const s = api.getState();
    const tris = s.parts.reduce((n, p) => n + p.faces.length, 0);
    const p = s.streams[i].parsed || {};
    streams.push({ format: s.streams[i].subtype, decodePath: p.decodePath || '?', parts: s.parts.length, tris, wires: (s.wires || []).length, warning: (p.warnings || [])[0] || '' });
    s.streams[i].parsed = null; // free memory between streams
  }
  return { streams, attachments: (st.attachments || []).map((a) => a.name), ms: Date.now() - t0 };
}

function syntheticAttachmentPDF() {
  const step = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
  const objs = ['<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles << /Names [(bracket.step) 4 0 R] >> >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
    '<< /Type /Filespec /F (bracket.step) /UF (bracket.step) /EF << /F 5 0 R >> >>',
    `<< /Type /EmbeddedFile /Length ${step.length} >>\nstream\n${step}\nendstream`];
  let out = '%PDF-1.7\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

(async () => {
  const { api, window, scripts } = loadApp();
  console.log(`app ${window.CAD3DExtractorVersion} scripts: ${scripts.join(', ')}`);

  // 1. bundled sample
  { const r = await decodeFile(api, path.join(ROOT, 'sample-cad-assembly-3d.pdf')); const t = r.streams.reduce((n, s) => n + s.tris, 0);
    console.log(`sample: ${r.streams.length} streams, ${t} tris`); check(r.streams.length >= 1 && t > 0, 'bundled sample produced no geometry');
    if (doExports) { await api.activateStream(0);
      for (const k of ['buildParasolidXT', 'buildSTEPAP214', 'buildASCIISTL', 'buildWavefrontOBJ', 'buildBinarySTL']) { const o = api[k](); const len = Array.isArray(o) ? o.reduce((n, c) => n + c.length, 0) : (o.length || o.byteLength || 0); check(len > 100, k + ' empty'); console.log(`  ${k}: ${len}`); } } }

  // 2. embedded CAD attachment, no 3D annotation
  { const tmp = path.join(require('os').tmpdir(), 'pdf3d-attach-test.pdf'); fs.writeFileSync(tmp, syntheticAttachmentPDF());
    const r = await decodeFile(api, tmp); console.log(`attachment pdf: streams ${r.streams.length}, attachments ${r.attachments.join(', ')}`);
    check(r.streams.length === 0 && r.attachments.includes('bracket.step'), 'embedded STEP attachment not offered'); }

  // 3. corpus
  if (corpus) {
    const expFile = path.join(__dirname, 'expect.json'); const expect = fs.existsSync(expFile) ? JSON.parse(fs.readFileSync(expFile, 'utf8')) : {};
    const files = fs.readdirSync(corpus).filter((f) => f.endsWith('.pdf') && (!only || only.split(',').some((o) => f.startsWith(o)))).sort();
    const nx = process.env.NX_PDF || path.join(corpus, '..', 'nx2512-input.pdf');
    for (const f of files) {
      let r; try { r = await decodeFile(api, path.join(corpus, f)); } catch (e) { r = { error: e.message, streams: [], attachments: [] }; }
      const got = r.streams.map((s) => [s.format, s.decodePath, s.tris]); const exp = expect[f];
      let ok = !r.error;
      if (exp && !update) ok = check(JSON.stringify(got) === JSON.stringify(exp.streams), `${f}: got ${JSON.stringify(got)} expected ${JSON.stringify(exp.streams)}`) && ok;
      if (update) expect[f] = { streams: got };
      if (r.error) check(false, `${f}: ${r.error}`);
      rows.push(`| ${f} | ${ok ? 'PASS' : 'FAIL'} | ${r.streams.length} | ${r.streams.map((s) => s.decodePath).join(', ')} | ${r.streams.map((s) => s.tris).join(' + ')} | ${r.ms || '-'} | ${(r.streams.find((s) => s.warning) || {}).warning || r.error || ''} |`.replace(/\n/g, ' '));
      console.log(rows[rows.length - 1].slice(0, 220));
    }
    if (fs.existsSync(nx) && (!only || only.includes('nx'))) { const r = await decodeFile(api, nx); const t = r.streams.reduce((n, s) => n + s.tris, 0);
      console.log(`NX ${path.basename(nx)}: ${t} tris`); check(t === 37196, `NX: ${t} tris, expected 37196`); }
    if (update) { fs.writeFileSync(expFile, JSON.stringify(expect, null, 1) + '\n'); console.log('wrote ' + expFile); }
    fs.writeFileSync(path.join(require('os').tmpdir(), 'pdf3d-test-table.md'), '| file | result | streams | decode path | tris | ms | first warning |\n|---|---|---|---|---|---|---|\n' + rows.join('\n') + '\n');
  }
  console.log(failures ? `${failures} FAILURE(S)` : 'ALL OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
