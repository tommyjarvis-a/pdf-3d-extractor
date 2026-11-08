'use strict';
/*
 * pdf-extract.js - PDF layer of pdf-3d-extractor (MIT): finds and decodes embedded 3D streams; used by app.js extract3DStreamsFromPDF().
 *
 * What it fixes (each found by the regression corpus, see corpus/MANIFEST.md "Failures"):
 *  F1  Real object parser instead of "lastIndexOf('<<') within 1024 chars": nested dictionaries inside a 3D
 *      stream dict (/VA [<< /Type /3DView .. >>], Asymptote/media9/HOOPS) made /Subtype and /Filter invisible.
 *  F2  /DecodeParms predictors (PNG 10-15, TIFF 2) applied after FlateDecode; also ASCIIHex, ASCII85, LZW, RunLength.
 *  F3  PDF Standard security handler with local user/owner passwords and automatic empty-user authentication:
 *      RC4 40/128 (R2/R3), V4 AESV2 / V2 crypt filters (R4), AESV3 (R5 and R6 / ISO 32000-2 Algorithm 2.B).
 *  F4  Annotation-driven discovery: /3D annots (/3DD stream or /3DRef), /RichMedia annots (RichMediaContent /Assets
 *      name tree -> filespec /EF), with xref tables, xref streams, object streams (ObjStm) and incremental updates;
 *      brute-force object scan as fallback for damaged xref.
 * Returns the same objects as app.js ({index, subtype, filter, compressedLength, rawBytes, title}) plus
 * {objNum, page, annot, container, encrypted, sameAs}.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crypto-lite'), require('./saslprep'));
  else root.PDF3DExtract = factory(root.CryptoLite, root.PDF3DSASLprep);
})(typeof self !== 'undefined' ? self : this, function (C, preparePassword) {
  const WS = new Uint8Array(256); [0, 9, 10, 12, 13, 32].forEach((c) => (WS[c] = 1));
  const DELIM = new Uint8Array(256); '()<>[]{}/%'.split('').forEach((c) => (DELIM[c.charCodeAt(0)] = 1));
  class Ref { constructor(n, g) { this.num = n; this.gen = g; } }
  class Name { constructor(s) { this.name = s; } }
  class Str { constructor(b) { this.bytes = b; } }
  const latin1 = (u8, a = 0, b = u8.length) => { let s = ''; for (let i = a; i < b; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(b, i + 32768))); return s; };
  const isName = (v, n) => v instanceof Name && v.name === n;

  // ---------------- lexer / object parser ----------------
  class Parser {
    constructor(u8, pos) { this.d = u8; this.p = pos || 0; }
    skipWS() { const d = this.d; for (;;) { while (this.p < d.length && WS[d[this.p]]) this.p++; if (d[this.p] === 37) { while (this.p < d.length && d[this.p] !== 10 && d[this.p] !== 13) this.p++; } else break; } }
    token() { // returns raw keyword/number token string
      const d = this.d; const s = this.p; while (this.p < d.length && !WS[d[this.p]] && !DELIM[d[this.p]]) this.p++; return latin1(d, s, this.p);
    }
    parse(depth = 0) {
      if (depth > 64) throw new Error('PDF: nesting too deep');
      this.skipWS(); const d = this.d, c = d[this.p];
      if (c === 60 && d[this.p + 1] === 60) { // dict
        this.p += 2; const o = {};
        for (;;) { this.skipWS(); if (d[this.p] === 62 && d[this.p + 1] === 62) { this.p += 2; break; } if (this.p >= d.length) break;
          const k = this.parse(depth + 1); if (!(k instanceof Name)) { if (k === undefined) break; continue; } o[k.name] = this.parse(depth + 1); }
        return o;
      }
      if (c === 91) { this.p++; const a = []; for (;;) { this.skipWS(); if (d[this.p] === 93) { this.p++; break; } if (this.p >= d.length) break; a.push(this.parse(depth + 1)); } return a; }
      if (c === 47) { this.p++; const s = this.p; while (this.p < d.length && !WS[d[this.p]] && !DELIM[d[this.p]]) this.p++;
        return new Name(latin1(d, s, this.p).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))); }
      if (c === 40) return this.litString();
      if (c === 60) { this.p++; const s = this.p; while (this.p < d.length && d[this.p] !== 62) this.p++; const hex = latin1(d, s, this.p).replace(/[^0-9a-fA-F]/g, ''); this.p++;
        const b = new Uint8Array((hex.length + 1) >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt((hex.substr(i * 2, 2) + '0').slice(0, 2), 16); return new Str(b); }
      if (c === 41 || c === 62 || c === 93 || c === 125 || c === 123) { this.p++; return undefined; }
      const t = this.token(); if (!t) { this.p++; return undefined; }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) {
        if (/^\d+$/.test(t)) { // maybe "n g R"
          const save = this.p; this.skipWS(); const s2 = this.p; const t2 = this.token();
          if (/^\d+$/.test(t2)) { this.skipWS(); if (this.d[this.p] === 82 && (this.p + 1 >= d.length || WS[d[this.p + 1]] || DELIM[d[this.p + 1]])) { this.p++; return new Ref(+t, +t2); } }
          this.p = save; void s2;
        }
        return parseFloat(t);
      }
      if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
      return { kw: t };
    }
    litString() {
      const d = this.d; this.p++; let depth = 1; const out = [];
      while (this.p < d.length) {
        let c = d[this.p++];
        if (c === 92) { c = d[this.p++]; const m = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[c];
          if (m !== undefined) out.push(m); else if (c >= 48 && c <= 55) { let v = c - 48; for (let k = 0; k < 2 && d[this.p] >= 48 && d[this.p] <= 55; k++) v = v * 8 + d[this.p++] - 48; out.push(v & 255); }
          else if (c === 13) { if (d[this.p] === 10) this.p++; } else if (c !== 10) out.push(c); continue; }
        if (c === 40) depth++; else if (c === 41 && --depth === 0) break; out.push(c);
      }
      return new Str(Uint8Array.from(out));
    }
  }

  // ---------------- filters ----------------
  async function inflate(u8, inflateFn) {
    if (inflateFn) { try { const r = await inflateFn(u8); if (r && r !== u8) return r; } catch (_) {} }
    if (typeof require === 'function') { try { const z = require('zlib'); return new Uint8Array(z.inflateSync(Buffer.from(u8), { finishFlush: z.constants.Z_SYNC_FLUSH })); } catch (_) {} }
    if (typeof DecompressionStream !== 'undefined') { // tolerate trailing garbage: read chunks until error
      for (const fmt of ['deflate', 'deflate-raw']) {
        try { const ds = new DecompressionStream(fmt); const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
          const r = ds.readable.getReader(); const parts = []; let n = 0;
          try { for (;;) { const { value, done } = await r.read(); if (done) break; parts.push(value); n += value.length; } } catch (e) { if (!n) throw e; }
          const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } if (n) return out; } catch (_) {}
      }
    }
    throw new Error('FlateDecode: inflate failed');
  }
  function predictor(data, parms) {
    const pred = num(parms && parms.Predictor, 1); if (pred < 2) return data;
    const colors = num(parms.Colors, 1), bpc = num(parms.BitsPerComponent, 8), cols = num(parms.Columns, 1);
    const bpp = Math.max(1, (colors * bpc + 7) >> 3), rowLen = (colors * bpc * cols + 7) >> 3;
    if (pred === 2) { const out = data.slice(); if (bpc !== 8) return out; for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255; return out; }
    const rows = Math.floor(data.length / (rowLen + 1)); const out = new Uint8Array(rows * rowLen); const prev = new Uint8Array(rowLen);
    for (let r = 0; r < rows; r++) {
      const ft = data[r * (rowLen + 1)]; const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)); const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
      for (let i = 0; i < rowLen; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = src[i];
        if (ft === 1) v += a; else if (ft === 2) v += b; else if (ft === 3) v += (a + b) >> 1;
        else if (ft === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        cur[i] = v & 255;
      }
      prev.set(cur);
    }
    return out;
  }
  function asciiHex(u8) { const s = latin1(u8).replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, ''); const o = new Uint8Array((s.length + 1) >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt((s.substr(i * 2, 2) + '0').slice(0, 2), 16); return o; }
  function ascii85(u8) { const s = latin1(u8).replace(/^\s*<~/, '').replace(/~>.*$/s, '').replace(/\s+/g, ''); const out = []; let g = [];
    for (const ch of s) { if (ch === 'z' && !g.length) { out.push(0, 0, 0, 0); continue; } g.push(ch.charCodeAt(0) - 33); if (g.length === 5) { let v = 0; for (const x of g) v = v * 85 + x; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); g = []; } }
    if (g.length) { const n = g.length; while (g.length < 5) g.push(84); let v = 0; for (const x of g) v = v * 85 + x; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
    return Uint8Array.from(out); }
  function lzw(u8, early = 1) { const out = []; let dict = [], bits = 9, buf = 0, nb = 0, prev = null; const reset = () => { dict = []; for (let i = 0; i < 256; i++) dict.push([i]); dict.push(null, null); bits = 9; };
    reset(); for (let i = 0; i < u8.length; i++) { buf = (buf << 8) | u8[i]; nb += 8; while (nb >= bits) { const code = (buf >>> (nb - bits)) & ((1 << bits) - 1); nb -= bits;
      if (code === 256) { reset(); prev = null; continue; } if (code === 257) return Uint8Array.from(out);
      let e = dict[code]; if (!e) e = prev.concat([prev[0]]); out.push(...e); if (prev) dict.push(prev.concat([e[0]])); prev = e;
      if (dict.length + early >= (1 << bits) && bits < 12) bits++; } } return Uint8Array.from(out); }
  function runLength(u8) { const o = []; for (let i = 0; i < u8.length;) { const n = u8[i++]; if (n === 128) break; if (n < 128) { for (let k = 0; k <= n; k++) o.push(u8[i++]); } else { const b = u8[i++]; for (let k = 0; k < 257 - n; k++) o.push(b); } } return Uint8Array.from(o); }
  // ISO32000 PDFDocEncoding; table cross-checked against libqpdf String decoding.
  const PDFDOC = "\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007\b\t\n\u000b\f\r\u000e\u000f\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017\u02d8\u02c7\u02c6\u02d9\u02dd\u02db\u02da\u02dc !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\ufffd\u2022\u2020\u2021\u2026\u2014\u2013\u0192\u2044\u2039\u203a\u2212\u2030\u201e\u201c\u201d\u2018\u2019\u201a\u2122\ufb01\ufb02\u0141\u0152\u0160\u0178\u017d\u0131\u0142\u0153\u0161\u017e\ufffd\u20ac\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\ufffd\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff";
  const num = (v, d) => (typeof v === 'number' ? v : d);

  // ---------------- document ----------------
  class Doc {
    constructor(u8, opts) { this.d = u8; this.opts = { ...(opts || {}) }; this.offsets = new Map(); this.inObjStm = new Map(); this.cache = new Map(); this.objStmCache = new Map(); this.trailer = {}; this.crypt = null; this.log = []; }
    async open() {
      try { await this.readXrefChain(); } catch (e) { this.log.push('xref: ' + e.message); }
      if (!this.offsets.size && !this.inObjStm.size) await this.scanObjects(); else await this.scanObjects(true);
      if (this.trailer.Encrypt) await this.initCrypt();
    }
    // --- xref ---
    async readXrefChain() {
      const tail = latin1(this.d, Math.max(0, this.d.length - 2048)); const m = tail.match(/startxref\s+(\d+)\s*%%EOF\s*$/) || [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
      if (!m) throw new Error('no startxref'); let off = +m[1]; const seen = new Set(); let first = true;
      while (off != null && off > 0 && off < this.d.length && !seen.has(off)) {
        seen.add(off); let tr;
        const p = new Parser(this.d, off); p.skipWS();
        if (latin1(this.d, p.p, p.p + 4) === 'xref') tr = this.readXrefTable(p);
        else tr = await this.readXrefStream(off);
        if (first) { this.trailer = tr; first = false; } else for (const k of ['Encrypt', 'ID', 'Root', 'Info']) if (!(k in this.trailer) && k in tr) this.trailer[k] = tr[k];
        if (typeof tr.XRefStm === 'number') { try { await this.readXrefStream(tr.XRefStm); } catch (_) {} }
        off = typeof tr.Prev === 'number' ? tr.Prev : null;
      }
    }
    setOff(n, v, objstm) { if (this.offsets.has(n) || this.inObjStm.has(n)) return; if (objstm) this.inObjStm.set(n, v); else this.offsets.set(n, v); }
    readXrefTable(p) {
      p.p += 4; for (;;) { p.skipWS(); const save = p.p; const t = p.token(); if (t === 'trailer') break; if (!/^\d+$/.test(t)) throw new Error('bad xref table');
        p.skipWS(); const cnt = +p.token(); let start = +t;
        for (let i = 0; i < cnt; i++) { p.skipWS(); const line = latin1(this.d, p.p, p.p + 20); const mm = line.match(/^(\d{10}) (\d{5}) ([nf])/); if (!mm) { p.p = save; throw new Error('bad xref entry'); }
          if (mm[3] === 'n' && +mm[1] > 0) this.setOff(start + i, +mm[1]); p.p += 18; } }
      return p.parse();
    }
    async readXrefStream(off) {
      const o = this.parseIndirectAt(off); if (!o || !o.stream || !isName(o.value.Type, 'XRef')) throw new Error('not an xref stream at ' + off);
      return this._xrefSync(o.value, o.value.W, o.value.Index || [0, o.value.Size], o);
    }
    async _xrefSync(dict, W, idx, o) {
      // xref streams are never encrypted
      const raw = this.rawStream(o); const filt = [].concat(dict.Filter || []).map((f) => f.name);
      let data = raw; if (filt.includes('FlateDecode')) data = await inflate(raw, this.opts.inflate); data = predictor(data, [].concat(dict.DecodeParms || [])[0]);
      const rec = W[0] + W[1] + W[2]; let pos = 0;
      for (let k = 0; k < idx.length; k += 2) for (let i = 0; i < idx[k + 1]; i++, pos += rec) {
        if (pos + rec > data.length) break; const f = (n, o2) => { let v = 0; for (let j = 0; j < n; j++) v = v * 256 + data[pos + o2 + j]; return v; };
        const type = W[0] ? f(W[0], 0) : 1, a = f(W[1], W[0]), b = f(W[2], W[0] + W[1]); const n = idx[k] + i;
        if (type === 1 && a > 0) this.setOff(n, a); else if (type === 2) this.setOff(n, { stm: a, idx: b }, true);
      }
      return dict;
    }
    async scanObjects(onlyMissing) { // fallback / supplement: brute-force "n g obj"
      const s = latin1(this.d); const re = /(?:^|[^0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b/g; let m; const found = new Map();
      while ((m = re.exec(s))) found.set(+m[1], m.index + m[0].indexOf(m[1]));
      for (const [n, off] of found) { if (onlyMissing && (this.offsets.has(n) || this.inObjStm.has(n))) continue; this.offsets.set(n, off); }
      if (!onlyMissing) { const t = s.lastIndexOf('trailer'); if (t >= 0) { try { this.trailer = new Parser(this.d, t + 7).parse(); } catch (_) {} } }
      if (!this.trailer.Root) for (const [n, off] of found) { const o = this.parseIndirectAt(off); if (o && o.value && isName(o.value.Type, 'XRef')) { Object.assign(this.trailer, o.value); try { await this._xrefSync(o.value, o.value.W, o.value.Index || [0, o.value.Size], o); } catch (_) {} } }
      if (!this.trailer.Root) for (const [n] of found) { const v = this.getSync(n); if (v && isName(v.Type, 'Catalog')) { this.trailer.Root = new Ref(n, 0); break; } }
    }
    parseIndirectAt(off) {
      const p = new Parser(this.d, off); p.skipWS(); const n = p.token(); p.skipWS(); const g = p.token(); p.skipWS(); const kw = p.token();
      if (kw !== 'obj') return null; const value = p.parse(); p.skipWS();
      const save = p.p; const t = p.token();
      if (t === 'stream' && value && typeof value === 'object') { let s = p.p; if (this.d[s] === 13) s++; if (this.d[s] === 10) s++; return { num: +n, gen: +g, value, stream: true, dataStart: s }; }
      p.p = save; return { num: +n, gen: +g, value, stream: false };
    }
    rawStream(o) {
      let len = o.value.Length; if (len instanceof Ref) len = this.getSync(len.num);
      const d = this.d; let end;
      if (typeof len === 'number' && len >= 0 && o.dataStart + len <= d.length) { const t = latin1(d, o.dataStart + len, Math.min(d.length, o.dataStart + len + 40)); if (/^\s*endstream/.test(t)) end = o.dataStart + len; }
      if (end === undefined) { const s = latin1(d, o.dataStart, Math.min(d.length, o.dataStart + (typeof len === 'number' ? len + 4096 : d.length)));
        let i = s.indexOf('endstream'); if (i < 0) i = s.length; end = o.dataStart + i; if (d[end - 1] === 10) end--; if (d[end - 1] === 13) end--; }
      return d.subarray(o.dataStart, end);
    }
    getObj(n) { // {value, stream?, num, gen}
      if (this.cache.has(n)) return this.cache.get(n);
      let r = null;
      if (this.offsets.has(n)) { try { r = this.parseIndirectAt(this.offsets.get(n)); } catch (_) {} if (r && r.num !== n) r = null; }
      if (!r && this.inObjStm.has(n)) { const { stm, idx } = this.inObjStm.get(n); r = this.fromObjStm(stm, idx, n); }
      // 1.6.2: strings of an encrypted file are decrypted with their object's key (not inside object streams, whose
      // stream is decrypted as a whole; not the /Encrypt dictionary or an XRef stream's dictionary)
      if (r && this.crypt && !r.inStm && this.strMethod !== 'None' && !(this.encNum === n) && !(r.value && isName(r.value.Type, 'XRef'))) r.value = this.decryptStrings(r.value, r.num, r.gen, 0);
      this.cache.set(n, r); return r;
    }
    getSync(n) { const o = this.getObj(n); return o ? o.value : undefined; }
    fromObjStm(stmNum, idx, n) {
      let objs = this.objStmCache.get(stmNum);
      if (!objs) {
        const so = this.getObj(stmNum); if (!so || !so.stream) return null;
        const data = this._objStmDecoded ? this._objStmDecoded(so) : null; if (!data) return null;
        const N = so.value.N, First = so.value.First; const hp = new Parser(data, 0); const hdr = [];
        for (let i = 0; i < N; i++) { const a = hp.parse(), b = hp.parse(); hdr.push([a, b]); }
        objs = new Map(); for (const [on, off] of hdr) { try { objs.set(on, new Parser(data, First + off).parse()); } catch (_) {} }
        this.objStmCache.set(stmNum, objs);
      }
      return objs.has(n) ? { num: n, gen: 0, value: objs.get(n), stream: false, inStm: true } : null;
    }
    resolve(v) { let k = 0; while (v instanceof Ref && k++ < 32) v = this.getSync(v.num); return v; }
    // --- encryption (ISO 32000-2 7.6) ---
    async initCrypt() {
      const fail = (code, message) => { const e = new Error(message); e.code = code; throw e; };
      const unsupported = message => fail('PDF_SECURITY_UNSUPPORTED', 'Unsupported PDF security: ' + message);
      if (this.trailer.Encrypt instanceof Ref) this.encNum = this.trailer.Encrypt.num;
      const E = this.resolve(this.trailer.Encrypt);
      if (!E || !isName(E.Filter, 'Standard')) unsupported('certificate/public-key security or DRM handler (only Standard password security is supported)');
      const V = num(E.V, 0), R = num(E.R, 0);
      if (!({2:[1],3:[2,3],4:[4],5:[5],6:[5]})[R]?.includes(V)) unsupported('unhandled revision/version');
      if (!Number.isInteger(E.P)) fail('PDF_DAMAGED','Damaged PDF permissions dictionary');
      const O = this.strBytes(E.O), U = this.strBytes(E.U);
      if (O.length < (R >= 5 ? 48 : 32) || U.length < (R >= 5 ? 48 : 32)) fail('PDF_DAMAGED', 'Damaged PDF encryption dictionary');
      let keyLen = R === 2 ? 5 : R >= 5 ? 32 : num(E.Length, 40) / 8;
      if (!Number.isInteger(keyLen) || keyLen < 5 || (R < 5 && keyLen > 16)) unsupported('invalid encryption key length');
      const cf = this.resolve(E.CF) || {};
      this.cryptFilters = { Identity: 'None' };
      for (const name of Object.keys(cf)) {
        const f = this.resolve(cf[name]); const method = ({V2:'RC4',AESV2:'AES',AESV3:'AES256',None:'None'})[f?.CFM?.name];
        if (!method || (R < 5 && method === 'AES256') || (R >= 5 && !['AES256','None'].includes(method))) unsupported('unhandled crypt filter');
        if (method !== 'None' && f.Length && (f.Length > 32 ? f.Length / 8 : f.Length) !== keyLen) unsupported('incompatible crypt-filter key length');
        if (method === 'AES' && keyLen !== 16) unsupported('AESV2 requires a 128-bit key');
        this.cryptFilters[name] = method;
      }
      const filter = name => { if (!Object.prototype.hasOwnProperty.call(this.cryptFilters,name)) unsupported('unknown crypt filter name'); return this.cryptFilters[name]; };
      const method = V >= 4 ? filter(E.StmF?.name || 'Identity') : 'RC4';
      this.strMethod = V >= 4 ? filter(E.StrF?.name || 'Identity') : 'RC4';
      this.efMethod = V >= 4 && E.EFF ? filter(E.EFF.name) : method;
      this.encryptMetadata = R < 4 || E.EncryptMetadata !== false;
      const supplied = Object.prototype.hasOwnProperty.call(this.opts, 'password');
      const password = supplied ? String(this.opts.password) : ''; delete this.opts.password;
      // Password bytes live only in this invocation/document, never in exported records/logs.
      let key;
      if (R >= 5) {
        let pw;
        try { pw = new TextEncoder().encode(R === 6 ? preparePassword(password) : password).subarray(0,127); }
        catch (_) { fail(supplied ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED', 'Password could not authenticate this PDF'); }
        const user = eq(await this.hash2B(pw, U.subarray(32,40), R, null), U.subarray(0,32));
        const owner = !user && eq(await this.hash2B(pw, O.subarray(32,40), R, U.subarray(0,48)), O.subarray(0,32));
        if (!user && !owner) fail(supplied ? 'PDF_PASSWORD_INCORRECT' : 'PDF_PASSWORD_REQUIRED', supplied ? 'Incorrect PDF password. Try again or Cancel.' : 'This PDF needs a password.');
        const entry = user ? U : O, encryptedKey = this.strBytes(user ? E.UE : E.OE);
        if (encryptedKey.length !== 32) fail('PDF_DAMAGED','Damaged PDF encrypted file key');
        key = C.aesCbcDecrypt(await this.hash2B(pw, entry.subarray(40,48), R, user ? null : U.subarray(0,48)), encryptedKey, new Uint8Array(16), false);
        const perms = this.strBytes(E.Perms);
        if (perms.length !== 16) fail('PDF_DAMAGED','Damaged PDF permissions block');
        const dec = C.aesCbcDecrypt(key, perms, new Uint8Array(16), false), P = num(E.P,0);
        if (dec[9] !== 97 || dec[10] !== 100 || dec[11] !== 98 || dec[8] !== (this.encryptMetadata ? 84 : 70) || !dec.subarray(4,8).every(x=>x===255) || !dec.subarray(0,4).every((x,i)=>x===((P >>> (i*8)) & 255))) fail('PDF_DAMAGED','Damaged PDF permissions validation');
      } else {
        const PAD = Uint8Array.from([0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0,0x4E,0x56,0xFF,0xFA,1,8,0x2E,0x2E,0,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);
        const pad = bytes => cat(bytes, PAD).subarray(0,32);
        // Legacy Standard passwords are byte strings, not UTF-8. Reject unrepresentable input.
        const legacy = Array.from(password).map(c=>PDFDOC.indexOf(c));
        const bytes = Uint8Array.from(legacy);
        const representable = legacy.every(c=>c>=0) && !password.includes('\ufffd');
        const id0 = this.trailer.ID ? this.strBytes(this.resolve(this.trailer.ID)[0]) : new Uint8Array(0), P = num(E.P,0);
        const derive = padded => {
          let k = C.md5(cat(padded,O.subarray(0,32),Uint8Array.of(P&255,(P>>>8)&255,(P>>>16)&255,(P>>>24)&255),id0,R>=4&&!this.encryptMetadata?Uint8Array.of(255,255,255,255):new Uint8Array(0)));
          if (R>=3) for(let i=0;i<50;i++) k=C.md5(k.subarray(0,keyLen)); return k.subarray(0,keyLen);
        };
        const check = k => {
          if(R===2) return eq(C.rc4(k,PAD),U.subarray(0,32));
          let x=C.rc4(k,C.md5(cat(PAD,id0))); for(let i=1;i<=19;i++) x=C.rc4(k.map(b=>b^i),x); return eq(x.subarray(0,16),U.subarray(0,16));
        };
        key=derive(pad(bytes));
        if (!representable || !check(key)) {
          let digest=C.md5(pad(bytes)); if(R>=3) for(let i=0;i<50;i++) digest=C.md5(digest);
          const ownerKey=digest.subarray(0,keyLen); let recovered=O.subarray(0,32);
          if(R===2) recovered=C.rc4(ownerKey,recovered); else for(let i=19;i>=0;i--) recovered=C.rc4(ownerKey.map(b=>b^i),recovered);
          key=derive(recovered);
          if (!representable || !check(key)) fail(supplied ? 'PDF_PASSWORD_INCORRECT':'PDF_PASSWORD_REQUIRED', supplied?'Incorrect PDF password. Try again or Cancel.':'This PDF needs a password.');
        }
      }
      this.crypt = { key, method, R, V };
      this.log.push(`decrypt: Standard R${R} V${V} ${method} (${key.length*8} bit)`);
    }
    async hash2B(pw, salt, R, udata) {
      let K = await C.sha('SHA-256', cat(pw, salt, udata || new Uint8Array(0))); if (R === 5) return K;
      for (let round = 0; ; round++) {
        const K1one = cat(pw, K, udata || new Uint8Array(0)); const K1 = new Uint8Array(K1one.length * 64); for (let i = 0; i < 64; i++) K1.set(K1one, i * K1one.length);
        const E = C.aesCbcEncryptNoPad(K.subarray(0, 16), K1, K.subarray(16, 32));
        let m = 0; for (let i = 0; i < 16; i++) m += E[i]; m %= 3;
        K = await C.sha(m === 0 ? 'SHA-256' : m === 1 ? 'SHA-384' : 'SHA-512', E);
        if (round >= 63 && E[E.length - 1] <= round - 31) break;
      }
      return K.subarray(0, 32);
    }
    strBytes(v) { v = this.resolve(v); return v instanceof Str ? v.bytes : new Uint8Array(0); }
    // strings: the string crypt filter (V4+ /StrF; V1-3 the file's method); a string that fails to decrypt stays as it was
    decryptStrings(v, num_, gen, depth) {
      if (depth > 64 || v == null || typeof v !== 'object') return v;
      if (v instanceof Str) { if (!v.bytes.length) return v;
        try { return new Str(this.decryptWith(this.strMethod || this.crypt.method,num_,gen,v.bytes)); }
        catch (e) { if (e.code !== 'PDF_DAMAGED') throw e; this.log.push(`Damaged optional encrypted string in object ${num_}; omitted (3D stream decryption remains strict)`); return new Str(new Uint8Array(0)); } }
      if (v instanceof Ref || v instanceof Name) return v;
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = this.decryptStrings(v[i], num_, gen, depth + 1); return v; }
      for (const k of Object.keys(v)) { if (k === 'Contents' && isName(v.Type,'Sig')) continue; v[k] = this.decryptStrings(v[k], num_, gen, depth + 1); } return v;
    }
    decryptWith(method, num_, gen, data) {
      const c = this.crypt; if (method === 'None') return data;
      if (method === 'AES256') { try { return C.aesCbcDecrypt(c.key,data); } catch (_) { const e=new Error('Damaged encrypted PDF stream or string');e.code='PDF_DAMAGED';throw e; } }
      const k = cat(c.key, Uint8Array.from([num_ & 255, (num_ >> 8) & 255, (num_ >> 16) & 255, gen & 255, (gen >> 8) & 255]), method === 'AES' ? Uint8Array.from([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0));
      const ok = C.md5(k).subarray(0, Math.min(c.key.length + 5, 16));
      if (method !== 'AES') return C.rc4(ok,data);
      try { return C.aesCbcDecrypt(ok,data); } catch (_) { const e=new Error('Damaged encrypted PDF stream or string');e.code='PDF_DAMAGED';throw e; }
    }
    decryptFor(num_, gen, data, isEF) {
      return this.decryptWith(isEF ? this.efMethod : this.crypt.method, num_, gen, data);
    }
    async streamData(o, isEF) {
      let data = this.rawStream(o); const v = o.value; const isXref = isName(v.Type, 'XRef');
      const filters = [].concat(this.resolve(v.Filter) || []).map(f=>this.resolve(f)).filter(Boolean).map(f=>f.name);
      const parms = [].concat(this.resolve(v.DecodeParms || v.DP) || []).map(x=>this.resolve(x));
      if (filters.includes('Crypt') && (filters[0] !== 'Crypt' || filters.lastIndexOf('Crypt') !== 0)) { const e=new Error('Unsupported PDF security: Crypt must be the first and only crypt filter'); e.code='PDF_SECURITY_UNSUPPORTED'; throw e; }
      const encrypted = this.crypt && !isXref && !(isName(v.Type,'Metadata') && !this.encryptMetadata);
      if (encrypted && !filters.includes('Crypt')) data = this.decryptFor(o.num,o.gen,data,isEF);
      const applied = [];
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i], p = parms[i] || (filters.length === 1 ? parms[0] : null);
        if (f === 'FlateDecode' || f === 'Fl') { data = await inflate(data, this.opts.inflate); data = predictor(data, p); }
        else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
        else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
        else if (f === 'LZWDecode' || f === 'LZW') { data = lzw(data, p && p.EarlyChange === 0 ? 0 : 1); data = predictor(data, p); }
        else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
        else if (f === 'Crypt') {
          const name = p?.Name?.name || 'Identity'; const method = this.cryptFilters?.[name] || (name === 'Identity' ? 'None' : null);
          if (!method || (!encrypted && method !== 'None')) { const e=new Error('Unsupported PDF security: unknown Crypt filter'); e.code='PDF_SECURITY_UNSUPPORTED'; throw e; }
          if (encrypted) data=this.decryptWith(method,o.num,o.gen,data);
        } else throw new Error('unsupported filter /' + f);
        applied.push(f + (p && p.Predictor > 1 ? `(Predictor ${p.Predictor})` : ''));
      }
      return { data, filters: applied };
    }
  }
  const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

  // ---------------- 3D discovery ----------------
  function textOf(doc, v) { v = doc.resolve(v); if (v instanceof Str) { const b = v.bytes; if (b[0] === 254 && b[1] === 255) { let s = ''; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; } return latin1(b); } return v && v.name ? v.name : ''; }
  function nameTreeValues(doc, node, out, depth = 0) { node = doc.resolve(node); if (!node || depth > 32) return out;
    if (Array.isArray(node.Names)) for (let i = 0; i + 1 < node.Names.length; i += 2) out.push([textOf(doc, node.Names[i]), node.Names[i + 1]]);
    if (Array.isArray(node.Kids)) for (const k of node.Kids) nameTreeValues(doc, k, out, depth + 1); return out; }
  function pagesOf(doc) { const root = doc.resolve(doc.trailer.Root); const out = []; const seen = new Set();
    const walk = (n, d) => { if (d > 64) return; const ref = n; n = doc.resolve(n); if (!n || (ref instanceof Ref && seen.has(ref.num))) return; if (ref instanceof Ref) seen.add(ref.num);
      if (Array.isArray(n.Kids)) for (const k of n.Kids) walk(k, d + 1); else out.push(n); };
    if (root && root.Pages) walk(root.Pages, 0); return out; }

  // 1.6.2: attachmentDetails[].isCAD: exactly these extensions, case-insensitive (the name's suffix is lower-cased first)
  const CAD_EXT = new Set(['stp', 'step', 'igs', 'iges', 'jt', 'x_t', 'x_b', 'sat', 'sab', '3dxml', 'stl', 'prt', 'catpart', 'catproduct', 'sldprt', 'sldasm', 'ipt', 'iam', 'vds']);
  async function extract3DStreamsFromPDF(u8, fileName, opts) {
    opts = opts || {};
    const head = latin1(u8, 0, 4);
    if (head.startsWith('U3D') || head.startsWith('PRC')) { const st = head.startsWith('U3D') ? 'U3D' : 'PRC'; return [{ index: 0, subtype: st, filter: `None (Raw ${st})`, compressedLength: u8.length, rawBytes: u8, title: fileName || `Direct ${st} Stream` }]; }
    const doc = new Doc(u8, opts); doc._objStmDecoded = null;
    await doc.open();
    // object streams need async decode (inflate + decryption): pre-decode every ObjStm we know about
    const stmNums = new Set([...doc.inObjStm.values()].map((x) => x.stm)); const dec = new Map();
    for (const sn of stmNums) { const so = doc.getObj(sn); if (so && so.stream) { try { dec.set(sn, (await doc.streamData(so)).data); } catch (e) { if (/^PDF_/.test(e.code || '')) throw e; doc.log.push(`ObjStm ${sn}: ${e.message}`); } } }
    doc._objStmDecoded = (so) => dec.get(so.num); doc.cache.clear(); doc.objStmCache.clear();
    if (!doc.trailer.Root) await doc.scanObjects(true);
    if (doc.trailer.Encrypt && !doc.crypt) { await doc.initCrypt(); doc.cache.clear(); }
    if (doc.cryptError) { const e = new Error('Encrypted PDF: ' + doc.cryptError); e.code = 'PDF_ENCRYPTED'; throw e; }

    const found = []; const seenObj = new Map(); const bad = []; // bad: 3D streams (a /3D annotation's /3DD, or a /Subtype /U3D|/PRC stream) that are not U3D/PRC data
    const dictSubtype = (o) => (o && o.value ? (isName(o.value.Subtype, 'PRC') ? 'PRC' : isName(o.value.Subtype, 'U3D') ? 'U3D' : null) : null);
    const take = async (ref, meta, isEF) => {
      if (!(ref instanceof Ref)) return; const o = doc.getObj(ref.num); if (!o || !o.stream) return;
      if (seenObj.has(ref.num)) { seenObj.get(ref.num).refs.push(meta); return; }
      const claims3D = meta.container === '/3D' || (meta.container === 'stream scan');
      let r; try { r = await doc.streamData(o, isEF); } catch (e) { if (/^PDF_/.test(e.code || '')) throw e; doc.log.push(`obj ${ref.num}: ${e.message}`);
        if (claims3D) { seenObj.set(ref.num, { st: null, o, r: null, meta, refs: [meta] }); bad.push({ o, meta, data: new Uint8Array(0), why: `the 3D stream (obj ${ref.num}) could not be decoded: ${e.message}` }); } return; }
      const h = latin1(r.data, 0, 4); const st = h.startsWith('U3D') ? 'U3D' : h.startsWith('PRC') ? 'PRC' : null;
      const entry = { st, o, r, meta, refs: [meta] }; seenObj.set(ref.num, entry); if (st) found.push(entry);
      else { const hex = [...r.data.subarray(0, 4)].map((b) => b.toString(16)).join(' ');
        doc.log.push(`obj ${ref.num} (${meta.container}) is not U3D/PRC (head ${hex})`);
        if (claims3D) bad.push({ o, meta, r, data: r.data, why: `the 3D stream (obj ${ref.num}, ${r.data.length} bytes) is not U3D or PRC data (starts with ${hex || 'nothing'})` }); }
    };
    const pages = pagesOf(doc);
    for (let pi = 0; pi < pages.length; pi++) {
      const annots = doc.resolve(pages[pi].Annots); if (!Array.isArray(annots)) continue;
      for (let ai = 0; ai < annots.length; ai++) {
        const a = doc.resolve(annots[ai]); if (!a) continue; const title = textOf(doc, a.NM) || textOf(doc, a.Contents) || textOf(doc, a.T);
        if (isName(a.Subtype, '3D')) {
          let dd = a['3DD']; const ddv = doc.resolve(dd); if (ddv && !ddv.Length && ddv['3DD']) dd = ddv['3DD']; // /3DRef dictionary
          await take(dd, { container: '/3D', page: pi + 1, annot: ai, title });
        } else if (isName(a.Subtype, 'RichMedia')) {
          const rc = doc.resolve(a.RichMediaContent) || {}; const assets = nameTreeValues(doc, rc.Assets, []);
          for (const [nm, fsRef] of assets) { const fsd = doc.resolve(fsRef) || {}; const ef = doc.resolve(fsd.EF) || {}; await take(ef.F || ef.UF, { container: '/RichMedia', page: pi + 1, annot: ai, title: nm || title }, true); }
        }
      }
    }
    if (!found.length || opts.scanAll) { // fallback: any stream object that is a 3D stream / embedded file with 3D magic
      for (const n of [...doc.offsets.keys()].sort((a, b) => a - b)) {
        if (seenObj.has(n)) continue; const o = doc.getObj(n); if (!o || !o.stream) continue; const v = o.value;
        const is3D = isName(v.Subtype, 'U3D') || isName(v.Subtype, 'PRC') || isName(v.Type, '3D'); const isEF = isName(v.Type, 'EmbeddedFile');
        if (is3D || isEF) await take(new Ref(n, o.gen), { container: is3D ? 'stream scan' : 'EmbeddedFile scan', page: null, annot: null, title: '' }, isEF);
      }
    }
    // embedded files (catalog /EmbeddedFiles name tree, /FileAttachment annotations, PDF 2.0 /AF associated files): offered as downloads
    const attachments = []; const seenEF = new Set();
    const takeFS = async (fsRef, where) => {
      const fsd = doc.resolve(fsRef); if (!fsd || typeof fsd !== 'object' || fsd instanceof Str) return; // a plain-string file spec embeds nothing
      const ef = doc.resolve(fsd.EF) || {}; const refs = [ef.UF, ef.F].filter((r, i, a) => r instanceof Ref && a.findIndex((x) => x instanceof Ref && x.num === r.num) === i);
      if (!refs.length || refs.some((r) => seenEF.has(r.num))) return; for (const r of refs) seenEF.add(r.num);
      const name = textOf(doc, fsd.UF) || textOf(doc, fsd.F) || ('attachment-' + refs[0].num);
      // /UF is preferred; when its stream is missing or does not decode, a distinct /F stream is tried before giving up
      let data = null, error = null, errorName = null, o = null, sref = refs[0];
      for (const r of refs) { const oo = doc.getObj(r.num);
        if (!oo || !oo.stream) { if (!error) { error = 'embedded file stream missing (object ' + r.num + ')'; errorName = 'Error'; } continue; }
        try { data = (await doc.streamData(oo, true)).data; o = oo; sref = r; error = null; errorName = null; break; } catch (e) { if (/^PDF_/.test(e.code || '')) throw e; if (!o) { o = oo; sref = r; } error = e.message; errorName = (e && e.name) || 'Error'; data = null; } }
      const ext = (/\.([A-Za-z0-9_]+)$/.exec(name) || [, ''])[1].toLowerCase();
      const sub = o && o.value && doc.resolve(o.value.Subtype); const mime = sub instanceof Name && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(sub.name) ? sub.name.toLowerCase() : null;
      const params = o && o.value && doc.resolve(o.value.Params); const declaredSize = params && typeof doc.resolve(params.Size) === 'number' ? doc.resolve(params.Size) : null;
      attachments.push({ name, ext, isCAD: CAD_EXT.has(ext), bytes: data, size: data ? data.length : 0, error, errorName, mime, declaredSize, objNum: sref.num, where, description: textOf(doc, fsd.Desc) || '' });
    };
    const takeAF = async (af, where) => { af = doc.resolve(af); if (Array.isArray(af)) for (const f of af) await takeFS(f, where); };
    try {
      const root = doc.resolve(doc.trailer.Root) || {}; const names = doc.resolve(root.Names) || {};
      for (const [, fsRef] of nameTreeValues(doc, names.EmbeddedFiles, [])) await takeFS(fsRef, 'EmbeddedFiles');
      await takeAF(root.AF, 'AF catalog');
      for (let pi = 0; pi < pages.length; pi++) { await takeAF(pages[pi].AF, 'AF p' + (pi + 1)); const annots = doc.resolve(pages[pi].Annots); if (!Array.isArray(annots)) continue;
        for (const ar of annots) { const a = doc.resolve(ar); if (!a || typeof a !== 'object') continue;
          if (isName(a.Subtype, 'FileAttachment')) await takeFS(a.FS, 'FileAttachment p' + (pi + 1));
          await takeAF(a.AF, 'AF annot p' + (pi + 1)); } }
      for (const e of seenObj.values()) if (!e.st && e.meta && e.meta.container === '/RichMedia') { /* non-3D RichMedia assets (e.g. .swf/.js) are not CAD */ }
    } catch (e) { if (/^PDF_/.test(e.code || '')) throw e; doc.log.push('attachments: ' + e.message); }
    const bySha = new Map();
    if (!found.length && bad.length) { // 3D content is declared but unreadable: report it (the app shows DECODE_ERROR), not "no 3D"
      const out = bad.map((e, i) => { const st = dictSubtype(e.o);
        return { index: i, subtype: st || 'U3D', declaredSubtype: st, filter: e.r ? (e.r.filters.join(' + ') || 'None') : 'undecodable', compressedLength: doc.rawStream(e.o).length, rawBytes: e.data,
          title: `${e.meta.title || '3D Stream'} #${i + 1} (damaged, ${e.meta.container}${e.meta.page ? ' p' + e.meta.page : ''})`, objNum: e.o.num, page: e.meta.page, annot: e.meta.annot,
          container: e.meta.container, annotations: 1, encrypted: !!doc.crypt, sameAs: undefined, badHeader: e.why, log: i === 0 ? doc.log : undefined }; });
      out.attachments = attachments; out.log = doc.log; out.securityHandled = !!doc.trailer.Encrypt; return out;
    }
    const out = found.map((e, i) => {
      const fp = e.r.data.length + ':' + latin1(e.r.data, 0, 64) + latin1(e.r.data, Math.max(0, e.r.data.length - 64)); const same = bySha.get(fp); if (same === undefined) bySha.set(fp, i);
      return { index: i, subtype: e.st, filter: e.r.filters.join(' + ') || 'None', compressedLength: doc.rawStream(e.o).length, rawBytes: e.r.data,
        title: `${e.meta.title || '3D Stream'} #${i + 1} (${e.st}, ${e.meta.container}${e.meta.page ? ' p' + e.meta.page : ''})`, objNum: e.o.num, page: e.meta.page, annot: e.meta.annot,
        extractionWarning: doc.log.some(x=>/^Damaged optional encrypted string/.test(x)) ? 'Some optional PDF text could not be decrypted; 3D streams were decrypted separately.' : undefined,
        container: e.meta.container, annotations: e.refs.length, encrypted: !!doc.crypt, sameAs: same, log: i === 0 ? doc.log : undefined };
    });
    out.attachments = attachments; out.log = doc.log; out.securityHandled = !!doc.trailer.Encrypt;
    return out;
  }
  return { extract3DStreamsFromPDF, _Doc: Doc, _Parser: Parser, _predictor: predictor };
});
