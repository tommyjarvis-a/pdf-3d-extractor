'use strict';
/*
 * fixes/u3d-rhadobe-mesh.js - decoder for the U3D vendor extension "RHAdobeMeshResource"
 *   (Right Hemisphere Adobe 3D Mesh Compression, Acrobat 8.1+), declared via a New Object Type block 0xFFFFFF16
 *   (GUID 96a804a6-3fb9-43c5-b2df-2a31b5569340, vendor "Right Hemisphere Adobe Systems", info "version 1.0") and
 *   stored in New Object Blocks (block type = the declaration's "New Declaration Block Type", 0x100..0xFFFFFF).
 *
 * FIXES: r09_coretech_compare_u3d_2annots_aes128.pdf (CoreTechnologie 3D_Evolution, AES-128; both annots carry the
 *   byte-identical U3D stream with 2 RHAdobe meshes: PartBody_2Resource 70,958 tris / 49,549 verts and
 *   PartBody_5Resource 71,146 tris / 49,662 verts). Stock app: 0 tris + "Unsupported proprietary U3D mesh" (u3d-guard).
 *
 * FORMAT (Adobe Acrobat SDK 8.1 "U3D Supported Elements", ch.2 + appendix A; verified byte-exact on r09, every
 *   encoded array ends exactly at its declared size and the 2nd mesh ends exactly at the U3D block end):
 *   String ObjectName (U16 len + UTF-8)  [no Chain Index / Character Encoding string seen in this producer]
 *   U8 ChunkFlags: bits0-3 version(0), bit4 subchunks (must be 0), bit5 skeleton, bits6-7 MaterialsCount encoding
 *       (0 => 1 material; 1/2/3 => U8/U16/U32 count follows)
 *   Materials[count]: U8 MaterialFlag (b0-1 tex dims layer0, b2-3 bytes-1 of ShadingID, b4-5 bytes-1 of NumTexLayers,
 *       b6 hasDiffuse, b7 hasSpecular), UN NumTexLayers, UN OriginalShadingID, ceil((layers-1)/4) bytes of dims
 *   U8 ValuesFlags (b0 faces, b1 positions, b2 normals, b3 diffuse, b4 specular, b5 texcoords present;
 *       b6-7 bytes-1 of each count) + the counts
 *   Float arrays (planar XXX..YYY..ZZZ): U8 DataType then per component: 0 = raw F32[n]; 2 = F32 min, F32 max,
 *       [U32 NumQuants + UINT block, only if min != max], value = min + q*(max-min)/NumQuants; 3 = alpha/theta normals.
 *       positions*3, normals*3 (if count), diffuse*4, specular*4, texcoords*4
 *   UINT arrays: [face material IDs, only if >1 material], position face idx [3F], normal face idx [3F if normals],
 *       diffuse idx, specular idx (for faces whose material has the flag), texcoord idx [3F per tex layer]
 *   UINT block: U8 (b0-5 encoding, b6-7 bytes-1 of size field); 0 all-zero (no size), 1 replicate U32 (no size);
 *       otherwise U8|16|24|32 byte size, then data: 2 U4, 3 U8, 4 U16, 5 U24, 6 U32, 7 RH39, 8/9 U3D arithmetic
 *       (NOT implemented - not used by r09), 10 UIC1 (implemented from the appendix, verified on the spec's cube example).
 *
 * INTEGRATION (app.js, read-only for QA; for Dev):
 *   <script src="u3d-rhadobe-mesh.js"> (global RHAdobeMesh) before app.js. In parseU3DStreamCore's block loop, on block
 *   0xFFFFFF16 whose name is 'RHAdobeMeshResource' remember its declBlockType; on a block of that type call
 *   const m = RHAdobeMesh.decodeBlock(u8, dataOffset, dataSize) and meshes.set(m.name, { meshName: m.name,
 *   positions: m.positionsAoA(), faces: m.facesAoA(), chainIdx: 0 }) - the existing Model Node code then applies the
 *   node transforms. Or, minimal: in parseU3DStream() when tris==0 and the guard sees RHAdobeMeshResource, return
 *   RHAdobeMesh.parseU3D(u8) (same {parts:[{name,meshName,visible,color,positions,faces}]} shape as app parts).
 *   Typed arrays (m.positions Float32Array, m.indices Uint32Array) are available for Dev's typed-array parts.
 * CLI: node fixes/u3d-rhadobe-mesh.js <in.u3d|in.pdf> [-o out.stl] [--obj out.obj] [--json summary.json] [--no-transform]
 *   (.pdf input uses fixes/pdf-extract.js + crypto-lite.js, so AES/RC4 owner-only files work.)
 * LIMITS: encodings 8/9 (U3D arithmetic coder) and normals type 3 decode paths are unverified (8/9 throw); skeleton and
 *   subchunk data are ignored; texture coordinates are decoded (OBJ vt) but textures/materials are not mapped; tested
 *   only on the CoreTechnologie producer in r09 (1 material, no normals, no colours).
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.RHAdobeMesh = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const GUID = '96a804a6-3fb9-43c5-b2df-2a31b5569340';
  function Reader(u8, p, end) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const R = { p, end,
      u8() { if (R.p >= R.end) throw new Error('RHAdobe: read past block end'); return u8[R.p++]; },
      u16() { const v = dv.getUint16(R.p, true); R.p += 2; return v; },
      u24() { const v = u8[R.p] | (u8[R.p + 1] << 8) | (u8[R.p + 2] << 16); R.p += 3; return v >>> 0; },
      u32() { const v = dv.getUint32(R.p, true); R.p += 4; return v; },
      f32() { const v = dv.getFloat32(R.p, true); R.p += 4; return v; },
      n(bytes) { return bytes === 1 ? R.u8() : bytes === 2 ? R.u16() : bytes === 3 ? R.u24() : R.u32(); },
      str() { const L = R.u16(); const s = new TextDecoder().decode(u8.subarray(R.p, R.p + L)); R.p += L; return s; } };
    return R;
  }
  function rh39(R, count, end) {
    const out = new Uint32Array(count); let o = 0, offset = 0, c = count;
    while (c && R.p < end) {
      const b = R.u8(); const op = (b >> 4) & 7; let len = b & 15;
      if (b & 0x80) len = 17 + (len << 8) + R.u8(); else len++;
      if (op === 7) { offset = R.n(len); continue; }
      if (c < len) throw new Error('RH39: run longer than remaining count'); c -= len; let b4 = 0;
      for (let i = 0; i < len; i++) {
        let v;
        switch (op) { case 6: v = R.u8(); break; case 4: v = R.u16(); break; case 0: v = R.u32(); break;
          case 2: v = offset + R.u8(); break; case 3: v = offset + R.u16(); break; case 5: v = offset; break;
          default: if (i & 1) v = offset + (b4 >> 4); else { b4 = R.u8(); v = offset + (b4 & 15); } }
        out[o++] = v >>> 0;
      }
    }
    if (c) throw new Error('RH39: data ended ' + c + ' values early');
    return out;
  }
  function uic1(R, count, end, vertical) {
    const out = new Uint32Array(count); const PV = new Uint32Array(32), PD = new Int32Array(32);
    let cv = 0, cd = 0, q = 0, qv = 0, r = 0;
    const gv = (w) => PV[cv >= w ? cv - w : 32 + cv - w], gd = (w) => PD[cd >= w ? cd - w : 32 + cd - w];
    const C = [0xFF, 0xFF00, 0xFF0000, 0xFF000000, 0xFFFFFF, 0xFFFFFFFF];
    for (let i = 0; i < count; i++) {
      const prev = r; const pv = vertical && i >= 3 ? out[i - 3] : 0;
      if (q) { q--; r = gv(qv); } else {
        if (R.p >= end) throw new Error('UIC1: data ended at value ' + i);
        const cmd = R.u8(), a = cmd >> 4;
        switch (cmd & 15) {
          case 0: r = gv(a); break; case 5: r = gv(16 + a); break;
          case 13: r = gv(a >> 2); qv = a & 3; q = 1; break; case 14: r = gv(0); qv = 0; q = a + 2; break;
          case 6: r = (r + gd(a)) >>> 0; break;
          case 1: r = (cmd & 16) ? (r + (cmd >> 5) + 1) >>> 0 : (r - ((cmd >> 5) + 1)) >>> 0; break; // per appendix A.2 code
          case 3: r = (pv + a + 1) >>> 0; break; case 4: r = (pv - a - 1) >>> 0; break;
          case 7: r = (pv + a + 17) >>> 0; break; case 8: r = (pv - a - 17) >>> 0; break;
          case 9: r = (r + a + (R.u8() << 4) + 3) >>> 0; break; case 10: r = (r - (a + (R.u8() << 4) + 3)) >>> 0; break;
          case 11: r = a + (R.u8() << 4); break; case 12: r = a + (R.u16() << 4); break;
          case 15:
            if (a <= 4) r = a; else if (a <= 10) r = C[a - 5];
            else if (a === 11) { const bl = R.u8(); r = ((R.u16() << 8) + bl) >>> 0; }
            else if (a === 12) r = R.u32();
            else if (a === 13) { qv = 0; q = R.u16() + 35; r = gv(0); } // replicate last value 36+N times (this one + 35+N queued)
            else throw new Error('UIC1: undefined extended command ' + a);
            break;
          default: throw new Error('UIC1: undefined command 2');
        }
      }
      r >>>= 0; out[i] = r; cv = (cv + 1) & 31; PV[cv] = r;
      if (r !== prev) { const d = r > prev ? r - prev : -(prev - r); if (Math.abs(d) < 0x7fffffff) { cd = (cd + 1) & 31; PD[cd] = d; } }
    }
    return out;
  }
  function uintBlock(R, count, vertical, info) {
    const b = R.u8(), t = b & 63;
    if (t === 0) return new Uint32Array(count);
    if (t === 1) return new Uint32Array(count).fill(R.u32());
    const size = R.n((b >> 6) + 1), start = R.p, end = start + size; let out;
    if (t === 2) { out = new Uint32Array(count); let b4 = 0; for (let i = 0; i < count; i++) { if (!(i & 1)) b4 = R.u8(); out[i] = i & 1 ? b4 >> 4 : b4 & 15; } }
    else if (t >= 3 && t <= 6) { out = new Uint32Array(count); for (let i = 0; i < count; i++) out[i] = R.n(t - 2); }
    else if (t === 7) out = rh39(R, count, end);
    else if (t === 10) out = uic1(R, count, end, vertical);
    else throw new Error('RHAdobe: UINT encoding ' + t + (t === 8 || t === 9 ? ' (U3D arithmetic coder) not implemented' : ' unknown'));
    if (info) info.push({ enc: t, size, consumed: R.p - start });
    R.p = end; return out;
  }
  function floatArray(R, n, comps, info) {
    const dt = R.u8(); const out = [];
    for (let c = 0; c < comps; c++) {
      if (dt === 0) { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = R.f32(); out.push(a); continue; }
      if (dt === 3) { // alpha/theta normals: whole 3-vector from 2 arrays
        const nq = R.u32(); const al = uintBlock(R, n, false, info), th = uintBlock(R, n, false, info);
        const x = new Float32Array(n), y = new Float32Array(n), z = new Float32Array(n), k = 2 * Math.PI / nq;
        for (let i = 0; i < n; i++) { const A = al[i] * k, T = th[i] * k; x[i] = Math.sin(T) * Math.cos(A); y[i] = Math.sin(T) * Math.sin(A); z[i] = Math.cos(T); }
        return [x, y, z];
      }
      if (dt !== 2) throw new Error('RHAdobe: float DataType ' + dt);
      const mn = R.f32(), mx = R.f32();
      if (mn === mx) { out.push(new Float32Array(n).fill(mn)); continue; }
      const nq = R.u32(); const q = uintBlock(R, n, false, info); const a = new Float32Array(n), s = (mx - mn) / nq;
      for (let i = 0; i < n; i++) a[i] = mn + q[i] * s; out.push(a);
    }
    return out;
  }
  /** Decode one RHAdobeMeshResource New Object Block payload (u8[off .. off+size)). */
  function decodeBlock(u8, off, size) {
    const R = Reader(u8, off, off + size); const info = [];
    const name = R.str();
    const flags = R.u8(); if (flags & 15) throw new Error('RHAdobe: chunk version ' + (flags & 15) + ' != 0');
    if (flags & 16) throw new Error('RHAdobe: subchunk extension data not supported');
    const mcEnc = flags >> 6; const nMat = mcEnc === 0 ? 1 : R.n([0, 1, 2, 4][mcEnc]);
    const materials = [];
    for (let m = 0; m < nMat; m++) {
      const mf = R.u8(); const layers = R.n(((mf >> 4) & 3) + 1); const shadingId = R.n(((mf >> 2) & 3) + 1);
      const dims = [mf & 3]; const extra = Math.max(0, layers - 1); for (let k = 0; k < Math.ceil(extra / 4); k++) { const b = R.u8(); for (let j = 0; j < 4 && dims.length < layers; j++) dims.push((b >> (2 * j)) & 3); }
      materials.push({ layers, shadingId, texDims: dims, hasDiffuse: !!(mf & 64), hasSpecular: !!(mf & 128) });
    }
    const vf = R.u8(), vs = (vf >> 6) + 1; const cnt = {};
    ['faces', 'positions', 'normals', 'diffuse', 'specular', 'texCoords'].forEach((k, b) => { cnt[k] = vf & (1 << b) ? R.n(vs) : 0; });
    const F = cnt.faces;
    const P = floatArray(R, cnt.positions, 3, info);
    const N = cnt.normals ? floatArray(R, cnt.normals, 3, info) : null;
    const D = cnt.diffuse ? floatArray(R, cnt.diffuse, 4, info) : null;
    const S = cnt.specular ? floatArray(R, cnt.specular, 4, info) : null;
    const T = cnt.texCoords ? floatArray(R, cnt.texCoords, 4, info) : null;
    const matIds = nMat > 1 ? uintBlock(R, F, false, info) : new Uint32Array(F);
    const indices = uintBlock(R, F * 3, true, info);
    const normalIdx = cnt.normals ? uintBlock(R, F * 3, true, info) : null;
    const nDif = materials.some((m) => m.hasDiffuse) ? 3 * Array.from(matIds).filter((id) => materials[id] && materials[id].hasDiffuse).length : 0;
    const diffuseIdx = nDif ? uintBlock(R, nDif, true, info) : null;
    const nSpc = materials.some((m) => m.hasSpecular) ? 3 * Array.from(matIds).filter((id) => materials[id] && materials[id].hasSpecular).length : 0;
    const specularIdx = nSpc ? uintBlock(R, nSpc, true, info) : null;
    const texIdx = []; const maxLayers = Math.max(0, ...materials.map((m) => m.layers));
    if (cnt.texCoords) for (let l = 0; l < maxLayers; l++) texIdx.push(uintBlock(R, F * 3, true, info)); // assumes every face uses all layers
    const positions = new Float32Array(cnt.positions * 3);
    for (let i = 0; i < cnt.positions; i++) { positions[3 * i] = P[0][i]; positions[3 * i + 1] = P[1][i]; positions[3 * i + 2] = P[2][i]; }
    let badIndex = 0; for (let i = 0; i < indices.length; i++) if (indices[i] >= cnt.positions) badIndex++;
    const uv = T ? (() => { const a = new Float32Array(cnt.texCoords * 2); for (let i = 0; i < cnt.texCoords; i++) { a[2 * i] = T[0][i]; a[2 * i + 1] = T[1][i]; } return a; })() : null;
    return { name, materials, counts: cnt, positions, indices, matIds, uv, uvIndices: texIdx[0] || null, normals: N, normalIdx, diffuse: D, diffuseIdx, specular: S, specularIdx,
      badIndex, bytesUsed: R.p - off, bytesDeclared: size, exactEnd: R.p === off + size, arrays: info,
      positionsAoA() { const a = new Array(cnt.positions); for (let i = 0; i < cnt.positions; i++) a[i] = [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]]; return a; },
      facesAoA() { const a = new Array(F); for (let i = 0; i < F; i++) a[i] = [indices[3 * i], indices[3 * i + 1], indices[3 * i + 2]]; return a; } };
  }
  const p4 = (x) => (x + 3) & ~3;
  /** Walk a U3D stream: blocks + modifier chains; returns {decls, meshes, nodes, warnings}. */
  function scan(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const td = new TextDecoder();
    const str = (o) => { const L = dv.getUint16(o, true); return [td.decode(u8.subarray(o + 2, o + 2 + L)), o + 2 + L]; };
    const decls = new Map(), meshes = [], nodes = [], warnings = [];
    function block(o, lim) {
      const type = dv.getUint32(o, true), ds = dv.getUint32(o + 4, true), ms = dv.getUint32(o + 8, true); const d0 = o + 12;
      if (d0 + ds > lim) throw new Error('U3D block overruns stream at ' + o);
      if (type === 0xFFFFFF14) { // modifier chain: name, type, attrs, [sphere], [aabb], pad, count, blocks
        let [, q] = str(d0); const attr = dv.getUint32(q + 4, true); q += 8; if (attr & 1) q += 16; if (attr & 2) q += 24;
        q = d0 + p4(q - d0); const n = dv.getUint32(q, true); q += 4;
        for (let i = 0; i < n; i++) q = block(q, d0 + ds);
      } else if (type === 0xFFFFFF16) {
        let [name, q] = str(d0); q += 4; const g = [dv.getUint32(q, true).toString(16).padStart(8, '0'), dv.getUint16(q + 4, true).toString(16).padStart(4, '0'), dv.getUint16(q + 6, true).toString(16).padStart(4, '0'),
          Array.from(u8.subarray(q + 8, q + 10), (b) => b.toString(16).padStart(2, '0')).join(''), Array.from(u8.subarray(q + 10, q + 16), (b) => b.toString(16).padStart(2, '0')).join('')].join('-');
        q += 16; const declType = dv.getUint32(q, true); decls.set(declType, { name, guid: g });
        if (name !== 'RHAdobeMeshResource' || g !== GUID) warnings.push(`New Object Type '${name}' ${g} is not RHAdobeMeshResource; its blocks are skipped`);
      } else if (type >= 0x100 && type <= 0xFFFFFF && type !== 0x00443355) {
        const dcl = decls.get(type);
        if (dcl && dcl.name === 'RHAdobeMeshResource') {
          try { meshes.push(decodeBlock(u8, d0, ds)); } catch (e) { warnings.push(`RHAdobeMeshResource block at ${o}: ${e.message}`); }
        } else warnings.push(`New Object Block type 0x${type.toString(16)} at ${o} has no RHAdobeMeshResource declaration`);
      } else if (type === 0xFFFFFF21 || type === 0xFFFFFF22) { // group/model node: name, parents{name, 4x4 col-major}, [resource]
        let [name, q] = str(d0); const np = dv.getUint32(q, true); q += 4; const parents = [];
        for (let i = 0; i < np; i++) { let pn; [pn, q] = str(q); const m = new Float64Array(16); for (let k = 0; k < 16; k++) m[k] = dv.getFloat32(q + 4 * k, true); q += 64; parents.push({ name: pn, m }); }
        let resource = null; if (type === 0xFFFFFF22) [resource] = str(q);
        nodes.push({ name, model: type === 0xFFFFFF22, parents, resource });
      }
      return d0 + p4(ds) + p4(ms);
    }
    let o = 0; while (o + 12 <= u8.length) o = block(o, u8.length);
    return { decls, meshes, nodes, warnings };
  }
  const mul = (a, b) => { const r = new Float64Array(16); for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k]; r[c * 4 + rr] = s; } return r; };
  const I = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  function worldMatrices(nodes, name, depth = 0) {
    const n = nodes.find((x) => x.name === name); if (!n || depth > 64) return [I()];
    const out = []; for (const p of n.parents) { const base = p.name && p.name !== '' && nodes.some((x) => x.name === p.name) ? worldMatrices(nodes, p.name, depth + 1) : [I()]; for (const B of base) out.push(mul(B, p.m)); }
    return out.length ? out : [I()];
  }
  /** App-shaped result: parts with node transforms applied (one part per model-node instance). */
  function parseU3D(u8, opts = {}) {
    const sc = scan(u8); const parts = [];
    for (const m of sc.meshes) {
      const users = sc.nodes.filter((n) => n.model && n.resource === m.name);
      const insts = opts.noTransform || !users.length ? [{ node: m.name.replace(/Resource$/, ''), M: I() }] : users.flatMap((u) => worldMatrices(sc.nodes, u.name).map((M) => ({ node: u.name, M })));
      for (const { node, M } of insts) {
        const P = m.positions, nv = P.length / 3, pos = new Float32Array(P.length);
        for (let i = 0; i < nv; i++) { const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
          pos[3 * i] = M[0] * x + M[4] * y + M[8] * z + M[12]; pos[3 * i + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]; pos[3 * i + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]; }
        parts.push({ name: node, meshName: m.name, visible: true, positionsTyped: pos, indices: m.indices, uv: m.uv, uvIndices: m.uvIndices, matrix: Array.from(M),
          get positions() { const a = new Array(nv); for (let i = 0; i < nv; i++) a[i] = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]; return a; },
          get faces() { return m.facesAoA(); }, analyticFeatures: [] });
      }
    }
    return { format: 'U3D (ECMA-363) + RHAdobeMeshResource', parts, meshes: sc.meshes, nodes: sc.nodes, warnings: sc.warnings, decodePath: 'U3D/RHAdobeMeshResource' };
  }
  return { GUID, decodeBlock, scan, parseU3D, _rh39: rh39, _uic1: uic1, _uintBlock: uintBlock, Reader };
});

if (typeof require !== 'undefined' && require.main === module) (async () => {
  const fs = require('fs'), path = require('path'); const M = module.exports;
  const a = process.argv.slice(2); const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const inp = a[0]; if (!inp) { console.error('usage: node u3d-rhadobe-mesh.js <in.u3d|in.pdf> [-o out.stl] [--obj out.obj] [--json s.json] [--no-transform]'); process.exit(1); }
  const t0 = Date.now(); let u3ds = []; const raw = new Uint8Array(fs.readFileSync(inp));
  if (/\.pdf$/i.test(inp)) {
    const X = require('./pdf-extract'); const zlib = require('zlib');
    const streams = await X.extract3DStreamsFromPDF(raw, path.basename(inp), { inflate: async (b) => new Uint8Array(zlib.inflateSync(Buffer.from(b))) });
    const seen = new Set(); for (const s of streams) { if (s.subtype !== 'U3D') continue; const h = require('crypto').createHash('sha1').update(s.rawBytes).digest('hex'); if (seen.has(h)) continue; seen.add(h); u3ds.push(s.rawBytes); }
    console.error(`pdf: ${streams.length} 3D stream(s), ${u3ds.length} distinct U3D`);
  } else u3ds = [raw];
  const parts = [], meshes = [], warnings = [];
  for (const u of u3ds) { const r = M.parseU3D(u, { noTransform: a.includes('--no-transform') }); parts.push(...r.parts); meshes.push(...r.meshes); warnings.push(...r.warnings); }
  let tris = 0, verts = 0, bad = 0, degen = 0; const bb = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
  for (const p of parts) { tris += p.indices.length / 3; verts += p.positionsTyped.length / 3; for (let i = 0; i < p.positionsTyped.length; i++) { const v = p.positionsTyped[i], k = i % 3; if (v < bb[0][k]) bb[0][k] = v; if (v > bb[1][k]) bb[1][k] = v; } }
  const out = arg('-o');
  if (out) { const buf = Buffer.alloc(84 + tris * 50); buf.write('RHAdobeMeshResource via fixes/u3d-rhadobe-mesh.js', 0); buf.writeUInt32LE(tris, 80); let o = 84;
    for (const p of parts) { const P = p.positionsTyped, ix = p.indices;
      for (let t = 0; t < ix.length; t += 3) { const A = ix[t] * 3, B = ix[t + 1] * 3, C = ix[t + 2] * 3;
        if (A >= P.length || B >= P.length || C >= P.length) { bad++; o += 50; continue; }
        const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2], vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz); if (l) { nx /= l; ny /= l; nz /= l; } else degen++;
        buf.writeFloatLE(nx, o); buf.writeFloatLE(ny, o + 4); buf.writeFloatLE(nz, o + 8); o += 12;
        for (const V of [A, B, C]) { buf.writeFloatLE(P[V], o); buf.writeFloatLE(P[V + 1], o + 4); buf.writeFloatLE(P[V + 2], o + 8); o += 12; } o += 2; } }
    fs.writeFileSync(out, buf); }
  const objp = arg('--obj');
  if (objp) { const w = fs.createWriteStream(objp); w.write('# RHAdobeMeshResource via fixes/u3d-rhadobe-mesh.js\n'); let vb = 1, tb = 1;
    for (const p of parts) { w.write(`o ${p.name}\n`); const P = p.positionsTyped; let s = ''; for (let i = 0; i < P.length; i += 3) { s += `v ${P[i]} ${P[i + 1]} ${P[i + 2]}\n`; if (s.length > 1 << 20) { w.write(s); s = ''; } }
      const U = p.uv; if (U) for (let i = 0; i < U.length; i += 2) { s += `vt ${U[i]} ${U[i + 1]}\n`; if (s.length > 1 << 20) { w.write(s); s = ''; } }
      const ix = p.indices, ti = p.uvIndices; for (let t = 0; t < ix.length; t += 3) { s += ti ? `f ${ix[t] + vb}/${ti[t] + tb} ${ix[t + 1] + vb}/${ti[t + 1] + tb} ${ix[t + 2] + vb}/${ti[t + 2] + tb}\n` : `f ${ix[t] + vb} ${ix[t + 1] + vb} ${ix[t + 2] + vb}\n`; if (s.length > 1 << 20) { w.write(s); s = ''; } }
      w.write(s); vb += P.length / 3; if (U) tb += U.length / 2; }
    await new Promise((r) => w.end(r)); }
  const summary = { input: inp, distinctU3D: u3ds.length, meshes: meshes.map((m) => ({ name: m.name, faces: m.counts.faces, positions: m.counts.positions, texCoords: m.counts.texCoords, normals: m.counts.normals, materials: m.materials.length, badIndex: m.badIndex, exactEnd: m.exactEnd, bytes: m.bytesDeclared, encodings: m.arrays.map((x) => x.enc).join(',') })),
    parts: parts.map((p) => ({ name: p.name, mesh: p.meshName, tris: p.indices.length / 3, matrixIsIdentity: p.matrix.every((v, i) => v === (i % 5 === 0 ? 1 : 0)) })),
    tris, verts, badIndex: bad, zeroAreaTris: degen, bbox: bb, ms: Date.now() - t0, rssMB: process.memoryUsage().rss >> 20, warnings };
  if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
})().catch((e) => { console.error(e.stack || e); process.exit(2); });
