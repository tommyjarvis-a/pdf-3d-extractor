'use strict';
/*
 * u3d-guard.js (pdf-3d-extractor, MIT) - diagnoses U3D streams whose geometry is only in a vendor "New Object Type" (ECMA-363 block
 *   0xFFFFFF16 declaration + 0x00000100.. new-object blocks), e.g. Adobe/Right Hemisphere "RHAdobeMeshResource"
 *   (CoreTechnologie, r09). Stock parseU3DStream() skips unknown blocks silently and returns 0 parts, so the UI shows an
 *   empty model with no explanation.
 * Fixes (verified in harness): r09 now fails with an explicit, actionable error (code U3D_NO_GEOMETRY) naming the
 *   extension instead of an empty model. It does NOT decode the mesh: RHAdobeMeshResource's layout is not public
 *   (not in ECMA-363 1st-4th ed.); decoding needs reverse engineering (approach in REPORT.md, sec. "U3D").
 * Integration into app.js: wrap the existing parser once, e.g. after its definition:
 *     parseU3DStream = U3DGuard.wrapParseU3D(parseU3DStream);
 *   or inline: after building parts, if total triangles === 0 call U3DGuard.scanU3D(u8) and throw/warn with its text.
 *   scanU3D(u8) -> { types: {hexType: count}, newTypes: [names] } (top-level block walk + whole-stream search for
 *   0xFFFFFF16 declarations, which usually sit inside Modifier Chain 0xFFFFFF14 blocks).
 * Known limits: heuristic byte search for nested declarations (validated: printable name, sane sizes); does not
 *   parse modifier chains structurally. Self-contained, no dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.U3DGuard = factory();
})(typeof self !== 'undefined' ? self : this, function () {
function scanU3D(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); const types = {}; const newTypes = new Set(); let off = 0, guard = 0;
  while (off + 12 <= u8.length && guard++ < 1e6) {
    const t = dv.getUint32(off, true), ds = dv.getUint32(off + 4, true), ms = dv.getUint32(off + 8, true);
    types[t.toString(16)] = (types[t.toString(16)] || 0) + 1;
    off += 12 + ((ds + 3) & ~3) + ((ms + 3) & ~3);
  }
  // New Object Type declarations usually sit inside Modifier Chain blocks (0xFFFFFF14), so search the whole stream.
  for (let i = 0; i + 14 < u8.length; i++) {
    if (u8[i] !== 0x16 || u8[i + 1] !== 0xff || u8[i + 2] !== 0xff || u8[i + 3] !== 0xff) continue;
    const ds = dv.getUint32(i + 4, true), L = dv.getUint16(i + 12, true);
    if (ds < 2 || ds > u8.length || !L || L > 200 || L + 2 > ds) continue;
    const name = String.fromCharCode(...u8.subarray(i + 14, i + 14 + L));
    if (/^[\x20-\x7e]+$/.test(name)) { newTypes.add(name); types.ffffff16 = (types.ffffff16 || 0) + 1; }
  }
  return { types, newTypes: [...newTypes] };
}
function wrapParseU3D(orig) {
  return function parseU3DStream(u8) {
    const r = orig(u8);
    const tris = (r.parts || []).reduce((s, p) => s + (p.faces ? p.faces.length : 0), 0);
    if (!tris) {
      const sc = scanU3D(u8); const mesh = ['ffffff31', 'ffffff36', 'ffffff37'].filter((t) => sc.types[t]);
      const e = new Error(sc.newTypes.length && !mesh.length
        ? `U3D has no CLOD/line/point set declarations; its geometry is only in New Object Type extension block(s) ${sc.newTypes.join(', ')} (vendor extension, not defined in ECMA-363) which this extractor cannot decode`
        : `U3D parsed but no mesh produced (block types: ${Object.keys(sc.types).join(',')})`);
      e.code = 'U3D_NO_GEOMETRY'; throw e;
    }
    return r;
  };
}
return { wrapParseU3D, scanU3D };
});
