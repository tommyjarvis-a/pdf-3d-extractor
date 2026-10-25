/* fit.js - mesh -> CAD surface fitting for the "Export as CAD surfaces (STEP)" feature (plain JS, runs in the CAD worker
 * and in Node). JS port of the reconstruction pipeline (fit.py / bspline.py / brep.py split / fit_helical2.py /
 * rotate_ff.py) with generalisations: fragment merging, kinematic (helical) detection and verified symmetry reuse.
 * Part of pdf-3d-extractor (MIT).
 *
 *   fitMesh({V,T,F,NN,CN}, {onProgress, shouldStop}) -> {F, regions, ff, unfit, stats}
 *     V Float64Array(3n) mm, T Int32Array(3m), F Int32Array(m) PRC face per triangle,
 *     NN Float64Array(3k) tessellation normals or null, CN Int32Array(3m) normal index per corner (-1 = none) or null.
 *   Output regions: [{face, type: PLANE|CYLINDER|CONE|SPHERE|TORUS|FREEFORM, params, split_of?, maxdev, ...}]
 *   ff: {face: {poles[i][j], tu, tv, nu, nv, deg, maxdev, rms, angmax, method}} for FREEFORM regions (recon/occ-build.js input)
 */
(function (root) {
  'use strict';
  const LA = (typeof require === 'function' && typeof module !== 'undefined') ? require('./fit-linalg.js') : root.PDF3DFitLA;
  const { sub, add, mul, dot, cross, norm, unit, eigSym3, inv3, lstsq, cholSolve, cgSolve, knots, basis3, makeSurf, project, deviation, lsqAccumulate, addSecondDiff, fit1D, Heap, fminbound, levmar } = LA;
  const TOL_D = 0.004, TOL_A = 0.25 * Math.PI / 180;
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function frame(a) { a = unit(a); const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; const x = unit(cross(a, t)); return [x, cross(a, x)]; }
  function perp(a, hint) { a = unit(a); let h = sub(hint, mul(a, dot(hint, a))); if (norm(h) < 1e-9) { const t = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; h = sub(t, mul(a, dot(t, a))); } return unit(h); }
  function mean(P) { const c = [0, 0, 0]; for (const p of P) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return mul(c, 1 / Math.max(1, P.length)); }
  function sym3(P, f) { const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const p of P) { const q = f ? f(p) : p; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] += q[i] * q[j]; } return M; }

  // ---------------- surface models (fit.py) ----------------
  function Plane(o, n) { n = unit(n); return { kind: 'PLANE', o, n, dist: p => dot(sub(p, o), n), normal: () => n, params: () => ({ origin: o, normal: n }), pack: () => [...o, ...n] }; }
  function Cylinder(c, a, r) { a = unit(a); const rad = p => { const d = sub(p, c); return sub(d, mul(a, dot(d, a))); };
    return { kind: 'CYLINDER', c, a, r, dist: p => norm(rad(p)) - Math.abs(r), normal: p => mul(unit(rad(p)), Math.sign(r)), params: () => ({ origin: c, axis: a, radius: Math.abs(r), convex: r > 0 }), pack: () => [...c, ...a, r] }; }
  function Sphere(c, r) { return { kind: 'SPHERE', c, r, dist: p => norm(sub(p, c)) - Math.abs(r), normal: p => mul(unit(sub(p, c)), Math.sign(r)), params: () => ({ center: c, radius: Math.abs(r), convex: r > 0 }), pack: () => [...c, r] }; }
  function Cone(apex, a, al, sg) { a = unit(a); const ca = Math.cos(al), sa = Math.sin(al);
    const hr = p => { const d = sub(p, apex); const h = dot(d, a); const rv = sub(d, mul(a, h)); return [h, norm(rv), rv]; };
    return { kind: 'CONE', apex, a, al, sg, dist: p => { const [h, rho] = hr(p); return rho * ca - h * sa; },
      normal: p => { const [, rho, rv] = hr(p); const e = mul(rv, 1 / Math.max(rho, 1e-12)); return mul(sub(mul(e, ca), mul(a, sa)), sg); },
      params: () => ({ apex, axis: a, half_angle_deg: al * 180 / Math.PI, sense: sg }), pack: () => [...apex, ...a, al] }; }
  function Torus(c, a, R, r) { a = unit(a);
    const q = p => { const d = sub(p, c); const h = dot(d, a); const rv = sub(d, mul(a, h)); const rho = norm(rv); return [rho - R, h, mul(rv, 1 / Math.max(rho, 1e-12))]; };
    return { kind: 'TORUS', c, a, R, r, dist: p => { const [w0, w1] = q(p); return Math.hypot(w0, w1) - Math.abs(r); },
      normal: p => { const [w0, w1, e] = q(p); const l = Math.hypot(w0, w1) || 1; return mul(add(mul(e, w0 / l), mul(a, w1 / l)), Math.sign(r)); },
      params: () => ({ center: c, axis: a, major: R, minor: Math.abs(r), convex: r > 0 }), pack: () => [...c, ...a, R, r] }; }
  function unpack(kind, x, ref) {
    const v = i => [x[i], x[i + 1], x[i + 2]];
    if (kind === 'PLANE') return Plane(v(0), v(3)); if (kind === 'CYLINDER') return Cylinder(v(0), v(3), x[6]);
    if (kind === 'SPHERE') return Sphere(v(0), x[3]); if (kind === 'CONE') return Cone(v(0), v(3), x[6], ref.sg); return Torus(v(0), v(3), x[6], x[7]);
  }
  function score(m, P, N) {
    let mx = 0, ss = 0, am = 0;
    for (let i = 0; i < P.length; i++) { const d = m.dist(P[i]); const nn = m.normal(P[i]); const ad = Math.abs(d); if (!(ad <= mx)) mx = isFinite(ad) ? Math.max(mx, ad) : Infinity; ss += d * d;
      const an = Math.acos(Math.max(-1, Math.min(1, dot(nn, N[i])))); if (!(an <= am)) am = isFinite(an) ? an : Infinity; }
    return [mx, Math.sqrt(ss / Math.max(1, P.length)), am];
  }
  function fitPlane(P, N) { return Plane(mean(P), unit(mean(N))); }
  function fitSphere(P, N) { const A = [], B = []; for (let i = 0; i < P.length; i++) for (let k = 0; k < 3; k++) { const r = [0, 0, 0, N[i][k]]; r[k] = 1; A.push(r); B.push([P[i][k]]); }
    const x = lstsq(A, B).map(r => r[0]); return Sphere([x[0], x[1], x[2]], -x[3]); }
  function fitCyl(P, N) { const a = eigSym3(sym3(N)).U[0]; const [x, y] = frame(a); const A = [], B = [];
    for (let i = 0; i < P.length; i++) A.push([1, 0, dot(N[i], x)]), B.push([dot(P[i], x)]);
    for (let i = 0; i < P.length; i++) A.push([0, 1, dot(N[i], y)]), B.push([dot(P[i], y)]);
    const s = lstsq(A, B).map(r => r[0]); return Cylinder(add(mul(x, s[0]), mul(y, s[1])), a, s[2]); }
  function fitCone(P, N) { const mn = mean(N); const C = sym3(N, n => sub(n, mn)); let a = eigSym3(C).U[0]; let k = 0; for (const n of N) k += dot(n, a); k /= N.length;
    const apex = lstsq(N.map(n => [...n]), N.map((n, i) => [dot(n, P[i])])).map(r => r[0]);
    let s = 0; for (const p of P) s += dot(sub(p, apex), a); if (s / P.length < 0) { a = mul(a, -1); k = -k; }
    const al = Math.asin(Math.min(1, Math.abs(k))); return Cone(apex, a, al, k < 0 ? 1 : -1); }
  function circle3d(Q) { const o = mean(Q); const E = eigSym3(sym3(Q, q => sub(q, o))); const a = E.U[0], x = E.U[2], y = E.U[1];
    const A = [], B = []; const uv = Q.map(q => { const d = sub(q, o); return [dot(d, x), dot(d, y)]; });
    for (const [u, v] of uv) { A.push([2 * u, 2 * v, 1]); B.push([u * u + v * v]); }
    const s = lstsq(A, B).map(r => r[0]); const R = Math.sqrt(Math.max(s[2] + s[0] * s[0] + s[1] * s[1], 0)); const c = add(o, add(mul(x, s[0]), mul(y, s[1])));
    let ss = 0; for (const q of Q) { const d = sub(q, c); const h = dot(d, a); const rr = norm(sub(d, mul(a, h))) - R; ss += rr * rr + h * h; }
    return { c, a, R, rms: Math.sqrt(ss / Q.length) }; }
  function fitTorus(P, N, diag) {
    const f = r => circle3d(P.map((p, i) => sub(p, mul(N[i], r)))).rms; let best = null;
    for (const sg of [1, -1]) for (let i = 0; i < 25; i++) { const r0 = sg * 0.3 * Math.pow(diag / 0.3, i / 24); const e = f(r0); if (!best || e < best[1]) best = [r0, e]; }
    const r0 = best[0]; const [lo, hi] = r0 > 0 ? [r0 / 1.3, r0 * 1.3] : [r0 * 1.3, r0 / 1.3];
    const r = fminbound(f, lo, hi, 1e-7).x; const ci = circle3d(P.map((p, i) => sub(p, mul(N[i], r)))); return Torus(ci.c, ci.a, ci.R, r); }
  function refine(m, P, N) {
    const res = x => { const mm = unpack(m.kind, x, m); const out = new Float64Array(4 * P.length); for (let i = 0; i < P.length; i++) { out[i] = mm.dist(P[i]); const nn = mm.normal(P[i]); const o = P.length + 3 * i; out[o] = 2 * (nn[0] - N[i][0]); out[o + 1] = 2 * (nn[1] - N[i][1]); out[o + 2] = 2 * (nn[2] - N[i][2]); } return out; };
    try { const x = levmar(res, m.pack(), 200); const m2 = unpack(m.kind, Array.from(x), m); if (score(m2, P, N)[1] <= score(m, P, N)[1]) return m2; } catch (e) { /* keep */ }
    return m;
  }
  const ORDER = ['PLANE', 'CYLINDER', 'SPHERE', 'CONE', 'TORUS'];
  function classify(P, N, diag) {
    const fns = { PLANE: () => fitPlane(P, N), CYLINDER: () => fitCyl(P, N), SPHERE: () => fitSphere(P, N), CONE: () => fitCone(P, N), TORUS: () => fitTorus(P, N, diag) };
    const tries = {};
    if (P.length < 3) return { type: 'FREEFORM', tries };
    for (const k of ORDER) {
      try {
        let m = fns[k](); if (!m.pack().every(isFinite)) continue;
        let s = score(m, P, N); if (s[0] > TOL_D || s[2] > TOL_A) { m = refine(m, P, N); s = score(m, P, N); }
        tries[k] = { max: s[0], rms: s[1], angdeg: s[2] * 180 / Math.PI };
        if (s[0] <= TOL_D && s[2] <= TOL_A) return { type: k, model: m, s, tries };
      } catch (e) { /* next */ }
    }
    return { type: 'FREEFORM', tries };
  }

  // ---------------- mesh helpers ----------------
  function vertexTris(T, nv) { const m = T.length / 3; const cnt = new Int32Array(nv + 1); for (let i = 0; i < T.length; i++) cnt[T[i] + 1]++; for (let i = 0; i < nv; i++) cnt[i + 1] += cnt[i];
    const at = new Int32Array(T.length); const pos = cnt.slice(0, nv); for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const v = T[3 * t + k]; at[pos[v]++] = t; } return { ptr: cnt, tri: at }; }
  // edge-adjacency within a triangle subset (array of tri ids) -> Map tri -> [neighbour tris]
  function triAdjacency(T, idx, nv) { const ed = new Map(); for (const t of idx) for (let k = 0; k < 3; k++) { const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3]; const key = Math.min(a, b) * nv + Math.max(a, b); let l = ed.get(key); if (!l) ed.set(key, l = []); l.push(t); }
    const adj = new Map(); for (const t of idx) adj.set(t, []); for (const l of ed.values()) if (l.length > 1) for (const x of l) for (const y of l) if (x !== y) adj.get(x).push(y); return adj; }
  function components(T, idx, nv) { const adj = triAdjacency(T, idx, nv); const seen = new Set(), out = [];
    for (const t of idx) { if (seen.has(t)) continue; const st = [t]; seen.add(t); const cc = []; while (st.length) { const x = st.pop(); cc.push(x); for (const y of adj.get(x)) if (!seen.has(y)) { seen.add(y); st.push(y); } } out.push(cc); } return out; }
  function trisOf(F) { const m = new Map(); for (let t = 0; t < F.length; t++) { let a = m.get(F[t]); if (!a) m.set(F[t], a = []); a.push(t); } return m; }

  // ---------------- main context ----------------
  function makeCtx(mesh) {
    const V = mesh.V, T = mesh.T, nv = V.length / 3; const P = i => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { const x = V[3 * i + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    const diag = norm(sub(hi, lo)) || 1;
    return { V, T, nv, P, NN: mesh.NN || null, CN: mesh.CN || null, diag, VT: vertexTris(T, nv) };
  }
  // region_data: vertices, points, unit-mean corner normals (fallback: area-weighted triangle normals inside the region)
  function regionData(ctx, tidx) {
    const { T, NN, CN, P } = ctx; const acc = new Map(), fb = new Map();
    for (const t of tidx) {
      const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2]; const pa = P(a); const tn = cross(sub(P(b), pa), sub(P(c), pa));
      for (let k = 0; k < 3; k++) { const v = T[3 * t + k]; let f = fb.get(v); if (!f) fb.set(v, f = [0, 0, 0]); f[0] += tn[0]; f[1] += tn[1]; f[2] += tn[2];
        const n = CN ? CN[3 * t + k] : -1; if (n >= 0 && NN) { let s = acc.get(v); if (!s) acc.set(v, s = [0, 0, 0, 0]); s[0] += NN[3 * n]; s[1] += NN[3 * n + 1]; s[2] += NN[3 * n + 2]; s[3]++; } }
    }
    const vs = [...fb.keys()].sort((x, y) => x - y); const Pv = vs.map(P);
    const N = vs.map(v => { const s = acc.get(v); if (s) { const m = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; const l = norm(m); if (l > 1e-12) return mul(m, 1 / l); } const f = fb.get(v); const l = norm(f); return l > 0 ? mul(f, 1 / l) : [NaN, NaN, NaN]; });
    return { vs, P: Pv, N };
  }
  function triArea(ctx, ts) { const { T, P } = ctx; let A = 0; for (const t of ts) { const a = P(T[3 * t]); A += norm(cross(sub(P(T[3 * t + 1]), a), sub(P(T[3 * t + 2]), a))) / 2; } return A; }

  // ---------------- split_full_revolutions (brep.py) ----------------
  function gapDir(a, c, pts) { a = unit(a); const e1 = perp(a, [1, 0, 0]), e2 = cross(a, e1); const th = pts.map(p => { const d = sub(p, c); return Math.atan2(dot(d, e2), dot(d, e1)); }).sort((x, y) => x - y);
    let gi = 0, g = -1; for (let i = 0; i < th.length; i++) { const gg = (i + 1 < th.length ? th[i + 1] : th[0] + 2 * Math.PI) - th[i]; if (gg > g) { g = gg; gi = i; } } return { gap: g }; }
  function fixPinches(ctx, F, labs, it) {
    const { T, VT } = ctx; labs = new Set(labs); it = it || 50;
    for (let n = 0; n < it; n++) {
      const idx = []; for (let t = 0; t < F.length; t++) if (labs.has(F[t])) idx.push(t);
      const vs = new Set(); for (const t of idx) for (let k = 0; k < 3; k++) vs.add(T[3 * t + k]);
      const he = new Map(); const nv = ctx.nv; const ts = new Set(); for (const v of vs) for (let p = VT.ptr[v]; p < VT.ptr[v + 1]; p++) ts.add(VT.tri[p]);
      for (const t of ts) for (let k = 0; k < 3; k++) he.set(T[3 * t + k] * nv + T[3 * t + (k + 1) % 3], F[t]);
      const cnt = new Map();
      for (const [key, f] of he) { if (!labs.has(f)) continue; const a = Math.floor(key / nv), b = key - a * nv; const g = he.get(b * nv + a); if (g !== undefined && g !== f) { const ck = f + ':' + a; cnt.set(ck, (cnt.get(ck) || 0) + 1); } }
      const bad = new Set(); for (const [ck, c] of cnt) if (c > 1) bad.add(+ck.split(':')[1]);
      if (!bad.size) return;
      if (labs.size === 2) { const f0 = [...labs][0]; for (const t of idx) if (bad.has(T[3 * t]) || bad.has(T[3 * t + 1]) || bad.has(T[3 * t + 2])) F[t] = f0; }
      else for (const v of bad) { const tl = []; for (let p = VT.ptr[v]; p < VT.ptr[v + 1]; p++) { const t = VT.tri[p]; if (labs.has(F[t])) tl.push(t); } if (!tl.length) continue;
        const c = new Map(); for (const t of tl) c.set(F[t], (c.get(F[t]) || 0) + 1); let maj = null, mc = -1; for (const [k, v2] of c) if (v2 > mc) { mc = v2; maj = k; } for (const t of tl) F[t] = maj; }
    }
  }
  function growHalf(ctx, idx, c, e1, e2) {
    const { T, P } = ctx; const th = new Map(), ar = new Map(); let tot = 0;
    for (const t of idx) { const a = P(T[3 * t]), b = P(T[3 * t + 1]), cc = P(T[3 * t + 2]); const cen = sub(mul(add(add(a, b), cc), 1 / 3), c); th.set(t, Math.atan2(dot(cen, e2), dot(cen, e1))); const A = norm(cross(sub(b, a), sub(cc, a))) / 2; ar.set(t, A); tot += A; }
    const adj = triAdjacency(T, idx, ctx.nv); const pr = t => { let x = th.get(t) + Math.PI / 2; x = Math.atan2(Math.sin(x), Math.cos(x)); return Math.abs(x); };
    let seed = idx[0], bs = Infinity; for (const t of idx) { const p = pr(t); if (p < bs) { bs = p; seed = t; } }
    const h = new Heap(); h.push(pr(seed), seed); const got = new Set(); let A = 0; const half = tot / 2;
    while (h.size && A < half) { const [, t] = h.pop(); if (got.has(t)) continue; got.add(t); A += ar.get(t); for (const y of adj.get(t)) if (!got.has(y)) h.push(pr(y), y); }
    return [...got].sort((x, y) => x - y);
  }
  function splitFullRevolutions(ctx, F, R, thr) {
    thr = thr || 0.5; F = Int32Array.from(F); const { T, P } = ctx; let nxt = 0; for (const f of F) nxt = Math.max(nxt, f + 1); for (const r of R) nxt = Math.max(nxt, r.face + 1);
    const split = {}; const out = R.slice();
    const tf = () => trisOf(F);
    for (const r of R) {
      const t = r.type, p = r.params; if (!['CYLINDER', 'CONE', 'TORUS'].includes(t)) continue; if (t === 'TORUS' && p.major < 1e-3 * p.minor) continue;
      const a = unit(p.axis), c = p.origin || p.center || p.apex;
      const idx = []; for (let i = 0; i < F.length; i++) if (F[i] === r.face) idx.push(i); if (!idx.length) continue;
      const uniqP = ts => { const s = new Set(); for (const t2 of ts) for (let k = 0; k < 3; k++) s.add(T[3 * t2 + k]); return [...s].map(P); };
      if (gapDir(a, c, uniqP(idx)).gap > thr) continue;
      const e1 = perp(a, [1, 0, 0]); let e2 = cross(a, e1); const q = 0.3711; e2 = add(mul(e2, Math.cos(q)), mul(e1, Math.sin(q)));
      const sel = growHalf(ctx, idx, c, e1, e2); const lab1 = nxt; for (const t2 of sel) F[t2] = lab1; fixPinches(ctx, F, [r.face, lab1]);
      const compsOf = labs => { const o = []; const m = tf(); for (const L of labs) { const ts = m.get(L); if (ts) for (const cc of components(T, ts, ctx.nv)) o.push([L, cc]); } return o; };
      for (let k = 0; k < 40; k++) { const cs = compsOf([r.face, lab1]); if (cs.length <= 2) break; let mi = 0; for (let i = 1; i < cs.length; i++) if (cs[i][1].length < cs[mi][1].length) mi = i;
        const [L, cc] = cs[mi]; for (const t2 of cc) F[t2] = L === r.face ? lab1 : r.face; fixPinches(ctx, F, [r.face, lab1]); }
      nxt++;
      let comps = compsOf([r.face, lab1]).map(x => x[1]);
      if (comps.some(cc => gapDir(a, c, uniqP(cc)).gap <= thr)) {
        const labs = [r.face, nxt, nxt + 1, nxt + 2]; nxt += 3;
        for (const t2 of idx) { const cen = sub(mul(add(add(P(T[3 * t2]), P(T[3 * t2 + 1])), P(T[3 * t2 + 2])), 1 / 3), c); const th = Math.atan2(dot(cen, e2), dot(cen, e1)); const l = ((Math.floor((th + Math.PI) / (Math.PI / 2)) % 4) + 4) % 4; F[t2] = labs[l]; }
        fixPinches(ctx, F, labs); comps = compsOf(labs).map(x => x[1]);
      }
      split[r.face] = [];
      comps.forEach((cc, k) => { if (k === 0) { for (const t2 of cc) F[t2] = r.face; return; } for (const t2 of cc) F[t2] = nxt; out.push({ ...r, face: nxt, split_of: r.face }); split[r.face].push(nxt); nxt++; });
    }
    return { F, R: out, split };
  }

  // ---------------- freeform: harmonic map + LSQ tensor B-spline (bspline.py) ----------------
  function boundaryLoops(T, tidx, nv) {
    const E = new Map(); for (const t of tidx) for (let k = 0; k < 3; k++) { const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3]; const key = a * nv + b; E.set(key, (E.get(key) || 0) + 1); }
    const nxt = new Map(); for (const key of E.keys()) { const a = Math.floor(key / nv), b = key - a * nv; if (!E.has(b * nv + a)) { if (nxt.has(a)) nxt.set(a, -1); else nxt.set(a, b); } }
    const loops = []; const used = new Set();
    for (const s of nxt.keys()) { if (used.has(s)) continue; const loop = [s]; used.add(s); let v = nxt.get(s); let ok = true;
      while (v !== s) { if (v === undefined || v < 0 || used.has(v) || loop.length > nxt.size) { ok = false; break; } loop.push(v); used.add(v); v = nxt.get(v); }
      loops.push({ loop, ok }); }
    return loops;
  }
  function squareMap(ctx, tidx, loop, corner) {
    const { T, P } = ctx; const vset = new Set(); for (const t of tidx) for (let k = 0; k < 3; k++) vset.add(T[3 * t + k]);
    const verts = [...vset].sort((a, b) => a - b); const gi = new Map(verts.map((v, i) => [v, i])); const n = verts.length; const L = loop.length;
    const LP = loop.map(P); const seg = LP.map((p, i) => norm(sub(LP[(i + 1) % L], p))); const s = [0]; for (let i = 1; i < L; i++) s.push(s[i - 1] + seg[i - 1]); const tot = s[L - 1] + seg[L - 1];
    let cand = []; loop.forEach((v, i) => { if (corner(v)) cand.push(i); });
    const turn = LP.map((p, i) => { const d1 = sub(p, LP[(i - 1 + L) % L]), d2 = sub(LP[(i + 1) % L], p); return Math.acos(Math.max(-1, Math.min(1, dot(d1, d2) / (norm(d1) * norm(d2) || 1)))); });
    if (cand.length > 4) cand = cand.slice().sort((i, j) => turn[j] - turn[i]).slice(0, 4).sort((a, b) => a - b);
    if (cand.length < 4) {
      const set = new Set(cand); for (const qq of [0, 0.25, 0.5, 0.75]) { let bi = 0, bd = Infinity; for (let i = 0; i < L; i++) { const d = Math.abs(s[i] - qq * tot); if (d < bd) { bd = d; bi = i; } } set.add(bi); }
      cand = [...set].sort((a, b) => a - b);
      while (cand.length > 4) { const gaps = cand.map((c0, k) => (((s[cand[(k + 1) % cand.length]] - s[c0]) % tot) + tot) % tot); let mi = 0; for (let k = 1; k < gaps.length; k++) if (gaps[k] < gaps[mi]) mi = k; cand.splice((mi + 1) % cand.length, 1); }
    }
    if (cand.length < 4) return null;
    const sq = [[0, 0], [1, 0], [1, 1], [0, 1]]; const uvb = new Float64Array(2 * L);
    for (let k = 0; k < 4; k++) { const a = cand[k], b = cand[(k + 1) % 4]; const len = (((b - a) % L) + L) % L; const idx = []; for (let j = 0; j <= len; j++) idx.push((a + j) % L);
      const ss = [0]; for (let j = 0; j < idx.length - 1; j++) ss.push(ss[j] + seg[idx[j]]); const sl = ss[ss.length - 1] || 1;
      idx.forEach((ii, j) => { const w = ss[j] / sl; uvb[2 * ii] = sq[k][0] * (1 - w) + sq[(k + 1) % 4][0] * w; uvb[2 * ii + 1] = sq[k][1] * (1 - w) + sq[(k + 1) % 4][1] * w; }); }
    // clamped cotan weights
    const W = new Map(); const addW = (i, j, w) => { const key = i * n + j; W.set(key, (W.get(key) || 0) + w); };
    for (const t of tidx) { const tr = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
      for (const [i, j, k] of [[0, 1, 2], [1, 2, 0], [2, 0, 1]]) { const pk = P(tr[k]); const u = sub(P(tr[i]), pk), w = sub(P(tr[j]), pk); let cot = dot(u, w) / Math.max(norm(cross(u, w)), 1e-12); cot = Math.max(cot, 1e-3); addW(gi.get(tr[i]), gi.get(tr[j]), cot / 2); addW(gi.get(tr[j]), gi.get(tr[i]), cot / 2); } }
    const isb = new Int32Array(n).fill(-1); loop.forEach((v, i) => { isb[gi.get(v)] = i; });
    const UV = new Float64Array(2 * n); for (let i = 0; i < n; i++) if (isb[i] >= 0) { UV[2 * i] = uvb[2 * isb[i]]; UV[2 * i + 1] = uvb[2 * isb[i] + 1]; }
    const inn = []; const ii = new Int32Array(n).fill(-1); for (let i = 0; i < n; i++) if (isb[i] < 0) { ii[i] = inn.length; inn.push(i); }
    if (inn.length) {
      const rows = inn.map(() => new Map()); const B = new Float64Array(2 * inn.length);
      for (const [key, w] of W) { const i = Math.floor(key / n), j = key - i * n; if (ii[i] < 0) continue; const r = rows[ii[i]]; r.set(ii[i], (r.get(ii[i]) || 0) + w);
        if (ii[j] >= 0) r.set(ii[j], (r.get(ii[j]) || 0) - w); else { B[2 * ii[i]] += w * UV[2 * j]; B[2 * ii[i] + 1] += w * UV[2 * j + 1]; } }
      const rp = new Int32Array(inn.length + 1); for (let i = 0; i < inn.length; i++) rp[i + 1] = rp[i] + rows[i].size;
      const col = new Int32Array(rp[inn.length]), val = new Float64Array(rp[inn.length]); rows.forEach((r, i) => { let p = rp[i]; for (const [j, w] of r) { col[p] = j; val[p] = w; p++; } });
      const { X } = cgSolve(rp, col, val, inn.length, B, 2, 1e-13); for (let i = 0; i < inn.length; i++) { UV[2 * inn[i]] = X[2 * i]; UV[2 * inn[i] + 1] = X[2 * i + 1]; }
    }
    return { verts, UV, gi };
  }
  function pnSamples(ctx, tidx, gi, VNf, UVm) {
    const { T, P } = ctx; const bary = [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];
    const X = new Float64Array(tidx.length * 12), U = new Float64Array(tidx.length * 8); let q = 0;
    for (const t of tidx) {
      const id = [T[3 * t], T[3 * t + 1], T[3 * t + 2]]; const p = id.map(P); const nn = id.map(v => { const i = gi.get(v); return [VNf[3 * i], VNf[3 * i + 1], VNf[3 * i + 2]]; });
      const bij = (i, j) => { const w = dot(sub(p[j], p[i]), nn[i]); return mul(sub(add(mul(p[i], 2), p[j]), mul(nn[i], w)), 1 / 3); };
      const b210 = bij(0, 1), b120 = bij(1, 0), b021 = bij(1, 2), b012 = bij(2, 1), b102 = bij(2, 0), b201 = bij(0, 2);
      const E = mul(add(add(add(b210, b120), add(b021, b012)), add(b102, b201)), 1 / 6), Vc = mul(add(add(p[0], p[1]), p[2]), 1 / 3), b111 = add(E, mul(sub(E, Vc), 0.5));
      const uv = id.map(v => { const i = gi.get(v); return [UVm[2 * i], UVm[2 * i + 1]]; });
      for (const [w, u, v] of bary) {
        for (let k = 0; k < 3; k++) X[3 * q + k] = p[0][k] * w ** 3 + p[1][k] * u ** 3 + p[2][k] * v ** 3 + b210[k] * 3 * w * w * u + b120[k] * 3 * w * u * u + b201[k] * 3 * w * w * v + b021[k] * 3 * u * u * v + b102[k] * 3 * w * v * v + b012[k] * 3 * u * v * v + b111[k] * 6 * w * u * v;
        U[2 * q] = w * uv[0][0] + u * uv[1][0] + v * uv[2][0]; U[2 * q + 1] = w * uv[0][1] + u * uv[1][1] + v * uv[2][1]; q++;
      }
    }
    return { X, U };
  }
  function solveTP(nu, nv, UV, X, W, s2) {
    const n = nu * nv; const M = new Float64Array(n * n), R = new Float64Array(3 * n); const tu = knots(nu), tv = knots(nv);
    const fro = lsqAccumulate(nu, nv, UV, X, W, M, R, tu, tv); if (s2 == null) { const nd = addSecondDiff(nu, nv, null, 0); s2 = 1e-4 * fro / Math.max(1, nd); }
    addSecondDiff(nu, nv, M, s2); const C = cholSolve(M, n, R, 3); return { C, s2 };
  }
  function fitBspline(ctx, tidx, data, corner, nu, nv, opt) {
    const loops = boundaryLoops(ctx.T, tidx, ctx.nv); if (loops.length !== 1 || !loops[0].ok) return { error: loops.length ? 'region is not a disc (' + loops.length + ' boundary loops)' : 'no boundary' };
    const loop = loops[0].loop; if (loop.length < 4) return { error: 'tiny boundary' };
    const sm = squareMap(ctx, tidx, loop, corner); if (!sm) return { error: 'no corners' };
    const { verts, UV: UV0, gi } = sm; const nV = verts.length;
    const vi = new Map(data.vs.map((v, i) => [v, i])); const VNf = new Float64Array(3 * nV), Pv = new Float64Array(3 * nV);
    verts.forEach((v, i) => { const p = ctx.P(v); Pv.set(p, 3 * i); const n = data.N[vi.get(v)]; VNf.set(n && isFinite(n[0]) ? n : [0, 0, 0], 3 * i); });
    const ps = pnSamples(ctx, tidx, gi, VNf, UV0);
    nu = nu || Math.max(6, Math.min(24, (loop.length >> 2) + 4)); nv = nv || Math.max(5, Math.min(16, (loop.length >> 3) + 4));
    const nS = ps.X.length / 3; const X = new Float64Array(3 * (nV + nS)); X.set(Pv); X.set(ps.X, 3 * nV);
    let UVa = new Float64Array(2 * (nV + nS)); UVa.set(UV0); UVa.set(ps.U, 2 * nV);
    const W = new Float64Array(nV + nS).fill(1); W.fill(3, 0, nV);
    let sol = solveTP(nu, nv, UVa, X, W, null); if (!sol.C) return { error: 'singular LSQ' }; const s2 = sol.s2; let C = sol.C;
    for (let it = 0; it < 4; it++) { project(makeSurf(nu, nv, C), X, UVa, 3); const r2 = solveTP(nu, nv, UVa, X, W, s2); if (!r2.C) break; C = r2.C; if (opt && opt.shouldStop && opt.shouldStop()) break; }
    const S = makeSurf(nu, nv, C); const UVv = UVa.slice(0, 2 * nV); project(S, Pv, UVv, 8);
    const dv = deviation(S, Pv, UVv, VNf);
    return { nu, nv, C, S, maxdev: dv.maxdev, rms: dv.rms, angmax: dv.angmax, flip: dv.flip, verts, UVv, Pv, VNf, method: 'harmonic_lsq' };
  }
  function polesOf(nu, nv, C) { const out = []; for (let i = 0; i < nu; i++) { const r = []; for (let j = 0; j < nv; j++) { const k = 3 * (i * nv + j); r.push([C[k], C[k + 1], C[k + 2]]); } out.push(r); } return out; }

  // ---------------- helical sweep (fit_helical2.py, generalised with a kinematic axis estimate) ----------------
  // Pottmann/Randrup line-geometry fit: minimise sum (N.cbar + (P x N).c)^2, |c| = 1 -> helical motion (axis, pitch)
  function kinematic(P, N) {
    const o = mean(P); const M = []; for (let i = 0; i < 6; i++) M.push(new Float64Array(6));
    for (let i = 0; i < P.length; i++) { const p = sub(P[i], o), n = N[i]; if (!isFinite(n[0])) continue; const r = [n[0], n[1], n[2], ...cross(p, n)]; for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) M[a][b] += r[a] * r[b]; }
    const Mbb = [0, 1, 2].map(i => [M[i][0], M[i][1], M[i][2]]), Mbc = [0, 1, 2].map(i => [M[i][3], M[i][4], M[i][5]]), Mcc = [3, 4, 5].map(i => [M[i][3], M[i][4], M[i][5]]);
    const Bi = inv3(Mbb); if (!Bi) return null;
    const X = [0, 1, 2].map(i => [0, 1, 2].map(j => Bi[i][0] * Mbc[0][j] + Bi[i][1] * Mbc[1][j] + Bi[i][2] * Mbc[2][j])); // Mbb^-1 Mbc
    const S = [0, 1, 2].map(i => [0, 1, 2].map(j => Mcc[i][j] - (Mbc[0][i] * X[0][j] + Mbc[1][i] * X[1][j] + Mbc[2][i] * X[2][j])));
    const E = eigSym3(S); const c = E.U[0]; const cb = [0, 1, 2].map(i => -(X[i][0] * c[0] + X[i][1] * c[1] + X[i][2] * c[2]));
    const pitch = dot(c, cb); const q = add(o, cross(c, cb));
    return { axis: c, point: q, pitch, resid: Math.sqrt(Math.max(0, E.w[0]) / P.length), eig: E.w };
  }
  function helicalFit(ctx, tidx, data, opt) {
    opt = opt || {}; const kin = opt.kin || kinematic(data.P, data.N); if (!kin || !isFinite(kin.pitch) || Math.abs(kin.pitch) < 1e-9) return { error: 'no helical motion' };
    const ez = unit(kin.axis); const ex = perp(ez, [1, 0, 0]), ey = cross(ez, ex); const q0 = kin.point;
    const toL = p => { const d = sub(p, q0); return [dot(d, ex), dot(d, ey), dot(d, ez)]; }; const toW = l => add(q0, add(add(mul(ex, l[0]), mul(ey, l[1])), mul(ez, l[2])));
    const P = data.P.map(toL), N = data.N.map(n => [dot(n, ex), dot(n, ey), dot(n, ez)]);
    let k = 1 / kin.pitch; // rad per mm along +z
    let z0 = Infinity, z1 = -Infinity; for (const p of P) { z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); } if (!(z1 - z0 > 1e-6)) return { error: 'flat in z' };
    if (Math.abs(k * (z1 - z0)) < 0.05) return { error: 'twist too small' };
    const loops = boundaryLoops(ctx.T, tidx, ctx.nv); if (loops.length !== 1 || !loops[0].ok) return { error: 'not a disc' };
    const loop = loops[0].loop; const vi = new Map(data.vs.map((v, i) => [v, i])); const Lz = loop.map(v => P[vi.get(v)][2]);
    const ztol = Math.max(1e-6, 2e-5 * (z1 - z0) + 1e-4 * opt.edge);
    // profile chain: boundary run at z0 (or z1)
    function chain(zz) { const bot = Lz.map(z => Math.abs(z - zz) < ztol); const i0 = bot.indexOf(false); if (i0 < 0) return null; const out = []; for (let j = 0; j < loop.length; j++) { const i = (i0 + j) % loop.length; if (bot[i]) out.push(vi.get(loop[i])); } return out; }
    const untw = (X, kk) => { const a = -kk * X[2], c = Math.cos(a), s = Math.sin(a); return [c * X[0] - s * X[1], s * X[0] + c * X[1]]; };
    let best = null;
    for (const zz of [z0, z1]) {
      const ch = chain(zz); if (!ch || ch.length < 4) continue;
      for (const nu of (opt.nus || [6, 10, 14, 20, 28])) {
        const r = helicalOnce(P, N, ch, k, z0, z1, nu, untw, opt); if (!r) continue;
        if (!best || r.maxdev < best.maxdev) best = r; if (best.maxdev <= (opt.target || 0.002)) break; if (opt.shouldStop && opt.shouldStop()) break;
      }
      if (best && best.maxdev <= (opt.target || 0.002)) break;
    }
    if (!best) return { error: 'no profile chain' };
    // world poles
    const Cw = new Float64Array(best.C.length); for (let i = 0; i < best.C.length / 3; i++) { const w = toW([best.C[3 * i], best.C[3 * i + 1], best.C[3 * i + 2]]); Cw[3 * i] = w[0]; Cw[3 * i + 1] = w[1]; Cw[3 * i + 2] = w[2]; }
    const S = makeSurf(best.nu, best.nv, Cw); const Pv = new Float64Array(3 * data.P.length); data.P.forEach((p, i) => Pv.set(p, 3 * i)); const VNf = new Float64Array(3 * data.N.length); data.N.forEach((n, i) => VNf.set(isFinite(n[0]) ? n : [0, 0, 0], 3 * i));
    const UVv = best.UV; const dv = deviation(S, Pv, UVv, VNf);
    return { nu: best.nu, nv: best.nv, C: Cw, S, maxdev: dv.maxdev, rms: dv.rms, angmax: dv.angmax, flip: dv.flip, verts: data.vs, UVv, Pv, VNf, method: 'helical_sweep', twist_deg_per_mm: k * 180 / Math.PI, axis: ez, axisPoint: q0 };
  }
  function helicalOnce(P, N, ch, k, z0, z1, nu, untw, opt) {
    const n = P.length; const Q = P.map(p => untw(p, k)); const prof = ch.map(i => Q[i]);
    const seg = []; const s = [0]; for (let i = 0; i + 1 < prof.length; i++) { const d = Math.hypot(prof[i + 1][0] - prof[i][0], prof[i + 1][1] - prof[i][1]); seg.push(d); s.push(s[i] + d); } const stot = s[s.length - 1]; if (!(stot > 0)) return null;
    let u = new Float64Array(n);
    for (let p = 0; p < n; p++) { let bd = Infinity, bu = 0; for (let i = 0; i < seg.length; i++) { const ax = prof[i][0], ay = prof[i][1], dx = prof[i + 1][0] - ax, dy = prof[i + 1][1] - ay; const L2 = dx * dx + dy * dy || 1e-300; let t = ((Q[p][0] - ax) * dx + (Q[p][1] - ay) * dy) / L2; t = Math.max(0, Math.min(1, t)); const ex = ax + t * dx - Q[p][0], ey = ay + t * dy - Q[p][1]; const d = ex * ex + ey * ey; if (d < bd) { bd = d; bu = (s[i] + t * seg[i]) / stot; } } u[p] = bu; }
    const tu = knots(nu); const Qf = new Float64Array(2 * n); Q.forEach((q, i) => { Qf[2 * i] = q[0]; Qf[2 * i + 1] = q[1]; }); const o = {};
    let C = null;
    for (let it = 0; it < 8; it++) { C = fit1D(tu, nu, u, Qf, 2, 1e-12); if (!C) return null;
      for (let r = 0; r < 3; r++) for (let p = 0; p < n; p++) { basis3(tu, nu, u[p], o); let sx = 0, sy = 0, dx = 0, dy = 0; for (let a = 0; a < 4; a++) { const j = o.s + a; sx += o.N[a] * C[2 * j]; sy += o.N[a] * C[2 * j + 1]; dx += o.D[a] * C[2 * j]; dy += o.D[a] * C[2 * j + 1]; }
        u[p] = Math.max(0, Math.min(1, u[p] + ((Qf[2 * p] - sx) * dx + (Qf[2 * p + 1] - sy) * dy) / Math.max(dx * dx + dy * dy, 1e-12))); } }
    C = fit1D(tu, nu, u, Qf, 2, 1e-12); if (!C) return null;
    // cos/sin(kz) along v
    const twist = Math.abs(k * (z1 - z0)); const nv = opt.nv || Math.max(8, Math.min(64, Math.round(twist * 10) + 4)); const tv = knots(nv);
    const ns = 2000, vv = new Float64Array(ns), Y = new Float64Array(3 * ns); for (let i = 0; i < ns; i++) { vv[i] = i / (ns - 1); const zz = z0 + vv[i] * (z1 - z0); Y[3 * i] = Math.cos(k * zz); Y[3 * i + 1] = Math.sin(k * zz); Y[3 * i + 2] = zz; }
    const ab = fit1D(tv, nv, vv, Y, 3, 0); if (!ab) return null;
    const Cf = new Float64Array(3 * nu * nv);
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) { const a = ab[3 * j], b = ab[3 * j + 1], cx = C[2 * i], cy = C[2 * i + 1]; const q = 3 * (i * nv + j); Cf[q] = a * cx - b * cy; Cf[q + 1] = a * cy + b * cx; Cf[q + 2] = ab[3 * j + 2]; }
    const Pf = new Float64Array(3 * n); P.forEach((p, i) => Pf.set(p, 3 * i)); const UV = new Float64Array(2 * n); for (let p = 0; p < n; p++) { UV[2 * p] = u[p]; UV[2 * p + 1] = (P[p][2] - z0) / (z1 - z0); }
    let S = makeSurf(nu, nv, Cf); project(S, Pf, UV, 6); let dv = deviation(S, Pf, UV, null);
    // ridge-regularised free 3D refinement toward the sweep net (kept only if it lowers the max deviation)
    const lam = opt.lam != null ? opt.lam : 0.05;
    if (lam > 0 && dv.maxdev > 2e-4) {
      let Cr = Cf, UVr = UV.slice(); const C0 = Cf; const nn = nu * nv;
      for (let it = 0; it < 3; it++) { const M = new Float64Array(nn * nn), R = new Float64Array(3 * nn); lsqAccumulate(nu, nv, UVr, Pf, null, M, R, S.tu, S.tv); for (let i = 0; i < nn; i++) { M[i * nn + i] += lam; R[3 * i] += lam * C0[3 * i]; R[3 * i + 1] += lam * C0[3 * i + 1]; R[3 * i + 2] += lam * C0[3 * i + 2]; }
        const X = cholSolve(M, nn, R, 3); if (!X) break; Cr = X; project(makeSurf(nu, nv, Cr), Pf, UVr, 4); }
      const dr = deviation(makeSurf(nu, nv, Cr), Pf, UVr, null);
      if (dr.maxdev < dv.maxdev) return { nu, nv, C: Cr, UV: UVr, maxdev: dr.maxdev };
    }
    return { nu, nv, C: Cf, UV, maxdev: dv.maxdev };
  }

  // ---------------- symmetry reuse ----------------
  function rotAbout(p, q, a, th) { const d = sub(p, q); const c = Math.cos(th), s = Math.sin(th); const k = dot(d, a); const r = add(add(mul(d, c), mul(cross(a, d), s)), mul(a, k * (1 - c))); return add(q, r); }
  function gridNN(pts, h) { const g = new Map(); const key = (x, y, z) => x + ',' + y + ',' + z; pts.forEach((p, i) => { const k = key(Math.floor(p[0] / h), Math.floor(p[1] / h), Math.floor(p[2] / h)); let l = g.get(k); if (!l) g.set(k, l = []); l.push(i); });
    return q => { const x = Math.floor(q[0] / h), y = Math.floor(q[1] / h), z = Math.floor(q[2] / h); let bd = Infinity, bi = -1; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) { const l = g.get(key(x + dx, y + dy, z + dz)); if (!l) continue; for (const i of l) { const d = norm(sub(pts[i], q)); if (d < bd) { bd = d; bi = i; } } } return [bd, bi]; }; }

  // ---------------- driver ----------------
  function fitMesh(mesh, opt) {
    opt = opt || {}; const progress = opt.onProgress || (() => {}); const stop = opt.shouldStop || (() => false);
    const tm = {}; let t0 = nowMs();
    const ctx = makeCtx(mesh); const { T, nv } = ctx; const m = T.length / 3;
    // mean edge length (tolerance scale)
    let el = 0; for (let t = 0; t < Math.min(m, 20000); t++) el += norm(sub(ctx.P(T[3 * t]), ctx.P(T[3 * t + 1]))); const edge = el / Math.max(1, Math.min(m, 20000));
    // 1. segmentation: PRC face ids -> connected components (each its own region)
    progress({ stage: 'segment', done: 0, total: 1, label: 'Segmenting faces' });
    let F = Int32Array.from(mesh.F); let nxt = 0; for (const f of F) nxt = Math.max(nxt, f + 1);
    const fragOf = new Map(); let nFrag = 0;
    for (const [f, ts] of trisOf(F)) { const cs = components(T, ts, nv); if (cs.length < 2) continue; cs.sort((a, b) => b.length - a.length); for (let k = 1; k < cs.length; k++) { for (const t of cs[k]) F[t] = nxt; fragOf.set(nxt, f); nxt++; nFrag++; } }
    tm.segmentMs = nowMs() - t0; t0 = nowMs();
    // 2. primitives
    let regs = trisOf(F); const faces = [...regs.keys()].sort((a, b) => a - b); const R = []; const dataOf = new Map();
    let done = 0; const nTot = faces.length;
    for (const f of faces) {
      if (stop()) return { cancelled: true };
      const ts = regs.get(f); const d = regionData(ctx, ts); dataOf.set(f, d);
      const ok = d.N.map(n => isFinite(n[0])); const Pk = d.P.filter((_, i) => ok[i]), Nk = d.N.filter((_, i) => ok[i]);
      const c = classify(Pk, Nk, ctx.diag);
      R.push({ face: f, type: c.type, params: c.model ? c.model.params() : null, maxdev: c.s ? c.s[0] : null, rms: c.s ? c.s[1] : null, angdeg: c.s ? c.s[2] * 180 / Math.PI : null, nverts: d.vs.length, ntris: ts.length, area: triArea(ctx, ts), tries: c.tries, model: c.model || null });
      done++; if ((done & 7) === 0 || done === nTot) progress({ stage: 'fit', sub: 'primitives', done, total: nTot });
    }
    tm.primitivesMs = nowMs() - t0; t0 = nowMs();
    // 3. fragment merging: a FREEFORM fragment / small region whose vertices lie on an adjacent primitive joins it
    const Rby = new Map(R.map(r => [r.face, r])); let nMerged = 0;
    {
      const eFace = new Map(); for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3]; const key = Math.min(a, b) * nv + Math.max(a, b); let l = eFace.get(key); if (!l) eFace.set(key, l = []); l.push(t); }
      const nbrs = f => { const cnt = new Map(); for (const t of regs.get(f)) for (let k = 0; k < 3; k++) { const a = T[3 * t + k], b = T[3 * t + (k + 1) % 3]; for (const u of eFace.get(Math.min(a, b) * nv + Math.max(a, b))) { const g = F[u]; if (g !== f) cnt.set(g, (cnt.get(g) || 0) + 1); } } return [...cnt.entries()].sort((x, y) => y[1] - x[1]).map(x => x[0]); };
      const small = r => r.ntris <= 8 || fragOf.has(r.face);
      for (const r of R.slice().sort((a, b) => a.ntris - b.ntris)) {
        if (!Rby.has(r.face)) continue; if (!(r.type === 'FREEFORM' || small(r))) continue;
        const d = dataOf.get(r.face); const ok = d.N.map(n => isFinite(n[0]));
        for (const g of nbrs(r.face)) { const rg = Rby.get(g); if (!rg || !rg.model || rg.face === r.face) continue; if (r.type !== 'FREEFORM' && !(small(r) && rg.type === r.type)) continue;
          const s = score(rg.model, d.P.filter((_, i) => ok[i]), d.N.filter((_, i) => ok[i])); if (!(s[0] <= TOL_D && s[2] <= TOL_A)) continue;
          for (const t of regs.get(r.face)) F[t] = g; regs.get(g).push(...regs.get(r.face)); regs.delete(r.face); Rby.delete(r.face); nMerged++;
          dataOf.set(g, regionData(ctx, regs.get(g))); rg.ntris = regs.get(g).length; rg.nverts = dataOf.get(g).vs.length; rg.area = triArea(ctx, regs.get(g)); break; }
      }
    }
    let R2 = R.filter(r => Rby.has(r.face));
    tm.mergeMs = nowMs() - t0; t0 = nowMs();
    // corner flags: vertices touching >= 3 regions (before periodic splitting)
    const vfc = new Map(); for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const v = T[3 * t + k]; let s = vfc.get(v); if (!s) vfc.set(v, s = new Set()); s.add(F[t]); }
    const corner = v => { const s = vfc.get(v); return !!s && s.size >= 3; };
    // 4. periodic splitting
    const spl = splitFullRevolutions(ctx, F, R2.map(r => ({ face: r.face, type: r.type, params: r.params, maxdev: r.maxdev })), 0.5);
    F = spl.F; tm.splitMs = nowMs() - t0; t0 = nowMs();
    regs = trisOf(F);
    // 5. freeform faces
    const ffaces = R2.filter(r => r.type === 'FREEFORM').map(r => r.face);
    const ffTol = Math.max(0.05, 1e-3 * ctx.diag);
    const ff = {}; const fitInfo = {}; const unfit = [];
    // axes for symmetry: fitted rotational primitives
    const axes = []; const addAxis = (q, a) => { a = unit(a); for (const ax of axes) { if (Math.abs(Math.abs(dot(ax.a, a)) - 1) < 1e-6 && norm(cross(sub(q, ax.q), ax.a)) < 1e-4 * ctx.diag) { ax.n++; return; } } axes.push({ q, a, n: 1 }); };
    for (const r of R2) if (r.model) { const p = r.params; if (r.type === 'CYLINDER') addAxis(p.origin, p.axis); else if (r.type === 'CONE') addAxis(p.apex, p.axis); else if (r.type === 'TORUS') addAxis(p.center, p.axis); }
    axes.sort((a, b) => b.n - a.n);
    // classes of look-alike freeform faces (same size); representative fitted, copies by rotation if verified
    const sig = f => { const r = Rby.get(f); return r; }; const reps = []; const copyOf = new Map();
    for (const f of ffaces) { const r = sig(f); let found = null; for (const g of reps) { const rg = sig(g); if (Math.abs(rg.area - r.area) <= 0.01 * rg.area && Math.abs(rg.nverts - r.nverts) <= 0.1 * rg.nverts) { found = g; break; } }
      if (found != null) copyOf.set(f, found); else reps.push(f); }
    const fittedState = new Map();
    const stats = { symmetryCopies: 0, symmetryRejected: 0, helical: 0, bsplineRetries: 0, fragments: nFrag, merged: nMerged };
    let fdone = 0; const fTot = ffaces.length;
    const fitOne = (f) => {
      const ts = regs.get(f); const d = dataOf.get(f) || regionData(ctx, ts);
      let best = fitBspline(ctx, ts, d, corner, null, null, { shouldStop: stop });
      if (!best.error && best.maxdev > 0.01) {
        // grid retries for long thin strips (head_test thread faces) - keep the best
        for (const [gu, gv] of [[64, 5], [5, 64], [96, 6], [6, 96], [48, 4]]) { if (stop()) break; const b = fitBspline(ctx, ts, d, corner, gu, gv, {}); stats.bsplineRetries++; if (!b.error && b.maxdev < best.maxdev) best = b; if (best.maxdev < 0.01) break; }
      }
      if (best.error || best.maxdev > 0.002) { // helical sweep candidate (surface is invariant under a screw motion)
        const ok = d.N.map(n => isFinite(n[0])); const kin = kinematic(d.P.filter((_, i) => ok[i]), d.N.filter((_, i) => ok[i]));
        if (kin && kin.eig[0] < 1e-4 * kin.eig[1]) { const h = helicalFit(ctx, ts, d, { kin, edge, shouldStop: stop }); if (!h.error && (best.error || h.maxdev < best.maxdev)) { best = h; stats.helical++; } }
      }
      return best;
    };
    const accept = (f, b, extra) => {
      const ok = !b.error && b.maxdev <= ffTol && b.angmax < 89;
      fitInfo[f] = { method: b.method || null, maxdev: b.maxdev, rms: b.rms, angmax: b.angmax, nu: b.nu, nv: b.nv, error: b.error || null, ...extra };
      if (!ok) { unfit.push(f); return; }
      ff[f] = { poles: polesOf(b.nu, b.nv, b.C), tu: knots(b.nu), tv: knots(b.nv), nu: b.nu, nv: b.nv, deg: 3, maxdev: b.maxdev, rms: b.rms, angmax: b.angmax, flip: b.flip, method: b.method, ...extra };
    };
    for (const f of reps) {
      if (stop()) return { cancelled: true };
      const b = fitOne(f); fittedState.set(f, b); accept(f, b, {});
      fdone++; progress({ stage: 'fit', sub: 'freeform', done: fdone, total: fTot });
    }
    for (const f of ffaces) {
      if (!copyOf.has(f)) continue; if (stop()) return { cancelled: true };
      const g = copyOf.get(f); const bg = fittedState.get(g); let done2 = false;
      if (bg && !bg.error) {
        const dg = dataOf.get(g), df = dataOf.get(f); const cg = mean(dg.P), cf = mean(df.P);
        const nn = gridNN(df.P, Math.max(edge, 1e-3) * 2);
        for (const ax of axes.slice(0, 6)) {
          const rg = sub(cg, ax.q), rf = sub(cf, ax.q); const pg = sub(rg, mul(ax.a, dot(rg, ax.a))), pf = sub(rf, mul(ax.a, dot(rf, ax.a)));
          if (norm(pg) < 1e-6 * ctx.diag || Math.abs(norm(pg) - norm(pf)) > 0.01 * norm(pg) + 1e-3 || Math.abs(dot(rg, ax.a) - dot(rf, ax.a)) > 0.01 * ctx.diag) continue;
          const th = Math.atan2(dot(cross(pg, pf), ax.a), dot(pg, pf));
          // vertex match p95
          const dl = []; const match = new Int32Array(df.P.length).fill(-1); const bestD = new Float64Array(df.P.length).fill(Infinity);
          dg.P.forEach((p, i) => { const [dd, j] = nn(rotAbout(p, ax.q, ax.a, th)); dl.push(dd); if (j >= 0 && dd < bestD[j]) { bestD[j] = dd; match[j] = i; } });
          dl.sort((a, b) => a - b); const p95 = dl[Math.floor(0.95 * (dl.length - 1))];
          if (!(p95 < Math.max(0.01, 0.25 * edge))) continue;
          // rotate poles and verify every vertex of the copy by projection
          const C = new Float64Array(bg.C.length); for (let i = 0; i < C.length / 3; i++) { const r = rotAbout([bg.C[3 * i], bg.C[3 * i + 1], bg.C[3 * i + 2]], ax.q, ax.a, th); C[3 * i] = r[0]; C[3 * i + 1] = r[1]; C[3 * i + 2] = r[2]; }
          const S = makeSurf(bg.nu, bg.nv, C); const gIdx = new Map(bg.verts.map((v, i) => [v, i])); const dgi = new Map(dg.vs.map((v, i) => [i, v]));
          const nF = df.P.length; const Pf = new Float64Array(3 * nF), Nf = new Float64Array(3 * nF), UV = new Float64Array(2 * nF);
          const backNN = gridNN(dg.P.map(p => rotAbout(p, ax.q, ax.a, th)), Math.max(edge, 1e-3) * 2);
          for (let i = 0; i < nF; i++) { Pf.set(df.P[i], 3 * i); Nf.set(isFinite(df.N[i][0]) ? df.N[i] : [0, 0, 0], 3 * i); let j = match[i]; if (j < 0) j = backNN(df.P[i])[1]; const gi2 = j >= 0 ? gIdx.get(dgi.get(j)) : undefined; UV[2 * i] = gi2 != null ? bg.UVv[2 * gi2] : 0.5; UV[2 * i + 1] = gi2 != null ? bg.UVv[2 * gi2 + 1] : 0.5; }
          project(S, Pf, UV, 8); const dv = deviation(S, Pf, UV, Nf);
          if (dv.maxdev <= Math.max(2 * bg.maxdev, bg.maxdev + 0.002) && dv.maxdev <= ffTol) {
            accept(f, { nu: bg.nu, nv: bg.nv, C, maxdev: dv.maxdev, rms: dv.rms, angmax: dv.angmax, flip: dv.flip, method: (bg.method || '') + '+rotated' }, { src: g, angle_deg: th * 180 / Math.PI, match_p95: p95 });
            stats.symmetryCopies++; done2 = true; break;
          } else stats.symmetryRejected++;
        }
      }
      if (!done2) { const b = fitOne(f); accept(f, b, {}); }
      fdone++; progress({ stage: 'fit', sub: 'freeform', done: fdone, total: fTot });
    }
    tm.freeformMs = nowMs() - t0;
    const regions = spl.R.map(r => ({ face: r.face, type: r.type, params: r.params, split_of: r.split_of != null ? r.split_of : undefined, maxdev: r.maxdev }));
    const byType = { plane: 0, cylinder: 0, cone: 0, sphere: 0, torus: 0, bspline: 0 };
    for (const r of regions) { const k = r.type === 'FREEFORM' ? 'bspline' : r.type.toLowerCase(); byType[k]++; }
    return { F, regions, ff, unfit, fitInfo, byType, stats, timings: tm, diag: ctx.diag, edge };
  }

  const api = { fitMesh, classify, regionData, makeCtx, splitFullRevolutions, fitBspline, helicalFit, kinematic, circle3d, TOL_D, TOL_A };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDF3DFit = api;
})(typeof self !== 'undefined' ? self : this);
