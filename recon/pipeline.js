/* pipeline.js - CAD-surface reconstruction pipeline shared by recon/cad-worker.js and the Node tools.
 * decoded PRC part -> mesh (mm) -> recon/fit.js -> recon/occ-build.js -> validation -> fitted STEP (opencascade.js).
 * Part of pdf-3d-extractor (MIT). */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports && typeof require === 'function';
  const Fit = isNode ? require('./fit.js') : root.PDF3DFit;
  const Occ = isNode ? require('./occ-build.js') : root.ReconOcc;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  // product base name: first path component of the PRC label ("head_test/BrepModel#7" -> "head_test"), STEP-safe
  function baseName(name) { let s = String(name || 'part').split('/')[0].trim() || 'part'; return s.replace(/[^A-Za-z0-9_.\-]+/g, '_'); }

  // decoded PRC part (parsePRC(..., {withNormals:true})) -> flat mesh in mm with optional corner normals.
  // Positions are already placed by the decoder; p.matrix (row-major 4x4) is only needed for the normals.
  function meshFromPart(p, unitsInMM) {
    const mm = unitsInMM > 0 ? unitsInMM : 1; const nV = p.positions.length; const V = new Float64Array(3 * nV);
    for (let i = 0; i < nV; i++) { const q = p.positions[i]; V[3 * i] = q[0] * mm; V[3 * i + 1] = q[1] * mm; V[3 * i + 2] = q[2] * mm; }
    const m = p.faces.length; const T = new Int32Array(3 * m); for (let t = 0; t < m; t++) { const f = p.faces[t]; T[3 * t] = f[0]; T[3 * t + 1] = f[1]; T[3 * t + 2] = f[2]; }
    const F = p.faceIndexPerTriangle ? Int32Array.from(p.faceIndexPerTriangle) : null;
    let NN = null, CN = null;
    if (p.cornerNormalIdx && p.tessNormals && p.tessNormals.length) {
      NN = Float64Array.from(p.tessNormals); const M = p.matrix;
      if (M) { // inverse-transpose of the linear part (cofactor matrix, sign of det)
        const L = [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]];
        const C = [[L[1][1] * L[2][2] - L[1][2] * L[2][1], L[1][2] * L[2][0] - L[1][0] * L[2][2], L[1][0] * L[2][1] - L[1][1] * L[2][0]],
          [L[0][2] * L[2][1] - L[0][1] * L[2][2], L[0][0] * L[2][2] - L[0][2] * L[2][0], L[0][1] * L[2][0] - L[0][0] * L[2][1]],
          [L[0][1] * L[1][2] - L[0][2] * L[1][1], L[0][2] * L[1][0] - L[0][0] * L[1][2], L[0][0] * L[1][1] - L[0][1] * L[1][0]]];
        const det = L[0][0] * C[0][0] + L[0][1] * C[0][1] + L[0][2] * C[0][2]; const sg = det < 0 ? -1 : 1;
        for (let i = 0; i < NN.length; i += 3) { const x = NN[i], y = NN[i + 1], z = NN[i + 2]; const a = C[0][0] * x + C[0][1] * y + C[0][2] * z, b = C[1][0] * x + C[1][1] * y + C[1][2] * z, c = C[2][0] * x + C[2][1] * y + C[2][2] * z; const l = (Math.hypot(a, b, c) || 1) * sg; NN[i] = a / l; NN[i + 1] = b / l; NN[i + 2] = c / l; }
      }
      CN = new Int32Array(3 * m); for (let t = 0; t < m; t++) { const c = p.cornerNormalIdx[t]; for (let k = 0; k < 3; k++) { const v = c ? c[k] : -1; CN[3 * t + k] = v >= 0 ? (v / 3) | 0 : -1; } }
    }
    return { V, T, F, NN, CN };
  }

  // per (final region, vertex) mean normal, for occ-build orientation
  function regionNormalFn(F, T, NN, CN, V) {
    const acc = new Map(); const nv = V.length / 3;
    for (let t = 0; t < F.length; t++) { const f = F[t];
      let fb = null; if (!CN) { const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2]; const ux = V[3 * b] - V[3 * a], uy = V[3 * b + 1] - V[3 * a + 1], uz = V[3 * b + 2] - V[3 * a + 2], wx = V[3 * c] - V[3 * a], wy = V[3 * c + 1] - V[3 * a + 1], wz = V[3 * c + 2] - V[3 * a + 2]; fb = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx]; }
      for (let k = 0; k < 3; k++) { const v = T[3 * t + k]; const key = f * nv + v; let a = acc.get(key); if (!a) acc.set(key, a = [0, 0, 0]);
        if (fb) { a[0] += fb[0]; a[1] += fb[1]; a[2] += fb[2]; continue; } const n = CN[3 * t + k]; if (n < 0) continue; a[0] += NN[3 * n]; a[1] += NN[3 * n + 1]; a[2] += NN[3 * n + 2]; } }
    return (f, v) => { const a = acc.get(f * nv + v); if (!a) return null; const l = Math.hypot(a[0], a[1], a[2]); if (!(l > 0)) return null; return [a[0] / l, a[1] / l, a[2] / l]; };
  }

  const zeroTypes = () => ({ plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0 });

  // Run one part -> {shape|null, status:'solid'|'shell'|'mesh_only', reason, summary} or {cancelled:true}
  function runPart(oc, mesh, name, opt) {
    opt = opt || {}; const post = opt.post || (() => {}); const stop = opt.shouldStop || (() => false); const tm = {};
    const base = baseName(name); const nTris = mesh.T.length / 3;
    const empty = (status, reason) => ({ shape: null, status, reason, summary: { name: base, faces: 0, byType: zeroTypes(), closed: false, valid: false, unfitFaces: [], meshFallback: true, timings: tm } });
    if (!mesh.F || mesh.F.length !== nTris) return empty('mesh_only', 'no PRC face ids for this part');
    let t = nowMs();
    const fit = Fit.fitMesh(mesh, { shouldStop: stop, onProgress: e => post({ ...e, part: base }) });
    if (fit.cancelled) return { cancelled: true };
    tm.fitMs = nowMs() - t; tm.fit = fit.timings;
    const unfitSet = new Set(fit.unfit);
    const skip = fit.regions.filter(r => unfitSet.has(r.face) || (r.split_of != null && unfitSet.has(r.split_of))).map(r => r.face);
    if (skip.length === fit.regions.length) { const e = empty('mesh_only', 'no face could be fitted within tolerance'); e.fit = fit; e.summary.unfitFaces = [...unfitSet]; return e; }
    post({ stage: 'build', done: 0, total: fit.regions.length, part: base });
    t = nowMs(); let res;
    try {
      res = Occ.build(oc, { V: mesh.V, T: mesh.T, F: fit.F, regions: fit.regions, ff: fit.ff, skip, regionNormal: regionNormalFn(fit.F, mesh.T, mesh.NN, mesh.CN, mesh.V) },
        { shouldStop: stop, onProgress: e => { if (e.stage === 'faces' || e.stage === 'edges') post({ stage: 'build', sub: e.stage, done: e.done, total: e.total, part: base }); } });
    } catch (e) { const r = empty('mesh_only', 'surface build failed: ' + (e && e.message || e)); r.fit = fit; return r; }
    if (res.cancelled) return { cancelled: true };
    tm.buildMs = nowMs() - t; tm.build = res.timing;
    post({ stage: 'validate', part: base }); t = nowMs();
    let chk; try { chk = Occ.check(oc, res.fitted); } catch (e) { chk = { valid: false, closed: false, solids: 0, error: String(e && e.message || e) }; }
    tm.validateMs = nowMs() - t;
    const bad = res.finfo.filter(f => f.how !== 'trimmed'); const good = res.finfo.filter(f => f.how === 'trimmed');
    const unfitFaces = [...new Set(bad.map(f => (f.split_of != null ? f.split_of : f.face)))].sort((a, b) => a - b);
    let status, shape = res.fitted, reason = null;
    if (res.complete && chk.valid && chk.closed && chk.solids === 1) status = 'solid';
    else {
      status = good.length ? 'shell' : 'mesh_only';
      if (res.complete) { // never export a broken solid: re-pack its faces as an open shell
        const B = new oc.BRep_Builder(); const sh = new oc.TopoDS_Shell(); B.MakeShell(sh);
        const ex = new oc.TopExp_Explorer_2(res.fitted, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; ex.More(); ex.Next()) B.Add(sh, ex.Current()); ex.delete(); shape = sh;
        reason = 'the fitted faces did not close into a valid solid (' + (chk.valid ? 'valid' : 'invalid') + ', free edges ' + chk.freeEdges + ')';
      } else reason = bad.length + ' of ' + res.finfo.length + ' faces could not be fitted or trimmed';
      if (!good.length) shape = null;
    }
    const byType = zeroTypes();
    for (const f of good) { const k = f.type === 'FREEFORM' ? 'bspline' : String(f.type).toLowerCase(); if (k in byType) byType[k]++; }
    return { shape, status, reason, fit, res, check: chk,
      summary: { name: base, faces: good.length, byType, closed: status === 'solid', valid: status === 'solid', unfitFaces, meshFallback: status !== 'solid', check: chk, fitStats: fit.stats, timings: tm } };
  }

  const writeFitted = (oc, bodies, productName) => Occ.writeStep(oc, bodies, productName);
  const api = { baseName, meshFromPart, regionNormalFn, runPart, writeFitted };
  if (isNode) module.exports = api; else root.PDF3DCadPipeline = api;
})(typeof self !== 'undefined' ? self : this);
