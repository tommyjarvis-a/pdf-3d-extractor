/* cad-worker.js - classic Web Worker for "Export as CAD surfaces (STEP)" (pdf-3d-extractor, MIT).
 * Started lazily by recon/cad-export.js on first use and terminated after every run (frees the WASM heap; cancel = terminate).
 * Loads the PRC decoder + fitting code with importScripts and the vendored opencascade.js (LGPL-2.1) with dynamic import().
 *
 * in : {cmd:'run', prc:ArrayBuffer, partIdx:[i..] (index into parsePRC(...).parts.filter(p => p.faces.length) = app parts),
 *       names:[..], kernelBytes}
 * out: {type:'progress', stage, pct (0..1 within the worker's share), done, total, bytes, totalBytes, label}
 *      {type:'done', fittedStep:ArrayBuffer|null, parts:[{idx, status, reason, summary}], timings, wasmHeapPeak}
 *      {type:'error', message}
 */
'use strict';
importScripts('../prc-brep.js', '../prc-decoder.js', 'fit-linalg.js', 'fit.js', 'occ-build.js', 'pipeline.js');
const Pipe = self.PDF3DCadPipeline;
const now = () => performance.now();
const KERNEL_JS = new URL('vendor/opencascade/opencascade.full.js', self.location.href).href;
const KERNEL_WASM = new URL('vendor/opencascade/opencascade.full.wasm', self.location.href).href;
const KERNEL_RAW_BYTES = 50305130;
const KERNEL_GZ_BYTES = 13719175;  // typical transfer size with gzip

// fetch the wasm ourselves to report download progress (bytes are decompressed bytes; Content-Length may be the gzip size)
async function fetchWasm(post) {
  const r = await fetch(KERNEL_WASM); if (!r.ok) throw new Error('CAD kernel download failed (HTTP ' + r.status + ')');
  const enc = r.headers.get('content-encoding'); const cl = +r.headers.get('content-length') || 0;
  const total = !enc && cl ? cl : KERNEL_RAW_BYTES;
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(); const parts = []; let got = 0, lastPost = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length;
    const t = now(); if (t - lastPost > 100) { lastPost = t; const fr = Math.min(got / total, 1);
      // worker share: kernel download 0-0.10, kernel start 0.10-0.12 (the whole kernel stage is 0-0.12)
      post({ stage: 'kernel', pct: fr * 0.10, bytes: got, totalBytes: total, done: got, total,
        label: enc ? 'Loading CAD kernel ' + Math.round(fr * 100) + '% (' + (KERNEL_GZ_BYTES / 1048576).toFixed(1) + ' MB download)'
          : 'Loading CAD kernel ' + (got / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB' }); } }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
async function loadKernel(post) {
  const t = now(); const wasmBinary = await fetchWasm(post); const tDl = now() - t;
  post({ stage: 'kernel', pct: 0.10, label: 'Starting CAD kernel…' });
  const init = (await import(KERNEL_JS)).default;
  const oc = await new init({ wasmBinary: wasmBinary.buffer, locateFile: p => (p.endsWith('.wasm') ? KERNEL_WASM : p) });
  return { oc, downloadMs: tDl, initMs: now() - t - tDl };
}

self.onmessage = async (ev) => {
  const m = ev.data; if (!m || m.cmd !== 'run') return;
  const T0 = now(); const timings = {}; let heapPeak = 0; let oc = null;
  const heap = () => { if (oc && oc.HEAP8 && oc.HEAP8.length > heapPeak) heapPeak = oc.HEAP8.length; };
  // overall worker share: kernel 0-0.12, parts 0.12-0.97 (weighted by triangles), write 0.97-1
  let lastPost = 0;
  const post = (p, force) => { const t = now(); if (!force && t - lastPost < 80) return; lastPost = t; self.postMessage({ type: 'progress', ...p }); };
  try {
    let t = now();
    const prc = new Uint8Array(m.prc);
    const r = self.PRCDecoder.parsePRC(prc, { warnings: [], withNormals: true });
    const dparts = r.parts.filter(q => q.faces && q.faces.length); timings.decode = Math.round(now() - t);
    const k = await loadKernel(post); oc = k.oc; heap();
    timings.kernel = Math.round(k.downloadMs + k.initMs); timings.kernelDownload = Math.round(k.downloadMs);
    post({ stage: 'kernel', pct: 0.12, label: 'CAD kernel ready' }, true);
    const sel = m.partIdx.filter(i => dparts[i]);
    const tris = sel.map(i => dparts[i].faces.length); const triSum = tris.reduce((a, b) => a + b, 0) || 1;
    let base = 0.12; const parts = [], bodies = [];
    timings.segment = 0; timings.fit = 0; timings.build = 0; timings.validate = 0;
    for (let s = 0; s < sel.length; s++) {
      const i = sel[s]; const p = dparts[i]; const span = 0.85 * tris[s] / triSum; const nm = (m.names && m.names[s]) || p.name;
      const mesh = Pipe.meshFromPart(p, r.units && r.units.unitsInMM);
      const of = sel.length > 1 ? ' (part ' + (s + 1) + '/' + sel.length + ')' : '';
      // within a part: segment 0-0.05, primitives 0.05-0.25, free-form 0.25-0.8, build 0.8-0.97, validate 0.97-1
      let segT0 = now(), stageT = now(), curStage = 'segment';
      const enter = st => { if (st === curStage) return; const t2 = now(); timings[curStage] = (timings[curStage] || 0) + Math.round(t2 - stageT); stageT = t2; curStage = st; };
      const res = Pipe.runPart(oc, mesh, nm, { post: e => {
        heap(); let f = 0, label = '';
        const frac = e.total ? Math.min(e.done / e.total, 1) : 0;
        if (e.stage === 'segment') { enter('segment'); f = 0.02; label = 'Finding faces in the mesh' + of + '…'; }
        else if (e.stage === 'fit') { enter('fit'); if (e.sub === 'freeform') { f = 0.25 + 0.55 * frac; label = 'Fitting free-form faces ' + e.done + '/' + e.total + of; } else { f = 0.05 + 0.2 * frac; label = 'Fitting faces ' + e.done + '/' + e.total + of; } }
        else if (e.stage === 'build') { enter('build'); f = 0.8 + 0.17 * (e.sub === 'edges' ? 0.5 + 0.5 * frac : 0.5 * frac); label = 'Building solid' + (e.total ? ' ' + e.done + '/' + e.total : '') + of + '…'; }
        else if (e.stage === 'validate') { enter('validate'); f = 0.97; label = 'Checking the solid' + of + '…'; }
        else return;
        post({ stage: curStage, pct: base + span * f, done: e.done, total: e.total, label, part: s }, e.stage === 'validate');
      } });
      enter('done'); void segT0;
      heap();
      if (res.cancelled) { self.postMessage({ type: 'cancelled' }); return; }
      parts.push({ idx: i, status: res.status, reason: res.reason, summary: { ...res.summary, check: res.check || null, tris: tris[s] } });
      if (res.shape) bodies.push([res.shape, res.summary.name + '_fitted']);
      base += span;
    }
    post({ stage: 'write', pct: 0.97, label: 'Writing fitted surfaces…' }, true);
    t = now(); let fitted = null;
    if (bodies.length) { const bytes = Pipe.writeFitted(oc, bodies, Pipe.baseName(dparts[sel[0]].name)); fitted = bytes.slice().buffer; }
    timings.writeFitted = Math.round(now() - t); heap();
    timings.worker = Math.round(now() - T0);
    self.postMessage({ type: 'done', fittedStep: fitted, parts, timings, wasmHeapPeak: heapPeak }, fitted ? [fitted] : []);
  } catch (e) {
    heap();
    self.postMessage({ type: 'error', message: String((e && e.message) || e), wasmHeapPeak: heapPeak, oom: /memory|Aborted\(OOM|allocation/i.test(String(e && e.message || e)) });
  }
};
