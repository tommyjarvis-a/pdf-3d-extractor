#!/usr/bin/env node
'use strict';
/*
 * 1.6.1: synthetic damaged / edge-case PDFs for the regression corpus (test/run.js checks them against test/expect.json,
 * including their lastLoad status / reasonCode).
 *
 *   node tools/make-damaged-fixtures.js <corpusDir>
 *
 * Writes into <corpusDir> (deterministic bytes, so the same files every run):
 *   x01_damaged_prc.pdf        g07's PRC stream with its middle overwritten by 0xFF  -> error / DECODE_ERROR
 *   x02_damaged_vea_mesh.pdf   r18's U3D (SAP VEA RHAdobeMeshResource / UIC1) with one mesh block's payload garbled
 *                              -> error / DECODE_ERROR (not UNSUPPORTED_MESH)
 *   x03_random_bytes_3d.pdf    a /3D annotation whose /Subtype /U3D stream is 4096 random bytes -> error / DECODE_ERROR
 *   x04_attachments_only.pdf   no /3D, two embedded files (bracket.step, notes.txt) -> no3d / NO_3D + attachmentDetails
 *   x05_u3d_damaged_node_count.pdf  g10's classic U3D with a damaged GroupNode (huge parent count) -> error / DECODE_ERROR
 *                              in milliseconds (1.6.0 hung for minutes)
 * Needs g07_*.pdf, g10_*.pdf and r18_*.pdf in the corpus dir (their streams are the damage sources).
 */
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const corpus = process.argv[2]; if (!corpus) { console.error('usage: node tools/make-damaged-fixtures.js <corpusDir>'); process.exit(2); }

// one-page PDF: /3D annotations (one stream each) + embedded files
function makePDF(o) {
  const objs = []; const add = (s) => { objs.push(s); return objs.length; };
  const cat = add(null), pages = add(null), page = add(null); const annots = [], efs = [];
  for (const s of o.streams || []) {
    let data = Buffer.from(s.data); if (s.flate) data = zlib.deflateSync(data, { level: 9 });
    const st = add(Buffer.concat([Buffer.from(`<< /Type /3D${s.subtype ? ' /Subtype /' + s.subtype : ''}${s.flate ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    annots.push(add(`<< /Type /Annot /Subtype /3D /Rect [0 0 200 200] /3DD ${st} 0 R /Contents (3D) >>`));
  }
  for (const a of o.attachments || []) {
    const d = Buffer.from(a.data);
    const ef = add(Buffer.concat([Buffer.from(`<< /Type /EmbeddedFile /Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]));
    efs.push([a.name, add(`<< /Type /Filespec /F (${a.name}) /UF (${a.name})${a.desc ? ' /Desc (' + a.desc + ')' : ''} /EF << /F ${ef} 0 R >> >>`)]);
  }
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R${efs.length ? ' /Names << /EmbeddedFiles << /Names [' + efs.map(([n, r]) => `(${n}) ${r} 0 R`).join(' ') + '] >> >>' : ''} >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  objs[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 200 200]${annots.length ? ' /Annots [' + annots.map((a) => a + ' 0 R').join(' ') + ']' : ''} >>`;
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; let len = parts[0].length; const off = [];
  objs.forEach((ob, i) => { off.push(len); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(ob) ? ob : Buffer.from(ob, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); len += b.length; });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((v) => String(v).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
// the app's own extractor (pdf-extract.js) gives the source streams' raw bytes
function streamsOf(file) {
  return require(path.join(ROOT, 'pdf-extract.js')).extract3DStreamsFromPDF(new Uint8Array(fs.readFileSync(file)), path.basename(file));
}
const find = (prefix) => { const f = fs.readdirSync(corpus).find((n) => n.startsWith(prefix) && n.endsWith('.pdf')); if (!f) throw new Error(`${prefix}*.pdf not in ${corpus}`); return path.join(corpus, f); };
let seed = 0x1610; const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 24; };
const out = (name, buf) => { fs.writeFileSync(path.join(corpus, name), buf); console.log(`${name}: ${buf.length} B`); };

(async () => {
  // x01: PRC with the middle half overwritten
  { const s = (await streamsOf(find('g07_'))).find((x) => x.subtype === 'PRC'); const b = Buffer.from(s.rawBytes);
    b.fill(0xff, b.length >> 2, (b.length * 3) >> 2); out('x01_damaged_prc.pdf', makePDF({ streams: [{ data: b, subtype: 'PRC', flate: true }] })); }
  // x02: VEA RHAdobeMeshResource: garble the payload of the first mesh block (after its first 16 bytes)
  { const s = (await streamsOf(find('r18_'))).find((x) => x.subtype === 'U3D'); const b = Buffer.from(s.rawBytes);
    const M = require(path.join(ROOT, 'u3d-rhadobe-mesh.js')); const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const decls = new Set(); let hit = -1;
    const walk = (o, lim) => { const type = dv.getUint32(o, true), ds = dv.getUint32(o + 4, true), ms = dv.getUint32(o + 8, true), d0 = o + 12;
      if (type === 0xFFFFFF16) { const L = dv.getUint16(d0, true); const name = b.toString('latin1', d0 + 2, d0 + 2 + L); if (name === 'RHAdobeMeshResource') decls.add(dv.getUint32(d0 + 2 + L + 4 + 16, true)); }
      else if (type === 0xFFFFFF14) { // modifier chain (as u3d-rhadobe-mesh.js scan): name, type, attrs, [sphere], [aabb], pad, count, blocks
        let q = d0 + 2 + dv.getUint16(d0, true); const attr = dv.getUint32(q + 4, true); q += 8; if (attr & 1) q += 16; if (attr & 2) q += 24;
        q = d0 + ((q - d0 + 3) & ~3); const n = dv.getUint32(q, true); q += 4; for (let i = 0; i < n && hit < 0; i++) q = walk(q, d0 + ds); }
      else if (hit < 0 && decls.has(type)) { hit = o; for (let k = d0 + 16; k < d0 + ds; k++) b[k] = rnd(); }
      return d0 + ((ds + 3) & ~3) + ((ms + 3) & ~3); };
    let o = 0; while (o + 12 <= b.length && hit < 0) o = walk(o, b.length);
    const sc = M.scan(new Uint8Array(b)); if (hit < 0 || !sc.meshErrors.length) throw new Error('x02: no damaged RH mesh block (' + hit + ')');
    console.log(`  x02: garbled the RH mesh block at ${hit}: ${sc.meshErrors[0].message}`);
    out('x02_damaged_vea_mesh.pdf', makePDF({ streams: [{ data: b, subtype: 'U3D', flate: true }] })); }
  // x03: random bytes declared as U3D
  { const b = Buffer.alloc(4096); for (let i = 0; i < b.length; i++) b[i] = rnd(); b[0] = 0x9c;
    out('x03_random_bytes_3d.pdf', makePDF({ streams: [{ data: b, subtype: 'U3D', flate: false }] })); }
  // x04: attachments only
  { const step = 'ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((\'bracket\'),\'2;1\');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
    out('x04_attachments_only.pdf', makePDF({ attachments: [{ name: 'bracket.step', data: step, desc: 'Bracket STEP model' }, { name: 'notes.txt', data: 'Assembly notes\n' }] })); }
  // x05: classic U3D (g10's second stream) with bytes 2976..5112 set to 0x72: a GroupNode's parent count turns huge and,
  // before 1.6.1, the parser spun for minutes reading zero bits past the block end (found by the 1.6.1 end-to-end fuzz)
  { const s = (await streamsOf(find('g10_'))).filter((x) => x.subtype === 'U3D')[1]; const b = Buffer.from(s.rawBytes);
    b.fill(0x72, 2976, 5113); out('x05_u3d_damaged_node_count.pdf', makePDF({ streams: [{ data: b, subtype: 'U3D', flate: true }] })); }
})().catch((e) => { console.error(e); process.exit(1); });
