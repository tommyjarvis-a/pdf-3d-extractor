/* cad-export.js - "Export as CAD surfaces (STEP)" API for pdf-3d-extractor (MIT). Main-thread side; the work runs in
 * recon/cad-worker.js (lazily started, terminated after each run). See recon/README.md for the contract and policies.
 *
 *   PDF3D.canExportCadSurfaces(partIds)  (sync, cheap, never loads the kernel)
 *     -> { ok, reason: null|'unavailable'|'too_large'|'no_parts', message, estimate: { tris, kernelBytes, kernelCached, mode } }
 *   PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal })
 *     -> Promise<{ blob, filename, status: 'solid'|'shell'|'mesh_only'|'skipped'|'cancelled', reason, reasonCode,
 *                  summary: { faces, byType, closed, valid, unfitFaces, meshFallback, timings, tris, parts, wasmHeapPeak } }>
 *   partIds: indices into CAD3DExtractor.getState().parts; null/undefined = all visible parts.
 */
(function () {
  'use strict';
  const NS = (window.PDF3D = window.PDF3D || {});
  const cs = document.currentScript;
  // the single-file build inlines this script (no src): no worker/kernel files next to it -> 'unavailable'
  const SRC = cs && cs.src ? cs.src : null;
  const VER = SRC ? (new URL(SRC).searchParams.get('v') || '') : '';
  const WORKER_URL = SRC ? new URL('cad-worker.js' + (VER ? '?v=' + encodeURIComponent(VER) : ''), SRC).href : null;

  const LIMITS = {
    maxTris: 1000000,    // above: 'too_large' (skipped) - the WASM heap would run out (2-4 GB limit)
    maxFitTris: 200000,  // above: mesh body only (fitting would take many minutes and >1.5 GB)
  };
  const KERNEL_BYTES = 13719175;  // gzip transfer size of opencascade.full.wasm (50.3 MB raw)
  const LS_KEY = 'pdf3d.cadKernel';
  const KERNEL_TAG = 'occjs-2.0.0-beta.b5ff984';

  const unavailableWhy = () => {
    if (!SRC) return 'CAD surface export is not available in the single-file (offline) build — use the online version';
    if (location.protocol === 'file:') return 'CAD surface export needs the page to be served over http(s), not opened as a local file';
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return 'This browser does not support Web Workers / WebAssembly';
    return null;
  };
  const appState = () => { try { return window.CAD3DExtractor && window.CAD3DExtractor.getState(); } catch (e) { return null; } };
  const kernelCached = () => { try { return localStorage.getItem(LS_KEY) === KERNEL_TAG; } catch (e) { return false; } };
  const trisOf = (p) => (p && (p.triCount || (p.faces && p.faces.length) || (p.idx ? p.idx.length / 3 : 0))) | 0;

  function selection(partIds) {
    const st = appState(); const all = (st && st.parts) || [];
    const ids = partIds == null ? all.map((p, i) => i).filter((i) => all[i].visible !== false) : [...new Set([].concat(partIds))].filter((i) => Number.isInteger(i) && all[i]);
    const parts = ids.map((i) => all[i]); const tris = parts.reduce((s, p) => s + trisOf(p), 0);
    const stream = st && st.streams && st.streams[st.activeStreamIdx];
    const parsed = stream && stream.parsed;
    const fittable = !!(stream && stream.subtype === 'PRC' && stream.rawBytes && parsed && parsed.decodePath !== 'sample');
    let mode = 'fit', why = null;
    if (!fittable) { mode = 'mesh_only'; why = stream && stream.subtype === 'U3D' ? 'U3D models carry no CAD face data, so only the mesh body is exported' : 'This model carries no CAD face data, so only the mesh body is exported'; }
    else if (tris > LIMITS.maxFitTris) { mode = 'mesh_only'; why = 'Too many triangles to fit surfaces in the browser (' + fmtK(tris) + ', fitting limit ' + fmtK(LIMITS.maxFitTris) + '), so only the mesh body is exported'; }
    return { st, ids, parts, tris, stream, mode, why };
  }
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + ' M' : Math.round(n / 1e3) + ' k') + ' triangles';

  function canExportCadSurfaces(partIds) {
    const sel = selection(partIds);
    const estimate = { tris: sel.tris, kernelBytes: KERNEL_BYTES, kernelCached: kernelCached(), mode: sel.mode };
    const un = unavailableWhy();
    if (un) return { ok: false, reason: 'unavailable', message: un, estimate };
    if (!sel.parts.length) return { ok: false, reason: 'no_parts', message: 'Open a 3D PDF with visible parts first', estimate };
    if (sel.tris > LIMITS.maxTris) return { ok: false, reason: 'too_large', message: 'Model too large to fit surfaces in the browser (' + fmtK(sel.tris) + ', limit ' + fmtK(LIMITS.maxTris) + ')', estimate };
    return { ok: true, reason: null, message: sel.why || '', estimate };
  }

  const zeroTypes = () => ({ plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0 });
  let running = false;

  async function exportCadSurfaces(partIds, opts) {
    const o = opts || {}; const fittedOnly = !!o.fittedOnly; const signal = o.signal;
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    const emit = (p) => { try { onProgress(p); } catch (e) { setTimeout(() => { throw e; }); } };
    const T0 = performance.now(); const timings = {};
    const pre = canExportCadSurfaces(partIds); const sel = selection(partIds);
    const stem = ((sel.st && sel.st.fileName) || 'cad-3d-pdf-assembly').replace(/\.(pdf|u3d|prc)$/i, '');
    const filename = stem + (fittedOnly ? '-surfaces-only.stp' : '-surfaces.stp');
    const blank = (extra) => ({ faces: 0, byType: zeroTypes(), closed: false, valid: false, unfitFaces: [], meshFallback: false, timings, tris: sel.tris, parts: [], wasmHeapPeak: 0, ...extra });
    const cancelled = () => ({ blob: null, filename: null, status: 'cancelled', reason: 'Cancelled by user', reasonCode: 'cancelled', summary: null });
    if (!pre.ok) return { blob: null, filename: null, status: 'skipped', reason: pre.message, reasonCode: pre.reason, summary: blank() };
    if (signal && signal.aborted) return cancelled();
    if (running) throw new Error('A CAD surface export is already running');
    running = true;
    try {
      let wres = null, workerErr = null;
      if (sel.mode === 'fit') {
        wres = await runWorker(sel, emit, signal);
        if (wres === 'cancelled') return cancelled();
        if (wres && wres.error) { workerErr = wres; wres = null; }
      }
      if (signal && signal.aborted) return cancelled();
      // per-part outcome -> overall status
      const parts = wres ? wres.parts : []; const bodiesOk = parts.filter((p) => p.status === 'solid' || p.status === 'shell');
      let status, reason = null, reasonCode = null;
      if (workerErr) { status = 'mesh_only'; reasonCode = workerErr.oom ? 'out_of_memory' : 'error'; reason = (workerErr.oom ? 'Ran out of browser memory while fitting surfaces' : 'Surface fitting failed: ' + workerErr.message) + ' — exported the mesh body only'; }
      else if (sel.mode !== 'fit') { status = 'mesh_only'; reasonCode = sel.tris > LIMITS.maxFitTris ? 'fit_limit' : 'no_face_data'; reason = sel.why; }
      else if (!bodiesOk.length) { status = 'mesh_only'; reasonCode = 'no_fit'; reason = 'No clean surface fit: ' + (parts.map((p) => p.reason).filter(Boolean)[0] || 'no face could be fitted'); }
      else if (bodiesOk.length === parts.length && parts.every((p) => p.status === 'solid')) status = 'solid';
      else { status = 'shell'; reasonCode = 'open_shell'; reason = parts.filter((p) => p.status !== 'solid').map((p) => p.summary.name + ': ' + (p.reason || p.status)).join('; '); }
      if (fittedOnly && !bodiesOk.length) {
        timings.total = Math.round(performance.now() - T0);
        return { blob: null, filename: null, status: 'skipped', reason: (reason || 'Nothing could be fitted') + ' (fitted-only export: no file written)', reasonCode: reasonCode || 'no_fit', summary: summarize(parts, wres, sel, false, timings) };
      }
      // mesh body (app exporter, main thread) + text merge
      const workerShare = sel.mode === 'fit' ? 92 : 0;
      let meshText = null;
      if (!fittedOnly) {
        emit({ stage: 'write', pct: workerShare, label: 'Writing mesh body…' });
        await new Promise((r) => setTimeout(r, 30));
        if (signal && signal.aborted) return cancelled();
        const t = performance.now();
        const byIdx = new Map(parts.map((p) => [p.idx, p]));
        const meshParts = sel.ids.map((i, k) => { const ap = sel.parts[k]; const wp = byIdx.get(i);
          return wp && (wp.status === 'solid' || wp.status === 'shell') ? { ...ap, name: wp.summary.name + '_mesh', visible: true } : { ...ap, visible: true }; });
        meshText = window.CAD3DExtractor.buildSTEPAP214({ parts: meshParts, units: 'mm', brepMode: 'merged', detail: 1 });
        timings.meshWrite = Math.round(performance.now() - t);
      }
      if (signal && signal.aborted) return cancelled();
      emit({ stage: 'write', pct: 99, label: 'Writing STEP…' });
      const t = performance.now();
      const fittedText = wres && wres.fittedStep ? new TextDecoder().decode(wres.fittedStep) : null;
      const chunks = window.PDF3DStepMerge.mergeSTEPChunks([fittedText, meshText], { fileName: filename, description: '3D PDF CAD surfaces - STEP AP214' });
      const blob = new Blob(chunks, { type: 'application/step' });
      timings.write = Math.round(performance.now() - t) + (timings.meshWrite || 0) + ((wres && wres.timings.writeFitted) || 0);
      timings.total = Math.round(performance.now() - T0);
      emit({ stage: 'write', pct: 100, label: 'Done', bytes: blob.size, totalBytes: blob.size });
      if (signal && signal.aborted) return cancelled();
      return { blob, filename, status, reason, reasonCode, summary: summarize(parts, wres, sel, !fittedOnly, timings) };
    } finally { running = false; }
  }

  function summarize(parts, wres, sel, meshFallback, timings) {
    const byType = zeroTypes(); let faces = 0; const unfit = [];
    for (const p of parts) { if (p.status === 'mesh_only') { for (const f of p.summary.unfitFaces || []) unfit.push({ part: p.idx, face: f }); continue; }
      faces += p.summary.faces; for (const k in p.summary.byType) byType[k] = (byType[k] || 0) + p.summary.byType[k];
      for (const f of p.summary.unfitFaces || []) unfit.push({ part: p.idx, face: f }); }
    const all = parts.length > 0 && parts.every((p) => p.status === 'solid');
    if (wres) for (const k of ['kernel', 'kernelDownload', 'decode', 'segment', 'fit', 'build', 'validate']) if (wres.timings[k] != null) timings[k] = wres.timings[k];
    return { faces, byType, closed: all, valid: all, unfitFaces: unfit, meshFallback, timings, tris: sel.tris,
      parts: parts.map((p) => ({ index: p.idx, name: p.summary.name, status: p.status, reason: p.reason, faces: p.summary.faces, tris: p.summary.tris, check: p.summary.check })),
      wasmHeapPeak: (wres && wres.wasmHeapPeak) || 0 };
  }

  function runWorker(sel, emit, signal) {
    return new Promise((resolve) => {
      let w; try { w = new Worker(WORKER_URL); } catch (e) { resolve({ error: true, message: String(e && e.message || e) }); return; }
      let done = false; let lastPct = 0; let heapPeak = 0;
      const finish = (v) => { if (done) return; done = true; try { w.terminate(); } catch (e) { /* gone */ } if (signal) signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => finish('cancelled');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      w.onmessage = (ev) => { const m = ev.data || {};
        if (m.type === 'progress') { const pct = Math.max(lastPct, Math.round(m.pct * 92 * 10) / 10); lastPct = pct;
          if (m.stage === 'kernel' && m.pct >= 0.12) { try { localStorage.setItem(LS_KEY, KERNEL_TAG); } catch (e) { /* private mode */ } }
          emit({ stage: m.stage, pct, done: m.done, total: m.total, bytes: m.bytes, totalBytes: m.totalBytes, label: m.label }); }
        else if (m.type === 'done') { heapPeak = m.wasmHeapPeak; finish({ fittedStep: m.fittedStep, parts: m.parts, timings: m.timings || {}, wasmHeapPeak: heapPeak }); }
        else if (m.type === 'cancelled') finish('cancelled');
        else if (m.type === 'error') finish({ error: true, message: m.message, oom: !!m.oom, wasmHeapPeak: m.wasmHeapPeak }); };
      w.onerror = (e) => { e.preventDefault && e.preventDefault(); finish({ error: true, message: (e && e.message) || 'worker error', oom: /memory/i.test((e && e.message) || '') }); };
      const prc = sel.stream.rawBytes.slice().buffer;  // copy: the app keeps its bytes
      w.postMessage({ cmd: 'run', prc, partIdx: sel.ids, names: sel.parts.map((p) => p.name) }, [prc]);
      emit({ stage: 'kernel', pct: 0, label: kernelCached() ? 'Starting CAD kernel…' : 'Loading CAD kernel (' + (KERNEL_BYTES / 1048576).toFixed(1) + ' MB)…', bytes: 0, totalBytes: KERNEL_BYTES });
    });
  }

  // UI: Designer's cad-export-ui.js (Simple menu item + Advanced button, progress/cancel toast) drives this API.

  if (!NS.exportCadSurfaces || NS.exportCadSurfaces.__cadStub) {
    NS.canExportCadSurfaces = canExportCadSurfaces;
    NS.exportCadSurfaces = exportCadSurfaces;
    NS.cadSurfaceLimits = LIMITS;
  }
})();
