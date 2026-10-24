'use strict';
/*
 * pdf-extract.js - PDF layer of pdf-3d-extractor (MIT): finds and decodes embedded 3D streams; used by app.js extract3DStreamsFromPDF().
 *
 * What it fixes (each found by the regression corpus, see corpus/MANIFEST.md "Failures"):
 *  F1  Real object parser instead of "lastIndexOf('<<') within 1024 chars": nested dictionaries inside a 3D
 *      stream dict (/VA [<< /Type /3DView .. >>], Asymptote/media9/HOOPS) made /Subtype and /Filter invisible.
 *  F2  /DecodeParms predictors (PNG 10-15, TIFF 2) applied after FlateDecode; also ASCIIHex, ASCII85, LZW, RunLength.
 *  F3  PDF Standard security handler with the empty user password (owner-password-only files):
 *      RC4 40/128 (R2/R3), V4 AESV2 / V2 crypt filters (R4), AESV3 (R5 and R6 / ISO 32000-2 Algorithm 2.B).
 *  F4  Annotation-driven discovery: /3D annots (/3DD stream or /3DRef), /RichMedia annots (RichMediaContent /Assets
 *      name tree -> filespec /EF), with xref tables, xref streams, object streams (ObjStm) and incremental updates;
 *      brute-force object scan as fallback for damaged xref.
 * Returns the same objects as app.js ({index, subtype, filter, compressedLength, rawBytes, title}) plus
 * {objNum, page, annot, container, encrypted, sameAs}.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./crypto-lite'));
  else root.PDF3DExtract = factory(root.CryptoLite);
})(typeof self !== 'undefined' ? self : this, function (C) {
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
  const num = (v, d) => (typeof v === 'number' ? v : d);

  // ---------------- document ----------------
  class Doc {
    constructor(u8, opts) { this.d = u8; this.opts = opts || {}; this.offsets = new Map(); this.inObjStm = new Map(); this.cache = new Map(); this.objStmCache = new Map(); this.trailer = {}; this.crypt = null; this.log = []; }
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
      return objs.has(n) ? { num: n, gen: 0, value: objs.get(n), stream: false } : null;
    }
    resolve(v) { let k = 0; while (v instanceof Ref && k++ < 32) v = this.getSync(v.num); return v; }
    // --- encryption (ISO 32000-2 7.6) ---
    async initCrypt() {
      const E = this.resolve(this.trailer.Encrypt); if (!E || !isName(E.Filter, 'Standard')) { this.cryptError = 'unsupported security handler ' + (E && E.Filter && E.Filter.name); return; }
      const V = num(E.V, 0), R = num(E.R, 2); const O = this.strBytes(E.O), U = this.strBytes(E.U);
      const id0 = this.trailer.ID ? this.strBytes(this.resolve(this.trailer.ID)[0]) : new Uint8Array(0);
      let method = 'RC4', keyLen = V === 1 ? 5 : num(E.Length, 40) / 8;
      if (V >= 4) { const cf = this.resolve(E.CF) || {}; const stmf = (E.StmF && E.StmF.name) || 'Identity'; this.stmIdentity = stmf === 'Identity';
        const f = this.resolve(cf[stmf]) || {}; const cfm = f.CFM && f.CFM.name; method = cfm === 'AESV2' ? 'AES' : cfm === 'AESV3' ? 'AES256' : cfm === 'None' ? 'None' : 'RC4'; if (f.Length) keyLen = f.Length > 32 ? f.Length / 8 : f.Length; if (method === 'AES') keyLen = 16;
        this.efMethod = (E.EFF && E.EFF.name && this.resolve(cf[E.EFF.name])) ? ((this.resolve(cf[E.EFF.name]).CFM || {}).name) : null; }
      let key;
      if (R >= 5) {
        const pw = new Uint8Array(0); // empty user password (owner-password-only files)
        const vs = U.subarray(32, 40), ks = U.subarray(40, 48); const h = await this.hash2B(pw, vs, R, null);
        if (!eq(h, U.subarray(0, 32))) { this.cryptError = 'user password is not empty (cannot open without it)'; return; }
        const ik = await this.hash2B(pw, ks, R, null); key = C.aesCbcDecrypt(ik, this.strBytes(E.UE), new Uint8Array(16), false); method = 'AES256';
      } else {
        const PAD = Uint8Array.from([0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A]);
        const P = num(E.P, 0); const buf = [...PAD, ...O.subarray(0, 32), P & 255, (P >>> 8) & 255, (P >>> 16) & 255, (P >>> 24) & 255, ...id0];
        if (R >= 4 && E.EncryptMetadata === false) buf.push(255, 255, 255, 255);
        key = C.md5(Uint8Array.from(buf)); if (R >= 3) for (let i = 0; i < 50; i++) key = C.md5(key.subarray(0, keyLen)); key = key.subarray(0, keyLen);
        // verify (Algorithm 4/5)
        let ok; if (R === 2) ok = eq(C.rc4(key, PAD), U.subarray(0, 32));
        else { let x = C.rc4(key, C.md5(Uint8Array.from([...PAD, ...id0]))); for (let i = 1; i <= 19; i++) x = C.rc4(key.map((b) => b ^ i), x); ok = eq(x.subarray(0, 16), U.subarray(0, 16)); }
        if (!ok) { this.cryptError = 'user password is not empty (cannot open without it)'; return; }
      }
      this.crypt = { key, method, R, V }; this.log.push(`decrypt: Standard R${R} V${V} ${method} key ${key.length * 8} bit (empty user password)`);
    }
    async hash2B(pw, salt, R, udata) {
      let K = await C.sha('SHA-256', cat(pw, salt, udata || new Uint8Array(0))); if (R === 5) return K;
      for (let round = 0; ; round++) {
        const K1one = cat(pw, K, udata || new Uint8Array(0)); const K1 = new Uint8Array(K1one.length * 64); for (let i = 0; i < 64; i++) K1.set(K1one, i * K1one.length);
        const E = C.aesCbcEncryptNoPad(K.subarray(0, 16), K1, K.subarray(16, 32));
        let m = 0; for (let i = 0; i < 16; i++) m += E[i]; m %= 3;
        K = await C.sha(m === 0 ? 'SHA-256' : m === 1 ? 'SHA-384' : 'SHA-512', E);
        if (round >= 63 && E[E.length - 1] <= round - 32) break;
      }
      return K.subarray(0, 32);
    }
    strBytes(v) { v = this.resolve(v); return v instanceof Str ? v.bytes : new Uint8Array(0); }
    decryptFor(num_, gen, data, isEF) {
      const c = this.crypt; if (!c || (this.stmIdentity && !isEF)) return data; if (isEF && this.efMethod === 'None') return data;
      if (c.method === 'AES256') return C.aesCbcDecrypt(c.key, data);
      const k = cat(c.key, Uint8Array.from([num_ & 255, (num_ >> 8) & 255, (num_ >> 16) & 255, gen & 255, (gen >> 8) & 255]), c.method === 'AES' ? Uint8Array.from([0x73, 0x41, 0x6C, 0x54]) : new Uint8Array(0));
      const ok = C.md5(k).subarray(0, Math.min(c.key.length + 5, 16));
      return c.method === 'AES' ? C.aesCbcDecrypt(ok, data) : C.rc4(ok, data);
    }
    async streamData(o, isEF) {
      let data = this.rawStream(o); const v = o.value; const isXref = isName(v.Type, 'XRef');
      if (this.crypt && !isXref) data = this.decryptFor(o.num, o.gen, data, isEF);
      const filters = [].concat(this.resolve(v.Filter) || []).map((f) => this.resolve(f)).filter(Boolean).map((f) => f.name);
      const parms = [].concat(this.resolve(v.DecodeParms || v.DP) || []).map((x) => this.resolve(x));
      const applied = [];
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i], p = parms[i] || (filters.length === 1 ? parms[0] : null);
        if (f === 'FlateDecode' || f === 'Fl') { data = await inflate(data, this.opts.inflate); data = predictor(data, p); }
        else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
        else if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
        else if (f === 'LZWDecode' || f === 'LZW') { data = lzw(data, p && p.EarlyChange === 0 ? 0 : 1); data = predictor(data, p); }
        else if (f === 'RunLengthDecode' || f === 'RL') data = runLength(data);
        else if (f === 'Crypt') { /* Identity crypt filter */ } else throw new Error('unsupported filter /' + f);
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

  async function extract3DStreamsFromPDF(u8, fileName, opts) {
    opts = opts || {};
    const head = latin1(u8, 0, 4);
    if (head.startsWith('U3D') || head.startsWith('PRC')) { const st = head.startsWith('U3D') ? 'U3D' : 'PRC'; return [{ index: 0, subtype: st, filter: `None (Raw ${st})`, compressedLength: u8.length, rawBytes: u8, title: fileName || `Direct ${st} Stream` }]; }
    const doc = new Doc(u8, opts); doc._objStmDecoded = null;
    await doc.open();
    // object streams need async decode (inflate + decryption): pre-decode every ObjStm we know about
    const stmNums = new Set([...doc.inObjStm.values()].map((x) => x.stm)); const dec = new Map();
    for (const sn of stmNums) { const so = doc.getObj(sn); if (so && so.stream) { try { dec.set(sn, (await doc.streamData(so)).data); } catch (e) { doc.log.push(`ObjStm ${sn}: ${e.message}`); } } }
    doc._objStmDecoded = (so) => dec.get(so.num); doc.cache.clear(); doc.objStmCache.clear();
    if (!doc.trailer.Root) await doc.scanObjects(true);
    if (doc.trailer.Encrypt && !doc.crypt) { await doc.initCrypt(); doc.cache.clear(); }
    if (doc.cryptError) { const e = new Error('Encrypted PDF: ' + doc.cryptError); e.code = 'PDF_ENCRYPTED'; throw e; }

    const found = []; const seenObj = new Map();
    const take = async (ref, meta, isEF) => {
      if (!(ref instanceof Ref)) return; const o = doc.getObj(ref.num); if (!o || !o.stream) return;
      if (seenObj.has(ref.num)) { seenObj.get(ref.num).refs.push(meta); return; }
      let r; try { r = await doc.streamData(o, isEF); } catch (e) { doc.log.push(`obj ${ref.num}: ${e.message}`); return; }
      const h = latin1(r.data, 0, 4); const st = h.startsWith('U3D') ? 'U3D' : h.startsWith('PRC') ? 'PRC' : null;
      const entry = { st, o, r, meta, refs: [meta] }; seenObj.set(ref.num, entry); if (st) found.push(entry);
      else doc.log.push(`obj ${ref.num} (${meta.container}) is not U3D/PRC (head ${[...r.data.subarray(0, 4)].map((b) => b.toString(16)).join(' ')})`);
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
    const bySha = new Map();
    return found.map((e, i) => {
      const fp = e.r.data.length + ':' + latin1(e.r.data, 0, 64) + latin1(e.r.data, Math.max(0, e.r.data.length - 64)); const same = bySha.get(fp); if (same === undefined) bySha.set(fp, i);
      return { index: i, subtype: e.st, filter: e.r.filters.join(' + ') || 'None', compressedLength: doc.rawStream(e.o).length, rawBytes: e.r.data,
        title: `${e.meta.title || '3D Stream'} #${i + 1} (${e.st}, ${e.meta.container}${e.meta.page ? ' p' + e.meta.page : ''})`, objNum: e.o.num, page: e.meta.page, annot: e.meta.annot,
        container: e.meta.container, annotations: e.refs.length, encrypted: !!doc.crypt, sameAs: same, log: i === 0 ? doc.log : undefined };
    });
  }
  return { extract3DStreamsFromPDF, _Doc: Doc, _Parser: Parser, _predictor: predictor };
});
