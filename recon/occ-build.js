/* recon/occ-build.js - B-Rep assembly of fitted surfaces with opencascade.js (WASM).
 * Port of nx-prc-analysis/reconstruct/brep.py + topo.py + export_step.py.
 * Input: welded mesh {V:Float64Array(3n), T:Int32Array(3m), F:Int32Array(m) face label per tri,
 *        VN: Float64Array(3n) per-vertex normals (per region averaged, optional)}
 *        regions: [{face, type, params, split_of?}], ff: {face: {poles:[[...]], tu, tv, nu, nv}}
 * Pure function of (oc, input); no DOM. Runs in a Worker or Node.
 */
'use strict';
(function (root) {
  // ---------- small vector helpers ----------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const TWO_PI = 2 * Math.PI;

  function perp(a, hint) {
    a = unit(a); let h = sub(hint, mul(a, dot(hint, a)));
    if (norm(h) < 1e-9) { const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; h = sub(t, mul(a, dot(t, a))); }
    return unit(h);
  }
  // symmetric 3x3 eigen (Jacobi); returns {w:[3], U: columns}
  function eig3(A) {
    const a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
      if (off < 1e-30) break;
      for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return { w: idx.map(i => a[i][i]), U: idx.map(i => [v[0][i], v[1][i], v[2][i]]) }; // ascending; U[k] = eigvec k
  }
  function solve3(M, b) { // Cramer / gaussian with pivot for 3x3
    const A = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      if (Math.abs(A[c][c]) < 1e-300) return null;
      for (let r = 0; r < 3; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]; }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  }
  function circle3d(Q) {
    const n = Q.length; let o = [0, 0, 0]; for (const q of Q) o = add(o, q); o = mul(o, 1 / n);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const q of Q) { const d = sub(q, o); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
    const { U } = eig3(C); const a = U[0], x = U[2], y = U[1];
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
    for (const q of Q) {
      const d = sub(q, o), u = dot(d, x), v = dot(d, y), row = [2 * u, 2 * v, 1], rhs = u * u + v * v;
      for (let i = 0; i < 3; i++) { r[i] += row[i] * rhs; for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j]; }
    }
    const s = solve3(M, r) || [0, 0, 0];
    const R = Math.sqrt(Math.max(s[2] + s[0] ** 2 + s[1] ** 2, 0)); const c = add(o, add(mul(x, s[0]), mul(y, s[1])));
    let ss = 0, mx = 0;
    for (const q of Q) {
      const d = sub(q, c), h = dot(d, a), rad = norm(sub(d, mul(a, h))); const e = Math.hypot(rad - R, h);
      ss += e * e; if (e > mx) mx = e;
    }
    return { c, a, R, rms: Math.sqrt(ss / n), max: mx };
  }
  function gapDir(a, c, pts) {
    a = unit(a); const e1 = perp(a, [1, 0, 0]), e2 = cross(a, e1);
    const th = pts.map(p => { const d = sub(p, c); return Math.atan2(dot(d, e2), dot(d, e1)); }).sort((x, y) => x - y);
    let gi = 0, gm = -1;
    for (let i = 0; i < th.length; i++) { const g = (i + 1 < th.length ? th[i + 1] : th[0] + TWO_PI) - th[i]; if (g > gm) { gm = g; gi = i; } }
    const phi = th[gi] + gm / 2;
    return { dir: add(mul(e1, Math.cos(phi)), mul(e2, Math.sin(phi))), gap: gm };
  }
  function wrapRange(ang) {
    const th = ang.map(x => ((x % TWO_PI) + TWO_PI) % TWO_PI).sort((x, y) => x - y);
    let gi = 0, gm = -1;
    for (let i = 0; i < th.length; i++) { const g = (i + 1 < th.length ? th[i + 1] : th[0] + TWO_PI) - th[i]; if (g > gm) { gm = g; gi = i; } }
    const lo = th[(gi + 1) % th.length]; let hi = th[gi]; if (hi < lo) hi += TWO_PI;
    return { lo, hi, gap: gm };
  }

  // ---------- topology (topo.py) ----------
  function buildTopology(V, T, F) {
    const nv = V.length / 3, m = F.length;
    const he = new Map(); const K = (a, b) => a * nv + b;
    for (let t = 0; t < m; t++) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2], f = F[t];
      he.set(K(a, b), f); he.set(K(b, c), f); he.set(K(c, a), f);
    }
    const vf = new Map();
    for (const [k, f] of he) { const a = Math.floor(k / nv); let s = vf.get(a); if (!s) vf.set(a, s = new Set()); s.add(f); }
    const topoV = new Set(); for (const [v, s] of vf) if (s.size >= 3) topoV.add(v);
    const nxt = new Map(); // f -> Map(a->b)
    const bad = new Map(); // face -> reason (topology cannot be built; the face is skipped -> shell fallback)
    for (const [k, f] of he) {
      const a = Math.floor(k / nv), b = k - a * nv; const g = he.get(K(b, a));
      if (g === undefined) { bad.set(f, 'open mesh boundary'); continue; }
      if (g !== f) { let d = nxt.get(f); if (!d) nxt.set(f, d = new Map()); if (d.has(a)) { bad.set(f, 'pinch vertex ' + a); continue; } d.set(a, b); }
    }
    const loops = new Map();
    for (const [f, d] of nxt) {
      if (bad.has(f)) continue;
      const seen = new Set(); const LL = []; let ok = true;
      for (const s of d.keys()) {
        if (seen.has(s)) continue;
        const L = [s]; seen.add(s); let v = d.get(s);
        while (v !== s) { if (v === undefined || seen.has(v)) { ok = false; break; } L.push(v); seen.add(v); v = d.get(v); }
        if (!ok) break;
        LL.push(L);
      }
      if (ok) loops.set(f, LL); else bad.set(f, 'pinch vertex in boundary loop');
    }
    const edges = new Map(); const faceLoops = new Map(); const extraV = new Set();
    const nb = (a, b) => he.get(K(b, a));
    for (const [f, LL] of loops) {
      const fl = [];
      for (const L of LL) {
        const n = L.length; let br = [];
        for (let i = 0; i < n; i++) {
          const ip = (i - 1 + n) % n, inx = (i + 1) % n;
          if (topoV.has(L[i]) || nb(L[ip], L[i]) !== nb(L[i], L[inx])) br.push(i);
        }
        if (!br.length) {
          let v0 = Infinity, i0 = 0; for (let i = 0; i < n; i++) if (L[i] < v0) { v0 = L[i]; i0 = i; }
          let i1 = 0, dm = -1; for (let i = 0; i < n; i++) { const d = Math.hypot(V[3 * L[i]] - V[3 * v0], V[3 * L[i] + 1] - V[3 * v0 + 1], V[3 * L[i] + 2] - V[3 * v0 + 2]); if (d > dm) { dm = d; i1 = i; } }
          br = [i0, i1].sort((x, y) => x - y); extraV.add(L[i0]); extraV.add(L[i1]);
        }
        const segs = [];
        for (let k = 0; k < br.length; k++) {
          const i = br[k]; let j = br[(k + 1) % br.length]; if (j <= i) j += n;
          const seq = []; for (let x = i; x <= j; x++) seq.push(L[x % n]);
          const rev = seq.slice().reverse();
          // canonical: lexicographically smaller tuple
          let cmp = 0; for (let q = 0; q < seq.length && !cmp; q++) cmp = seq[q] - rev[q];
          const keySeq = cmp <= 0 ? seq : rev; const key = keySeq.join(','); const fwd = cmp <= 0;
          let e = edges.get(key); if (!e) edges.set(key, e = { faces: new Set(), seq: keySeq }); e.faces.add(f);
          segs.push([key, fwd]);
        }
        fl.push(segs);
      }
      faceLoops.set(f, fl);
    }
    const TV = new Set([...topoV, ...extraV]);
    return { edges, faceLoops, TV, bad };
  }

  // ---------- cubic interpolation (replacement for GeomAPI_Interpolate, which has no HArray binding) ----------
  function bsBasis(p, U, i, t) { // all nonzero basis at span i (Piegl A2.2)
    const N = [1], left = [], right = [];
    for (let j = 1; j <= p; j++) {
      left[j] = t - U[i + 1 - j]; right[j] = U[i + j] - t; let saved = 0;
      for (let r = 0; r < j; r++) { const tmp = N[r] / (right[r + 1] + left[j - r]); N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; }
      N[j] = saved;
    }
    return N;
  }
  function findSpan(n, p, U, t) { if (t >= U[n + 1]) return n; let lo = p, hi = n + 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < U[mid]) hi = mid; else lo = mid; } return lo; }
  let PARAM_CENTRIPETAL = false;
  function interpCubic(pts) {
    const n = pts.length - 1, p = Math.min(3, n);
    const d = [0]; for (let i = 1; i <= n; i++) d.push(d[i - 1] + (PARAM_CENTRIPETAL ? Math.sqrt(norm(sub(pts[i], pts[i - 1]))) : norm(sub(pts[i], pts[i - 1])))); // chord length (matches GeomAPI_Interpolate)
    const tot = d[n] || 1; const u = d.map(x => x / tot);
    const U = []; for (let i = 0; i <= p; i++) U.push(0);
    for (let j = 1; j <= n - p; j++) { let s = 0; for (let i = j; i < j + p; i++) s += u[i]; U.push(s / p); }
    for (let i = 0; i <= p; i++) U.push(1);
    // banded system A (n+1 x n+1), rows = basis at u[k]
    const A = []; for (let k = 0; k <= n; k++) { const sp = findSpan(n, p, U, u[k]); const N = bsBasis(p, U, sp, u[k]); const row = new Map(); for (let j = 0; j <= p; j++) row.set(sp - p + j, N[j]); A.push(row); }
    // dense-ish gaussian elimination on band (no pivoting: totally positive)
    const B = pts.map(q => q.slice());
    for (let c = 0; c <= n; c++) {
      const pc = A[c].get(c) || 1e-300;
      for (let r = c + 1; r <= Math.min(n, c + p + 1); r++) {
        const f = (A[r].get(c) || 0) / pc; if (!f) continue;
        for (const [j, val] of A[c]) if (j >= c) A[r].set(j, (A[r].get(j) || 0) - f * val);
        A[r].delete(c); for (let k = 0; k < 3; k++) B[r][k] -= f * B[c][k];
      }
    }
    for (let r = n; r >= 0; r--) { for (const [j, val] of A[r]) if (j > r) for (let k = 0; k < 3; k++) B[r][k] -= val * B[j][k]; const pr = A[r].get(r); for (let k = 0; k < 3; k++) B[r][k] /= pr; }
    return { poles: B, U, p };
  }
  function knotsMults(U) { const K = [], M = []; for (const x of U) { if (K.length && Math.abs(x - K[K.length - 1]) < 1e-14) M[M.length - 1]++; else { K.push(x); M.push(1); } } return { K, M }; }

  // ---------- main builder ----------
  function build(oc, input, opt) {
    opt = opt || {};
    const progress = opt.onProgress || (() => {});
    const { V, T, VN } = input; let F = input.F;
    const nv = V.length / 3;
    const P = i => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
    const gp = q => new oc.gp_Pnt_3(q[0], q[1], q[2]);
    const gd = q => new oc.gp_Dir_4(q[0], q[1], q[2]);
    const hS = s => new oc.Handle_Geom_Surface_2(s);
    const hC = c => new oc.Handle_Geom_Curve_2(c);
    const R = input.regions; const ff = input.ff || {};
    const Rby = new Map(R.map(r => [r.face, r])); const fam = f => { const r = Rby.get(f); return r && r.split_of != null ? r.split_of : f; };
    // per-region vertex lists + normals + triangles
    const regTris = new Map(), regVerts = new Map();
    for (let t = 0; t < F.length; t++) { const f = F[t]; let a = regTris.get(f); if (!a) regTris.set(f, a = []); a.push(t); }
    for (const [f, ts] of regTris) { const s = new Set(); for (const t of ts) { s.add(T[3 * t]); s.add(T[3 * t + 1]); s.add(T[3 * t + 2]); } regVerts.set(f, [...s].sort((a, b) => a - b)); }
    const regN = (f, v) => { const nn = input.regionNormal ? input.regionNormal(f, v) : [VN[3 * v], VN[3 * v + 1], VN[3 * v + 2]]; return nn; };
    const triArea = ts => { let A = 0; for (const t of ts) { const a = P(T[3 * t]), b = P(T[3 * t + 1]), c = P(T[3 * t + 2]); A += norm(cross(sub(b, a), sub(c, a))) / 2; } return A; };

    function makeSurface(r) {
      const t = r.type, p = r.params; const Preg = regVerts.get(r.face).map(P);
      let cen = [0, 0, 0]; for (const q of Preg) cen = add(cen, q); cen = mul(cen, 1 / Preg.length);
      if (t === 'FREEFORM') {
        const b = ff[String(r.face)] || ff[String(r.split_of)]; if (!b) throw new Error('no freeform data for ' + r.face);
        const nu = b.nu, nvv = b.nv; const poles = new oc.TColgp_Array2OfPnt_2(1, nu, 1, nvv);
        for (let i = 0; i < nu; i++) for (let j = 0; j < nvv; j++) poles.SetValue(i + 1, j + 1, gp(b.poles[i][j]));
        const km = U => { const { K, M } = knotsMults(U); const KA = new oc.TColStd_Array1OfReal_2(1, K.length), MA = new oc.TColStd_Array1OfInteger_2(1, K.length); K.forEach((x, i) => { KA.SetValue(i + 1, x); MA.SetValue(i + 1, M[i]); }); return [KA, MA]; };
        const [Ku, Mu] = km(b.tu), [Kv, Mv] = km(b.tv);
        return hS(new oc.Geom_BSplineSurface_1(poles, Ku, Kv, Mu, Mv, b.deg || 3, b.deg || 3, false, false));
      }
      if (t === 'PLANE') { const n = p.normal; return hS(new oc.Geom_Plane_1(new oc.gp_Ax3_3(gp(p.origin), gd(n), gd(perp(n, [1, 0, 0]))))); }
      if (t === 'CYLINDER') { const a = p.axis, c = p.origin; const x = gapDir(a, c, Preg).dir; return hS(new oc.Geom_CylindricalSurface_1(new oc.gp_Ax3_3(gp(c), gd(a), gd(perp(a, x))), p.radius)); }
      if (t === 'SPHERE') {
        const c = p.center; const d = sub(cen, c); let x = norm(d) > 1e-9 ? mul(unit(d), -1) : perp([0, 0, 1], [1, 0, 0]);
        let a = perp(x, [0, 0, 1]); a = unit(cross(x, a));
        return hS(new oc.Geom_SphericalSurface_1(new oc.gp_Ax3_3(gp(c), gd(a), gd(perp(a, x))), p.radius));
      }
      if (t === 'CONE') {
        const apex = p.apex, a = unit(p.axis), al = p.half_angle_deg * Math.PI / 180; const h = dot(sub(cen, apex), a); const loc = add(apex, mul(a, h));
        const x = gapDir(a, loc, Preg).dir; return hS(new oc.Geom_ConicalSurface_1(new oc.gp_Ax3_3(gp(loc), gd(a), gd(perp(a, x))), al, Math.abs(h) * Math.tan(al)));
      }
      if (t === 'TORUS' && p.major < 1e-3 * p.minor) return makeSurface({ face: r.face, type: 'SPHERE', params: { center: p.center, radius: p.minor } });
      if (t === 'TORUS') {
        const c = p.center, a = unit(p.axis); const x = perp(a, gapDir(a, c, Preg).dir);
        const v = Preg.map(q => { const d = sub(q, c), z = dot(d, a), rad = norm(sub(d, mul(a, z))); return Math.atan2(z, rad - p.major); });
        const wr = wrapRange(v);
        if (wr.hi > TWO_PI - 1e-6 && wr.gap > 0.05) {
          const mv = Math.min(0.02, wr.gap / 4);
          const circ = new oc.Geom_Circle_2(new oc.gp_Ax2_2(gp(add(c, mul(x, p.major))), gd(cross(x, a)), gd(x)), p.minor);
          const arc = new oc.Geom_TrimmedCurve(hC(circ), wr.lo - mv, wr.hi + mv, true, true);
          return hS(new oc.Geom_SurfaceOfRevolution(hC(arc), new oc.gp_Ax1_2(gp(c), gd(a))));
        }
        return hS(new oc.Geom_ToroidalSurface_1(new oc.gp_Ax3_3(gp(c), gd(a), gd(x)), p.major, p.minor));
      }
      throw new Error('unknown surface type ' + t);
    }
    function bspCurve(poles, U, p) {
      const { K, M } = knotsMults(U);
      const PA = new oc.TColgp_Array1OfPnt_2(1, poles.length); poles.forEach((q, i) => PA.SetValue(i + 1, gp(q)));
      const KA = new oc.TColStd_Array1OfReal_2(1, K.length), MA = new oc.TColStd_Array1OfInteger_2(1, K.length);
      K.forEach((x, i) => { KA.SetValue(i + 1, x); MA.SetValue(i + 1, M[i]); });
      return hC(new oc.Geom_BSplineCurve_1(PA, KA, MA, p, false));
    }
    function polyCurve(Q) { // exact degree-1 B-spline through Q (chord length)
      const U = [0, 0]; let s = 0; const d = [0]; for (let i = 1; i < Q.length; i++) { s += norm(sub(Q[i], Q[i - 1])); d.push(s); }
      for (let i = 1; i < Q.length - 1; i++) U.push(d[i] / s); U.push(1, 1); return bspCurve(Q, U, 1);
    }
    function makeCurve(pts) {
      const p0 = pts[0], p1 = pts[pts.length - 1];
      if (pts.length === 2) return [hC(new oc.GC_MakeSegment_1(gp(p0), gp(p1)).Value().get()), 'line'];
      const d = sub(p1, p0), L = norm(d);
      if (L > 1e-9) { const u = mul(d, 1 / L); let dev = 0; for (const q of pts) { const o = sub(q, p0); dev = Math.max(dev, norm(sub(o, mul(u, dot(o, u))))); } if (dev < 1e-4) return [hC(new oc.GC_MakeSegment_1(gp(p0), gp(p1)).Value().get()), 'line']; }
      if (pts.length >= 3) {
        const ci = circle3d(pts);
        let dv = 0; for (const q of pts) { const o = sub(q, ci.c); dv = Math.max(dv, Math.abs(norm(sub(o, mul(ci.a, dot(o, ci.a)))) - ci.R)); }
        if (dv < 2e-4 && ci.R < 1e5 && L > 1e-6) { try { const mk = new oc.GC_MakeArcOfCircle_4(gp(p0), gp(pts[pts.length >> 1]), gp(p1)); if (mk.IsDone()) return [hC(mk.Value().get()), 'arc']; } catch (e) { /* fall through */ } }
      }
      const ip = interpCubic(pts); return [bspCurve(ip.poles, ip.U, ip.p), 'bspline'];
    }

    const t0 = Date.now();
    progress({ stage: 'topology' });
    const { edges, faceLoops, TV, bad } = buildTopology(V, T, F);
    const skip = new Map(); for (const [f, why] of bad) skip.set(f, why);
    for (const f of (input.skip || [])) if (!skip.has(f)) skip.set(f, 'surface fit out of tolerance');
    for (const r of R) if (r.type === 'FREEFORM' && !ff[String(r.face)] && !(r.split_of != null && ff[String(r.split_of)]) && !skip.has(r.face)) skip.set(r.face, 'no freeform surface');
    const failE = new Set(); const shouldStop = opt.shouldStop || (() => false);
    const B = new oc.BRep_Builder();
    const vmap = new Map(); for (const v of TV) vmap.set(v, new oc.BRepBuilderAPI_MakeVertex(gp(P(v))).Vertex());
    const emap = new Map(); const ckind = {}; const surfCache = new Map();
    let ei = 0;
    const extAlgo = oc.Extrema_ExtAlgo.Extrema_ExtAlgo_Grad;
    for (const [key, e] of edges) {
      if ((++ei & 255) === 0) progress({ stage: 'edges', done: ei, total: edges.size });
      const seq = e.seq; const pts = seq.map(P); const fs = [...e.faces].sort((a, b) => a - b);
      if (fs.every(f => skip.has(f))) continue;
      if ((ei & 63) === 0 && shouldStop()) return { cancelled: true };
      let cv, k;
      try {
      if (seq[0] === seq[seq.length - 1]) throw new Error('closed segment');
      if (fs.length === 2 && fam(fs[0]) === fam(fs[1]) && !skip.has(fs[0])) {
        const f0 = fs[0]; if (!surfCache.has(f0)) surfCache.set(f0, makeSurface(Rby.get(f0)));
        const S = surfCache.get(f0); const uv = [];
        for (const q of pts) { const pr = new oc.GeomAPI_ProjectPointOnSurf_2(gp(q), S, extAlgo); const u = { current: 0 }, v = { current: 0 }; pr.LowerDistanceParameters(u, v); uv.push([u.current, v.current]); pr.delete(); }
        const unwrap = (k2) => { for (let i = 1; i < uv.length; i++) { let dd = uv[i][k2] - uv[i - 1][k2]; while (dd > Math.PI) { uv[i][k2] -= TWO_PI; dd -= TWO_PI; } while (dd < -Math.PI) { uv[i][k2] += TWO_PI; dd += TWO_PI; } } };
        unwrap(0); if (S.get().IsVPeriodic()) unwrap(1);
        const dense = [];
        for (let i = 0; i < uv.length - 1; i++) { const Ls = norm(sub(pts[i + 1], pts[i])); const n = Math.max(2, Math.ceil(Ls / 0.25)); for (let j = 0; j < n; j++) { const tt = j / n; dense.push([uv[i][0] * (1 - tt) + uv[i + 1][0] * tt, uv[i][1] * (1 - tt) + uv[i + 1][1] * tt]); } }
        dense.push(uv[uv.length - 1]);
        const Q = dense.map(([u, v]) => { const pp = S.get().Value(u, v); const r = [pp.X(), pp.Y(), pp.Z()]; pp.delete(); return r; });
        Q[0] = pts[0]; Q[Q.length - 1] = pts[pts.length - 1];
        cv = polyCurve(Q); k = 'cut';
      } else[cv, k] = makeCurve(pts);
      let mk = new oc.BRepBuilderAPI_MakeEdge_27(cv, vmap.get(seq[0]), vmap.get(seq[seq.length - 1]));
      if (!mk.IsDone()) { mk.delete(); k = 'poly'; mk = new oc.BRepBuilderAPI_MakeEdge_27(polyCurve(pts), vmap.get(seq[0]), vmap.get(seq[seq.length - 1])); }
      if (!mk.IsDone()) throw new Error('edge fail ' + k);
      ckind[k] = (ckind[k] || 0) + 1;
      emap.set(key, mk.Edge()); mk.delete();
      } catch (err) { failE.add(key); for (const f of fs) if (!skip.has(f)) skip.set(f, 'edge construction failed: ' + (err && err.message || err)); }
    }
    const tEdges = Date.now();
    const faces = [], finfo = [];
    let fi = 0;
    for (const r of R) {
      if ((++fi & 7) === 0) progress({ stage: 'faces', done: fi, total: R.length });
      const f = r.face; const vs = regVerts.get(f); if (!vs) { finfo.push({ face: f, type: r.type, how: 'EMPTY' }); continue; }
      if (skip.has(f)) { finfo.push({ face: f, type: r.type, split_of: r.split_of, how: 'SKIPPED', why: skip.get(f) }); continue; }
      if (shouldStop()) return { cancelled: true };
      try {
      let S = makeSurface(r);
      const dots = []; const step = Math.max(1, Math.floor(vs.length / 15));
      for (let i = 0; i < vs.length; i += step) {
        const q = P(vs[i]), n = regN(f, vs[i]); if (!n || !isFinite(n[0])) continue;
        const pr = new oc.GeomAPI_ProjectPointOnSurf_2(gp(q), S, extAlgo); if (pr.NbPoints() === 0) { pr.delete(); continue; }
        const u = { current: 0 }, v = { current: 0 }; pr.LowerDistanceParameters(u, v); pr.delete();
        const pp = new oc.GeomLProp_SLProps_1(S, u.current, v.current, 1, 1e-9);
        if (pp.IsNormalDefined()) { const nn = pp.Normal(); dots.push(nn.X() * n[0] + nn.Y() * n[1] + nn.Z() * n[2]); }
        pp.delete();
      }
      dots.sort((a, b) => a - b);
      const med = dots.length ? (dots.length % 2 ? dots[dots.length >> 1] : (dots[dots.length / 2 - 1] + dots[dots.length / 2]) / 2) : 1;
      const rev = med < 0; if (rev) S = S.get().UReversed();
      let face = new oc.TopoDS_Face(); B.MakeFace_2(face, S, 1e-6);
      for (const segs of faceLoops.get(f) || []) {
        const w = new oc.TopoDS_Wire(); B.MakeWire(w);
        for (const [key, fwd] of segs) { const ed = emap.get(key); B.Add(w, fwd ? ed : ed.Reversed()); }
        w.Closed_2(true); B.Add(face, w);
      }
      const sf = new oc.ShapeFix_Face_2(face); sf.SetPrecision(1e-3); sf.SetMaxTolerance(0.5); sf.Perform(); face = sf.Face(); sf.delete();
      const marea = triArea(regTris.get(f));
      let how = 'trimmed';
      const ana = new oc.BRepCheck_Analyzer(face, true, false); const valid = ana.IsValid_2(); ana.delete();
      const g = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(face, g, false, false); const fa = g.Mass(); g.delete();
      if (!valid || Math.abs(fa - marea) > 0.02 * marea + 0.05) how = 'FAILED';
      if (how !== 'FAILED') faces.push(face);
      finfo.push({ face: f, type: r.type, split_of: r.split_of, reversed: rev, how, mesh_area: marea, area: fa, why: how === 'FAILED' ? (valid ? 'trimmed area differs from mesh' : 'invalid trimmed face') : undefined });
      } catch (err) { finfo.push({ face: f, type: r.type, split_of: r.split_of, how: 'FAILED', why: 'face construction failed: ' + (err && err.message || err) }); }
    }
    const tFaces = Date.now();
    progress({ stage: 'sew' });
    const shell = new oc.TopoDS_Shell(); B.MakeShell(shell); for (const fc of faces) B.Add(shell, fc);
    const complete = finfo.every(x => x.how === 'trimmed' || x.how === 'EMPTY');
    let fitted;
    if (complete) {
      const solid = new oc.TopoDS_Solid(); B.MakeSolid(solid); B.Add(solid, shell);
      const sfs = new oc.ShapeFix_Shape_2(solid); sfs.SetPrecision(1e-3); sfs.SetMaxTolerance(0.5); sfs.Perform(new oc.Message_ProgressRange_1());
      fitted = sfs.Shape(); sfs.delete();
    } else fitted = shell; // open shell of the good faces only (never a broken solid)
    const tFix = Date.now();
    return { fitted, complete, nGood: faces.length, finfo, ckind, timing: { edges: tEdges - t0, faces: tFaces - tEdges, fix: tFix - tFaces } };
  }

  function check(oc, shape) {
    const ana = new oc.BRepCheck_Analyzer(shape, true, false); const valid = ana.IsValid_2(); ana.delete();
    const count = typ => { let n = 0; const ex = new oc.TopExp_Explorer_2(shape, typ, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; ex.More(); ex.Next()) n++; ex.delete(); return n; };
    const nf = count(oc.TopAbs_ShapeEnum.TopAbs_FACE), nsh = count(oc.TopAbs_ShapeEnum.TopAbs_SHELL), nso = count(oc.TopAbs_ShapeEnum.TopAbs_SOLID);
    const g = new oc.GProp_GProps_1(); oc.BRepGProp.VolumeProperties_1(shape, g, false, false, false); const vol = g.Mass(); g.delete();
    const g2 = new oc.GProp_GProps_1(); oc.BRepGProp.SurfaceProperties_1(shape, g2, false, false); const area = g2.Mass(); g2.delete();
    // free edges: edges with only one face
    let free = 0; try {
      const fb = new oc.ShapeAnalysis_FreeBounds_2(shape, 1e-3, false, false); const w = fb.GetOpenWires(); const ex = new oc.TopExp_Explorer_2(w, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; ex.More(); ex.Next()) free++; ex.delete(); fb.delete();
      const w2 = new oc.ShapeAnalysis_FreeBounds_2(shape, 1e-3, false, false).GetClosedWires(); const ex2 = new oc.TopExp_Explorer_2(w2, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE); for (; ex2.More(); ex2.Next()) free++; ex2.delete();
    } catch (e) { free = -1; }
    return { valid, faces: nf, shells: nsh, solids: nso, volume: vol, area, freeEdges: free, closed: free === 0 };
  }

  function meshSolid(oc, V, T, onProgress) {
    const B = new oc.BRep_Builder(); const nv = V.length / 3; const vx = new Array(nv);
    const P = i => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
    for (let i = 0; i < nv; i++) { const p = new oc.gp_Pnt_3(V[3 * i], V[3 * i + 1], V[3 * i + 2]); const mv = new oc.BRepBuilderAPI_MakeVertex(p); vx[i] = mv.Vertex(); mv.delete(); p.delete(); }
    const em = new Map(); const sh = new oc.TopoDS_Shell(); B.MakeShell(sh);
    const m = T.length / 3;
    for (let t = 0; t < m; t++) {
      if ((t & 4095) === 0 && onProgress) onProgress({ stage: 'mesh body', done: t, total: m });
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2]; const pa = P(a), pb = P(b), pc = P(c);
      const n = cross(sub(pb, pa), sub(pc, pa)); const L = norm(n); if (L < 1e-14) continue;
      const w = new oc.TopoDS_Wire(); B.MakeWire(w);
      for (const [i, j] of [[a, b], [b, c], [c, a]]) {
        const k = Math.min(i, j) * nv + Math.max(i, j); let e = em.get(k);
        if (!e) { const mk = new oc.BRepBuilderAPI_MakeEdge_2(vx[Math.min(i, j)], vx[Math.max(i, j)]); e = mk.Edge(); mk.delete(); em.set(k, e); }
        B.Add(w, i < j ? e : e.Reversed());
      }
      w.Closed_2(true);
      const ax = new oc.gp_Ax3_3(new oc.gp_Pnt_3(...pa), new oc.gp_Dir_4(n[0] / L, n[1] / L, n[2] / L), new oc.gp_Dir_4(...unit(sub(pb, pa))));
      const pl = new oc.Handle_Geom_Surface_2(new oc.Geom_Plane_1(ax));
      const f = new oc.TopoDS_Face(); B.MakeFace_2(f, pl, 1e-6); B.Add(f, w); B.Add(sh, f); ax.delete();
    }
    sh.Closed_2(true); const so = new oc.TopoDS_Solid(); B.MakeSolid(so); B.Add(so, sh);
    return so;
  }

  function writeStep(oc, bodies, productName) {
    const doc = new oc.TDocStd_Document(new oc.TCollection_ExtendedString_2('XmlOcaf', true)); const hdoc = new oc.Handle_TDocStd_Document_2(doc);
    const st = oc.XCAFDoc_DocumentTool.ShapeTool(doc.Main()).get();
    for (const [shape, name] of bodies) { const lab = st.AddShape(shape, false, true); oc.TDataStd_Name.Set_1(lab, new oc.TCollection_ExtendedString_2(name, true)); }
    oc.Interface_Static.SetCVal('write.step.schema', 'AP214IS'); oc.Interface_Static.SetCVal('write.step.unit', 'MM');
    oc.Interface_Static.SetCVal('write.step.product.name', productName || 'part');
    const w = new oc.STEPCAFControl_Writer_1(); w.SetNameMode(true);
    const ok = w.Transfer_1(hdoc, oc.STEPControl_StepModelType.STEPControl_AsIs, null, new oc.Message_ProgressRange_1());
    if (!ok) throw new Error('STEP transfer failed');
    const fn = '/recon_out.step'; w.Write(fn); const bytes = oc.FS.readFile(fn); oc.FS.unlink(fn); w.delete();
    return bytes;
  }

  const api = { build, check, meshSolid, writeStep, buildTopology, circle3d, interpCubic, eig3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ReconOcc = api;
})(typeof self !== 'undefined' ? self : this);
