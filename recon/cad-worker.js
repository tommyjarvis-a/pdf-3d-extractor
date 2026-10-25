// Module Web Worker: lazily loads the vendored opencascade.js (LGPL-2.1) and builds CAD surfaces.
// Messages in:  {cmd:'run', id, mesh:{V,T,normals,cornerN}, F, regions, ff, name, fittedOnly}
// Messages out: {type:'progress', id, ...} | {type:'done', id, step:ArrayBuffer, summary} | {type:'error', id, message}
import initOpenCascade from './vendor/opencascade/opencascade.full.js';
import './occ-build.js';
const R = self.ReconOcc;
let ocPromise = null, ocInitMs = 0;
function getOC(post) {
  if (!ocPromise) {
    const t = performance.now(); post({ stage: 'wasm-load' });
    const wasmUrl = new URL('./vendor/opencascade/opencascade.full.wasm', import.meta.url).href;
    ocPromise = new initOpenCascade({ locateFile: p => (p.endsWith('.wasm') ? wasmUrl : p) }).then(oc => { ocInitMs = performance.now() - t; return oc; });
  }
  return ocPromise;
}
function regionNormalFn(F, T, normals, cornerN) {
  const acc = new Map();
  for (let t = 0; t < F.length; t++) {
    const f = F[t];
    for (let k = 0; k < 3; k++) {
      const v = T[3 * t + k], n = cornerN[3 * t + k]; if (n < 0) continue;
      const key = f * 1e7 + v; let a = acc.get(key); if (!a) acc.set(key, a = [0, 0, 0]);
      a[0] += normals[3 * n]; a[1] += normals[3 * n + 1]; a[2] += normals[3 * n + 2];
    }
  }
  return (f, v) => { const a = acc.get(f * 1e7 + v); if (!a) return null; const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
}
self.onmessage = async (ev) => {
  const m = ev.data; if (m.cmd !== 'run') return;
  const post = p => self.postMessage({ type: 'progress', id: m.id, ...p });
  const tm = {};
  try {
    let t = performance.now();
    const oc = await getOC(post); tm.wasmInitMs = ocInitMs;
    const { V, T, normals, cornerN } = m.mesh; const F = m.F;
    t = performance.now();
    const res = R.build(oc, { V, T, F, regions: m.regions, ff: m.ff, regionNormal: regionNormalFn(F, T, normals, cornerN) }, { onProgress: post });
    tm.buildMs = performance.now() - t; tm.buildDetail = res.timing;
    post({ stage: 'check' }); t = performance.now();
    const chk = R.check(oc, res.fitted); tm.checkMs = performance.now() - t;
    const bodies = [[res.fitted, m.name + '_fitted']];
    if (!m.fittedOnly) { post({ stage: 'mesh-body' }); t = performance.now(); bodies.push([R.meshSolid(oc, V, T), m.name + '_mesh']); tm.meshBodyMs = performance.now() - t; }
    post({ stage: 'step-write' }); t = performance.now();
    const bytes = R.writeStep(oc, bodies, m.name); tm.stepWriteMs = performance.now() - t;
    const how = {}; for (const f of res.finfo) how[f.how] = (how[f.how] || 0) + 1;
    const types = {}; for (const f of res.finfo) types[f.type] = (types[f.type] || 0) + 1;
    const buf = bytes.slice().buffer;
    self.postMessage({ type: 'done', id: m.id, step: buf, summary: { check: chk, how, types, curves: res.ckind, timing: tm, heapBytes: oc.HEAP8.length, stepBytes: buf.byteLength } }, [buf]);
  } catch (e) { self.postMessage({ type: 'error', id: m.id, message: String(e && e.stack || e) }); }
};
