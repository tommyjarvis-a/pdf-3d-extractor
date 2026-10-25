/**
 * viewer-gl.js - WebGL2 (WebGL1 fallback) preview renderer for the 3D PDF -> CAD Geometry Extractor.
 * Dependency-free. Replaces the Canvas 2D painter's-algorithm preview, which popped/striped on dense
 * meshes (per-triangle depth sort, per-triangle antialias seams, no depth test for wires/edges).
 *
 *   const v = PDF3DViewerGL.attach(canvas)  -> viewer | null (null: no WebGL, use the Canvas 2D fallback)
 *   v.render(scene)   schedule one frame (render on demand, coalesced into requestAnimationFrame)
 *   v.dispose()       free every GPU buffer (called automatically when scene.epoch changes = new file)
 *
 * scene = { epoch, center:[x,y,z], radius, camera:{mode,q,yaw,pitch,zoom,panX,panY}, renderMode, selectedPartIdx,
 *           items:[{ g:{vx,tv,nt,triFace,fev}, pIdx, color:[r,g,b], offset:[x,y,z] }], wires:[...],
 *           palette:[[r,g,b]x6], grid:{z,step,extent}, note:string }
 * Camera: orthographic, view basis from window.PDF3DCamera (free quaternion arcball by default, or the legacy
 * Z-up turntable); the canvas fallback uses the same basis so both renderers match exactly.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const OPTIONS = { wires: false, hiddenLines: false, meshWire: false, flat: false, creaseDeg: 30 };
  const MAX_TRIS = 2000000;          // preview cap in WebGL mode (GPU does the work; protects memory)
  const MAX_EDGES = 4000000;
  const GPU_BUDGET = 900 * 1024 * 1024; // free LRU-unused buffers beyond this
  const LINE_DEPTH_BIAS = 3e-4;          // NDC z bias for edges/wires (depth range spans ~2.1 x radius)
  const THICK_LINE_MAX_SEGS = 400000;   // above this a line set is drawn as 1px GL_LINES

  // ------------------------------------------------------------------ geometry preparation (CPU)
  // Split welded vertices by crease angle (and B-Rep face group) -> per-vertex smooth normals.
  // Inconsistent winding is handled: neighbours whose normals are opposite (|dot| >= cos) are smoothed
  // sign-aligned and get their own vertex carrying the normal in *their* winding, so gl_FrontFacing works.
  function buildFillMesh(g, flat, creaseDeg) {
    const vx = g.vx, tv = g.tv, nt = g.nt, nv = (vx.length / 3) | 0, tf = g.triFace;
    let ox = 0, oy = 0, oz = 0;
    { let a = Infinity, b = Infinity, c = Infinity, A = -Infinity, B = -Infinity, C = -Infinity;
      for (let i = 0; i < nv; i++) { const x = vx[3 * i], y = vx[3 * i + 1], z = vx[3 * i + 2];
        if (x < a) a = x; if (x > A) A = x; if (y < b) b = y; if (y > B) B = y; if (z < c) c = z; if (z > C) C = z; }
      if (nv) { ox = (a + A) / 2; oy = (b + B) / 2; oz = (c + C) / 2; } }
    // face normals: area-weighted (fn) and unit (fu)
    const fn = new Float32Array(nt * 3), fu = new Float32Array(nt * 3);
    for (let t = 0; t < nt; t++) {
      const a3 = 3 * tv[3 * t], b3 = 3 * tv[3 * t + 1], c3 = 3 * tv[3 * t + 2];
      const ux = vx[b3] - vx[a3], uy = vx[b3 + 1] - vx[a3 + 1], uz = vx[b3 + 2] - vx[a3 + 2];
      const wx = vx[c3] - vx[a3], wy = vx[c3 + 1] - vx[a3 + 1], wz = vx[c3 + 2] - vx[a3 + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      fn[3 * t] = nx; fn[3 * t + 1] = ny; fn[3 * t + 2] = nz;
      if (l > 0) { fu[3 * t] = nx / l; fu[3 * t + 1] = ny / l; fu[3 * t + 2] = nz / l; }
    }
    const faceOf = (t) => (tf ? (((tf[t] % 6) + 6) % 6) : 0);
    if (flat) {
      const n = nt * 3, P = new Float32Array(n * 3), N = new Int16Array(n * 4), F = new Uint8Array(n);
      for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
        const o = 3 * t + k, v = tv[o];
        P[3 * o] = vx[3 * v] - ox; P[3 * o + 1] = vx[3 * v + 1] - oy; P[3 * o + 2] = vx[3 * v + 2] - oz;
        N[4 * o] = fu[3 * t] * 32767; N[4 * o + 1] = fu[3 * t + 1] * 32767; N[4 * o + 2] = fu[3 * t + 2] * 32767;
        F[o] = faceOf(t);
      }
      const I = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) I[i] = i;
      return { origin: [ox, oy, oz], pos: P, nrm: N, face: F, idx: I, nVerts: n };
    }
    const cosT = Math.cos((creaseDeg || 30) * Math.PI / 180);
    // CSR vertex -> incident corners
    const cnt = new Uint32Array(nv + 1);
    for (let i = 0; i < nt * 3; i++) cnt[tv[i] + 1]++;
    for (let v = 0; v < nv; v++) cnt[v + 1] += cnt[v];
    const fill = cnt.slice(0, nv), corners = new Uint32Array(nt * 3);
    for (let i = 0; i < nt * 3; i++) corners[fill[tv[i]]++] = i;
    const outIdx = new Uint32Array(nt * 3);
    let P = new Float32Array(Math.max(16, nv * 3 * 2)), N = new Int16Array(Math.max(16, nv * 4 * 2)), F = new Uint8Array(Math.max(16, nv * 2));
    let nOut = 0;
    const grow = () => {
      const cap = Math.max(16, F.length * 2);
      const P2 = new Float32Array(cap * 3); P2.set(P); P = P2;
      const N2 = new Int16Array(cap * 4); N2.set(N); N = N2;
      const F2 = new Uint8Array(cap); F2.set(F); F = F2;
    };
    // scratch for clusters of one vertex
    const MAXC = 64;
    const cS = new Float32Array(MAXC * 3), cA = new Float64Array(MAXC * 3), cF = new Int32Array(MAXC);
    const cOut = new Int32Array(MAXC * 2);
    let cornerC = new Int32Array(64), cornerS = new Int8Array(64);
    for (let v = 0; v < nv; v++) {
      const s0 = cnt[v], s1 = cnt[v + 1], deg = s1 - s0;
      if (!deg) continue;
      if (deg > cornerC.length) { cornerC = new Int32Array(deg * 2); cornerS = new Int8Array(deg * 2); }
      let nc = 0;
      for (let k = 0; k < deg; k++) {
        const corner = corners[s0 + k], t = (corner / 3) | 0, f = faceOf(t);
        const nx = fu[3 * t], ny = fu[3 * t + 1], nz = fu[3 * t + 2];
        const degen = nx === 0 && ny === 0 && nz === 0;
        let j = -1, s = 1;
        for (let c = 0; c < nc; c++) {
          if (cF[c] !== f) continue;
          if (degen) { j = c; break; }
          const d = cS[3 * c] * nx + cS[3 * c + 1] * ny + cS[3 * c + 2] * nz;
          if (d >= cosT) { j = c; s = 1; break; }
          if (-d >= cosT) { j = c; s = -1; break; }
        }
        if (j < 0) {
          if (nc < MAXC) { j = nc++; cS[3 * j] = nx; cS[3 * j + 1] = ny; cS[3 * j + 2] = nz; cF[j] = f;
            cA[3 * j] = 0; cA[3 * j + 1] = 0; cA[3 * j + 2] = 0; cOut[2 * j] = -1; cOut[2 * j + 1] = -1; }
          else { j = -2 - t; } // too many clusters: flat corner
        }
        if (j >= 0) { cA[3 * j] += s * fn[3 * t]; cA[3 * j + 1] += s * fn[3 * t + 1]; cA[3 * j + 2] += s * fn[3 * t + 2]; }
        cornerC[k] = j; cornerS[k] = s;
      }
      const px = vx[3 * v] - ox, py = vx[3 * v + 1] - oy, pz = vx[3 * v + 2] - oz;
      for (let k = 0; k < deg; k++) {
        const corner = corners[s0 + k], j = cornerC[k], s = cornerS[k];
        let id;
        if (j >= 0 && cOut[2 * j + (s < 0 ? 1 : 0)] >= 0) id = cOut[2 * j + (s < 0 ? 1 : 0)];
        else {
          if (nOut >= F.length) grow();
          id = nOut++;
          P[3 * id] = px; P[3 * id + 1] = py; P[3 * id + 2] = pz;
          let nx, ny, nz, f;
          if (j >= 0) { nx = cA[3 * j] * s; ny = cA[3 * j + 1] * s; nz = cA[3 * j + 2] * s; f = cF[j]; cOut[2 * j + (s < 0 ? 1 : 0)] = id; }
          else { const t = -2 - j; nx = fu[3 * t]; ny = fu[3 * t + 1]; nz = fu[3 * t + 2]; f = faceOf(t); }
          const l = Math.hypot(nx, ny, nz) || 1;
          N[4 * id] = Math.round(nx / l * 32767); N[4 * id + 1] = Math.round(ny / l * 32767); N[4 * id + 2] = Math.round(nz / l * 32767);
          F[id] = f;
        }
        outIdx[corner] = id;
      }
    }
    const idx = nOut > 65535 ? outIdx : Uint16Array.from(outIdx);
    return { origin: [ox, oy, oz], pos: P.slice(0, nOut * 3), nrm: N.slice(0, nOut * 4), face: F.slice(0, nOut), idx, nVerts: nOut };
  }

  function basePositions(vx, origin) {
    const n = vx.length, P = new Float32Array(n);
    for (let i = 0; i < n; i += 3) { P[i] = vx[i] - origin[0]; P[i + 1] = vx[i + 1] - origin[1]; P[i + 2] = vx[i + 2] - origin[2]; }
    return P;
  }
  function meshLineIndex(tv, nt) {
    const L = new Uint32Array(nt * 6);
    for (let t = 0; t < nt; t++) {
      const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2], o = 6 * t;
      L[o] = a; L[o + 1] = b; L[o + 2] = b; L[o + 3] = c; L[o + 4] = c; L[o + 5] = a;
    }
    return L;
  }
  // Segment list (pairs into P) -> screen-space-expanded quads: 4 verts/segment (A, B, side).
  function thickLines(P, pairs, nSeg) {
    const A = new Float32Array(nSeg * 12), B = new Float32Array(nSeg * 12), S = new Int8Array(nSeg * 8);
    for (let s = 0; s < nSeg; s++) {
      const u = 3 * pairs[2 * s], v = 3 * pairs[2 * s + 1];
      for (let k = 0; k < 4; k++) {
        const o = 12 * s + 3 * k;
        A[o] = P[u]; A[o + 1] = P[u + 1]; A[o + 2] = P[u + 2];
        B[o] = P[v]; B[o + 1] = P[v + 1]; B[o + 2] = P[v + 2];
      }
      const o = 8 * s; // (t, side): (0,-1) (0,1) (1,-1) (1,1)
      S[o] = 0; S[o + 1] = -1; S[o + 2] = 0; S[o + 3] = 1; S[o + 4] = 1; S[o + 5] = -1; S[o + 6] = 1; S[o + 7] = 1;
    }
    const n = nSeg * 6, I = nSeg * 4 > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let s = 0; s < nSeg; s++) {
      const b = 4 * s, o = 6 * s;
      I[o] = b; I[o + 1] = b + 1; I[o + 2] = b + 2; I[o + 3] = b + 2; I[o + 4] = b + 1; I[o + 5] = b + 3;
    }
    return { A, B, S, I, nVerts: nSeg * 4 };
  }

  // ------------------------------------------------------------------ shaders (GLSL ES 1.00: WebGL1 + WebGL2)
  const VS_FILL = `
attribute vec3 aPos; attribute vec4 aNrm; attribute float aFace;
uniform mat4 uMVP; uniform mat3 uNM; uniform vec3 uOff; uniform vec3 uPal[6]; uniform float uFaceShift; uniform float uUsePal;
uniform vec3 uColor;
varying vec3 vN; varying vec3 vCol;
void main() {
  gl_Position = uMVP * vec4(aPos + uOff, 1.0);
  vN = uNM * aNrm.xyz;
  vec3 c = uColor;
  if (uUsePal > 0.5) {
    int k = int(mod(aFace + uFaceShift, 6.0) + 0.5);
    for (int i = 0; i < 6; i++) { if (i == k) c = uPal[i]; }
  }
  vCol = c;
}`;
  const FS_FILL = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 vN; varying vec3 vCol;
uniform vec3 uSelAdd; uniform float uAlpha;
void main() {
  vec3 n = vN; float l = length(n);
  n = l > 1e-6 ? n / l : vec3(0.0, 0.0, 1.0);
  if (!gl_FrontFacing) n = -n;
  float key = max(0.0, dot(n, vec3(0.45, 0.70, 0.55)));
  float fill = max(0.0, dot(n, vec3(-0.40, 0.35, -0.30)));
  float head = max(0.0, n.z);
  vec3 h = normalize(vec3(0.45, 0.70, 0.55) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(0.0, dot(n, h)), 48.0) * 0.18;
  float shade = 0.24 + 0.56 * key + 0.20 * fill + 0.16 * head;
  vec3 c = min(vec3(1.0), vCol * shade + spec) + uSelAdd;
  gl_FragColor = vec4(min(c, vec3(1.0)), uAlpha);
}`;
  const VS_LINE = `
attribute vec3 aPos;
uniform mat4 uMVP; uniform vec3 uOff; uniform float uBias;
void main() { gl_Position = uMVP * vec4(aPos + uOff, 1.0); gl_Position.z -= uBias; }`;
  const VS_THICK = `
attribute vec3 aA; attribute vec3 aB; attribute vec2 aS;
uniform mat4 uMVP; uniform vec3 uOff; uniform vec2 uVP; uniform float uHalfW; uniform float uBias;
void main() {
  vec4 a = uMVP * vec4(aA + uOff, 1.0), b = uMVP * vec4(aB + uOff, 1.0);
  vec2 d = (b.xy - a.xy) * uVP; float l = length(d);
  d = l > 1e-6 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-d.y, d.x);
  vec4 p = aS.x > 0.5 ? b : a;
  p.xy += (nrm * aS.y * uHalfW + d * (aS.x > 0.5 ? 1.0 : -1.0) * uHalfW * 0.5) / uVP;
  p.z -= uBias;   // small depth bias toward the viewer (on top of the fill polygonOffset): no edge shimmer
  gl_Position = p;
}`;
  const FS_LINE = `
precision mediump float;
uniform vec4 uRGBA;
void main() { gl_FragColor = uRGBA; }`;

  function compile(gl, vs, fs) {
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error('shader: ' + gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error('link: ' + gl.getProgramInfoLog(p));
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0, u = {}, a = {};
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const nm = info.name.replace(/\[0\]$/, ''); u[nm] = gl.getUniformLocation(p, info.name); }
    const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES) || 0;
    for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
    return { p, u, a };
  }

  // ------------------------------------------------------------------ viewer
  function attach(canvas) {
    if (!canvas || canvas.__pdf3dGL !== undefined) return canvas ? canvas.__pdf3dGL : null;
    try { if (new URLSearchParams(window.location.search || '').get('gl') === '0') { canvas.__pdf3dGL = null; return null; } } catch (e) { /* ignore */ }
    const attrs = { depth: true, antialias: true, alpha: true, premultipliedAlpha: true, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
    let gl = null, isGL2 = false;
    try { gl = canvas.getContext('webgl2', attrs); isGL2 = !!gl; } catch (e) { gl = null; }
    if (!gl) { try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch (e) { gl = null; } }
    if (!gl) { canvas.__pdf3dGL = null; return null; }
    const v = new Viewer(canvas, gl, isGL2);
    try { v._init(); } catch (e) { console.warn('[viewer-gl] init failed, using Canvas 2D fallback', e); canvas.__pdf3dGL = null; return null; }
    canvas.__pdf3dGL = v;
    return v;
  }

  function Viewer(canvas, gl, isGL2) {
    this.canvas = canvas; this.gl = gl; this.isGL2 = isGL2;
    this.cache = new Map();    // key object -> entry {bytes, bufs:[], lastUse}
    this.wireCache = new Map();
    this.scene = null; this.pending = false; this.lost = false; this.frame = 0; this.epoch = undefined;
    this.overlay = null; this.stats = {};
    canvas.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); this.lost = true; this.cache.clear(); this.wireCache.clear(); this.gridBuf = null; });
    canvas.addEventListener('webglcontextrestored', () => { try { this._init(); this.lost = false; this.render(this.scene); } catch (e) { console.error(e); } });
    if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
      this._ro = new ResizeObserver(() => { if (this.scene) this.render(this.scene); });
      this._ro.observe(canvas.parentElement);
    }
  }
  const VP = Viewer.prototype;

  VP._init = function () {
    const gl = this.gl;
    this.uint = this.isGL2 || !!gl.getExtension('OES_element_index_uint');
    this.progFill = compile(gl, VS_FILL, FS_FILL);
    this.progLine = compile(gl, VS_LINE, FS_LINE);
    this.progThick = compile(gl, VS_THICK, FS_LINE);
    this.depthBits = gl.getParameter(gl.DEPTH_BITS);
    this.gridBuf = null;
    if (this.isGL2) this.vao = gl.createVertexArray();
  };

  VP.render = function (scene) {
    if (!scene) return;
    this.scene = scene;
    if (this.pending) return;
    this.pending = true;
    const raf = window.requestAnimationFrame || ((f) => setTimeout(f, 16));
    raf(() => { this.pending = false; try { this._draw(); } catch (e) { console.error('[viewer-gl] draw failed', e); } });
  };

  VP.dispose = function () {
    const gl = this.gl;
    const del = (e) => { for (const b of e.bufs) gl.deleteBuffer(b); };
    if (!this.lost) { for (const e of this.cache.values()) del(e); for (const e of this.wireCache.values()) del(e); }
    this.cache.clear(); this.wireCache.clear();
  };

  // Upload attribute arrays + index; if the index needs 32 bits and the context can't, de-index.
  VP._upload = function (attrs, idx, nVerts) {
    const gl = this.gl, bufs = []; let bytes = 0;
    let indexed = true;
    if (idx instanceof Uint32Array && !this.uint) {
      if (nVerts <= 65535) idx = Uint16Array.from(idx);
      else {
        indexed = false;
        attrs = attrs.map((a) => {
          const comp = a.data.length / nVerts, out = new a.data.constructor(idx.length * comp);
          for (let i = 0; i < idx.length; i++) { const s = idx[i] * comp, d = i * comp; for (let c = 0; c < comp; c++) out[d + c] = a.data[s + c]; }
          return Object.assign({}, a, { data: out });
        });
      }
    }
    const out = { attrs: [], count: idx.length, indexed, bufs };
    for (const a of attrs) {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a.data, gl.STATIC_DRAW);
      bufs.push(b); bytes += a.data.byteLength;
      out.attrs.push({ name: a.name, buf: b, size: a.size, type: a.type, norm: !!a.norm });
    }
    if (indexed) {
      const b = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      bufs.push(b); bytes += idx.byteLength; out.ibuf = b; out.itype = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    }
    out.bytes = bytes;
    return out;
  };

  VP._bindDraw = function (prog, obj, mode) {
    const gl = this.gl, used = [];
    for (const a of obj.attrs) {
      const loc = prog.a[a.name]; if (loc === undefined || loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buf); gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, a.size, a.type, a.norm, 0, 0); used.push(loc);
    }
    if (obj.indexed) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, obj.ibuf); gl.drawElements(mode, obj.count, obj.itype, 0); }
    else gl.drawArrays(mode, 0, obj.count);
    for (const l of used) gl.disableVertexAttribArray(l);
  };

  VP._entry = function (g) {
    let e = this.cache.get(g);
    if (!e) { e = { g, bufs: [], bytes: 0, origin: null }; this.cache.set(g, e); }
    e.lastUse = this.frame;
    return e;
  };
  VP._track = function (e, obj) { e.bufs.push(...obj.bufs); e.bytes += obj.bytes; return obj; };
  VP._fill = function (e) {
    const flat = !!OPTIONS.flat, key = flat ? 'fillFlat' : 'fill';
    if (!e[key]) {
      const gl = this.gl, m = buildFillMesh(e.g, flat, OPTIONS.creaseDeg);
      if (!e.origin) e.origin = m.origin;
      e[key] = this._track(e, this._upload([
        { name: 'aPos', data: m.pos, size: 3, type: gl.FLOAT },
        { name: 'aNrm', data: m.nrm, size: 4, type: gl.SHORT, norm: true },
        { name: 'aFace', data: m.face, size: 1, type: gl.UNSIGNED_BYTE }], m.idx, m.nVerts));
    }
    return e[key];
  };
  VP._basePos = function (e) {
    if (!e.base) { if (!e.origin) this._fill(e); e.base = basePositions(e.g.vx, e.origin); }
    return e.base;
  };
  VP._lineSet = function (P, pairs, nSeg, thick) {
    const gl = this.gl;
    if (thick && nSeg <= THICK_LINE_MAX_SEGS) {
      const q = thickLines(P, pairs, nSeg);
      const o = this._upload([{ name: 'aA', data: q.A, size: 3, type: gl.FLOAT }, { name: 'aB', data: q.B, size: 3, type: gl.FLOAT },
        { name: 'aS', data: q.S, size: 2, type: gl.BYTE }], q.I, q.nVerts);
      o.thick = true; return o;
    }
    const nv = P.length / 3;
    const idx = nv > 65535 ? (pairs instanceof Uint32Array ? pairs : Uint32Array.from(pairs)) : Uint16Array.from(pairs);
    const o = this._upload([{ name: 'aPos', data: P, size: 3, type: gl.FLOAT }], idx, nv);
    o.thick = false; return o;
  };
  VP._edges = function (e) {
    if (e.edges === undefined) {
      const fev = e.g.fev;
      e.edges = fev && fev.length ? this._track(e, this._lineSet(this._basePos(e), fev, fev.length / 2, true)) : null;
    }
    return e.edges;
  };
  VP._meshLines = function (e) {
    if (!e.mesh) e.mesh = this._track(e, this._lineSet(this._basePos(e), meshLineIndex(e.g.tv, e.g.nt), e.g.nt * 3, false));
    return e.mesh;
  };
  VP._wire = function (wr) {
    let e = this.wireCache.get(wr);
    if (!e) {
      const pos = wr.positions || [], n = pos.length;
      let a = Infinity, b = Infinity, c = Infinity, A = -Infinity, B = -Infinity, C = -Infinity;
      for (const q of pos) { if (!q) continue; if (q[0] < a) a = q[0]; if (q[0] > A) A = q[0]; if (q[1] < b) b = q[1]; if (q[1] > B) B = q[1]; if (q[2] < c) c = q[2]; if (q[2] > C) C = q[2]; }
      const origin = isFinite(a) ? [(a + A) / 2, (b + B) / 2, (c + C) / 2] : [0, 0, 0];
      const P = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const q = pos[i]; if (!q) continue; P[3 * i] = q[0] - origin[0]; P[3 * i + 1] = q[1] - origin[1]; P[3 * i + 2] = q[2] - origin[2]; }
      const pairs = [];
      for (const pl of wr.polylines || []) for (let k = 1; k < pl.length; k++) { if (pos[pl[k - 1]] && pos[pl[k]]) pairs.push(pl[k - 1], pl[k]); }
      e = { bufs: [], bytes: 0, origin, bbox: isFinite(a) ? [a, b, c, A, B, C] : null, lines: null };
      if (pairs.length) e.lines = this._track(e, this._lineSet(P, Uint32Array.from(pairs), pairs.length / 2, true));
      this.wireCache.set(wr, e);
    }
    e.lastUse = this.frame;
    return e;
  };

  VP._gc = function () {
    let total = 0; for (const e of this.cache.values()) total += e.bytes; for (const e of this.wireCache.values()) total += e.bytes;
    this.stats.gpuBytes = total;
    if (total <= GPU_BUDGET) return;
    const all = [...this.cache.entries()].map(([k, e]) => [this.cache, k, e]).concat([...this.wireCache.entries()].map(([k, e]) => [this.wireCache, k, e]))
      .filter((x) => x[2].lastUse !== this.frame).sort((x, y) => x[2].lastUse - y[2].lastUse);
    for (const [m, k, e] of all) { if (total <= GPU_BUDGET) break; for (const b of e.bufs) this.gl.deleteBuffer(b); total -= e.bytes; m.delete(k); }
    this.stats.gpuBytes = total;
  };

  VP._draw = function () {
    const s = this.scene, gl = this.gl, canvas = this.canvas;
    if (!s || this.lost || gl.isContextLost()) return;
    if (s.epoch !== this.epoch) { this.dispose(); this.epoch = s.epoch; }
    this.frame++;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const rect = canvas.parentElement ? canvas.parentElement.getBoundingClientRect() : { width: canvas.clientWidth, height: canvas.clientHeight };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.floor(rect.width)), h = Math.max(240, Math.floor(rect.height));
    const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.vao) gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);   // PDF meshes have inconsistent winding: two-sided lighting instead
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const cam = s.camera, C = s.center;
    const B = Camera.basis(cam), R = B.r, U = B.u, D = B.d;
    const scale = (Math.min(w, h) * 0.39) / s.radius * cam.zoom;
    const cxS = w * 0.5 + cam.panX, cyS = h * 0.52 + cam.panY;

    // Tight bounding sphere (around the view center) of everything drawn depth-tested -> near/far.
    let r2 = 0;
    const growBox = (bx, off) => {
      for (let k = 0; k < 8; k++) {
        const x = (k & 1 ? bx[3] : bx[0]) + off[0] - C[0], y = (k & 2 ? bx[4] : bx[1]) + off[1] - C[1], z = (k & 4 ? bx[5] : bx[2]) + off[2] - C[2];
        const d = x * x + y * y + z * z; if (d > r2) r2 = d;
      }
    };
    const items = s.items || [];
    for (const it of items) { const e = this._entry(it.g); if (!e.bbox) e.bbox = bboxOf(it.g.vx); if (e.bbox) growBox(e.bbox, it.offset); }
    const wires = OPTIONS.wires ? (s.wires || []).filter((wr) => wr.visible !== false) : [];
    const wireEntries = wires.map((wr) => [wr, this._wire(wr)]);
    for (const [, we] of wireEntries) if (we.bbox) growBox(we.bbox, [0, 0, 0]);
    const r = Math.max(Math.sqrt(r2), 1e-6);
    const dist = 3 * r;
    const near = Math.max(dist - r * 1.05, r * 0.001), far = dist + r * 1.05;
    const kx = 2 * scale / w, ky = 2 * scale / h, kz = 2 / (far - near);
    const bx = 2 * cxS / w - 1, by = 1 - 2 * cyS / h, bz = kz * (dist - near) - 1;
    // column-major MVP mapping (world - center) -> clip, identical to the legacy projectPoint()
    const M = new Float32Array([
      kx * R[0], ky * U[0], kz * D[0], 0,
      kx * R[1], ky * U[1], kz * D[1], 0,
      kx * R[2], ky * U[2], kz * D[2], 0,
      bx, by, bz, 1]);
    const NM = new Float32Array([R[0], U[0], -D[0], R[1], U[1], -D[1], R[2], U[2], -D[2]]);
    this.stats.near = near; this.stats.far = far; this.stats.radius = r; this.stats.depthBits = this.depthBits;
    const offOf = (origin, off) => [origin[0] + off[0] - C[0], origin[1] + off[1] - C[1], origin[2] + off[2] - C[2]];

    const mode = s.renderMode || 'shaded-edges', sel = s.selectedPartIdx;

    // 1. datum grid (background, not depth tested, like the legacy view)
    if (s.grid) this._drawGrid(s.grid, M, C);

    const pf = this.progFill;
    const useProg = (p) => { gl.useProgram(p.p); gl.uniformMatrix4fv(p.u.uMVP, false, M); };
    // 2. fills
    if (mode !== 'wireframe') {
      useProg(pf);
      gl.uniformMatrix3fv(pf.u.uNM, false, NM);
      const pal = new Float32Array(18); (s.palette || []).slice(0, 6).forEach((c, i) => pal.set(c, 3 * i));
      gl.uniform3fv(pf.u.uPal, pal);
      gl.uniform1f(pf.u.uUsePal, mode === 'brep-faces' ? 1 : 0);
      const xray = mode === 'xray';
      gl.uniform1f(pf.u.uAlpha, xray ? 0.34 : 1);
      if (xray) { gl.disable(gl.DEPTH_TEST); gl.depthMask(false); }
      else { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); }
      // push fills back so coplanar edges/wires win the depth test (no edge/face striping)
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.0, 2.0);
      for (const it of items) {
        const e = this._entry(it.g), f = this._fill(e);
        gl.uniform3fv(pf.u.uOff, offOf(e.origin, it.offset));
        gl.uniform3fv(pf.u.uColor, it.color);
        gl.uniform1f(pf.u.uFaceShift, (it.pIdx * 2) % 6);
        gl.uniform3fv(pf.u.uSelAdd, sel === it.pIdx ? [28 / 255, 38 / 255, 45 / 255] : [0, 0, 0]);
        this._bindDraw(pf, f, gl.TRIANGLES);
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
    }

    // 3. lines: edges, wires, mesh wire. Depth-tested (LEQUAL) against the offset fills; optional dimmed hidden pass.
    const lineJobs = [];
    const nEdge = items.reduce((a, it) => a + (it.g.fev ? it.g.fev.length / 2 : 0), 0);
    if (mode === 'wireframe') {
      for (const it of items) { const e = this._entry(it.g);
        const c = sel === it.pIdx ? [0.133, 0.827, 0.933, 1] : [it.color[0], it.color[1], it.color[2], 0.78];
        lineJobs.push({ obj: this._meshLines(e), off: offOf(e.origin, it.offset), rgba: c, w: 1 }); }
    } else {
      if (OPTIONS.meshWire) for (const it of items) { const e = this._entry(it.g);
        lineJobs.push({ obj: this._meshLines(e), off: offOf(e.origin, it.offset), rgba: [0.05, 0.08, 0.13, 0.35], w: 1 }); }
      if ((mode === 'shaded-edges' || mode === 'brep-faces' || mode === 'xray') && nEdge <= MAX_EDGES) {
        for (const it of items) { const e = this._entry(it.g), ed = this._edges(e); if (!ed) continue;
          const selected = sel === it.pIdx;
          lineJobs.push({ obj: ed, off: offOf(e.origin, it.offset), w: selected ? 1.65 : 1.05,
            rgba: selected ? [0.133, 0.827, 0.933, 1] : mode === 'xray' ? [0.58, 0.82, 1, 0.68] : [0.035, 0.055, 0.09, 0.82] }); }
      }
    }
    for (const [wr, we] of wireEntries) {
      if (!we.lines) continue;
      const c = wr.color || [0, 0, 0];
      const rgba = (c[0] + c[1] + c[2]) * 255 < 60 ? [0.886, 0.91, 0.94, 0.55] : [c[0], c[1], c[2], 1];
      lineJobs.push({ obj: we.lines, off: [we.origin[0] - C[0], we.origin[1] - C[1], we.origin[2] - C[2]], rgba, w: 1 });
    }
    const noDepth = mode === 'wireframe' || mode === 'xray';
    gl.depthMask(false);
    if (noDepth) gl.disable(gl.DEPTH_TEST);
    else if (OPTIONS.hiddenLines) {
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.GREATER);
      for (const j of lineJobs) this._drawLines(j, M, W, H, dpr, 0.22);
    }
    if (!noDepth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); }
    for (const j of lineJobs) this._drawLines(j, M, W, H, dpr, 1);
    gl.depthMask(true); gl.depthFunc(gl.LESS);
    if (this.vao) gl.bindVertexArray(null);
    this._gc();

    // 4. 2D overlay: orientation triad + decimation note
    this._overlay(w, h, dpr, R, U, s.note);
    this.stats.frames = this.frame; this.stats.items = items.length; this.stats.lineJobs = lineJobs.length;
    this.stats.api = this.isGL2 ? 'WebGL2' : 'WebGL1';
    this.stats.drawnTris = items.reduce((a, it) => a + (it.g.nt || (it.g.tv ? it.g.tv.length / 3 : 0)), 0);
    this.stats.cpuMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - t0;
    if (typeof api.onStats === 'function') { try { api.onStats(this.stats); } catch (e) { /* HUD only */ } }
  };

  VP._drawLines = function (j, M, W, H, dpr, alphaMul) {
    const gl = this.gl, o = j.obj, p = o.thick ? this.progThick : this.progLine;
    gl.useProgram(p.p); gl.uniformMatrix4fv(p.u.uMVP, false, M);
    gl.uniform3fv(p.u.uOff, j.off);
    gl.uniform1f(p.u.uBias, LINE_DEPTH_BIAS);
    gl.uniform4f(p.u.uRGBA, j.rgba[0], j.rgba[1], j.rgba[2], j.rgba[3] * alphaMul);
    if (o.thick) { gl.uniform2f(p.u.uVP, W / 2, H / 2); gl.uniform1f(p.u.uHalfW, Math.max(0.5, j.w * dpr * 0.5)); }
    this._bindDraw(p, o, o.thick ? gl.TRIANGLES : gl.LINES);
  };

  VP._drawGrid = function (grid, M, C) {
    const gl = this.gl;
    const key = grid.z + ':' + grid.step + ':' + grid.extent + ':' + C.join(',');
    if (!this.gridBuf || this.gridBuf.key !== key) {
      if (this.gridBuf) for (const b of this.gridBuf.obj.bufs) gl.deleteBuffer(b);
      const pts = [];
      for (let g = -grid.extent; g <= grid.extent; g += grid.step) {
        pts.push(g, -grid.extent, grid.z, g, grid.extent, grid.z, -grid.extent, g, grid.z, grid.extent, g, grid.z);
      }
      const P = new Float32Array(pts.length);
      for (let i = 0; i < pts.length; i += 3) { P[i] = pts[i] - C[0]; P[i + 1] = pts[i + 1] - C[1]; P[i + 2] = pts[i + 2] - C[2]; }
      const idx = new Uint16Array(P.length / 3); for (let i = 0; i < idx.length; i++) idx[i] = i;
      this.gridBuf = { key, obj: this._upload([{ name: 'aPos', data: P, size: 3, type: gl.FLOAT }], idx, idx.length) };
    }
    gl.disable(gl.DEPTH_TEST);
    const p = this.progLine;
    gl.useProgram(p.p); gl.uniformMatrix4fv(p.u.uMVP, false, M); gl.uniform3fv(p.u.uOff, [0, 0, 0]); gl.uniform1f(p.u.uBias, 0);
    gl.uniform4f(p.u.uRGBA, 59 / 255, 130 / 255, 246 / 255, 0.14);
    this._bindDraw(p, this.gridBuf.obj, gl.LINES);
  };

  VP._overlay = function (w, h, dpr, R, U, note) {
    const canvas = this.canvas;
    if (!this.overlay) {
      const o = document.createElement('canvas');
      o.className = 'viewport-overlay';
      o.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';
      canvas.insertAdjacentElement('afterend', o);
      this.overlay = o;
    }
    const o = this.overlay;
    if (o.width !== Math.floor(w * dpr) || o.height !== Math.floor(h * dpr)) { o.width = Math.floor(w * dpr); o.height = Math.floor(h * dpr); }
    const ctx = o.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (note) {
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
      ctx.fillText(note, 12, h - 12);
    }
    const tx = w - 54, ty = h - 48, L = 28;
    const axes = [['X', [1, 0, 0], '#f43f5e'], ['Y', [0, 1, 0], '#10b981'], ['Z', [0, 0, 1], '#3b82f6']];
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    for (const [label, a, col] of axes) {
      const rx = a[0] * R[0] + a[1] * R[1] + a[2] * R[2], rz = a[0] * U[0] + a[1] * U[1] + a[2] * U[2];
      const ex = tx + rx * L, ey = ty - rz * L;
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = col; ctx.fillText(label, ex + (rx >= 0 ? 4 : -10), ey + (rz >= 0 ? -4 : 10));
    }
  };

  function bboxOf(vx) {
    let a = Infinity, b = Infinity, c = Infinity, A = -Infinity, B = -Infinity, C = -Infinity;
    for (let i = 0; i < vx.length; i += 3) { const x = vx[i], y = vx[i + 1], z = vx[i + 2];
      if (x < a) a = x; if (x > A) A = x; if (y < b) b = y; if (y > B) B = y; if (z < c) c = z; if (z > C) C = z; }
    return isFinite(a) ? [a, b, c, A, B, C] : null;
  }


  // ------------------------------------------------------------------ camera: free arcball (quaternion) or Z-up turntable
  // View basis: r = screen right, u = screen up, d = into the screen (depth). Rows (r, u, -d) form a proper rotation.
  // cam.mode 'free' (default): cam.q = [w,x,y,z] world->view quaternion, unclamped, no gimbal lock.
  // cam.mode 'turntable': legacy yaw (about Z) / pitch (about X), pitch clamped to +-1.48 rad.
  const ORBIT_KEY = 'pdf3d.orbitMode';
  function qNorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]; }
  function qMul(a, b) {
    return [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
  }
  function qAxisAngle(ax, ay, az, ang) { const l = Math.hypot(ax, ay, az) || 1, h = ang / 2, sn = Math.sin(h) / l; return [Math.cos(h), ax * sn, ay * sn, az * sn]; }
  function qToRows(q) { // rotation matrix rows (world -> view)
    const [w, x, y, z] = q;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  }
  function rowsToQ(m) {
    const t = m[0][0] + m[1][1] + m[2][2]; let q;
    if (t > 0) { const S = Math.sqrt(t + 1) * 2; q = [0.25 * S, (m[2][1] - m[1][2]) / S, (m[0][2] - m[2][0]) / S, (m[1][0] - m[0][1]) / S]; }
    else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const S = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; q = [(m[2][1] - m[1][2]) / S, 0.25 * S, (m[0][1] + m[1][0]) / S, (m[0][2] + m[2][0]) / S]; }
    else if (m[1][1] > m[2][2]) { const S = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; q = [(m[0][2] - m[2][0]) / S, (m[0][1] + m[1][0]) / S, 0.25 * S, (m[1][2] + m[2][1]) / S]; }
    else { const S = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; q = [(m[1][0] - m[0][1]) / S, (m[0][2] + m[2][0]) / S, (m[1][2] + m[2][1]) / S, 0.25 * S]; }
    return qNorm(q);
  }
  function ypBasis(yaw, pitch) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return { r: [cy, -sy, 0], u: [sp * sy, sp * cy, cp], d: [cp * sy, cp * cy, -sp] };
  }
  const Camera = {
    loadMode() { try { const m = window.localStorage && window.localStorage.getItem(ORBIT_KEY); return m === 'turntable' ? 'turntable' : 'free'; } catch (e) { return 'free'; } },
    saveMode(m) { try { if (window.localStorage) window.localStorage.setItem(ORBIT_KEY, m); } catch (e) { /* private mode */ } },
    fromYawPitch(yaw, pitch) { const b = ypBasis(yaw, pitch); return rowsToQ([b.r, b.u, [-b.d[0], -b.d[1], -b.d[2]]]); },
    basis(cam) {
      if (cam.mode === 'turntable' || !cam.q) return ypBasis(cam.yaw || 0, cam.pitch || 0);
      const m = qToRows(cam.q);
      return { r: m[0], u: m[1], d: [-m[2][0], -m[2][1], -m[2][2]] };
    },
    // set an absolute orientation (presets / reset) in both representations
    setYawPitch(cam, yaw, pitch) { cam.yaw = yaw; cam.pitch = pitch; cam.q = Camera.fromYawPitch(yaw, pitch); },
    // switch mode, carrying the current orientation over as closely as possible
    setMode(cam, mode) {
      if (mode === cam.mode) return;
      if (mode === 'free') cam.q = Camera.fromYawPitch(cam.yaw || 0, cam.pitch || 0);
      else {
        const b = Camera.basis(cam);
        const pitch = Math.max(-1.48, Math.min(1.48, Math.asin(Math.max(-1, Math.min(1, -b.d[2])))));
        const yaw = Math.hypot(b.d[0], b.d[1]) > 1e-3 ? Math.atan2(b.d[0], b.d[1]) : Math.atan2(-b.r[1], b.r[0]);
        cam.yaw = yaw; cam.pitch = pitch;
      }
      cam.mode = mode;
    },
    // mouse drag in CSS px. twist=true rotates about the view axis.
    drag(cam, dx, dy, twist) {
      const k = 0.01;
      if (cam.mode === 'turntable') {
        cam.yaw += dx * k;
        cam.pitch = Math.max(-1.48, Math.min(1.48, cam.pitch + dy * k));
        return;
      }
      if (!cam.q) cam.q = Camera.fromYawPitch(cam.yaw || 0, cam.pitch || 0);
      let dq;
      if (twist) { if (!dx && !dy) return; dq = qAxisAngle(0, 0, 1, -(dx - dy) * k); }
      else { const len = Math.hypot(dx, dy); if (!len) return; dq = qAxisAngle(dy, dx, 0, len * k); }
      // incremental rotation expressed in view space: drag right spins the front toward the right, drag down tips it down
      cam.q = qNorm(qMul(dq, cam.q));
    }
  };

  // ------------------------------------------------------------------ toolbar options (Lines: wires / hidden / mesh / flat)
  const api = {
    attach, options: OPTIONS, MAX_TRIS, MAX_EDGES, onOptionsChange: null, onStats: null,
    _buildFillMesh: buildFillMesh,
    setOption(k, v) {
      OPTIONS[k] = v;
      if (typeof api.onOptionsChange === 'function') api.onOptionsChange(k, v);
    }
  };
  window.PDF3DViewerGL = api;
  window.PDF3DCamera = Camera;
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('DOMContentLoaded', () => {
      const els = document.querySelectorAll ? document.querySelectorAll('input[data-viewopt]') : [];
      for (const el of els) {
        const k = el.getAttribute('data-viewopt');
        // the checkbox is visually hidden inside a toggle-button label; mirror its state onto the label
        const sync = () => { const lab = el.closest ? el.closest('.btn-toggle') : null; if (lab) lab.classList.toggle('is-on', !!el.checked); };
        if (k in OPTIONS) el.checked = !!OPTIONS[k];
        sync();
        el.addEventListener('change', () => { sync(); api.setOption(k, !!el.checked); });
      }
    });
  }
})();
