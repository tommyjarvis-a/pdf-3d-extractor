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
 *                              in milliseconds (1.6.0 hung for minutes); since 1.6.2 the damaged block is skipped and the
                              rest loads: ok, lastLoad.damaged set
 * 1.6.2 (attachment-only PDFs for PDF3D.saveAttachment; no /3D, so lastLoad is no3d / NO_3D):
 *   x06_attachments_mixed.pdf  unencrypted, 8 embedded files: bracket.step (2.6 MB, Flate, /Subtype /model#2Fstep, 3 picker
 *                              writes), notes.txt, damaged.stp (Flate stream of garbage -> ATTACHMENT_UNREADABLE),
 *                              Wing Assembly.CATPart (UTF-16 /UF, [/ASCIIHexDecode /FlateDecode], binary), fallback.igs
 *                              (/EF /UF -> missing object, /EF /F readable), ../../evil:name?.sat (fileName sanitizing),
 *                              part.x_t (page /AF), GAUGE.STL (FileAttachment annotation); bracket.step is also in the
 *                              catalog /AF (PDF/A-3 style: listed once); a FileAttachment with a plain-string /FS is ignored
 *   x07_attachments_aesv2.pdf  Standard V4 R4 AESV2 (StmF / StrF / EFF StdCF), empty user password: encrypted names,
 *                              descriptions and streams (bracket.step, notes.txt, Wing Assembly.CATPart, damaged.stp, GAUGE.STL)
 *   x08_attachments_rc4.pdf    Standard V2 R3 RC4 128-bit, empty user password (bracket.step, notes.txt)
 *   x09_attachments_eff_aesv2.pdf  V4 R4, StmF / StrF /Identity, EFF AESV2: only the embedded files are encrypted
 *   x10_u3d_bad_block_header.pdf  (1.6.2) g01's U3D with one block type overwritten -> ok (partial), lastLoad.damaged set
 *   x11_prc_truncated.pdf      (1.6.2) g07's PRC with the last 1% cut off -> error / DECODE_ERROR
 * The expected sha256 of each attachment (from the bytes written here, not from the extractor) is printed for
 * test/expect.json "attachmentSha256" (null = unreadable on purpose).
 * Needs g01_*.pdf, g07_*.pdf, g10_*.pdf and r18_*.pdf in the corpus dir (their streams are the damage sources).
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
// ---- 1.6.2 attachment fixtures: own builder (makePDF above stays as it was, so x01-x05 are byte-identical) ----
const nodeCrypto = require('crypto');
const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...b) => nodeCrypto.createHash('md5').update(Buffer.concat(b)).digest();
function rc4(key, data) { const S = [...Array(256).keys()]; let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + S[i] + key[i % key.length]) & 255; [S[i], S[j]] = [S[j], S[i]]; }
  const o = Buffer.alloc(data.length); let i = 0; j = 0;
  for (let k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + S[i]) & 255; [S[i], S[j]] = [S[j], S[i]]; o[k] = data[k] ^ S[(S[i] + S[j]) & 255]; } return o; }
let seed2 = 0x1620; const rnd2 = () => { seed2 = (Math.imul(seed2, 1103515245) + 12345) >>> 0; return seed2 >>> 24; };
const rndBytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = rnd2(); return b; };
// crypt: null | { V, R, method: 'RC4' | 'AES', strings, streams, ef } (Standard handler, empty user password, R3/R4 key algorithm)
function makeCrypt(c) {
  const id0 = rndBytes(16), O = rndBytes(32), P = -3904, n = 16;
  const pb = Buffer.alloc(4); pb.writeInt32LE(P);
  let key = md5(PAD, O, pb, id0); for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n)); key = key.subarray(0, n);
  let x = rc4(key, md5(PAD, id0)); for (let i = 1; i <= 19; i++) x = rc4(Buffer.from(key.map((b) => b ^ i)), x);
  const U = Buffer.concat([x, rndBytes(16)]);
  const enc = (num, data) => { const ok = md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]), c.method === 'AES' ? Buffer.from('sAlT') : Buffer.alloc(0)).subarray(0, Math.min(n + 5, 16));
    if (c.method !== 'AES') return rc4(ok, data); const iv = rndBytes(16); const ci = nodeCrypto.createCipheriv('aes-128-cbc', ok, iv); return Buffer.concat([iv, ci.update(data), ci.final()]); };
  const cf = (ev) => `/CF << /StdCF << /CFM /${c.method === 'AES' ? 'AESV2' : 'V2'} /AuthEvent /${ev} /Length 16 >> >>`;
  const dict = c.V === 4 ? `<< /Filter /Standard /V 4 /R 4 /Length 128 ${cf(c.streams ? 'DocOpen' : 'EFOpen')} /StmF /${c.streams ? 'StdCF' : 'Identity'} /StrF /${c.strings ? 'StdCF' : 'Identity'} /EFF /StdCF /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`
    : `<< /Filter /Standard /V 2 /R 3 /Length 128 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${P} >>`;
  return { ...c, id0, enc, dict };
}
// one-page attachment PDF. entries: { name, uf16?, data, flate?, hex?, garbage?, subtype?, desc?, where: 'names'|'annot'|'pageAF', missingUF?, alsoCatalogAF? }
function makeAttPDF(entries, cryptSpec, extra) {
  const C = cryptSpec ? makeCrypt(cryptSpec) : null; const objs = []; const alloc = () => { objs.push(null); return objs.length; };
  const cat = alloc(), pages = alloc(), page = alloc(); const names = [], annots = [], pageAF = [], catAF = [];
  const S = (num, v) => { let b = Buffer.isBuffer(v) ? v : Buffer.from(v, 'latin1'); if (C && C.strings) b = C.enc(num, b); return '<' + b.toString('hex') + '>'; };
  const u16 = (t) => Buffer.concat([Buffer.from([254, 255]), Buffer.from(t, 'utf16le').swap16()]);
  const sha = [];
  entries.forEach((e, k) => {
    const raw = Buffer.from(e.data); sha.push(e.garbage ? null : nodeCrypto.createHash('sha256').update(raw).digest('hex'));
    let d = raw; const filters = [];
    if (e.garbage) { d = Buffer.concat([Buffer.from([0, 0]), rndBytes(raw.length)]); filters.push('/FlateDecode'); }
    else { if (e.flate) { d = zlib.deflateSync(d, { level: 9 }); filters.unshift('/FlateDecode'); } if (e.hex) { d = Buffer.from(d.toString('hex').replace(/(.{78})/g, '$1\n') + '>', 'latin1'); filters.unshift('/ASCIIHexDecode'); } }
    const ef = alloc(); if (C && (cryptSpec.streams || cryptSpec.ef)) d = C.enc(ef, d);
    objs[ef - 1] = Buffer.concat([Buffer.from(`<< /Type /EmbeddedFile${e.subtype ? ' /Subtype /' + e.subtype.replace('/', '#2F') : ''}${filters.length ? ' /Filter ' + (filters.length > 1 ? '[' + filters.join(' ') + ']' : filters[0]) : ''} /Params << /Size ${raw.length} >> /Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]);
    const fs_ = alloc();
    objs[fs_ - 1] = `<< /Type /Filespec /F ${S(fs_, e.name)} /UF ${S(fs_, e.uf16 ? u16(e.name) : e.name)}${e.desc ? ' /Desc ' + S(fs_, e.desc) : ''}${e.where === 'pageAF' ? ' /AFRelationship /Source' : ''} /EF << ${e.missingUF ? '/UF 999 0 R ' : ''}/F ${ef} 0 R >> >>`;
    if (e.where === 'names') names.push([`a${String(k + 1).padStart(2, '0')}`, fs_]);
    else if (e.where === 'pageAF') pageAF.push(fs_);
    else { const an = alloc(); objs[an - 1] = `<< /Type /Annot /Subtype /FileAttachment /Rect [10 10 30 30] /Name /PushPin /FS ${fs_} 0 R /Contents ${S(an, 'Attachment ' + e.name)} >>`; annots.push(an); }
    if (e.alsoCatalogAF) catAF.push(fs_);
  });
  if (extra && extra.stringFS) { const an = alloc(); objs[an - 1] = `<< /Type /Annot /Subtype /FileAttachment /Rect [40 10 60 30] /FS ${S(an, 'external.dwg')} /Contents ${S(an, 'external file')} >>`; annots.push(an); }
  objs[cat - 1] = `<< /Type /Catalog /Pages ${pages} 0 R /Names << /EmbeddedFiles << /Names [${names.map(([n, r]) => `${S(cat, n)} ${r} 0 R`).join(' ')}] >> >>${catAF.length ? ' /AF [' + catAF.map((r) => r + ' 0 R').join(' ') + ']' : ''} >>`;
  objs[pages - 1] = `<< /Type /Pages /Kids [${page} 0 R] /Count 1 >>`;
  objs[page - 1] = `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 200 200]${annots.length ? ' /Annots [' + annots.map((a) => a + ' 0 R').join(' ') + ']' : ''}${pageAF.length ? ' /AF [' + pageAF.map((a) => a + ' 0 R').join(' ') + ']' : ''} >>`;
  let encNum = 0; if (C) { encNum = alloc(); objs[encNum - 1] = C.dict; }
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')]; let len = parts[0].length; const off = [];
  objs.forEach((ob, i) => { off.push(len); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(ob) ? ob : Buffer.from(ob, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); len += b.length; });
  parts.push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((v) => String(v).padStart(10, '0') + ' 00000 n \n').join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root ${cat} 0 R${C ? ` /Encrypt ${encNum} 0 R /ID [<${C.id0.toString('hex')}> <${C.id0.toString('hex')}>]` : ''} >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return { pdf: Buffer.concat(parts), sha };
}
const bigStep = () => { const L = ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('bracket'),'2;1');", "FILE_NAME('bracket.step','2026-11-01T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('AUTOMOTIVE_DESIGN'));", 'ENDSEC;', 'DATA;'];
  for (let i = 1; i <= 52000; i++) L.push(`#${i}=CARTESIAN_POINT('',(${(i * 0.731 % 100).toFixed(4)},${(i * 1.913 % 50).toFixed(4)},${(i * 0.377 % 25).toFixed(4)}));`);
  L.push('ENDSEC;', 'END-ISO-10303-21;', ''); return L.join('\n'); };
const smallStep = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('bracket'),'2;1');\nENDSEC;\nDATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;\n";
const binSTL = () => { const n = 12; const b = Buffer.alloc(84 + 50 * n); b.write('GAUGE binary STL', 0, 'latin1'); b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 12; k++) b.writeFloatLE(((t * 12 + k) % 7) - 3, 84 + t * 50 + k * 4); return b; };
const outAtt = (name, r) => { out(name, r.pdf); console.log(`  ${name} attachmentSha256: ${JSON.stringify(r.sha)}`); };
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
  // 1.6.2 attachment fixtures (rnd2 / seed2, so x01-x05 above are unchanged)
  const catpart = rndBytes(20000), stl = binSTL();
  outAtt('x06_attachments_mixed.pdf', makeAttPDF([
    { name: 'bracket.step', data: bigStep(), flate: true, subtype: 'model/step', desc: 'Bracket STEP model', where: 'names', alsoCatalogAF: true },
    { name: 'notes.txt', data: 'Assembly notes\nTorque M6 bolts to 10 Nm.\n', subtype: 'text/plain', where: 'names' },
    { name: 'damaged.stp', data: smallStep, garbage: true, desc: 'unreadable on purpose', where: 'names' },
    { name: 'Wing Assembly.CATPart', data: catpart, uf16: true, flate: true, hex: true, where: 'names' },
    { name: 'fallback.igs', data: 'IGES via /EF /F (the /UF stream is missing)\n', missingUF: true, where: 'names' },
    { name: '../../evil:name?.sat', data: '700 0 1 0\n', where: 'names' },
    { name: 'part.x_t', data: '**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*******************************\n', where: 'pageAF' },
    { name: 'GAUGE.STL', data: stl, flate: true, where: 'annot' },
  ], null, { stringFS: true }));
  outAtt('x07_attachments_aesv2.pdf', makeAttPDF([
    { name: 'bracket.step', data: smallStep, flate: true, subtype: 'model/step', desc: 'Bracket STEP model (encrypted PDF)', where: 'names' },
    { name: 'notes.txt', data: 'Encrypted notes\n', where: 'names' },
    { name: 'Wing Assembly.CATPart', data: catpart.subarray(0, 4096), uf16: true, flate: true, where: 'names' },
    { name: 'damaged.stp', data: smallStep, garbage: true, where: 'names' },
    { name: 'GAUGE.STL', data: stl, where: 'annot' },
  ], { V: 4, R: 4, method: 'AES', strings: true, streams: true, ef: true }));
  outAtt('x08_attachments_rc4.pdf', makeAttPDF([
    { name: 'bracket.step', data: smallStep, flate: true, desc: 'RC4 128-bit', where: 'names' },
    { name: 'notes.txt', data: 'RC4 notes\n', where: 'names' },
  ], { V: 2, R: 3, method: 'RC4', strings: true, streams: true, ef: true }));
  outAtt('x09_attachments_eff_aesv2.pdf', makeAttPDF([
    { name: 'bracket.step', data: smallStep, flate: true, desc: 'only embedded files are encrypted', where: 'names' },
    { name: 'notes.txt', data: 'EFF notes\n', where: 'names' },
  ], { V: 4, R: 4, method: 'AES', strings: false, streams: false, ef: true }));
  // x10 (1.6.2): g01's U3D with the type of one top-level block (a quarter of the way in) overwritten by 0x7a7a7a7a, which is
  // not a U3D block type: the parser records the damage, resyncs at the next pair of valid block headers and loads the rest
  { const s = (await streamsOf(find('g01_'))).find((x) => x.subtype === 'U3D'); const b = Buffer.from(s.rawBytes);
    const offs = []; for (let o = 0; o + 12 <= b.length;) { offs.push(o); o += 12 + ((b.readUInt32LE(o + 4) + 3) & ~3) + ((b.readUInt32LE(o + 8) + 3) & ~3); }
    const hit = offs[offs.length >> 2]; b.writeUInt32LE(0x7a7a7a7a, hit); console.log(`  x10: block header at ${hit} of ${offs.length} blocks`);
    out('x10_u3d_bad_block_header.pdf', makePDF({ streams: [{ data: b, subtype: 'U3D', flate: true }] })); }
  // x11 (1.6.2): g07's PRC with its last 1% cut off (the header's end-of-file offset is past the stream end) -> DECODE_ERROR
  // (1.6.1 reported UNSUPPORTED_MESH "exact geometry without tessellation")
  { const s = (await streamsOf(find('g07_'))).find((x) => x.subtype === 'PRC'); const b = Buffer.from(s.rawBytes);
    out('x11_prc_truncated.pdf', makePDF({ streams: [{ data: b.subarray(0, Math.floor(b.length * 0.99)), subtype: 'PRC', flate: true }] })); }
})().catch((e) => { console.error(e); process.exit(1); });
