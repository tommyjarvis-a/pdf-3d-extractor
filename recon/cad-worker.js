/* cad-worker.js - classic Web Worker for "Export as CAD surfaces (STEP)" (pdf-3d-extractor, MIT).
 * Started lazily by recon/cad-export.js on first use and terminated after every run (frees the WASM heap; cancel = terminate).
 * Loads the PRC decoder + fitting code with importScripts and the vendored opencascade.js (LGPL-2.1) with dynamic import().
 *
 * in : {cmd:'run', prc:ArrayBuffer, partIdx:[i..] (index into parsePRC(...).parts.filter(p => p.faces.length) = app parts),
 *       names:[..], kernelBytes, solidsOnly (only closed solids go into fittedStep; open shells are left out)}
 * out: {type:'progress', stage, pct (0..1 within the worker's share), done, total, bytes, totalBytes, label}
 *      {type:'done', fittedStep:ArrayBuffer|null, byType (face count per STEP surface type)|null, parts:[{idx, status, reason, summary}], timings, wasmHeapPeak}
 *      {type:'error', message}
 * in : {cmd:'classify', prc:ArrayBuffer, order:[partIdx..]} (1.8.0 face-type panel: no kernel, segmentation + primitive
 *       classification only); {cmd:'prioritize', partIdx} moves a body to the front of the queue
 * out: {type:'faces', idx, counts:{plane, cylinder, cone, sphere, torus, freeform}|null, reason} per body, then {type:'classified'}
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
// Cache Storage copy of the wasm (cacheName from cad-export.js, versioned by the kernel tag): read first, written after a
// successful download; cad-export.js probes the same entry for estimate.kernelCached. Missing Cache Storage = HTTP cache only.
async function openKernelCache(name) {
  try { if (!name || typeof caches === 'undefined') return null; const c = await caches.open(name);
    caches.keys().then(ks => ks.forEach(k => { if (k !== name && k.startsWith('pdf3d-cad-kernel-')) caches.delete(k); })).catch(() => {});
    return c; } catch (e) { return null; }
}
async function fetchWasm(post, cacheName) {
  const cache = await openKernelCache(cacheName);
  if (cache) { try { const hit = await cache.match(KERNEL_WASM); if (hit && hit.ok) { const b = new Uint8Array(await hit.arrayBuffer()); if (b.length > 1e6) return b; } } catch (e) { /* fall through to the network */ } }
  const out = await downloadWasm(post);
  if (cache) { try { await cache.put(KERNEL_WASM, new Response(out, { headers: { 'Content-Type': 'application/wasm', 'Content-Length': String(out.length) } })); } catch (e) { /* quota / private mode */ } }
  return out;
}
async function downloadWasm(post) {
  const r = await fetch(KERNEL_WASM); if (!r.ok) throw new Error('CAD kernel download failed (HTTP ' + r.status + ')');
  const enc = r.headers.get('content-encoding'); const cl = +r.headers.get('content-length') || 0;
  const total = !enc && cl ? cl : KERNEL_RAW_BYTES;
  if (!r.body || !r.body.getReader) return new Uint8Array(await r.arrayBuffer());
  const rd = r.body.getReader(); const parts = []; let got = 0, lastPost = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length;
    const t = now(); if (t - lastPost > 100) { lastPost = t; const fr = Math.min(got / total, 1);
      // worker share: kernel download 0-0.10, kernel start 0.10-0.12 (the whole kernel stage is 0-0.12)
      post({ stage: 'kernel', pct: fr * 0.10, bytes: got, totalBytes: total, done: got, total,
        label: enc ? 'Loading CAD kernel ' + Math.round(fr * 100) + '% (' + (KERNEL_GZ_BYTES / 1e6).toFixed(1) + ' MB download)'
          : 'Loading CAD kernel ' + (got / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB' }); } }
  const out = new Uint8Array(got); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}
async function loadKernel(post, cacheName) {
  const t = now(); const wasmBinary = await fetchWasm(post, cacheName); const tDl = now() - t;
  post({ stage: 'kernel', pct: 0.10, label: 'Starting CAD kernel…' });
  const init = (await import(KERNEL_JS)).default;
  const oc = await new init({ wasmBinary: wasmBinary.buffer, locateFile: p => (p.endsWith('.wasm') ? KERNEL_WASM : p) });
  return { oc, downloadMs: tDl, initMs: now() - t - tDl };
}

// face types per body for the Bodies list (1.8.0): one body at a time, yielding between bodies so 'prioritize' gets through
let classifyQueue = null;
const FACE_KEY = { PLANE: 'plane', CYLINDER: 'cylinder', CONE: 'cone', SPHERE: 'sphere', TORUS: 'torus', FREEFORM: 'freeform' };
async function classifyAll(m) {
  try {
    const r = self.PRCDecoder.parsePRC(new Uint8Array(m.prc), { warnings: [], withNormals: true });
    const dparts = r.parts.filter(q => q.faces && q.faces.length);
    classifyQueue = (m.order || []).slice();
    while (classifyQueue.length) {
      await new Promise(res => setTimeout(res, 0));
      const i = classifyQueue.shift(); const p = dparts[i];
      if (!p) { self.postMessage({ type: 'faces', idx: i, counts: null, reason: 'not_found' }); continue; }
      if (!p.faceIndexPerTriangle || p.faceIndexPerTriangle.length !== p.faces.length) { self.postMessage({ type: 'faces', idx: i, counts: null, reason: 'no_face_data' }); continue; }
      const fit = self.PDF3DFit.fitMesh(Pipe.meshFromPart(p, r.units && r.units.unitsInMM), { classifyOnly: true });
      const counts = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, freeform: 0 };
      for (const g of fit.regions || []) counts[FACE_KEY[g.type] || 'freeform']++;
      self.postMessage({ type: 'faces', idx: i, counts });
    }
    self.postMessage({ type: 'classified' });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.message) || e), stage: 'classify' });
  }
  classifyQueue = null;
}

self.onmessage = async (ev) => {
  const m = ev.data;
  // probe (PDF3D.retryCadKernel): a fresh kernel download / Cache Storage read + init in this new worker, nothing else
  if (m && m.cmd === 'probe') {
    try { await loadKernel(() => {}, m.cacheName); self.postMessage({ type: 'kernel', ok: true }); self.postMessage({ type: 'probe', ok: true }); }
    catch (e) { self.postMessage({ type: 'error', message: String((e && e.message) || e), stage: 'kernel', oom: /memory|Aborted\(OOM|allocation/i.test(String(e && e.message || e)) }); }
    return;
  }
  if (m && m.cmd === 'prioritize') { if (classifyQueue) { const k = classifyQueue.indexOf(m.partIdx); if (k > 0) { classifyQueue.splice(k, 1); classifyQueue.unshift(m.partIdx); } } return; }
  if (m && m.cmd === 'classify') { await classifyAll(m); return; }
  if (!m || m.cmd !== 'run') return;
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
    let k; try { k = await loadKernel(post, m.cacheName); } catch (e) { if (e && typeof e === 'object') e.stage = 'kernel'; throw e; }
    oc = k.oc; heap(); self.postMessage({ type: 'kernel', ok: true });
    timings.kernel = Math.round(k.downloadMs + k.initMs); timings.kernelDownload = Math.round(k.downloadMs);
    post({ stage: 'kernel', pct: 0.12, label: 'CAD kernel ready' }, true);
    const sel = m.partIdx.filter(i => dparts[i]);
    const tris = sel.map(i => dparts[i].faces.length); const triSum = tris.reduce((a, b) => a + b, 0) || 1;
    let base = 0.12; const parts = [], bodies = [];
    timings.segment = 0; timings.fit = 0; timings.build = 0; timings.validate = 0;
    for (let s = 0; s < sel.length; s++) {
      const i = sel[s]; const p = dparts[i]; const span = 0.85 * tris[s] / triSum; const nm = (m.names && m.names[s]) || p.name;
      const mesh = Pipe.meshFromPart(p, r.units && r.units.unitsInMM);
      const of = sel.length > 1 ? ' (body ' + (s + 1) + '/' + sel.length + ')' : '';
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
      // only parts the summary reports as fitted (solid, or shell unless solids-only) get a _fitted body; a mesh_only part's partial shape is not written
      if (res.shape && (res.status === 'solid' || (!m.solidsOnly && res.status === 'shell'))) bodies.push([res.shape, res.summary.name + '_fitted']);
      base += span;
    }
    post({ stage: 'write', pct: 0.97, label: 'Writing fitted surfaces…' }, true);
    t = now(); let fitted = null;
    let byType = null;
    if (bodies.length) { const bytes = Pipe.writeFitted(oc, bodies, Pipe.baseName((m.names && m.names[0]) || dparts[sel[0]].name)); fitted = bytes.slice().buffer; byType = Pipe.stepFaceTypes(new Uint8Array(fitted)); }
    timings.writeFitted = Math.round(now() - t); heap();
    timings.worker = Math.round(now() - T0);
    self.postMessage({ type: 'done', fittedStep: fitted, byType, parts, timings, wasmHeapPeak: heapPeak }, fitted ? [fitted] : []);
  } catch (e) {
    heap();
    self.postMessage({ type: 'error', message: String((e && e.message) || e), stage: (e && e.stage) || null, wasmHeapPeak: heapPeak, oom: /memory|Aborted\(OOM|allocation/i.test(String(e && e.message || e)) });
  }
};
