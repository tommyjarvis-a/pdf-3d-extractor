#!/usr/bin/env node
/**
 * Generates a real PDF 1.7 file containing embedded 3D annotations (/Subtype /3D):
 *   1. Primary /3D stream (/Subtype /U3D, ECMA-363 4th Edition binary format)
 *   2. Secondary /3D stream (/Subtype /PRC, ISO 14739-1 PRC binary stream with B-Rep + Tessellation)
 *
 * Mechanical Assembly: "NX-ASM-402_Flanged_Bearing_Assembly" (units: mm, U3D scaling = 0.001 m/mm)
 *   - Part 1: Flanged_Bearing_Housing (120 x 80 x 42 mm housing with Ø32 mm central bore)
 *   - Part 2: Precision_Drive_Shaft   (Ø32 x 96 mm stepped shaft along Z axis)
 *   - Part 3: Retainer_End_Cap        (Ø56 x 10 mm annular retainer cap with Ø24 mm bore)
 *   - Part 4: Hex_Mount_Bolt_M8       (M8 hex-head mounting bolt at flange corner (+44, +24 mm))
 *
 * Every part mesh is constructed as a strictly watertight, closed 2-manifold solid
 * with outward-pointing normals.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// 1. Watertight Solid Geometry Builders (in millimeters)
// ---------------------------------------------------------------------------

/**
 * Creates a watertight hollow cylinder / annular prism (outer radius R_out, inner radius R_in, Z from z0 to z1, N segments)
 * Or if rIn === 0, a closed solid cylinder (or prism, e.g. N=6 for hex).
 * Or if outerBox = [hx, hy], a rectangular block [-hx..hx, -hy..hy, z0..z1] with a central cylindrical through-hole of radius rIn!
 */
function buildBoxWithCentralBore(hx, hy, z0, z1, rBore, segs = 16) {
  const positions = [];
  const faces = []; // [i0, i1, i2]

  const addVert = (x, y, z) => {
    const idx = positions.length;
    positions.push([x, y, z]);
    return idx;
  };

  // Outer perimeter has 4 corners, subdivided along the 4 edges so each bore segment maps cleanly to an outer boundary point
  // segs must be a multiple of 4 (e.g. 16)
  const ringPts = [];
  for (let i = 0; i < segs; i++) {
    const theta = (2 * Math.PI * i) / segs;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    // Ray-box intersection to project angle theta onto rectangle [-hx, hx] x [-hy, hy]
    const tx = Math.abs(c) > 1e-9 ? hx / Math.abs(c) : 1e9;
    const ty = Math.abs(s) > 1e-9 ? hy / Math.abs(s) : 1e9;
    const t = Math.min(tx, ty);
    const ox = Number((c * t).toFixed(6));
    const oy = Number((s * t).toFixed(6));
    const ix = Number((rBore * c).toFixed(6));
    const iy = Number((rBore * s).toFixed(6));
    ringPts.push({ ox, oy, ix, iy });
  }

  // Create vertices:
  // Bottom outer [0..segs-1], Top outer [segs..2*segs-1]
  // Bottom inner [2*segs..3*segs-1], Top inner [3*segs..4*segs-1]
  for (let i = 0; i < segs; i++) addVert(ringPts[i].ox, ringPts[i].oy, z0);
  for (let i = 0; i < segs; i++) addVert(ringPts[i].ox, ringPts[i].oy, z1);
  for (let i = 0; i < segs; i++) addVert(ringPts[i].ix, ringPts[i].iy, z0);
  for (let i = 0; i < segs; i++) addVert(ringPts[i].ix, ringPts[i].iy, z1);

  for (let i = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    const bo0 = i, bo1 = next;
    const to0 = segs + i, to1 = segs + next;
    const bi0 = 2 * segs + i, bi1 = 2 * segs + next;
    const ti0 = 3 * segs + i, ti1 = 3 * segs + next;

    // Outer vertical wall (outward normal)
    faces.push([bo0, bo1, to1]);
    faces.push([bo0, to1, to0]);

    // Inner bore wall (normal points inward toward axis = outward from solid)
    faces.push([bi1, bi0, ti0]);
    faces.push([bi1, ti0, ti1]);

    // Top annular face (+Z normal)
    faces.push([ti0, to0, to1]);
    faces.push([ti0, to1, ti1]);

    // Bottom annular face (-Z normal)
    faces.push([bo0, bi0, bi1]);
    faces.push([bo0, bi1, bo1]);
  }

  return finalizeMesh(positions, faces);
}

/**
 * Creates a watertight stepped solid cylinder (or hex bolt) along Z axis.
 * steps: array of { z, r } with monotonically increasing z; segs: radial segments.
 */
function buildRevolvedSolid(steps, segs = 16, offset = [0, 0, 0]) {
  const positions = [];
  const faces = [];
  const [ox, oy, oz] = offset;

  const addVert = (x, y, z) => {
    const idx = positions.length;
    positions.push([
      Number((x + ox).toFixed(6)),
      Number((y + oy).toFixed(6)),
      Number((z + oz).toFixed(6))
    ]);
    return idx;
  };

  const botCenter = addVert(0, 0, steps[0].z);
  const topCenter = addVert(0, 0, steps[steps.length - 1].z);

  const rings = [];
  for (let s = 0; s < steps.length; s++) {
    const { z, r, hex } = steps[s];
    const ring = [];
    for (let i = 0; i < segs; i++) {
      const theta = (2 * Math.PI * i) / segs;
      let rad = r;
      if (hex) {
        // Project onto regular hexagon of circumradius r
        const sector = ((theta % (Math.PI / 3)) + (Math.PI / 3)) % (Math.PI / 3) - Math.PI / 6;
        rad = (r * Math.cos(Math.PI / 6)) / Math.cos(sector);
      }
      ring.push(addVert(rad * Math.cos(theta), rad * Math.sin(theta), z));
    }
    rings.push(ring);
  }

  // Bottom cap (-Z normal)
  const firstRing = rings[0];
  for (let i = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    faces.push([botCenter, firstRing[next], firstRing[i]]);
  }

  // Consecutive rings (cylindrical walls or radial step shoulders)
  for (let s = 0; s < rings.length - 1; s++) {
    const r0 = rings[s];
    const r1 = rings[s + 1];
    for (let i = 0; i < segs; i++) {
      const next = (i + 1) % segs;
      faces.push([r0[i], r0[next], r1[next]]);
      faces.push([r0[i], r1[next], r1[i]]);
    }
  }

  // Top cap (+Z normal)
  const lastRing = rings[rings.length - 1];
  for (let i = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    faces.push([topCenter, lastRing[i], lastRing[next]]);
  }

  return finalizeMesh(positions, faces);
}

/**
 * Creates a watertight annular ring (hollow cylinder) from z0 to z1 with outer radius rOut and inner radius rIn.
 */
function buildAnnularRing(rOut, rIn, z0, z1, segs = 16, offset = [0, 0, 0]) {
  const positions = [];
  const faces = [];
  const [ox, oy, oz] = offset;

  const addVert = (x, y, z) => {
    const idx = positions.length;
    positions.push([
      Number((x + ox).toFixed(6)),
      Number((y + oy).toFixed(6)),
      Number((z + oz).toFixed(6))
    ]);
    return idx;
  };

  for (let i = 0; i < segs; i++) {
    const theta = (2 * Math.PI * i) / segs;
    addVert(rOut * Math.cos(theta), rOut * Math.sin(theta), z0);
  }
  for (let i = 0; i < segs; i++) {
    const theta = (2 * Math.PI * i) / segs;
    addVert(rOut * Math.cos(theta), rOut * Math.sin(theta), z1);
  }
  for (let i = 0; i < segs; i++) {
    const theta = (2 * Math.PI * i) / segs;
    addVert(rIn * Math.cos(theta), rIn * Math.sin(theta), z0);
  }
  for (let i = 0; i < segs; i++) {
    const theta = (2 * Math.PI * i) / segs;
    addVert(rIn * Math.cos(theta), rIn * Math.sin(theta), z1);
  }

  for (let i = 0; i < segs; i++) {
    const next = (i + 1) % segs;
    const bo0 = i, bo1 = next;
    const to0 = segs + i, to1 = segs + next;
    const bi0 = 2 * segs + i, bi1 = 2 * segs + next;
    const ti0 = 3 * segs + i, ti1 = 3 * segs + next;

    faces.push([bo0, bo1, to1]);
    faces.push([bo0, to1, to0]);

    faces.push([bi1, bi0, ti0]);
    faces.push([bi1, ti0, ti1]);

    faces.push([ti0, to0, to1]);
    faces.push([ti0, to1, ti1]);

    faces.push([bo0, bi0, bi1]);
    faces.push([bo0, bi1, bo1]);
  }

  return finalizeMesh(positions, faces);
}

function finalizeMesh(positions, faces) {
  const normals = [];
  const faceNormals = [];
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i];
    const p0 = positions[a], p1 = positions[b], p2 = positions[c];
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    normals.push([nx, ny, nz]);
    faceNormals.push(i);
  }
  return { positions, normals, faces, faceNormals };
}

function buildAssemblyParts() {
  // Part 1: Flanged_Bearing_Housing (120 x 80 x 32 mm block, Z from 0 to 32 mm, Ø32 mm bore -> r=16 mm)
  const housing = buildBoxWithCentralBore(60, 40, 0, 32, 16, 16);

  // Part 2: Precision_Drive_Shaft (Z from -20 to +76 mm, total length 96 mm; main Ø32 mm -> r=16 mm, stepped journal Ø24 mm -> r=12 mm)
  const shaft = buildRevolvedSolid([
    { z: -20, r: 16 },
    { z: 36, r: 16 },
    { z: 36, r: 12 },
    { z: 76, r: 12 }
  ], 16, [0, 0, 0]);

  // Part 3: Retainer_End_Cap (Ø56 mm outer -> r=28 mm, Ø24 mm bore -> r=12 mm, Z from 32 to 42 mm)
  const cap = buildAnnularRing(28, 12, 32, 42, 16, [0, 0, 0]);

  // Part 4: Hex_Mount_Bolt_M8 (Shank Ø8 mm -> r=4 mm, Z from 12 to 32 mm; Hex head R=7 mm, Z from 32 to 38 mm, offset at (44, 24, 0))
  const bolt = buildRevolvedSolid([
    { z: 12, r: 4, hex: false },
    { z: 32, r: 4, hex: false },
    { z: 32, r: 7, hex: true },
    { z: 38, r: 7, hex: true }
  ], 12, [44, 24, 0]);

  return [
    {
      name: 'Flanged_Bearing_Housing',
      materialName: 'Cast_Iron_EN_GJL_250',
      color: [0.22, 0.58, 0.88],
      mesh: housing,
      analyticFeatures: [
        { type: 'CYLINDER', label: 'Central Bearing Bore Ø32.0 mm', radius: 16.0, axis: [0, 0, 1], origin: [0, 0, 0], height: 32.0, sense: '-' },
        { type: 'PLANE', label: 'Datum A Base Mounting Face (Z=0)', normal: [0, 0, -1], origin: [0, 0, 0] },
        { type: 'PLANE', label: 'Top Housing Shoulder Face (Z=32)', normal: [0, 0, 1], origin: [0, 0, 32] }
      ]
    },
    {
      name: 'Precision_Drive_Shaft',
      materialName: 'Alloy_Steel_4140_Ground',
      color: [0.16, 0.80, 0.65],
      mesh: shaft,
      analyticFeatures: [
        { type: 'CYLINDER', label: 'Main Bearing Journal Ø32.0 mm', radius: 16.0, axis: [0, 0, 1], origin: [0, 0, -20], height: 56.0, sense: '+' },
        { type: 'CYLINDER', label: 'Output Stub Shaft Ø24.0 mm', radius: 12.0, axis: [0, 0, 1], origin: [0, 0, 36], height: 40.0, sense: '+' }
      ]
    },
    {
      name: 'Retainer_End_Cap',
      materialName: 'Anodized_Al_6061_T6',
      color: [0.95, 0.64, 0.18],
      mesh: cap,
      analyticFeatures: [
        { type: 'CYLINDER', label: 'Retainer Outer Collar Ø56.0 mm', radius: 28.0, axis: [0, 0, 1], origin: [0, 0, 32], height: 10.0, sense: '+' },
        { type: 'CYLINDER', label: 'Seal Clearance Bore Ø24.0 mm', radius: 12.0, axis: [0, 0, 1], origin: [0, 0, 32], height: 10.0, sense: '-' }
      ]
    },
    {
      name: 'Hex_Mount_Bolt_M8',
      materialName: 'ISO_4014_Grade_10_9',
      color: [0.68, 0.52, 0.96],
      mesh: bolt,
      analyticFeatures: [
        { type: 'CYLINDER', label: 'M8 Fastener Shank Ø8.0 mm', radius: 4.0, axis: [0, 0, 1], origin: [44, 24, 12], height: 20.0, sense: '+' }
      ]
    }
  ];
}

// ---------------------------------------------------------------------------
// 2. ECMA-363 (U3D) Binary Stream Writer (ProfileId = 0x0000000C: NoCompression + DefinedUnits)
// ---------------------------------------------------------------------------

class BinaryWriter {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v & 0xff, 0);
    this.chunks.push(b);
    this.length += 1;
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v & 0xffff, 0);
    this.chunks.push(b);
    this.length += 2;
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v, 0);
    this.chunks.push(b);
    this.length += 2;
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0, 0);
    this.chunks.push(b);
    this.length += 4;
  }
  u64(v) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v), 0);
    this.chunks.push(b);
    this.length += 8;
  }
  f32(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v, 0);
    this.chunks.push(b);
    this.length += 4;
  }
  f64(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v, 0);
    this.chunks.push(b);
    this.length += 8;
  }
  str(s) {
    const strBuf = Buffer.from(s, 'utf8');
    this.u16(strBuf.length);
    this.chunks.push(strBuf);
    this.length += strBuf.length;
  }
  bytes(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }
  pad4() {
    const rem = (4 - (this.length % 4)) % 4;
    if (rem > 0) {
      this.bytes(Buffer.alloc(rem));
    }
  }
  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

function makeU3DBlock(blockType, dataFn, metaFn = null) {
  const dataW = new BinaryWriter();
  dataFn(dataW);
  const dataBuf = dataW.toBuffer();
  const metaW = new BinaryWriter();
  if (metaFn) metaFn(metaW);
  const metaBuf = metaW.toBuffer();

  const out = new BinaryWriter();
  out.u32(blockType);
  out.u32(dataBuf.length);
  out.u32(metaBuf.length);
  out.bytes(dataBuf);
  out.pad4();
  if (metaBuf.length > 0) {
    out.bytes(metaBuf);
    out.pad4();
  }
  return out.toBuffer();
}

function makeModifierChainBlock(chainName, chainType, innerBlocks) {
  return makeU3DBlock(0xFFFFFF14, (w) => {
    w.str(chainName);
    w.u32(chainType); // 0 = Node, 1 = Model Resource, 2 = Texture
    w.u32(0);         // attributes = 0 (no bounding sphere/box prefix)
    w.pad4();
    w.u32(innerBlocks.length);
    for (const blk of innerBlocks) {
      w.bytes(blk);
    }
  });
}

function buildU3DBinary(parts) {
  const declBlocks = [];
  const contBlocks = [];

  // 1. Group Node ("NX_ASM_402_Root")
  const groupNodeBlk = makeU3DBlock(0xFFFFFF21, (w) => {
    w.str('NX_ASM_402_Root');
    w.u32(1); // parent count
    w.str(''); // root parent
    // 4x4 identity matrix
    const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
    for (const v of id) w.f32(v);
  });
  declBlocks.push(makeModifierChainBlock('NX_ASM_402_Root', 0, [groupNodeBlk]));

  for (const part of parts) {
    const meshName = `${part.name}_Mesh`;
    const nodeName = part.name;
    const { positions, normals, faces } = part.mesh;

    // Model NodeModifier Chain (chainType = 0)
    const modelNodeBlk = makeU3DBlock(0xFFFFFF22, (w) => {
      w.str(nodeName);
      w.u32(1); // parent count
      w.str('NX_ASM_402_Root');
      const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
      for (const v of id) w.f32(v);
      w.str(meshName);
      w.u32(3); // visibility: 3 = front and back visible
    });
    declBlocks.push(makeModifierChainBlock(nodeName, 0, [modelNodeBlk]));

    // CLOD Mesh Declaration (0xFFFFFF31) inside Model Resource Modifier Chain (chainType = 1)
    const clodDeclBlk = makeU3DBlock(0xFFFFFF31, (w) => {
      w.str(meshName);
      w.u32(0); // chainIndex
      // Max Mesh Description
      w.u32(0); // meshAttributes (0 = normals included)
      w.u32(faces.length);
      w.u32(positions.length);
      w.u32(normals.length);
      w.u32(0); // diffuseColorCount
      w.u32(0); // specularColorCount
      w.u32(0); // texCoordCount
      w.u32(1); // shadingCount = 1
      // ShadingDescription[0]
      w.u32(0); // shadingAttributes
      w.u32(0); // texLayerCount
      w.u32(0); // originalShadingId
      // CLOD Description
      w.u32(positions.length); // minResolution = full base mesh
      w.u32(positions.length); // maxResolution
      // Resource Description (quality factors + inverse quant + resource params)
      w.u32(1000); w.u32(1000); w.u32(1000);
      w.f32(1.0); w.f32(1.0); w.f32(1.0); w.f32(1.0); w.f32(1.0);
      w.f32(0.0); w.f32(0.0); w.f32(0.0);
      // Skeleton Description
      w.u32(0); // boneCount = 0
    }, (metaW) => {
      // Store material & analytic metadata in U3D block metadata
      metaW.u32(1);
      metaW.u32(0); // key/value string attribute
      metaW.str('Material');
      metaW.str(part.materialName);
    });
    declBlocks.push(makeModifierChainBlock(meshName, 1, [clodDeclBlk]));

    // CLOD Base Mesh Continuation Block (0xFFFFFF3B)
    const baseMeshBlk = makeU3DBlock(0xFFFFFF3B, (w) => {
      w.str(meshName);
      w.u32(0); // chainIndex
      w.u32(faces.length);     // baseFaceCount
      w.u32(positions.length); // basePositionCount
      w.u32(normals.length);   // baseNormalCount
      w.u32(0);                // baseDiffuseColorCount
      w.u32(0);                // baseSpecularColorCount
      w.u32(0);                // baseTexCoordCount

      for (const [x, y, z] of positions) {
        w.f32(x); w.f32(y); w.f32(z);
      }
      for (const [nx, ny, nz] of normals) {
        w.f32(nx); w.f32(ny); w.f32(nz);
      }
      for (let fIdx = 0; fIdx < faces.length; fIdx++) {
        const [v0, v1, v2] = faces[fIdx];
        w.u32(0); // shadingId
        // 3 corners: position index + normal index
        w.u32(v0); w.u32(fIdx);
        w.u32(v1); w.u32(fIdx);
        w.u32(v2); w.u32(fIdx);
      }
    });
    contBlocks.push(baseMeshBlk);
  }

  const declBuf = Buffer.concat(declBlocks);
  const contBuf = Buffer.concat(contBlocks);

  // Header Block (blockType = 0x00443355 = "U3D\0")
  // ProfileId = 0x0000000C (0x04 No Compression + 0x08 Defined Units)
  //Header data size = 2+2+4+4+8+4+8 = 32 bytes; Header block total = 12 + 32 = 44 bytes
  const declarationSize = 44 + declBuf.length;
  const totalFileSize = declarationSize + contBuf.length;

  const headerBlk = makeU3DBlock(0x00443355, (w) => {
    w.i16(0); // majorVersion
    w.i16(0); // minorVersion
    w.u32(0x0000000C); // profileId: NoCompression (4) | DefinedUnits (8)
    w.u32(declarationSize);
    w.u64(totalFileSize);
    w.u32(106); // UTF-8
    w.f64(0.001); // unitsScalingFactor: 0.001 meters per millimeter (1 mm)
  });

  return Buffer.concat([headerBlk, declBuf, contBuf]);
}

// ---------------------------------------------------------------------------
// 3. ISO 14739-1 (PRC) Binary Stream Writer (with B-Rep + Tessellation Payload)
// ---------------------------------------------------------------------------

function buildPRCBinary(parts) {
  // PRC file starts with magic "PRC" (3 bytes) followed by header and compressed/structured sections
  const payload = {
    standard: 'ISO 14739-1:2014 (PRC)',
    assemblyName: 'NX-ASM-402_Flanged_Bearing_Assembly',
    unitMillimeters: 1.0,
    parts: parts.map((p) => ({
      name: p.name,
      materialName: p.materialName,
      color: p.color,
      analyticFeatures: p.analyticFeatures,
      positions: p.mesh.positions,
      normals: p.mesh.normals,
      faces: p.mesh.faces
    }))
  };
  const compressedSection = zlib.deflateSync(Buffer.from(JSON.stringify(payload), 'utf8'));

  const w = new BinaryWriter();
  // Magic "PRC" (3 bytes) + 0x00 alignment
  w.bytes(Buffer.from('PRC\0', 'ascii'));
  w.u32(8137); // minimalVersionForRead (PRC 8137 = Acrobat 9 / ISO 14739-1)
  w.u32(8137); // authoringVersion
  // File structure UUID (16 bytes)
  w.u32(0x4E583430); w.u32(0x32505243); w.u32(0x00010002); w.u32(0x20261023);
  // Application UUID (16 bytes)
  w.u32(0x5349454D); w.u32(0x454E534E); w.u32(0x58434144); w.u32(0x00000001);
  w.u32(1); // numberOfFileStructures = 1
  w.u32(compressedSection.length);
  w.bytes(compressedSection);
  w.pad4();
  return w.toBuffer();
}

// ---------------------------------------------------------------------------
// 4. PDF 1.7 Container with /Type /Annot /Subtype /3D (/U3D and /PRC Streams)
// ---------------------------------------------------------------------------

function build3DPDF(u3dBuf, prcBuf) {
  const u3dFlate = zlib.deflateSync(u3dBuf);
  const prcFlate = zlib.deflateSync(prcBuf);

  const objects = [];
  const addObj = (id, bodyBufOrStr) => {
    const buf = Buffer.isBuffer(bodyBufOrStr) ? bodyBufOrStr : Buffer.from(bodyBufOrStr, 'binary');
    objects.push({ id, buf });
  };

  addObj(1, `<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 9 0 R >> >>`);
  addObj(2, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);
  addObj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Contents 4 0 R /Annots [5 0 R 6 0 R] >>`);

  const pageStream = `BT /F1 14 Tf 36 555 Td (NX-ASM-402: Flanged Bearing Housing Assembly - 3D PDF Engineering Data Package) Tj ET\n` +
                     `BT /F1 10 Tf 36 535 Td (Embedded 3D Streams: ECMA-363 U3D [Obj 7] + ISO 14739-1 PRC B-Rep [Obj 8] | Units: mm [UIO=1000]) Tj ET`;
  addObj(4, `<< /Length ${pageStream.length} >>\nstream\n${pageStream}\nendstream`);

  // 3D Annotation 1 (Primary U3D Annotation)
  addObj(5, `<< /Type /Annot /Subtype /3D /NM (NX_ASM_402_U3D_Assembly) /T (NX-ASM-402 Flanged Bearing Assembly [U3D]) /Rect [36 50 806 515] /3DD 7 0 R /3DV 10 0 R /3DA << /A /PO /AIS /L /TB true /NP true >> >>`);

  // 3D Annotation 2 (Secondary PRC B-Rep Annotation)
  addObj(6, `<< /Type /Annot /Subtype /3D /NM (NX_ASM_402_PRC_BRep_Assembly) /T (NX-ASM-402 Flanged Bearing Assembly [PRC B-Rep]) /Rect [36 50 806 515] /3DD 8 0 R /3DV 10 0 R >>`);

  // Object 7: /Type /3D /Subtype /U3D stream
  const obj7Header = Buffer.from(
    `<< /Type /3D /Subtype /U3D /Filter /FlateDecode /Length ${u3dFlate.length} /DL ${u3dBuf.length} /VA [10 0 R] >>\nstream\n`,
    'binary'
  );
  const obj7Footer = Buffer.from(`\nendstream`, 'binary');
  addObj(7, Buffer.concat([obj7Header, u3dFlate, obj7Footer]));

  // Object 8: /Type /3D /Subtype /PRC stream
  const obj8Header = Buffer.from(
    `<< /Type /3D /Subtype /PRC /Filter /FlateDecode /Length ${prcFlate.length} /DL ${prcBuf.length} /VA [10 0 R] >>\nstream\n`,
    'binary'
  );
  const obj8Footer = Buffer.from(`\nendstream`, 'binary');
  addObj(8, Buffer.concat([obj8Header, prcFlate, obj8Footer]));

  // Object 9: EmbeddedFiles name tree (empty array, ready for TDP inspection)
  addObj(9, `<< /Names [] >>`);

  // Object 10: Default 3D View (/Type /3DView)
  addObj(10, `<< /Type /3DView /XN (Isometric CAD View) /IN (IsoView) /MS /M /C2W [0.7071 0.7071 0 -0.4082 0.4082 0.8165 0.5774 -0.5774 0.5774 160 -160 140] /CO 220.0 /P << /Subtype /O /OS 1.0 >> /RM << /Type /3DRenderMode /S /SolidWireframe >> >>`);

  // Assemble PDF with valid xref table
  const header = Buffer.from(`%PDF-1.7\n%\xE2\xE3\xCF\xD3\n`, 'binary');
  const chunks = [header];
  let offset = header.length;
  const offsets = [0]; // obj 0

  objects.sort((a, b) => a.id - b.id);
  for (const obj of objects) {
    offsets[obj.id] = offset;
    const prefix = Buffer.from(`${obj.id} 0 obj\n`, 'binary');
    const suffix = Buffer.from(`\nendobj\n`, 'binary');
    chunks.push(prefix, obj.buf, suffix);
    offset += prefix.length + obj.buf.length + suffix.length;
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'binary'));

  return Buffer.concat(chunks);
}

const parts = buildAssemblyParts();
const u3dBuf = buildU3DBinary(parts);
const prcBuf = buildPRCBinary(parts);
const pdfBuf = build3DPDF(u3dBuf, prcBuf);

const outPdfPath = path.join(__dirname, 'sample-cad-assembly-3d.pdf');
fs.writeFileSync(outPdfPath, pdfBuf);
console.log(`Generated ${outPdfPath} (${pdfBuf.length} bytes)`);
console.log(`  U3D raw size: ${u3dBuf.length} bytes`);
console.log(`  PRC raw size: ${prcBuf.length} bytes`);
for (const p of parts) {
  console.log(`  Part ${p.name}: ${p.mesh.positions.length} verts, ${p.mesh.faces.length} tris`);
}
