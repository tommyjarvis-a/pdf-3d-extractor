#!/usr/bin/env node
'use strict';
// Synthetic metadata probes are not cryptographic oracles. External controls are
// Tester's libqpdf-encrypted copies of the built-in U3D/PRC sample, never committed.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const U = b => new Uint8Array(b), B = s => Buffer.from(s, 'latin1');
const own = (v, k) => Object.prototype.hasOwnProperty.call(v, k);
function serialize(v) {
  if (Array.isArray(v)) return '[' + v.map(serialize).join(' ') + ']';
  if (v && v.bytes) return '<' + Buffer.from(v.bytes).toString('hex') + '>';
  if (v && own(v, 'name')) return '/' + v.name;
  if (v && own(v, 'kw')) return v.kw;
  if (v && own(v, 'num')) return `${v.num} ${v.gen} R`;
  if (v && typeof v === 'object') return '<< ' + Object.keys(v).filter(k => v[k] !== undefined).map(k => '/' + k + ' ' + serialize(v[k])).join(' ') + ' >>';
  return String(v);
}
function pdf(E, id = '[<00000000000000000000000000000000><11111111111111111111111111111111>]') {
  let s = '%PDF-1.7\n'; const offsets = [0];
  for (const [n, v] of [[1, '<< /Type /Catalog >>'], [2, E]]) { offsets[n] = s.length; s += `${n} 0 obj\n${v}\nendobj\n`; }
  const x = s.length;
  s += 'xref\n0 3\n0000000000 65535 f \n' + offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  s += `trailer\n<< /Root 1 0 R /Size 3 /Encrypt 2 0 R ${id === null ? '' : '/ID ' + id} >>\nstartxref\n${x}\n%%EOF\n`;
  return U(B(s));
}
function metadata(R = 4) {
  const hex = n => '<' + '00'.repeat(n) + '>';
  return `<< /Filter /Standard /R ${R} /V ${R >= 5 ? 5 : R === 4 ? 4 : R === 3 ? 2 : 1} /P -4 /Length ${R >= 5 ? 256 : R === 2 ? 40 : 128} /O ${hex(R >= 5 ? 48 : 32)} /U ${hex(R >= 5 ? 48 : 32)} ${R >= 4 ? `/CF << /StdCF << /CFM /${R >= 5 ? 'AESV3' : 'AESV2'} /Length ${R >= 5 ? 32 : 16} >> >> /StmF /StdCF /StrF /StdCF` : ''} ${R >= 5 ? `/OE ${hex(32)} /UE ${hex(32)} /Perms ${hex(16)}` : ''} >>`;
}
// A real incremental revision: preserve encrypted content and /Prev, replace only
// metadata; optionally move the unchanged ID array into an indirect object.
async function revised(X, data, edit, indirectID = false) {
  const doc = new X._Doc(data, {}); await doc.readXrefChain();
  const tr = doc.trailer, E = doc.resolve(tr.Encrypt); edit(E);
  let s = Buffer.from(data).toString('latin1') + '\n'; const entries = [];
  const add = (n, g, v) => { entries.push([n, g, s.length]); s += `${n} ${g} obj\n${serialize(v)}\nendobj\n`; };
  add(tr.Encrypt.num, tr.Encrypt.gen, E);
  const next = Math.max(...doc.offsets.keys()) + 1; let id = tr.ID;
  if (indirectID) { add(next, 0, id); id = new X._Parser(U(B(`${next} 0 R`))).parse(); }
  const prev = +Buffer.from(data).toString('latin1').match(/startxref\s+(\d+)\s*%%EOF\s*$/)[1];
  const x = s.length; s += 'xref\n';
  for (const [n, g, off] of entries.sort((a, b) => a[0] - b[0])) s += `${n} 1\n${String(off).padStart(10,'0')} ${String(g).padStart(5,'0')} n \n`;
  s += `trailer\n<< /Root ${serialize(tr.Root)} /Encrypt ${serialize(tr.Encrypt)} /ID ${serialize(id)} /Prev ${prev} /Size ${next + 1} >>\nstartxref\n${x}\n%%EOF\n`;
  return U(B(s));
}
async function run({loadApp, pages = ['index.html'], external = false}) {
  let cases = 0;
  for (const page of pages) {
    const {api, window, ctx} = loadApp({}, ROOT, page), X = window.PDF3DExtract;
    const warnings = []; ctx.console = {...console, warn: (...a) => warnings.push(a)};
    const parse = s => new X._Parser(U(B(s))).parse();
    async function damaged(data, code = 'PDF_DAMAGED') {
      let prompts = 0;
      await assert.rejects(() => X.extract3DStreamsFromPDF(data), e => e.code === code && e.encrypted === true && /damaged|unsupported/i.test(e.message));
      await api.loadPDFBuffer(data, 'metadata-probe.pdf', {requestPassword: async () => { prompts++; return null; }});
      assert.equal(window.PDF3D.lastLoad.reasonCode, code); assert.equal(prompts, 0);
      assert.ok(!warnings.some(a => String(a[0]).includes('falling back to legacy')));
      cases++;
    }
    const faults = [
      ['missing O', e => { delete e.O; }], ['non-string O', e => { e.O = 3; }], ['short O', e => { e.O = parse('<00>'); }],
      ['missing U', e => { delete e.U; }], ['non-string U', e => { e.U = parse('/No'); }], ['short U', e => { e.U = parse('<00>'); }],
      ['bad P', e => { e.P = parse('(bad)'); }], ['P overflow', e => { e.P = 2147483648; }],
      ['bad R type', e => { e.R = parse('/Four'); }], ['bad V type', e => { e.V = true; }],
      ['unknown R', e => { e.R = 7; }, 'PDF_SECURITY_UNSUPPORTED'], ['unknown V', e => { e.V = 9; }, 'PDF_SECURITY_UNSUPPORTED'],
      ['garbage Length', e => { e.Length = parse('(garbage)'); }], ['fractional Length', e => { e.Length = 127.5; }], ['zero Length', e => { e.Length = 0; }],
      ['missing CF', e => { delete e.CF; }], ['bad CF', e => { e.CF = 123; }], ['missing filter', e => { delete e.CF.StdCF; }],
      ['bad filter dictionary', e => { e.CF.StdCF = parse('/No'); }], ['bare filter token', e => { e.CF.StdCF = parse('garbage'); }], ['bad CFM', e => { e.CF.StdCF.CFM = 12; }],
      ['unknown CFM', e => { e.CF.StdCF.CFM = parse('/Unsupported'); }, 'PDF_SECURITY_UNSUPPORTED'], ['prototype CFM', e => { e.CF.StdCF.CFM = parse('/toString'); }, 'PDF_SECURITY_UNSUPPORTED'],
      ['bad CF Length', e => { e.CF.StdCF.Length = parse('(garbage)'); }], ['wrong CF Length', e => { e.CF.StdCF.Length = 15; }],
      ['bad StmF', e => { e.StmF = 12; }], ['bad StrF', e => { e.StrF = false; }], ['missing selected filter', e => { e.StrF = parse('/Missing'); }],
      ['bad metadata boolean', e => { e.EncryptMetadata = 0; }], ['unknown handler', e => { e.Filter = parse('/Adobe.PubSec'); }, 'PDF_SECURITY_UNSUPPORTED']
    ];
    for (const [label, edit, code] of faults) {
      const e = parse(metadata()); edit(e);
      try { await damaged(pdf(serialize(e)), code); } catch (error) { error.message = label + ': ' + error.message; throw error; }
    }
    for (const id of [null, 'null', '999 0 R', '[<00><11111111111111111111111111111111>]', '[<00000000000000000000000000000000><00>]', '[42 43]', '<<>>', '[<00000000000000000000000000000000>]']) await damaged(pdf(metadata(), id));
    for (const R of [2,3,4]) {
      const e = parse(metadata(R)); delete e.Length;
      if (R === 4) { e.CF.StdCF.CFM = parse('/V2'); delete e.CF.StdCF.Length; }
      // Legal omitted Length defaults to RC4-40, not a malformed metadata error.
      await assert.rejects(() => X.extract3DStreamsFromPDF(pdf(serialize(e))), e => e.code === 'PDF_PASSWORD_REQUIRED'); cases++;
      await damaged(pdf(metadata(R), null));
    }
    for (const R of [5,6]) {
      for (const field of ['OE','UE','Perms']) for (const bad of [undefined, 1, parse('<00>')]) {
        const e = parse(metadata(R)); e[field] = bad; await damaged(pdf(serialize(e)));
      }
      const e = parse(metadata(R)); e.Length = 128; await damaged(pdf(serialize(e)));
      await assert.rejects(() => X.extract3DStreamsFromPDF(pdf(metadata(R))), e => e.code === 'PDF_PASSWORD_REQUIRED'); cases++;
    }
    // No named filters: missing CF / StmF / StrF legally defaults to Identity.
    const identity = parse(metadata()); delete identity.CF; delete identity.StmF; delete identity.StrF;
    await assert.rejects(() => X.extract3DStreamsFromPDF(pdf(serialize(identity))), e => e.code === 'PDF_PASSWORD_REQUIRED'); cases++;
    await damaged(pdf('null')); await damaged(pdf('2 0 R'));
    const nested = Buffer.from(pdf(metadata())).toString('latin1').replace('/Encrypt 2 0 R', '/Encrypt << /Nested ' + '['.repeat(70) + '0' + ']'.repeat(70) + ' >>');
    await damaged(U(B(nested))); // /Encrypt is latched even if its value cannot be parsed.

    // Direct stream-level /Crypt metadata must not silently become Identity.
    const d = new X._Doc(U([]), {}); d.crypt = {method:'None'}; d.cryptFilters = {Identity:'None'}; d.rawStream = () => U([]);
    await assert.rejects(() => d.streamData({value:parse('<< /Filter /Crypt /DecodeParms << /Name 3 >> >>')}), e => e.code === 'PDF_DAMAGED'); cases++;

    // Unforeseen exceptions after /Encrypt must be typed by the PDF layer.
    const brokenObject = new X._Doc(U([]), {}); brokenObject.trailer = parse('<< /Encrypt null >>'); brokenObject.offsets.set(1,0);
    brokenObject.parseIndirectAt = () => { throw new TypeError('synthetic object parser failure'); };
    assert.throws(() => brokenObject.getObj(1), e => e.code === 'PDF_DAMAGED' && e.encrypted); cases++;
    const open = X._Doc.prototype.open;
    for (const failure of [new TypeError('synthetic unexpected exception'), null, Object.freeze(Object.assign(new Error('Damaged encrypted PDF: synthetic frozen error.'), {code:'PDF_DAMAGED'}))]) {
      X._Doc.prototype.open = async function () { this.trailer = parse('<< /Encrypt null >>'); throw failure; };
      try { await damaged(pdf(metadata())); } finally { X._Doc.prototype.open = open; }
    }
    // App defense also refuses generic exceptions / empty results from a future PDF-layer regression.
    const original = X.extract3DStreamsFromPDF;
    for (const outcome of ['throw','empty']) {
      X.extract3DStreamsFromPDF = async () => { if (outcome === 'throw') throw new TypeError('synthetic app boundary exception'); return []; };
      await api.loadPDFBuffer(pdf(metadata()), 'encrypted.pdf', {prompt:false});
      assert.equal(window.PDF3D.lastLoad.reasonCode, 'PDF_DAMAGED'); cases++;
    }
    // The same generic failure on an unencrypted file still invokes the legacy scanner.
    X.extract3DStreamsFromPDF = async () => { throw new TypeError('synthetic plaintext fallback'); };
    await api.loadPDFBuffer(U(fs.readFileSync(path.join(ROOT, 'sample-cad-assembly-3d.pdf'))), 'plain.pdf');
    assert.equal(window.PDF3D.lastLoad.status, 'ok');
    assert.equal(await X.hasEncryption(U(fs.readFileSync(path.join(ROOT, 'sample-cad-assembly-3d.pdf')))), false);
    assert.ok(warnings.some(a => String(a[0]).includes('falling back to legacy'))); cases++;
    X.extract3DStreamsFromPDF = original; warnings.length = 0;
    if (external) {
      const dir = process.env.PDF3D_SECURITY_REPRO || '/workspace/pdf-3d-extractor-qa/v190/repro';
      if (!fs.existsSync(path.join(dir, 'r3-base.pdf'))) console.log('SKIP external Tester ID fixtures: absent');
      else for (const n of ['r3','r4rc4','r4aes']) {
        const base = U(fs.readFileSync(path.join(dir, n + '-base.pdf')));
        const control = await X.extract3DStreamsFromPDF(base); assert.equal(control.length, 2);
        await api.loadPDFBuffer(base, n + '-base.pdf', {prompt:false}); assert.equal(window.PDF3D.lastLoad.status,'ok'); cases++;
        await damaged(U(fs.readFileSync(path.join(dir, n + '-idref.pdf'))));
        const streamData = X._Doc.prototype.streamData;
        X._Doc.prototype.streamData = async function () { throw new TypeError('synthetic post-authentication exception'); };
        try { await damaged(base); } finally { X._Doc.prototype.streamData = streamData; }

        const indirect = await revised(X, base, () => {}, true);
        const streams = await X.extract3DStreamsFromPDF(indirect);
        assert.deepEqual(streams.map(s => Buffer.from(s.rawBytes)), control.map(s => Buffer.from(s.rawBytes))); cases++;
        // Adjacent real-file mutations retain xrefs and encrypted stream bytes.
        const relevant = n === 'r3' ? faults.filter((f, i) => i < 15 || /metadata boolean|unknown handler/.test(f[0])) : faults;
        for (const [label, edit, code] of relevant) {
          try { await damaged(await revised(X, base, edit), code); } catch (error) { error.message = n + ' ' + label + ': ' + error.message; throw error; }
        }
        console.log(`${page}: ${n}: base OK (U3D + PRC), dangling ID typed, valid indirect ID byte-identical, ${relevant.length} malformed-entry checks`);
      }
    }
    console.log(`${page}: encrypted metadata / fail-closed checks passed`);
  }
  console.log(`OK ${cases} focused encrypted-metadata cases`); return cases;
}
module.exports = {run};
if (require.main === module) run({loadApp: require('./run').loadApp, pages: ['index.html','pdf-3d-extractor-standalone.html'], external:true}).catch(e => { console.error(e); process.exitCode=1; });
