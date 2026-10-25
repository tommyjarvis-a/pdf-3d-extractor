/* fit-linalg.js - small dense / sparse linear algebra + B-spline helpers for recon/fit.js (plain JS, no deps).
 * Part of pdf-3d-extractor (MIT). */
(function (root) {
  'use strict';
  // ---- 3-vectors
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => Math.hypot(a[0], a[1], a[2]);
  const unit = a => { const l = norm(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  // symmetric 3x3 eigen (Jacobi). Returns {w:[asc], U:[[vec0],[vec1],[vec2]]} with U[k] the eigenvector of w[k]
  function eigSym3(A) {
    const a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
    const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 60; sweep++) {
      const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      const sc = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]);
      if (off <= 1e-300 || off < 1e-17 * sc) break;
      for (let p = 0; p < 2; p++) for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
      }
    }
    const idx = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
    return { w: idx.map(i => a[i][i]), U: idx.map(i => [v[0][i], v[1][i], v[2][i]]) };
  }
  function inv3(M) {
    const [a, b, c] = M[0], [d, e, f] = M[1], [g, h, i] = M[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g; const det = a * A + b * B + c * C;
    if (!isFinite(det) || Math.abs(det) < 1e-300) return null;
    return [[A / det, -(b * i - c * h) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, -(a * f - c * d) / det], [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]];
  }
  // least squares min |A x - b| via Householder QR. A: array of rows (m x n), B: array of rows (m x k). Returns n x k (array of rows)
  function lstsq(A, B) {
    const m = A.length, n = A[0].length, k = B[0].length;
    const Q = A.map(r => Float64Array.from(r)); const R = B.map(r => Float64Array.from(r));
    // column scaling for conditioning
    const cs = new Float64Array(n); for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < m; i++) s += Q[i][j] * Q[i][j]; cs[j] = Math.sqrt(s) || 1; for (let i = 0; i < m; i++) Q[i][j] /= cs[j]; }
    const rank = [];
    for (let j = 0; j < n; j++) {
      let s = 0; for (let i = j; i < m; i++) s += Q[i][j] * Q[i][j]; let al = Math.sqrt(s); if (al < 1e-14) { rank.push(false); continue; }
      rank.push(true); if (Q[j][j] > 0) al = -al;
      const v = new Float64Array(m); for (let i = j; i < m; i++) v[i] = Q[i][j]; v[j] -= al; let vn = 0; for (let i = j; i < m; i++) vn += v[i] * v[i]; if (vn < 1e-300) continue;
      for (let c = j; c < n; c++) { let d = 0; for (let i = j; i < m; i++) d += v[i] * Q[i][c]; d = 2 * d / vn; for (let i = j; i < m; i++) Q[i][c] -= d * v[i]; }
      for (let c = 0; c < k; c++) { let d = 0; for (let i = j; i < m; i++) d += v[i] * R[i][c]; d = 2 * d / vn; for (let i = j; i < m; i++) R[i][c] -= d * v[i]; }
    }
    const X = []; for (let j = 0; j < n; j++) X.push(new Float64Array(k));
    for (let j = n - 1; j >= 0; j--) {
      if (!rank[j] || Math.abs(Q[j][j]) < 1e-13) continue;
      for (let c = 0; c < k; c++) { let s = R[j][c]; for (let l = j + 1; l < n; l++) s -= Q[j][l] * X[l][c]; X[j][c] = s / Q[j][j]; }
    }
    for (let j = 0; j < n; j++) for (let c = 0; c < k; c++) X[j][c] /= cs[j];
    return X.map(r => Array.from(r));
  }
  // dense SPD solve in place: M (n*n Float64Array, row-major), RHS (n*k Float64Array). returns X (n*k) or null
  function cholSolve(M, n, RHS, k) {
    const L = M; // overwrite
    let maxd = 0; for (let i = 0; i < n; i++) maxd = Math.max(maxd, L[i * n + i]);
    const jit = maxd * 1e-14 + 1e-300;
    for (let j = 0; j < n; j++) {
      const rj = j * n; let s = L[rj + j];
      for (let p = 0; p < j; p++) s -= L[rj + p] * L[rj + p];
      if (!(s > jit)) s = jit;
      const d = Math.sqrt(s); L[rj + j] = d;
      for (let i = j + 1; i < n; i++) {
        const ri = i * n; let t = L[ri + j];
        for (let p = 0; p < j; p++) t -= L[ri + p] * L[rj + p];
        L[ri + j] = t / d;
      }
    }
    const X = new Float64Array(RHS);
    for (let c = 0; c < k; c++) {
      for (let i = 0; i < n; i++) { let s = X[i * k + c]; const ri = i * n; for (let p = 0; p < i; p++) s -= L[ri + p] * X[p * k + c]; X[i * k + c] = s / L[ri + i]; }
      for (let i = n - 1; i >= 0; i--) { let s = X[i * k + c]; for (let p = i + 1; p < n; p++) s -= L[p * n + i] * X[p * k + c]; X[i * k + c] = s / L[i * n + i]; }
    }
    for (let i = 0; i < X.length; i++) if (!isFinite(X[i])) return null;
    return X;
  }
  // CSR sparse SPD solve by Jacobi-preconditioned CG (several RHS, solved independently)
  function cgSolve(rowPtr, col, val, n, B, k, tol, maxIt) {
    tol = tol || 1e-13; maxIt = maxIt || Math.max(200, 4 * n);
    const diag = new Float64Array(n); for (let i = 0; i < n; i++) for (let p = rowPtr[i]; p < rowPtr[i + 1]; p++) if (col[p] === i) diag[i] += val[p];
    const X = new Float64Array(n * k);
    const r = new Float64Array(n), z = new Float64Array(n), pp = new Float64Array(n), Ap = new Float64Array(n), x = new Float64Array(n);
    let iters = 0;
    for (let c = 0; c < k; c++) {
      let bn = 0; for (let i = 0; i < n; i++) { const b = B[i * k + c]; r[i] = b; bn += b * b; x[i] = 0; } bn = Math.sqrt(bn); if (bn === 0) continue;
      for (let i = 0; i < n; i++) { z[i] = r[i] / (diag[i] || 1); pp[i] = z[i]; }
      let rz = 0; for (let i = 0; i < n; i++) rz += r[i] * z[i];
      for (let it = 0; it < maxIt; it++) {
        iters++;
        for (let i = 0; i < n; i++) { let s = 0; for (let q = rowPtr[i]; q < rowPtr[i + 1]; q++) s += val[q] * pp[col[q]]; Ap[i] = s; }
        let pAp = 0; for (let i = 0; i < n; i++) pAp += pp[i] * Ap[i]; if (!(Math.abs(pAp) > 0)) break;
        const al = rz / pAp; let rn = 0;
        for (let i = 0; i < n; i++) { x[i] += al * pp[i]; r[i] -= al * Ap[i]; rn += r[i] * r[i]; }
        if (Math.sqrt(rn) <= tol * bn) break;
        let rz2 = 0; for (let i = 0; i < n; i++) { z[i] = r[i] / (diag[i] || 1); rz2 += r[i] * z[i]; }
        const be = rz2 / rz; rz = rz2; for (let i = 0; i < n; i++) pp[i] = z[i] + be * pp[i];
      }
      for (let i = 0; i < n; i++) X[i * k + c] = x[i];
    }
    return { X, iters };
  }

  // ---- clamped uniform cubic B-spline basis
  function knots(n, deg) { deg = deg || 3; const t = []; for (let i = 0; i < deg; i++) t.push(0); const m = n - deg + 1; for (let i = 0; i < m; i++) t.push(i / (m - 1)); for (let i = 0; i < deg; i++) t.push(1); return t; }
  // basis functions + first derivatives at x for knot vector t (degree 3). out: {s (first index), N[4], D[4]}
  function basis3(t, nb, x, out) {
    if (x < 0) x = 0; else if (x > 1) x = 1;
    let s = 3; { let lo = 3, hi = nb; // span in [3, nb-1]
      if (x >= t[nb]) s = nb - 1; else { while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (x < t[mid]) hi = mid; else lo = mid; } s = lo; } }
    // Cox-de Boor (NURBS book A2.2) for degree 2 and 3
    const left = out._l || (out._l = new Float64Array(4)), right = out._r || (out._r = new Float64Array(4));
    const N2 = out._n2 || (out._n2 = new Float64Array(3)); const Nn = out.N || (out.N = new Float64Array(4)); const D = out.D || (out.D = new Float64Array(4));
    const ndu = out._ndu || (out._ndu = new Float64Array(4));
    ndu[0] = 1;
    for (let j = 1; j <= 3; j++) {
      left[j] = x - t[s + 1 - j]; right[j] = t[s + j] - x; let saved = 0;
      for (let r = 0; r < j; r++) { const den = right[r + 1] + left[j - r]; const tmp = den ? ndu[r] / den : 0; ndu[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp; }
      ndu[j] = saved;
      if (j === 2) { N2[0] = ndu[0]; N2[1] = ndu[1]; N2[2] = ndu[2]; }
    }
    for (let i = 0; i < 4; i++) Nn[i] = ndu[i];
    // derivative: N'_{i,3} = 3 (N_{i,2}/(t_{i+3}-t_i) - N_{i+1,2}/(t_{i+4}-t_{i+1}))  for i = s-3..s; N2 holds N_{s-2..s,2}
    for (let a = 0; a < 4; a++) {
      const i = s - 3 + a; const n2a = a - 1 >= 0 ? N2[a - 1] : 0, n2b = a <= 2 ? N2[a] : 0;
      const d1 = t[i + 3] - t[i], d2 = t[i + 4] - t[i + 1];
      D[a] = 3 * ((d1 ? n2a / d1 : 0) - (d2 ? n2b / d2 : 0));
    }
    out.s = s - 3; return out;
  }
  // tensor-product surface. C: Float64Array (nu*nv*3), index (i*nv+j)*3
  function makeSurf(nu, nv, C) {
    const tu = knots(nu), tv = knots(nv); const bu = {}, bv = {};
    function ev(u, v, o) {
      basis3(tu, nu, u, bu); basis3(tv, nv, v, bv);
      let x = 0, y = 0, z = 0, xu = 0, yu = 0, zu = 0, xv = 0, yv = 0, zv = 0;
      for (let a = 0; a < 4; a++) { const Na = bu.N[a], Da = bu.D[a]; const ri = (bu.s + a) * nv + bv.s;
        for (let b = 0; b < 4; b++) { const k = (ri + b) * 3, Nb = bv.N[b], Db = bv.D[b]; const cx = C[k], cy = C[k + 1], cz = C[k + 2];
          const w = Na * Nb, wu = Da * Nb, wv = Na * Db; x += w * cx; y += w * cy; z += w * cz; xu += wu * cx; yu += wu * cy; zu += wu * cz; xv += wv * cx; yv += wv * cy; zv += wv * cz; } }
      o[0] = x; o[1] = y; o[2] = z; o[3] = xu; o[4] = yu; o[5] = zu; o[6] = xv; o[7] = yv; o[8] = zv; return o;
    }
    return { nu, nv, tu, tv, C, ev, bu, bv };
  }
  // point projection (Newton steps, step <= 0.1, clipped) -- mirrors bspline.py project()
  function project(S, X, UV, iters) {
    const o = new Float64Array(9); const n = UV.length / 2;
    for (let p = 0; p < n; p++) {
      let u = UV[2 * p], v = UV[2 * p + 1]; const px = X[3 * p], py = X[3 * p + 1], pz = X[3 * p + 2];
      for (let it = 0; it < iters; it++) {
        S.ev(u, v, o); const rx = px - o[0], ry = py - o[1], rz = pz - o[2];
        const a = o[3] * o[3] + o[4] * o[4] + o[5] * o[5], bb = o[3] * o[6] + o[4] * o[7] + o[5] * o[8], c = o[6] * o[6] + o[7] * o[7] + o[8] * o[8];
        const e = o[3] * rx + o[4] * ry + o[5] * rz, f = o[6] * rx + o[7] * ry + o[8] * rz;
        let det = a * c - bb * bb; if (Math.abs(det) < 1e-12) det = 1e-12;
        const du = (c * e - bb * f) / det, dv = (a * f - bb * e) / det;
        const st = Math.max(Math.hypot(du, dv), 1e-12), sc = Math.min(1, 0.1 / st);
        u = Math.min(1, Math.max(0, u + du * sc)); v = Math.min(1, Math.max(0, v + dv * sc));
      }
      UV[2 * p] = u; UV[2 * p + 1] = v;
    }
    return UV;
  }
  // deviation stats of points X (flat) against S at UV, with optional per-point normals N (flat)
  function deviation(S, X, UV, N) {
    const o = new Float64Array(9); const n = UV.length / 2; let mx = 0, ss = 0, amax = 0, dsum = 0; const dev = new Float64Array(n);
    for (let p = 0; p < n; p++) {
      S.ev(UV[2 * p], UV[2 * p + 1], o); const d = Math.hypot(X[3 * p] - o[0], X[3 * p + 1] - o[1], X[3 * p + 2] - o[2]); dev[p] = d; if (d > mx) mx = d; ss += d * d;
      if (N) { const nx = o[4] * o[8] - o[5] * o[7], ny = o[5] * o[6] - o[3] * o[8], nz = o[3] * o[7] - o[4] * o[6]; const l = Math.hypot(nx, ny, nz) || 1;
        const dt = (nx * N[3 * p] + ny * N[3 * p + 1] + nz * N[3 * p + 2]) / l; dsum += dt; const ang = Math.acos(Math.min(1, Math.abs(dt))) * 180 / Math.PI; if (ang > amax) amax = ang; }
    }
    return { maxdev: mx, rms: Math.sqrt(ss / Math.max(1, n)), angmax: amax, flip: N ? dsum / Math.max(1, n) < 0 : false, dev };
  }
  // accumulate weighted LSQ normal equations for the tensor-product fit
  function lsqAccumulate(nu, nv, UV, X, W, M, RHS, tu, tv) {
    const n = nu * nv; const bu = {}, bv = {}; const idx = new Int32Array(16), cf = new Float64Array(16); let fro = 0;
    const np = UV.length / 2;
    for (let p = 0; p < np; p++) {
      basis3(tu, nu, UV[2 * p], bu); basis3(tv, nv, UV[2 * p + 1], bv); const w = W ? W[p] : 1;
      let q = 0; for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) { idx[q] = (bu.s + a) * nv + bv.s + b; cf[q] = w * bu.N[a] * bv.N[b]; fro += cf[q] * cf[q]; q++; }
      const x = w * X[3 * p], y = w * X[3 * p + 1], z = w * X[3 * p + 2];
      for (let i = 0; i < 16; i++) { const ci = cf[i]; if (!ci) continue; const ri = idx[i] * n; for (let j = 0; j < 16; j++) M[ri + idx[j]] += ci * cf[j]; const r3 = idx[i] * 3; RHS[r3] += ci * x; RHS[r3 + 1] += ci * y; RHS[r3 + 2] += ci * z; }
    }
    return fro;
  }
  function addSecondDiff(nu, nv, M, s2) {
    const n = nu * nv; let cnt = 0; const st = (a, b, c) => { const ix = [a, b, c], w = [1, -2, 1]; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[ix[i] * n + ix[j]] += s2 * w[i] * w[j]; };
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      if (i > 0 && i < nu - 1) { if (M) st((i - 1) * nv + j, i * nv + j, (i + 1) * nv + j); cnt++; }
      if (j > 0 && j < nv - 1) { if (M) st(i * nv + j - 1, i * nv + j, i * nv + j + 1); cnt++; }
    }
    return cnt;
  }
  // 1D cubic B-spline basis matrix rows for x (array) -> for normal equations in 1D fits
  function fit1D(t, nb, xs, Y, dim, ridge) {
    const M = new Float64Array(nb * nb), R = new Float64Array(nb * dim); const o = {};
    for (let p = 0; p < xs.length; p++) { basis3(t, nb, xs[p], o); for (let a = 0; a < 4; a++) { const ia = o.s + a, na = o.N[a]; if (!na) continue; for (let b = 0; b < 4; b++) M[ia * nb + o.s + b] += na * o.N[b]; for (let d = 0; d < dim; d++) R[ia * dim + d] += na * Y[p * dim + d]; } }
    if (ridge) for (let i = 0; i < nb; i++) M[i * nb + i] += ridge;
    return cholSolve(M, nb, R, dim);
  }
  // binary heap
  class Heap { constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) { const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val); while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; } k[i] = key; v[i] = val; }
    pop() { const k = this.k, v = this.v; const top = v[0], tk = k[0]; const lk = k.pop(), lv = v.pop(); const n = k.length; if (n) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; } k[i] = lk; v[i] = lv; } return [tk, top]; } }
  // bounded scalar minimisation (Brent / fminbound, as scipy's 'bounded')
  function fminbound(f, a, b, xatol, maxit) {
    xatol = xatol || 1e-5; maxit = maxit || 500; const gr = (3 - Math.sqrt(5)) / 2; const sqeps = Math.sqrt(2.2e-16);
    let fulc = a + gr * (b - a), nfc = fulc, xf = fulc, rat = 0, e = 0; let x = xf, fx = f(x), fu; let ffulc = fx, fnfc = fx;
    let xm = 0.5 * (a + b), tol1 = sqeps * Math.abs(xf) + xatol / 3, tol2 = 2 * tol1;
    for (let it = 0; it < maxit && Math.abs(xf - xm) > (tol2 - 0.5 * (b - a)); it++) {
      let golden = true;
      if (Math.abs(e) > tol1) { golden = false; let r = (xf - nfc) * (fx - ffulc), q = (xf - fulc) * (fx - fnfc), p = (xf - fulc) * q - (xf - nfc) * r; q = 2 * (q - r); if (q > 0) p = -p; q = Math.abs(q); r = e; e = rat;
        if (Math.abs(p) < Math.abs(0.5 * q * r) && p > q * (a - xf) && p < q * (b - xf)) { rat = p / q; x = xf + rat; if ((x - a) < tol2 || (b - x) < tol2) rat = tol1 * (xm - xf >= 0 ? 1 : -1); } else golden = true; }
      if (golden) { e = xf >= xm ? a - xf : b - xf; rat = gr * e; }
      x = xf + (rat >= 0 ? 1 : -1) * Math.max(Math.abs(rat), tol1); fu = f(x);
      if (fu <= fx) { if (x >= xf) a = xf; else b = xf; fulc = nfc; ffulc = fnfc; nfc = xf; fnfc = fx; xf = x; fx = fu; }
      else { if (x < xf) a = x; else b = x; if (fu <= fnfc || nfc === xf) { fulc = nfc; ffulc = fnfc; nfc = x; fnfc = fu; } else if (fu <= ffulc || fulc === xf || fulc === nfc) { fulc = x; ffulc = fu; } }
      xm = 0.5 * (a + b); tol1 = sqeps * Math.abs(xf) + xatol / 3; tol2 = 2 * tol1;
    }
    return { x: xf, fun: fx };
  }
  // Levenberg-Marquardt with forward-difference Jacobian. res(x) -> Float64Array
  function levmar(res, x0, maxNfev) {
    maxNfev = maxNfev || 200; let x = Float64Array.from(x0); const n = x.length; let r = res(x); let nfev = 1; let cost = 0; for (const v of r) cost += v * v;
    let mu = -1; const m = r.length;
    while (nfev < maxNfev) {
      const J = []; for (let j = 0; j < n; j++) { const h = 1.49e-8 * Math.max(Math.abs(x[j]), 1e-3); const xs = Float64Array.from(x); xs[j] += h; const r2 = res(xs); nfev++; const col = new Float64Array(m); for (let i = 0; i < m; i++) col[i] = (r2[i] - r[i]) / h; J.push(col); }
      const JTJ = new Float64Array(n * n), g = new Float64Array(n);
      for (let a = 0; a < n; a++) { const ca = J[a]; let s = 0; for (let i = 0; i < m; i++) s += ca[i] * r[i]; g[a] = s; for (let b = a; b < n; b++) { const cb = J[b]; let t = 0; for (let i = 0; i < m; i++) t += ca[i] * cb[i]; JTJ[a * n + b] = JTJ[b * n + a] = t; } }
      if (mu < 0) { let md = 0; for (let a = 0; a < n; a++) md = Math.max(md, JTJ[a * n + a]); mu = 1e-3 * md; }
      let improved = false;
      for (let tr = 0; tr < 12 && nfev < maxNfev; tr++) {
        const A = new Float64Array(JTJ); for (let a = 0; a < n; a++) A[a * n + a] += mu * Math.max(JTJ[a * n + a], 1e-12);
        const d = cholSolve(A, n, Float64Array.from(g, v => -v), 1); if (!d) { mu *= 10; continue; }
        const xn = Float64Array.from(x, (v, i) => v + d[i]); const rn = res(xn); nfev++; let cn = 0; for (const v of rn) cn += v * v;
        if (isFinite(cn) && cn < cost) { const rel = (cost - cn) / Math.max(cost, 1e-300); x = xn; r = rn; cost = cn; mu = Math.max(mu / 3, 1e-15); improved = true; if (rel < 1e-15) return x; break; }
        mu *= 4;
      }
      if (!improved) break;
    }
    return x;
  }
  const api = { sub, add, mul, dot, cross, norm, unit, eigSym3, inv3, lstsq, cholSolve, cgSolve, knots, basis3, makeSurf, project, deviation, lsqAccumulate, addSecondDiff, fit1D, Heap, fminbound, levmar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PDF3DFitLA = api;
})(typeof self !== 'undefined' ? self : this);
