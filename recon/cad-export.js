/* cad-export.js - "Export as CAD surfaces (STEP)" API for pdf-3d-extractor (MIT). Main-thread side; the work runs in
 * recon/cad-worker.js (lazily started, terminated after each run). See recon/README.md for the contract and policies.
 *
 *   PDF3D.canExportCadSurfaces(partIds)  (sync, cheap, never loads the kernel)
 *     -> { ok, reason: null|'unavailable'|'too_large'|'no_parts', message, estimate: { tris, kernelBytes, kernelCached, mode } }
 *   PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal, noBlob })
 *     noBlob: no Blob is made; the file is returned as _parts (STEP text chunks, strings) + _type with blob: null
 *     (PDF3D.exportFormat writing into a FileSystemWritableFileStream)
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
  // cad-worker.js has its own cache key: bump WORKER_REV when the worker changes within a release
  const WORKER_REV = '1';
  const WORKER_URL = SRC ? new URL('cad-worker.js?v=' + encodeURIComponent((VER || '0') + '-w' + WORKER_REV), SRC).href : null;

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
  // PDF3D.capabilities.cadSurfaces / cadSurfacesReason (1.6.0, read by export-flow.js each time the popover opens):
  // 'single_file' (inlined build; checked first, serving that file over http does not add the kernel files),
  // 'file_url' (page opened from a local file), 'kernel_download' (the last run could not download the kernel or start the
  // worker - cleared after a later successful run or when the browser comes back online), 'browser_unsupported' (no Worker
  // or no WebAssembly in this browser). Only these four codes are used.
  let kernelFailed = false;
  const capReason = () => (!SRC ? 'single_file' : location.protocol === 'file:' ? 'file_url'
    : (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') ? 'browser_unsupported'
    : kernelFailed ? 'kernel_download' : null);
  const updateCaps = () => {
    const r = capReason(); const c = (NS.capabilities = NS.capabilities || {});
    c.cadSurfaces = !r; c.cadSurfacesReason = r;
  };
  const appState = () => { try { return window.CAD3DExtractor && window.CAD3DExtractor.getState(); } catch (e) { return null; } };
  // kernelCached: a real check of the Cache Storage entry the worker writes after a successful kernel load (CACHE_NAME / the
  // wasm URL; no network request). The preflight is synchronous, so it reads the last probe result; the probe re-runs on load,
  // on every preflight (async, for the next call) and after every run. Without Cache Storage (non-secure http, some
  // private modes) it falls back to a localStorage flag that is set only after a run that loaded the kernel and finished.
  const CACHE_NAME = 'pdf3d-cad-kernel-' + KERNEL_TAG;
  const WASM_URL = SRC ? new URL('vendor/opencascade/opencascade.full.wasm', SRC).href : null;
  let cacheProbe = null;  // null = unknown / no Cache Storage, else boolean
  let probing = null;
  const probeKernelCache = () => {
    if (probing || !WASM_URL || typeof caches === 'undefined' || !caches || !caches.open) return probing;
    probing = caches.open(CACHE_NAME).then((c) => c.match(WASM_URL)).then((r) => { cacheProbe = !!(r && r.ok); }, () => { cacheProbe = null; })
      .then(() => { probing = null; return cacheProbe; });
    return probing;
  };
  const lsFlag = () => { try { return localStorage.getItem(LS_KEY) === KERNEL_TAG; } catch (e) { return false; } };
  const kernelCached = () => { probeKernelCache(); return cacheProbe != null ? cacheProbe : lsFlag(); };
  if (WASM_URL && location.protocol !== 'file:') probeKernelCache();
  const trisOf = (p) => (p && (p.triCount || (p.faces && p.faces.length) || (p.idx ? p.idx.length / 3 : 0))) | 0;

  function selection(partIds) {
    const st = appState(); const all = (st && st.parts) || [];
    const ids = partIds == null ? all.map((p, i) => i).filter((i) => all[i].visible !== false) : [...new Set([].concat(partIds))].filter((i) => Number.isInteger(i) && all[i]);
    const parts = ids.map((i) => all[i]); const tris = parts.reduce((s, p) => s + trisOf(p), 0);
    const stream = st && st.streams && st.streams[st.activeStreamIdx];
    const parsed = stream && stream.parsed;
    const fittable = !!(stream && stream.subtype === 'PRC' && stream.rawBytes && parsed && parsed.decodePath !== 'sample');
    let mode = 'fit', cause = null;
    if (!fittable) { mode = 'mesh_only'; cause = noFaceDataCause(stream); }
    else if (tris > LIMITS.maxFitTris) { mode = 'mesh_only'; cause = 'Too many triangles to fit surfaces in the browser (' + fmtK(tris) + ', fitting limit ' + fmtK(LIMITS.maxFitTris) + ')'; }
    // why: the preflight / mesh_only text; cause: the same without the mesh clause (fitted-only skips write nothing)
    // model-wide reason no part was fitted (1.6.1, summary.fitSkippedReason): the card can show one line instead of per-part rows
    const skip = mode === 'fit' ? { fitSkippedReason: null }
      : fittable ? { fitSkippedReason: 'too_many_tris', fitSkippedTris: tris, fitSkippedLimit: LIMITS.maxFitTris }
        : { fitSkippedReason: 'no_face_data' };
    return { st, ids, parts, tris, stream, mode, cause, skip, why: cause && cause + ', so only the mesh body is exported' };
  }
  // the source format of the active stream: payload magic first (the /Subtype can lie), then the decoder's format, then /Subtype
  const sourceFormat = (stream) => {
    const b = stream && stream.rawBytes;
    if (b && b.length >= 3) { const m = String.fromCharCode(b[0], b[1], b[2]); if (m === 'PRC' || m === 'U3D') return m; }
    const f = String((stream && stream.parsed && stream.parsed.format) || (stream && stream.subtype) || '');
    return /^PRC/i.test(f) ? 'PRC' : /^U3D/i.test(f) ? 'U3D' : null;
  };
  function noFaceDataCause(stream) {
    const fmt = sourceFormat(stream); const parsed = stream && stream.parsed;
    if (fmt === 'U3D') {
      return 'This U3D stream stores triangles only (no CAD face data)';
    }
    if (fmt === 'PRC') {
      if (parsed && parsed.decodePath === 'sample') return 'The bundled sample\u2019s PRC stream is a legacy container without CAD face data';
      if (!(stream && stream.rawBytes)) return 'The raw data of this PRC stream is not available, so no CAD faces can be read';
      return 'No CAD face data could be decoded from this PRC stream';
    }
    return 'This model carries no CAD face data';
  }
  const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 2) + ' M' : Math.round(n / 1e3) + ' k') + ' triangles';

  function canExportCadSurfaces(partIds) {
    const sel = selection(partIds);
    const estimate = { tris: sel.tris, kernelBytes: KERNEL_BYTES, kernelCached: kernelCached(), mode: sel.mode };
    const un = unavailableWhy();
    if (un) return { ok: false, reason: 'unavailable', message: un, estimate };
    if (!sel.parts.length) return { ok: false, reason: 'no_parts', message: 'Open a 3D PDF with visible bodies first', estimate };
    if (sel.tris > LIMITS.maxTris) return { ok: false, reason: 'too_large', message: 'Model too large to fit surfaces in the browser (' + fmtK(sel.tris) + ', limit ' + fmtK(LIMITS.maxTris) + ')', estimate };
    return { ok: true, reason: null, message: sel.why || '', estimate };
  }

  // UTF-8 bytes -> string chunks of ~size bytes each (a streaming decode keeps multi-byte characters whole).
  // buf: the worker's fittedStep, an ArrayBuffer (transferred), or any typed-array view
  function decodeChunks(buf, size) {
    const u8 = buf instanceof Uint8Array ? buf : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
    size = size || (4 << 20); const td = new TextDecoder('utf-8'); const out = [];
    for (let o = 0; o < u8.length; o += size) out.push(td.decode(u8.subarray(o, Math.min(u8.length, o + size)), { stream: o + size < u8.length }));
    return out;
  }
  // UTF-8 byte length of a string (lone surrogates count 3, as TextEncoder writes U+FFFD)
  function utf8Length(str) {
    let n = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length && (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  const zeroTypes = () => ({ plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, revolution: 0, bspline: 0 });
  let running = false;

  async function exportCadSurfaces(partIds, opts) {
    const o = opts || {}; const fittedOnly = !!o.fittedOnly; const signal = o.signal;
    // solidsOnly (fitted-only): write only closed solids as fitted bodies; open shells count as not fitted (PDF3D.exportFormat)
    const solidsOnly = fittedOnly && !!o.solidsOnly;
    const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
    const emit = (p) => { try { onProgress(p); } catch (e) { setTimeout(() => { throw e; }); } };
    const T0 = performance.now(); const timings = {};
    const pre = canExportCadSurfaces(partIds); const sel = selection(partIds);
    const stem = ((sel.st && sel.st.fileName) || 'cad-3d-pdf-assembly').replace(/\.(pdf|u3d|prc)$/i, '');
    const filename = stem + (fittedOnly ? '-surfaces-only.stp' : '-surfaces.stp');
    const blank = (extra) => ({ faces: 0, byType: zeroTypes(), closed: false, valid: false, unfitFaces: [], meshFallback: false, timings, tris: sel.tris, parts: [], wasmHeapPeak: 0, ...sel.skip, ...extra });
    const cancelled = () => ({ blob: null, filename: null, status: 'cancelled', reason: 'Cancelled by user', reasonCode: 'cancelled', summary: null });
    if (!pre.ok) return { blob: null, filename: null, status: 'skipped', reason: pre.message, reasonCode: pre.reason, summary: blank() };
    if (signal && signal.aborted) return cancelled();
    if (running) throw new Error('A CAD surface export is already running');
    running = true;
    try {
      let wres = null, workerErr = null;
      if (sel.mode === 'fit') {
        wres = await runWorker(sel, emit, signal, solidsOnly);
        if (wres === 'cancelled') return cancelled();
        if (wres && wres.error) { workerErr = wres; wres = null; }
      }
      if (signal && signal.aborted) return cancelled();
      // per-part outcome -> overall status
      const parts = wres ? wres.parts : []; const bodiesOk = parts.filter((p) => p.status === 'solid' || (!solidsOnly && p.status === 'shell'));
      let status, reason = null, reasonCode = null;
      let cause = null;
      // a worker run that got past the kernel clears an earlier kernel failure (Fitted / Both come back without a reload)
      if (!workerErr && wres && kernelFailed) { kernelFailed = false; updateCaps(); }
      if (workerErr) { status = 'mesh_only'; const fe = friendlyError(workerErr); reasonCode = fe.code; cause = fe.text; reason = cause + ' — exported the mesh body only';
        if (fe.code === 'kernel_download' || fe.code === 'worker_failed') { kernelFailed = true; updateCaps(); } }
      else if (sel.mode !== 'fit') { status = 'mesh_only'; reasonCode = sel.tris > LIMITS.maxFitTris ? 'fit_limit' : 'no_face_data'; cause = sel.cause; reason = sel.why; }
      else if (!bodiesOk.length) { status = 'mesh_only'; reasonCode = 'no_fit'; reason = cause = 'No clean surface fit: ' + (parts.map((p) => p.reason).filter(Boolean)[0] || 'no face could be fitted'); }
      else if (bodiesOk.length === parts.length && parts.every((p) => p.status === 'solid')) status = 'solid';
      else { status = 'shell'; reasonCode = 'open_shell'; reason = parts.filter((p) => p.status !== 'solid').map((p) => p.summary.name + ': ' + (p.reason || p.status)).join('; '); }
      if (fittedOnly && !bodiesOk.length) {
        timings.total = Math.round(performance.now() - T0);
        return { blob: null, filename: null, status: 'skipped', reason: (cause || 'Nothing could be fitted').replace(/[.\s]+$/, '') + '. Fitted-only export: no fitted surfaces, so no file was written', reasonCode: reasonCode || 'no_fit', summary: summarize(parts, wres, sel, false, timings) };
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
        // every mesh body in a Both file is <name>_mesh (fitted bodies are <name>_fitted), fitted or not
        const meshParts = sel.ids.map((i, k) => { const ap = sel.parts[k]; const wp = byIdx.get(i);
          return { ...ap, name: ((wp && wp.summary && wp.summary.name) || ap.name) + '_mesh', visible: true }; });
        meshText = window.CAD3DExtractor.buildSTEPAP214({ parts: meshParts, units: 'mm', brepMode: 'merged', detail: 1 });
        timings.meshWrite = Math.round(performance.now() - t);
      }
      if (signal && signal.aborted) return cancelled();
      emit({ stage: 'write', pct: 99, label: 'Writing STEP…' });
      const t = performance.now();
      // fitted STEP bytes -> 4 MiB string chunks (streamed decode; mergeSTEPChunks carries partial lines), never one big string
      const fittedText = wres && wres.fittedStep ? decodeChunks(wres.fittedStep) : null;
      // 1.6.2: damaged load -> PARTIAL note as a second FILE_DESCRIPTION string (window.PDF3D.partialNote() is null otherwise)
      const note = window.PDF3D && typeof window.PDF3D.partialNote === 'function' ? window.PDF3D.partialNote() : null;
      const chunks = window.PDF3DStepMerge.mergeSTEPChunks([fittedText, meshText], { fileName: filename, description: note ? ['3D PDF CAD surfaces - STEP AP214', note] : '3D PDF CAD surfaces - STEP AP214' });
      let size = 0;
      if (o.noBlob) for (const c of chunks) size += utf8Length(c);
      const blob = o.noBlob ? null : new Blob(chunks, { type: 'application/step' });
      if (blob) size = blob.size;
      timings.write = Math.round(performance.now() - t) + (timings.meshWrite || 0) + ((wres && wres.timings.writeFitted) || 0);
      timings.total = Math.round(performance.now() - T0);
      emit({ stage: 'write', pct: 100, label: 'Done', bytes: size, totalBytes: size });
      if (signal && signal.aborted) return cancelled();
      if (!blob) return { blob: null, _parts: chunks, _type: 'application/step', size, filename, status, reason, reasonCode, summary: summarize(parts, wres, sel, !fittedOnly, timings) };
      return { blob, filename, status, reason, reasonCode, summary: summarize(parts, wres, sel, !fittedOnly, timings) };
    } finally { running = false; }
  }

  // worker / kernel failures -> {code, text} a user can act on (raw 'Failed to fetch' / 'worker error' are not shown alone)
  const KMB = () => (KERNEL_BYTES / 1e6).toFixed(1) + ' MB';
  function friendlyError(e) {
    const msg = String((e && e.message) || '');
    if (e && e.oom) return { code: 'out_of_memory', text: 'Ran out of browser memory while fitting surfaces' };
    const http = msg.match(/HTTP (\d{3})/);
    if (http) return { code: 'kernel_download', text: 'Could not download the CAD kernel (' + KMB() + '): the server answered HTTP ' + http[1] };
    if (/failed to fetch|networkerror|network error|load failed|err_internet|err_network|dynamically imported module/i.test(msg))
      return { code: 'kernel_download', text: 'Could not download the CAD kernel (' + KMB() + '): you may be offline, or a firewall, proxy or extension blocked it' };
    if ((e && e.worker) || /^worker error$|^script error\.?$|importScripts/i.test(msg) || !msg)
      return { code: 'worker_failed', text: 'The CAD fitting worker could not start (offline, or blocked by the browser or the site\u2019s security policy)' };
    return { code: 'error', text: 'Surface fitting failed: ' + msg.replace(/^(Uncaught\s+)?(Error:\s*)?/, '') };
  }

  function summarize(parts, wres, sel, meshFallback, timings) {
    // one entry per body: the worker's list deduplicated by part index (never more rows than parts exported)
    const seen = new Set(); parts = parts.filter((p) => !seen.has(p.idx) && seen.add(p.idx));
    const byType = zeroTypes(); let faces = 0; const unfit = [];
    for (const p of parts) { if (p.status === 'mesh_only') { for (const f of p.summary.unfitFaces || []) unfit.push({ part: p.idx, face: f }); continue; }
      faces += p.summary.faces; for (const k in p.summary.byType) byType[k] = (byType[k] || 0) + p.summary.byType[k];
      for (const f of p.summary.unfitFaces || []) unfit.push({ part: p.idx, face: f }); }
    // the written STEP is authoritative for the face types (the writer re-encodes some tori as surfaces of revolution)
    if (wres && wres.byType) { for (const k in byType) byType[k] = 0; for (const k in wres.byType) if (wres.byType[k] || byType[k] != null) byType[k] = wres.byType[k]; }
    const all = parts.length > 0 && parts.every((p) => p.status === 'solid');
    if (wres) for (const k of ['kernel', 'kernelDownload', 'decode', 'segment', 'fit', 'build', 'validate']) if (wres.timings[k] != null) timings[k] = wres.timings[k];
    return { faces, byType, closed: all, valid: all, unfitFaces: unfit, meshFallback, timings, tris: sel.tris, ...sel.skip,
      parts: parts.map((p) => ({ index: p.idx, name: p.summary.name, status: p.status, reason: p.reason, faces: p.summary.faces, tris: p.summary.tris, check: p.summary.check })),
      wasmHeapPeak: (wres && wres.wasmHeapPeak) || 0 };
  }

  function runWorker(sel, emit, signal, solidsOnly) {
    return new Promise((resolve) => {
      let w; try { w = new Worker(WORKER_URL); } catch (e) { resolve({ error: true, worker: true, message: String(e && e.message || e) }); return; }
      let done = false; let lastPct = 0; let heapPeak = 0; let kernelLoaded = false;
      const finish = (v) => { if (done) return; done = true; setTimeout(probeKernelCache, 0); try { w.terminate(); } catch (e) { /* gone */ } if (signal) signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => finish('cancelled');
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      w.onmessage = (ev) => { const m = ev.data || {};
        if (m.type === 'progress') { const pct = Math.max(lastPct, Math.round(m.pct * 92 * 10) / 10); lastPct = pct;
          emit({ stage: m.stage, pct, done: m.done, total: m.total, bytes: m.bytes, totalBytes: m.totalBytes, label: m.label }); }
        else if (m.type === 'kernel') kernelLoaded = true;
        else if (m.type === 'done') { if (kernelLoaded) { try { localStorage.setItem(LS_KEY, KERNEL_TAG); } catch (e) { /* private mode */ } } heapPeak = m.wasmHeapPeak; finish({ fittedStep: m.fittedStep, byType: m.byType || null, parts: m.parts, timings: m.timings || {}, wasmHeapPeak: heapPeak }); }
        else if (m.type === 'cancelled') finish('cancelled');
        else if (m.type === 'error') finish({ error: true, message: m.message, stage: m.stage, oom: !!m.oom, wasmHeapPeak: m.wasmHeapPeak }); };
      w.onerror = (e) => { e.preventDefault && e.preventDefault(); finish({ error: true, worker: true, message: (e && e.message) || 'worker error', oom: /memory/i.test((e && e.message) || '') }); };
      const prc = sel.stream.rawBytes.slice().buffer;  // copy: the app keeps its bytes
      w.postMessage({ cmd: 'run', cacheName: CACHE_NAME, prc, partIdx: sel.ids, names: sel.parts.map((p) => p.name), solidsOnly: !!solidsOnly }, [prc]);
      emit({ stage: 'kernel', pct: 0, label: kernelCached() ? 'Starting CAD kernel…' : 'Loading CAD kernel (' + (KERNEL_BYTES / 1e6).toFixed(1) + ' MB)…', bytes: 0, totalBytes: KERNEL_BYTES });
    });
  }

  // PDF3D.retryCadKernel() -> Promise<boolean> (1.6.0, the export flow's 'Try again' for cadSurfacesReason 'kernel_download'):
  // clears the failed state and makes a real, fresh attempt: a new worker downloads (or reads from Cache Storage) and starts
  // the kernel. Nothing is memoised between attempts (every worker is new; a failed fetch / import is not cached). Updates
  // capabilities.cadSurfaces / cadSurfacesReason and resolves true when fitting is usable, false otherwise (reason stays
  // 'kernel_download'). single_file / file_url / browser_unsupported resolve false without trying. Concurrent calls share
  // one attempt. Never rejects.
  let retrying = null;
  function probeWorker() {
    return new Promise((resolve) => {
      let w; try { w = new Worker(WORKER_URL); } catch (e) { resolve({ error: true, worker: true, message: String(e && e.message || e) }); return; }
      let done = false; let kernelLoaded = false;
      const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { w.terminate(); } catch (e) { /* gone */ } setTimeout(probeKernelCache, 0); resolve(v); };
      const timer = setTimeout(() => finish({ error: true, message: 'CAD kernel download timed out (network error)' }), 180000);
      w.onmessage = (ev) => { const m = ev.data || {};
        if (m.type === 'kernel') kernelLoaded = true;
        else if (m.type === 'probe') { if (kernelLoaded) { try { localStorage.setItem(LS_KEY, KERNEL_TAG); } catch (e) { /* private mode */ } } finish({ ok: true }); }
        else if (m.type === 'error') finish({ error: true, message: m.message, oom: !!m.oom }); };
      w.onerror = (e) => { e.preventDefault && e.preventDefault(); finish({ error: true, worker: true, message: (e && e.message) || 'worker error' }); };
      w.postMessage({ cmd: 'probe', cacheName: CACHE_NAME });
    });
  }
  function retryCadKernel() {
    kernelFailed = false;
    if (capReason()) { updateCaps(); return Promise.resolve(false); }   // single_file / file_url / browser_unsupported
    if (retrying) return retrying;
    retrying = probeWorker().then((r) => !!(r && r.ok), () => false).then((ok) => {
      kernelFailed = !ok; updateCaps(); retrying = null; return ok;
    });
    return retrying;
  }

  // UI: Designer's cad-export-ui.js (Export menu item, progress/cancel toast) drives this API.

  if (!NS.exportCadSurfaces || NS.exportCadSurfaces.__cadStub) {
    NS.canExportCadSurfaces = canExportCadSurfaces;
    NS.exportCadSurfaces = exportCadSurfaces;
    NS.cadSurfaceLimits = LIMITS;
    NS.retryCadKernel = retryCadKernel;
    updateCaps();
    window.addEventListener('online', () => { if (kernelFailed) { kernelFailed = false; updateCaps(); } });
  }
})();
