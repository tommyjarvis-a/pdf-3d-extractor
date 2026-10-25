/**
 * 3D PDF -> CAD Geometry Extractor & B-Rep Workbench (app.js) v1.4.0
 * Supports:
 *  - PDF 1.7 /3D (/Subtype /U3D & /Subtype /PRC) + /RichMedia stream extraction & FlateDecode decompression
 *  - ECMA-363 (U3D) binary stream parser (NoCompression & BitStreamRead arithmetic contexts)
 *  - ISO 14739-1 (PRC) binary stream parser (B-Rep & tessellation payloads)
 *  - Coplanar B-Rep Face Merger (reconstructs outer + inner hole boundary loops & analytic cylinders/planes)
 *  - CAD Exporters:
 *      1. Parasolid XT (.x_t) - ASCII transmit format, SCH_1200000_120060, meter scaling (1e-3 m/mm, UIO=1000)
 *      2. STEP AP214 (.stp) - ISO 10303-21 MANIFOLD_SOLID_BREP / CLOSED_SHELL / ADVANCED_FACE
 *      3. Binary & ASCII STL (.stl)
 *      4. Wavefront OBJ (.obj)
 *      5. IGES 5.3 Wireframe (.igs)
 *      6. Raw .u3d / .prc stream download
 */
(function () {
  'use strict';

  const APP_VERSION = '1.4.0';
  if (typeof window !== 'undefined') window.CAD3DExtractorVersion = APP_VERSION;

  // Parasolid XT (.x_t) export is hidden from the UI pending an NX compatibility fix (NX reports the
  // output as corrupt). The exporter (buildParasolidXT) is retained and stays on the programmatic API.
  // For dev testing, append ?xt=1 to the page URL to bring back the export button and inspector tab.
  const ENABLE_XT_EXPORT = false;
  const XT_UI_ENABLED = ENABLE_XT_EXPORT || (() => {
    try {
      const loc = typeof window !== 'undefined' && window.location;
      return !!(loc && typeof URLSearchParams !== 'undefined' && new URLSearchParams(loc.search || '').get('xt') === '1');
    } catch (e) { return false; }
  })();

  const PALETTE = [
    [0.22, 0.58, 0.88],
    [0.16, 0.80, 0.65],
    [0.95, 0.64, 0.18],
    [0.68, 0.52, 0.96],
    [0.94, 0.36, 0.48],
    [0.24, 0.78, 0.92]
  ];

  const state = {
    wires: [], tree: null, attachments: [],
    fileName: 'sample-cad-assembly-3d.pdf',
    fileSize: 0,
    streams: [],
    activeStreamIdx: 0,
    parts: [],
    selectedPartIdx: -1,
    units: 'mm',          // 'mm' | 'in' | 'm'
    brepMode: 'merged',   // 'merged' | 'faceted'
    renderMode: 'shaded-edges',
    explodeFactor: 0,
    activeTab: 'step',   // 'xt' tab only exists with ?xt=1 (see ENABLE_XT_EXPORT)
    camera: {
      mode: 'free',        // 'free' (quaternion arcball, unclamped) | 'turntable' (Z-up, pitch clamped); persisted
      q: null,             // world->view quaternion [w,x,y,z] for 'free' mode
      yaw: -0.68,
      pitch: 0.52,
      zoom: 1.0,
      panX: 0,
      panY: 0,
      Dragging: false,
      dragMode: 'orbit',
      lastX: 0,
      lastY: 0
    },
    cachedXT: null,
    cachedSTEP: null
  };

  // -------------------------------------------------------------------------
  // 1. Decompression Helpers (Browser DecompressionStream + pure-JS fallback)
  // -------------------------------------------------------------------------
  async function inflateFlateStream(uint8) {
    if (typeof require === 'function') {
      try {
        const zlib = require('zlib');
        return new Uint8Array(zlib.inflateSync(Buffer.from(uint8)));
      } catch (_) {
        try {
          const zlib = require('zlib');
          return new Uint8Array(zlib.inflateRawSync(Buffer.from(uint8)));
        } catch (__) {}
      }
    }
    // Browser DecompressionStream using Blob.stream().pipeThrough() to prevent TransformStream backpressure deadlock on large >64KB 3D streams
    for (const fmt of ['deflate', 'deflate-raw']) {
      try {
        if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
          const stream = new Blob([uint8]).stream().pipeThrough(new DecompressionStream(fmt));
          const ab = await new Response(stream).arrayBuffer();
          return new Uint8Array(ab);
        }
      } catch (_) {}
    }
    if (uint8.length > 6 && (uint8[0] & 0x0f) === 8) {
      try {
        if (typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined') {
          const slice = uint8.subarray(2, uint8.length - 4);
          const stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          const ab = await new Response(stream).arrayBuffer();
          return new Uint8Array(ab);
        }
      } catch (_) {}
    }
    return uint8;
  }

  function asciiSlice(u8, start, end) {
    let s = '';
    const lim = Math.min(u8.length, end);
    for (let i = Math.max(0, start); i < lim; i++) {
      s += String.fromCharCode(u8[i]);
    }
    return s;
  }

  // -------------------------------------------------------------------------
  // 2. PDF /3D & /RichMedia Stream Extractor
  // -------------------------------------------------------------------------
  // PDF layer lives in pdf-extract.js (object parser, xref streams/ObjStm, filters+predictors, Standard security
  // handler with empty user password, /3D + /RichMedia annotation walk). The old regex scanner remains as fallback.
  async function extract3DStreamsFromPDF(u8, fileName) {
    const X = getModule('PDF3DExtract', 'pdf-extract.js');
    let attachments = [];
    if (X) {
      try {
        const res = await X.extract3DStreamsFromPDF(u8, fileName, { inflate: inflateFlateStream });
        if (res && res.length) return res;
        attachments = (res && res.attachments) || [];
      } catch (err) {
        console.warn('pdf-extract failed, falling back to legacy scanner:', err);
      }
    }
    const legacy = await extract3DStreamsFromPDFLegacy(u8, fileName);
    if (!legacy.attachments) legacy.attachments = attachments;
    return legacy;
  }

  async function extract3DStreamsFromPDFLegacy(u8, fileName) {
    const streams = [];

    // Direct raw .u3d or .prc binary file support
    if (u8.length >= 4) {
      const magic4 = asciiSlice(u8, 0, 4);
      if (magic4.startsWith('U3D')) {
        streams.push({
          index: 0,
          subtype: 'U3D',
          filter: 'None (Raw U3D)',
          compressedLength: u8.length,
          rawBytes: u8,
          title: fileName || 'Direct U3D Stream'
        });
        return streams;
      }
      if (magic4.startsWith('PRC')) {
        streams.push({
          index: 0,
          subtype: 'PRC',
          filter: 'None (Raw PRC)',
          compressedLength: u8.length,
          rawBytes: u8,
          title: fileName || 'Direct PRC Stream'
        });
        return streams;
      }
    }

    const pdfLatin1 = asciiSlice(u8, 0, u8.length);

    // Pre-index indirect integer objects (e.g. "15 0 obj 123456 endobj") so "/Length 15 0 R" resolves accurately
    const indirectLengths = new Map();
    const indObjRegex = /(\d+)\s+(\d+)\s+obj[\s\r\n]+(\d+)[\s\r\n]+endobj/g;
    let indMatch;
    while ((indMatch = indObjRegex.exec(pdfLatin1)) !== null) {
      indirectLengths.set(`${indMatch[1]}_${indMatch[2]}`, parseInt(indMatch[3], 10));
    }

    let searchPos = 0;
    let streamIdx = 0;

    while (searchPos < pdfLatin1.length) {
      const streamTokenIdx = pdfLatin1.indexOf('stream', searchPos);
      if (streamTokenIdx === -1) break;

      // Ensure 'stream' is not part of 'endstream'
      if (streamTokenIdx >= 3 && pdfLatin1.slice(streamTokenIdx - 3, streamTokenIdx) === 'end') {
        searchPos = streamTokenIdx + 6;
        continue;
      }

      // Check header dictionary preceding 'stream' (look back up to 1024 chars)
      const dictStart = Math.max(0, streamTokenIdx - 1024);
      const dictWindow = pdfLatin1.slice(dictStart, streamTokenIdx);
      const dictOpenIdx = dictWindow.lastIndexOf('<<');
      const dictStr = dictOpenIdx !== -1 ? dictWindow.slice(dictOpenIdx) : dictWindow;

      // Advance past 'stream\r\n' or 'stream\n'
      let dataStart = streamTokenIdx + 6;
      if (u8[dataStart] === 13 && u8[dataStart + 1] === 10) dataStart += 2;
      else if (u8[dataStart] === 10 || u8[dataStart] === 13) dataStart += 1;
      else {
        searchPos = streamTokenIdx + 6;
        continue;
      }

      // Determine stream end using indirect /Length, direct /Length, or 'endstream'
      let declaredLen = 0;
      const lenRefMatch = dictStr.match(/\/Length\s+(\d+)\s+(\d+)\s+R\b/);
      const lenDirectMatch = dictStr.match(/\/Length\s+(\d+)(?!\s+\d+\s+R\b)/);
      if (lenRefMatch) {
        const refKey = `${lenRefMatch[1]}_${lenRefMatch[2]}`;
        if (indirectLengths.has(refKey)) {
          declaredLen = indirectLengths.get(refKey);
        }
      } else if (lenDirectMatch) {
        declaredLen = parseInt(lenDirectMatch[1], 10);
      }

      let dataEnd = -1;
      if (declaredLen > 0 && dataStart + declaredLen <= u8.length) {
        // Verify 'endstream' is near dataStart + declaredLen; if not, scan forward to actual endstream
        const tailCheck = asciiSlice(u8, dataStart + declaredLen, Math.min(u8.length, dataStart + declaredLen + 32));
        if (tailCheck.includes('endstream')) {
          dataEnd = dataStart + declaredLen;
        }
      }
      if (dataEnd === -1) {
        const endStreamIdx = pdfLatin1.indexOf('endstream', dataStart);
        if (endStreamIdx === -1) break;
        dataEnd = endStreamIdx;
        if (u8[dataEnd - 2] === 13 && u8[dataEnd - 1] === 10) dataEnd -= 2;
        else if (u8[dataEnd - 1] === 10 || u8[dataEnd - 1] === 13) dataEnd -= 1;
      }

      const is3DDict =
        /\/Subtype\s*\/U3D\b/i.test(dictStr) ||
        /\/Subtype\s*\/PRC\b/i.test(dictStr) ||
        /\/Type\s*\/3D\b/i.test(dictStr);

      const hasFlate = /\/Filter\s*(?:\[\s*)?\/FlateDecode\b/i.test(dictStr);
      const rawSlice = u8.subarray(dataStart, dataEnd);

      if (is3DDict || rawSlice.length > 24) {
        let candidateBytes = null;
        let filterLabel = hasFlate ? 'FlateDecode' : 'Uncompressed';

        if (!hasFlate && rawSlice.length >= 4) {
          const head4 = asciiSlice(rawSlice, 0, 4);
          if (head4.startsWith('U3D') || head4.startsWith('PRC')) {
            candidateBytes = rawSlice;
          }
        }

        if (!candidateBytes && (is3DDict || hasFlate)) {
          try {
            const inflated = await inflateFlateStream(rawSlice);
            if (inflated && inflated.length >= 4) {
              const head4 = asciiSlice(inflated, 0, 4);
              if (head4.startsWith('U3D') || head4.startsWith('PRC')) {
                candidateBytes = inflated;
                filterLabel = 'FlateDecode';
              }
            }
          } catch (_) {
            // Not a valid Flate 3D stream
          }
        }

        if (candidateBytes) {
          const magic = asciiSlice(candidateBytes, 0, 3);
          const subtype = magic === 'PRC' ? 'PRC' : 'U3D';
          streams.push({
            index: streamIdx++,
            subtype,
            filter: filterLabel,
            compressedLength: rawSlice.length,
            rawBytes: candidateBytes,
            title: `3D Stream #${streamIdx} (${subtype})`
          });
        }
      }

      searchPos = Math.max(dataEnd + 9, streamTokenIdx + 6);
    }

    return streams;
  }

  // -------------------------------------------------------------------------
  // 3. ECMA-363 (U3D) Binary & Arithmetic Range Bitstream Decoder
  // -------------------------------------------------------------------------
  const U3D_HALF_MASK = [
    0x00000000, 0x00000001, 0x00000003, 0x00000007,
    0x0000000f, 0x0000001f, 0x0000003f, 0x0000007f,
    0x000000ff, 0x000001ff, 0x000003ff, 0x000007ff,
    0x00000fff, 0x00001fff, 0x00003fff, 0x00007fff,
    0x0000ffff
  ];
  const U3D_NOT_HALF_MASK = [
    0xffffffff, 0xfffffffe, 0xfffffffc, 0xfffffff8,
    0xfffffff0, 0xffffffe0, 0xffffffc0, 0xffffff80,
    0xffffff00, 0xfffffe00, 0xfffffc00, 0xfffff800,
    0xfffff000, 0xffffe000, 0xffffc000, 0xffff8000,
    0xffff0000
  ];
  const U3D_SWAP8 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
  const U3D_READ_COUNT = [4, 3, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];
  const U3D_FAST_NOT_MASK = [0xffffffff, 0xffff7fff, 0xffff3fff, 0xffff1fff, 0xffff0fff];

  const U3D_AC_STATIC_FULL = 0x00000400;
  const U3D_CTX_BASE_SHADING_ID = 1;
  const U3D_CTX_SPLIT_POS_INDEX = 2; // uACContextNewPositionDiffMag = 2? No, see below

  // Exact ECMA-363 context IDs from Intel U3D IFXACContext.h
  const U3D_CTX = {
    BaseShadingID: 1,
    NewPosDiffSign: 2,
    NewPosDiffMagX: 3,
    NewPosDiffMagY: 4,
    NewPosDiffMagZ: 5,
    NewNormalCnt: 6,
    NewNormalDiffSign: 7,
    NewNormalDiffMagX: 8,
    NewNormalDiffMagY: 9,
    NewNormalDiffMagZ: 10,
    NewFacesCount: 11,
    OrientChange: 12,
    FaceType: 13,
    ShadingChange: 14,
    NewShadingID: 15,
    DupCornerIndex: 16,
    NormalLocalIndex: 17,
    DiffColorSign: 18,
    DiffColorMagR: 19,
    DiffColorMagG: 20,
    DiffColorMagB: 21,
    DiffColorMagA: 22,
    SpecColorSign: 23,
    SpecColorMagR: 24,
    SpecColorMagG: 25,
    SpecColorMagB: 26,
    SpecColorMagA: 27,
    TexCoordSign: 28,
    TexCoordMagU: 29,
    TexCoordMagV: 30,
    TexCoordMagS: 31,
    TexCoordMagT: 32,
    StayOrMove: 33,
    PositionDiffSign: 34,
    PositionDiffMagX: 35,
    PositionDiffMagY: 36,
    PositionDiffMagZ: 37,
    NormalDiffSign: 38,
    NormalDiffMagX: 39,
    NormalDiffMagY: 40,
    NormalDiffMagZ: 41,
    DiffColorSplitIndex: 42,
    SpecColorSplitIndex: 43,
    TexCoordSplitIndex: 44,
    ColorLocalIndex: 45,
    TexCoordLocalIndex: 46,
    NumLocalNormals: 6
  };

  class U3DHistogram {
    constructor(symbolLimit = 0x10000) {
      this.symbolLimit = symbolLimit;
      this.freq = new Uint16Array(256);
      this.cum = new Uint32Array(257);
      // Symbol 0 (Escape) starts with frequency 1 per ECMA-363 Section 8.2.5
      this.freq[0] = 1;
      this.totalCount = 1;
      for (let i = 1; i <= 256; i++) this.cum[i] = 1;
    }

    ensureCapacity(sym) {
      if (sym < this.freq.length) return;
      let newLen = this.freq.length;
      const oldLen = this.freq.length;
      while (newLen <= sym) newLen *= 2;
      const nf = new Uint16Array(newLen);
      nf.set(this.freq);
      this.freq = nf;
      const nc = new Uint32Array(newLen + 1);
      nc.set(this.cum);
      for (let i = oldLen + 1; i <= newLen; i++) {
        nc[i] = this.totalCount;
      }
      this.cum = nc;
    }

    addSymbolValue(symbol) {
      if (symbol >= this.symbolLimit) return;
      this.ensureCapacity(symbol);
      if (this.totalCount >= 0x1fff) {
        let total = 0;
        for (let i = 0; i < this.freq.length; i++) {
          this.cum[i] = total;
          if (this.freq[i] > 0) {
            this.freq[i] = (this.freq[i] >> 1) | 1;
            total += this.freq[i];
          }
        }
        this.totalCount = total;
        this.cum[this.freq.length] = total;
      }
      this.freq[symbol] += 1;
      this.totalCount += 1;
      for (let i = symbol + 1; i <= this.freq.length; i++) {
        this.cum[i] += 1;
      }
    }

    getTotalSymbolFreq() {
      return this.totalCount;
    }

    getSymbolFreq(symbol) {
      if (symbol < 0 || symbol >= this.freq.length) return 0;
      return this.freq[symbol];
    }

    getCumSymbolFreq(symbol) {
      if (symbol <= 0) return 0;
      if (symbol >= this.freq.length) return this.totalCount;
      return this.cum[symbol];
    }

    getSymbolFromFreq(cumFreq) {
      if (cumFreq >= this.totalCount) return this.freq.length - 1;
      let lo = 0;
      let hi = this.freq.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (this.cum[mid] <= cumFreq) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    }
  }

  class U3DBitStreamReader {
    constructor(u8, startOffset = 0, byteLen = u8.length - startOffset, noCompression = false) {
      this.noCompression = !!noCompression;
      this.u8 = u8;
      this.startOffset = startOffset;
      this.byteLen = byteLen;

      const wordCount = Math.ceil((byteLen + 16) / 4);
      this.data = new Uint32Array(wordCount);
      for (let i = 0; i < byteLen; i++) {
        this.data[i >> 2] |= (u8[startOffset + i] << ((i & 3) << 3));
      }

      this.bitPos = 0;
      this.high = 0x0000ffff;
      this.low = 0x00000000;
      this.underflowCount = 0;
      this.contexts = new Map();
    }

    get bytePos() {
      return this.startOffset + (this.bitPos >>> 3);
    }

    seek(absOffset) {
      const rel = Math.max(0, absOffset - this.startOffset);
      this.bitPos = rel << 3;
      this.high = 0x0000ffff;
      this.low = 0x00000000;
      this.underflowCount = 0;
    }

    alignToByte() {
      this.bitPos = (this.bitPos + 7) & ~7;
    }

    alignTo4Byte() {
      this.bitPos = (this.bitPos + 31) & ~31;
    }

    align4() {
      this.alignTo4Byte();
    }

    peekBitAt(bp) {
      const w = this.data[bp >>> 5] || 0;
      return (w >>> (bp & 31)) & 1;
    }

    readBit() {
      const b = this.peekBitAt(this.bitPos);
      this.bitPos += 1;
      return b >>> 0;
    }

    peekCode16() {
      let code = this.peekBitAt(this.bitPos) << 15;
      let p = this.bitPos + 1 + this.underflowCount;
      for (let i = 14; i >= 0; i--) {
        code |= (this.peekBitAt(p++) << i);
      }
      return code >>> 0;
    }

    getContext(ctxId) {
      let h = this.contexts.get(ctxId);
      if (!h) {
        h = new U3DHistogram();
        this.contexts.set(ctxId, h);
      }
      return h;
    }

    readSymbol(context) {
      if (this.noCompression || !context || context === 0x3fffffff) {
        return this.readBit();
      }
      let uValue = 0;
      if (context >= U3D_AC_STATIC_FULL) {
        const totalSymbols = context - U3D_AC_STATIC_FULL;
        if (totalSymbols <= 1) return 1;
        const code = this.peekCode16();
        const temp = (this.high + 1 - this.low) >>> 0;
        uValue = Math.floor((((code - this.low + 1) * totalSymbols - 1) / temp)) + 1;
        if (uValue < 1) uValue = 1;
        if (uValue > totalSymbols) uValue = totalSymbols;
        this.high = (this.low + Math.floor((temp * uValue) / totalSymbols) - 1) & 0xffff;
        this.low = (this.low + Math.floor((temp * (uValue - 1)) / totalSymbols)) & 0xffff;
      } else {
        const hist = this.getContext(context);
        const totalCumFreq = hist.getTotalSymbolFreq();
        if (totalCumFreq <= 1) {
          hist.addSymbolValue(0);
          return 0;
        }
        const code = this.peekCode16();
        const range = (this.high + 1 - this.low) >>> 0;
        const codeCumFreq = Math.floor(((totalCumFreq * (code - this.low + 1) - 1) / range));
        uValue = hist.getSymbolFromFreq(codeCumFreq >= 0 ? codeCumFreq : 0);
        const symbolCumFreq = hist.getCumSymbolFreq(uValue);
        const symbolFreq = hist.getSymbolFreq(uValue);
        this.high = (this.low + Math.floor((range * (symbolCumFreq + symbolFreq)) / totalCumFreq) - 1) & 0xffff;
        this.low = (this.low + Math.floor((range * symbolCumFreq) / totalCumFreq)) & 0xffff;
        hist.addSymbolValue(uValue);
      }

      let shifted = false;
      while (((this.high ^ this.low) & 0x8000) === 0) {
        if (!shifted) {
          this.bitPos += 1 + this.underflowCount;
          this.underflowCount = 0;
          shifted = true;
        } else {
          this.bitPos += 1;
        }
        this.low = (this.low << 1) & 0xffff;
        this.high = ((this.high << 1) | 1) & 0xffff;
      }
      while (((~this.high & this.low) & 0x4000) !== 0) {
        this.underflowCount += 1;
        this.low = (this.low << 1) & 0x7fff;
        this.high = ((this.high << 1) & 0x7fff) | 0x8001;
      }
      return uValue >>> 0;
    }

    swapBits8(rValue) {
      return (U3D_SWAP8[rValue & 0xf] << 4) | U3D_SWAP8[(rValue >>> 4) & 0xf];
    }

    readBitCount(count) {
      let value = 0;
      for (let i = 0; i < count; i++) {
        value |= (this.readBit() << i);
      }
      return value >>> 0;
    }

    u8Val() {
      if (this.noCompression) {
        return this.readBitCount(8);
      }
      const sym = this.readSymbol(U3D_AC_STATIC_FULL + 0x100);
      return this.swapBits8((sym - 1) & 0xff) >>> 0;
    }

    u16() {
      const low = this.u8Val();
      const high = this.u8Val();
      return (low | (high << 8)) >>> 0;
    }

    i16() {
      const v = this.u16();
      return v >= 0x8000 ? v - 0x10000 : v;
    }

    u32() {
      const low = this.u16();
      const high = this.u16();
      return ((low | (high << 16)) >>> 0);
    }

    i32() {
      return this.u32() | 0;
    }

    u64() {
      const lo = this.u32();
      const hi = this.u32();
      return lo + hi * 4294967296;
    }

    f32() {
      const bits = this.u32();
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setUint32(0, bits, true);
      return dv.getFloat32(0, true);
    }

    f64() {
      const lo = this.u32();
      const hi = this.u32();
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint32(0, lo, true);
      dv.setUint32(4, hi, true);
      return dv.getFloat64(0, true);
    }

    readCompressedU32(context) {
      if (this.noCompression || !context || context === 0x3fffffff) return this.u32();
      if (context < U3D_AC_STATIC_FULL) {
        const symbol = this.readSymbol(context);
        if (symbol !== 0) {
          return (symbol - 1) >>> 0;
        }
        const val = this.u32();
        this.getContext(context).addSymbolValue(val + 1);
        return val >>> 0;
      } else {
        const symbol = this.readSymbol(context);
        return symbol !== 0 ? (symbol - 1) >>> 0 : this.u32();
      }
    }

    readCompressedU16(context) {
      if (this.noCompression || !context || context === 0x3fffffff) return this.u16();
      if (context < U3D_AC_STATIC_FULL) {
        const symbol = this.readSymbol(context);
        if (symbol !== 0) {
          return (symbol - 1) & 0xffff;
        }
        const val = this.u16();
        this.getContext(context).addSymbolValue(val + 1);
        return val & 0xffff;
      } else {
        const symbol = this.readSymbol(context);
        return symbol !== 0 ? (symbol - 1) & 0xffff : this.u16();
      }
    }

    readCompressedU8(context) {
      if (this.noCompression || !context || context === 0x3fffffff) return this.u8Val();
      if (context < U3D_AC_STATIC_FULL) {
        const symbol = this.readSymbol(context);
        if (symbol !== 0) {
          return (symbol - 1) & 0xff;
        }
        const val = this.u8Val();
        this.getContext(context).addSymbolValue(val + 1);
        return val & 0xff;
      } else {
        const symbol = this.readSymbol(context);
        return symbol !== 0 ? (symbol - 1) & 0xff : this.u8Val();
      }
    }

    str() {
      const len = this.u16();
      if (len === 0 || len > 4096) return "";
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = this.u8Val();
      }
      return new TextDecoder("utf-8").decode(bytes);
    }
  }

  function pad4(n) {
    return (n + 3) & ~3;
  }

  function blockTypeName(t) {
    const map = {
      0x00443355: 'FileHeader (U3D)',
      0xFFFFFF12: 'FileReference',
      0xFFFFFF14: 'ModifierChain / ViewNode',
      0xFFFFFF15: 'PriorityUpdate',
      0xFFFFFF16: 'NewObjectType',
      0xFFFFFF21: 'GroupNode',
      0xFFFFFF22: 'ModelNode',
      0xFFFFFF23: 'LightNode',
      0xFFFFFF24: 'ViewNode',
      0xFFFFFF31: 'CLODMeshDeclaration',
      0xFFFFFF36: 'PointSetDeclaration',
      0xFFFFFF37: 'LineSetDeclaration',
      0xFFFFFF3B: 'CLODBaseMeshContinuation',
      0xFFFFFF3C: 'CLODProgressiveMeshContinuation',
      0xFFFFFF3E: 'PointSetContinuation',
      0xFFFFFF3F: 'LineSetContinuation',
      0xFFFFFF45: 'ShadingModifier',
      0xFFFFFF46: 'CLODModifier',
      0xFFFFFF51: 'LightResource',
      0xFFFFFF52: 'ViewResource',
      0xFFFFFF53: 'LitTextureShader',
      0xFFFFFF54: 'MaterialResource',
      0xFFFFFF55: 'TextureDeclaration',
      0xFFFFFF5C: 'TextureContinuation'
    };
    return map[t >>> 0] || `0x${(t >>> 0).toString(16).toUpperCase()}`;
  }

  // 4x4 Column-Major Matrix Helpers for ECMA-363 Scene Graph Transforms
  function identityMat4() {
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1
    ];
  }

  function multiplyMat4(a, b) {
    const out = new Array(16).fill(0);
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 4; row++) {
        out[col * 4 + row] =
          a[0 * 4 + row] * b[col * 4 + 0] +
          a[1 * 4 + row] * b[col * 4 + 1] +
          a[2 * 4 + row] * b[col * 4 + 2] +
          a[3 * 4 + row] * b[col * 4 + 3];
      }
    }
    return out;
  }

  function transformPointMat4(pt, m) {
    const [x, y, z] = pt;
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14]
    ];
  }

  function mat4Determinant3x3(m) {
    return (
      m[0] * (m[5] * m[10] - m[9] * m[6]) -
      m[4] * (m[1] * m[10] - m[9] * m[2]) +
      m[8] * (m[1] * m[6] - m[5] * m[2])
    );
  }

  // Author CLOD Mesh Adjacency Tracker for 0xFFFFFF3C Progressive Mesh Continuation
  class U3DCLODProgressiveMesh {
    constructor(positions, faces, faceShadingIds, normals = [], faceNormalIndices = []) {
      this.positions = positions;
      this.faces = faces;
      this.faceShadingIds = faceShadingIds;
      this.normals = normals;
      this.faceNormalIndices = faceNormalIndices;
      this.posToFaces = positions.map(() => []);
      faces.forEach((f, fIdx) => {
        for (const v of f) {
          if (this.posToFaces[v] && !this.posToFaces[v].includes(fIdx)) {
            this.posToFaces[v].push(fIdx);
          }
        }
      });
    }

    addPos(xyz) {
      const idx = this.positions.length;
      this.positions.push(xyz);
      this.posToFaces.push([]);
      return idx;
    }

    addFace(a, b, c, shId = 0, na = 0, nb = 0, nc = 0) {
      const fIdx = this.faces.length;
      this.faces.push([a, b, c]);
      this.faceShadingIds.push(shId);
      this.faceNormalIndices.push([na, nb, nc]);
      for (const v of [a, b, c]) {
        if (!this.posToFaces[v]) this.posToFaces[v] = [];
        if (!this.posToFaces[v].includes(fIdx)) {
          this.posToFaces[v].push(fIdx);
          // Keep CIFXSetX descending order (Wait: CIFXSetX sorts ascending in m_pMemberData[0..size-1]! Let's check below)
          this.posToFaces[v].sort((x, y) => y - x);
        }
      }
      return fIdx;
    }

    replaceFaceVertex(fIdx, oldV, newV) {
      const f = this.faces[fIdx];
      if (!f) return;
      for (let k = 0; k < 3; k++) {
        if (f[k] === oldV) f[k] = newV;
      }
      const oldSet = this.posToFaces[oldV];
      if (oldSet) {
        const pos = oldSet.indexOf(fIdx);
        if (pos !== -1) oldSet.splice(pos, 1);
      }
      if (!this.posToFaces[newV]) this.posToFaces[newV] = [];
      if (!this.posToFaces[newV].includes(fIdx)) {
        this.posToFaces[newV].push(fIdx);
        this.posToFaces[newV].sort((x, y) => y - x);
      }
    }

    getMoveFaceSet(splitPosIdx, stayOrMoveArr) {
      const faceSet = this.posToFaces[splitPosIdx] ? [...this.posToFaces[splitPosIdx]] : [];
      const moveFaces = [];
      for (let i = 0; i < faceSet.length; i++) {
        if (stayOrMoveArr[i] === 1) moveFaces.push(faceSet[i]);
      }
      return moveFaces;
    }
  }

  // U3D entry point: ECMA-363 decode plus a clear diagnosis when no mesh comes out (e.g. geometry only in a
  // vendor New Object Type such as Adobe/Right Hemisphere "RHAdobeMeshResource", whose layout is not public).
  function parseU3DStream(u8) {
    const r = parseU3DStreamCore(u8);
    r.warnings = r.warnings || [];
    const tris = (r.parts || []).reduce((n, p) => n + ((p.faces && p.faces.length) || 0), 0);
    r.decodePath = tris ? 'U3D' : 'none';
    if (!tris) {
      // Vendor mesh "RHAdobeMeshResource" (Adobe Acrobat SDK 8.1 U3D supplement; decoder by QA/Tester)
      const RH = getModule('RHAdobeMesh', 'u3d-rhadobe-mesh.js');
      if (RH) {
        try {
          const rr = RH.parseU3D(u8);
          const rparts = (rr.parts || []).filter((q) => q.indices && q.indices.length);
          if (rparts.length) {
            r.parts = rparts.map((q) => {
              const pos = Float64Array.from(q.positionsTyped), idx = Uint32Array.from(q.indices), nv = pos.length / 3, nt = idx.length / 3;
              return {
                name: q.name, meshName: q.meshName, materialName: 'RHAdobeMeshResource', analyticFeatures: [], pos, idx,
                // legacy accessors (harness / older callers); built on demand only
                get positions() { const a = new Array(nv); for (let i = 0; i < nv; i++) a[i] = [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]; return a; },
                get faces() { const a = new Array(nt); for (let t = 0; t < nt; t++) a[t] = [idx[3 * t], idx[3 * t + 1], idx[3 * t + 2]]; return a; },
                set positions(v) { Object.defineProperty(this, 'positions', { value: v, writable: true, enumerable: true, configurable: true }); },
                set faces(v) { Object.defineProperty(this, 'faces', { value: v, writable: true, enumerable: true, configurable: true }); }
              };
            });
            r.decodePath = 'U3D/RHAdobeMeshResource';
            for (const w of rr.warnings || []) r.warnings.push(w);
            return r;
          }
          for (const w of rr.warnings || []) r.warnings.push(w);
        } catch (e) { r.warnings.push(`RHAdobeMeshResource: ${e.message}`); }
      }
      const G = getModule('U3DGuard', 'u3d-guard.js');
      const sc = G ? G.scanU3D(u8) : { types: {}, newTypes: [] };
      const meshDecl = ['ffffff31', 'ffffff36', 'ffffff37'].filter((t) => sc.types[t]);
      r.warnings.push(sc.newTypes.length && !meshDecl.length
        ? `Unsupported proprietary U3D mesh: geometry is only in vendor New Object Type block(s) ${sc.newTypes.join(', ')} (not defined in ECMA-363), which cannot be decoded`
        : `U3D parsed but no mesh was produced${Object.keys(sc.types).length ? ' (block types: ' + Object.keys(sc.types).join(',') + ')' : ''}`);
      r.errorCode = 'U3D_NO_GEOMETRY';
    }
    return r;
  }

  function parseU3DStreamCore(u8) {
    if (u8.length < 24 || asciiSlice(u8, 0, 3) !== 'U3D') {
      throw new Error('Invalid U3D header signature');
    }

    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let offset = 0;

    let profileId = 0;
    let unitsScalingFactor = 1.0;
    let noCompression = false;

    const blocks = [];
    const nodesByName = new Map();
    const modelNodes = [];
    const shadingModifiers = new Map();
    const shaderLists = new Map();
    const materials = new Map();
    const meshDecls = new Map();
    const meshes = new Map();

    // Parse a single U3D block at [dataStart, dataStart + dataSize)
    function parseSingleBlock(blockType, dataStart, dataSize, metaStart, metaSize, blockOffset, isNested = false) {
      blocks.push({
        blockType,
        name: blockTypeName(blockType),
        dataSize,
        metaSize,
        offset: blockOffset,
        nested: isNested
      });

      const r = new U3DBitStreamReader(u8, dataStart, dataSize, noCompression);

      if (blockType === 0x00443355) {
        const majorVersion = r.i16();
        const minorVersion = r.i16();
        profileId = r.u32();
        const declSize = r.u32();
        const fileSize = r.u64();
        const charEncoding = r.u32();
        if ((profileId & 8) !== 0 && dataSize >= 32) {
          unitsScalingFactor = r.f64();
        }
        noCompression = (profileId & 4) !== 0;
        void majorVersion; void minorVersion; void declSize; void fileSize; void charEncoding;
      } else if (blockType === 0xFFFFFF14) {
        // ECMA-363 Section 9.4.3: Modifier Chain (0xFFFFFF14)
        // Also gracefully ignores synthetic ViewNode blocks if not a valid Modifier Chain
        try {
          const chainName = r.str();
          const chainType = r.u32();
          const chainAttrs = r.u32();
          if (chainType <= 2 && (chainAttrs & ~3) === 0) {
            if ((chainAttrs & 1) !== 0) {
              r.f32(); r.f32(); r.f32(); r.f32();
            }
            if ((chainAttrs & 2) !== 0) {
              for (let i = 0; i < 6; i++) r.f32();
            }
            r.alignTo4Byte();
            const modCount = r.u32();
            let subOff = r.bytePos;
            const chainEnd = dataStart + dataSize;
            if (modCount >= 1 && modCount <= 256 && subOff + 12 <= chainEnd) {
              const firstSubType = dv.getUint32(subOff, true);
              if ((firstSubType >>> 8) === 0x00ffffff) {
                for (let m = 0; m < modCount && subOff + 12 <= chainEnd; m++) {
                  const subType = dv.getUint32(subOff, true);
                  const subDataSize = dv.getUint32(subOff + 4, true);
                  const subMetaSize = dv.getUint32(subOff + 8, true);
                  const subDataStart = subOff + 12;
                  const subMetaStart = subDataStart + pad4(subDataSize);
                  const subNext = subMetaStart + pad4(subMetaSize);
                  if (subNext > chainEnd + 4) break;
                  parseSingleBlock(subType, subDataStart, subDataSize, subMetaStart, subMetaSize, subOff, true);
                  subOff = subNext;
                }
              }
            }
          }
          void chainName;
        } catch (_) {
          // Ignore malformed/synthetic 0xFFFFFF14 block
        }
      } else if (blockType === 0xFFFFFF21) {
        // Group Node
        const nodeName = r.str();
        const parentCount = r.u32();
        let parentName = '';
        let localMatrix = identityMat4();
        for (let p = 0; p < parentCount; p++) {
          const pName = r.str();
          const mat = [];
          for (let m = 0; m < 16; m++) mat.push(r.f32());
          if (p === 0) {
            parentName = pName;
            localMatrix = mat;
          }
        }
        nodesByName.set(nodeName, { nodeName, parentName, localMatrix, type: 'GROUP' });
      } else if (blockType === 0xFFFFFF22) {
        // Model Node
        const nodeName = r.str();
        const parentCount = r.u32();
        let parentName = '';
        let localMatrix = identityMat4();
        for (let p = 0; p < parentCount; p++) {
          const pName = r.str();
          const mat = [];
          for (let m = 0; m < 16; m++) mat.push(r.f32());
          if (p === 0) {
            parentName = pName;
            localMatrix = mat;
          }
        }
        const resourceName = r.str();
        const visibility = r.u32();
        const nodeObj = { nodeName, parentName, localMatrix, resourceName, visibility, type: 'MODEL' };
        nodesByName.set(nodeName, nodeObj);
        modelNodes.push(nodeObj);
      } else if (blockType === 0xFFFFFF45) {
        // Shading Modifier (ECMA-363 Section 9.7.5)
        const modName = r.str();
        r.u32(); // chainIndex
        r.u32(); // shadingAttributes
        const shaderListCount = r.u32();
        const shaders = [];
        for (let i = 0; i < shaderListCount; i++) {
          const shCount = r.u32();
          for (let j = 0; j < shCount; j++) {
            shaders.push(r.str());
          }
        }
        if (shaders.length > 0) {
          shadingModifiers.set(modName, shaders[0]);
        }
      } else if (blockType === 0xFFFFFF53) {
        // Lit Texture Shader (ECMA-363 Section 9.8.3) or synthetic Shader List
        const shaderName = r.str();
        const remBytes = (dataStart + dataSize) - r.bytePos;
        let matName = '';
        // Check if synthetic sample format (3x U32 = 12B, then u32 shCount=1, then str)
        const posAfterName = r.bytePos;
        const u0 = r.u32();
        const u1 = r.u32();
        const u2 = r.u32();
        if (u0 === 0 && u1 === 1 && u2 === 1 && remBytes < 30) {
          const shCount = r.u32();
          if (shCount > 0) matName = r.str();
        } else {
          // Standard ECMA-363 9.8.3 Lit Texture Shader: 7 x 32-bit fields (28 bytes) before Material Name
          r.seek(posAfterName + 28);
          if (r.bytePos + 2 <= dataStart + dataSize) {
            matName = r.str();
          }
        }
        shaderLists.set(shaderName, matName);
      } else if (blockType === 0xFFFFFF54) {
        // Material Resource (ECMA-363 Section 9.8.4)
        const matName = r.str();
        const matAttributes = r.u32();
        const ar = r.f32(), ag = r.f32(), ab = r.f32();
        const dr = r.f32(), dg = r.f32(), db = r.f32();
        materials.set(matName, {
          matName,
          matAttributes,
          ambient: [ar, ag, ab],
          color: [dr, dg, db]
        });
      } else if (blockType === 0xFFFFFF31) {
        // CLOD Mesh Generator Declaration (ECMA-363 Section 9.6.1.1)
        const meshName = r.str();
        const chainIdx = r.u32();
        const meshAttrs = r.u32();
        const faceCount = r.u32();
        const posCount = r.u32();
        const normCount = r.u32();
        const diffCount = r.u32();
        const specCount = r.u32();
        const texCount = r.u32();
        const numShading = r.u32();
        const shadings = [];
        for (let s = 0; s < numShading; s++) {
          const shAttr = r.u32();
          const texLayerCount = r.u32();
          const texDims = [];
          for (let t = 0; t < texLayerCount; t++) texDims.push(r.u32());
          const origShadingId = r.u32();
          shadings.push({ shAttr, texLayerCount, texDims, origShadingId });
        }
        let minResolution = posCount;
        let maxResolution = posCount;
        let invQuantPos = 1.0;
        let invQuantNorm = 1.0;
        if (r.bytePos + 8 <= dataStart + dataSize) {
          minResolution = r.u32();
          maxResolution = r.u32();
        }
        if (r.bytePos + 32 <= dataStart + dataSize) {
          r.u32(); r.u32(); r.u32(); // quality factors
          invQuantPos = r.f32() || 1.0;
          invQuantNorm = r.f32() || 1.0;
          r.f32(); r.f32(); r.f32();
        }
        meshDecls.set(meshName, {
          meshName,
          chainIdx,
          meshAttrs,
          faceCount,
          posCount,
          normCount,
          diffCount,
          specCount,
          texCount,
          shadings,
          minResolution,
          maxResolution,
          invQuantPos,
          invQuantNorm
        });
      } else if (blockType === 0xFFFFFF3B) {
        // CLOD Base Mesh Continuation (ECMA-363 Section 9.6.1.2)
        const meshName = r.str();
        const chainIdx = r.u32();
        const baseFaceCount = r.u32();
        const basePosCount = r.u32();
        const baseNormCount = r.u32();
        const baseDiffCount = r.u32();
        const baseSpecCount = r.u32();
        const baseTexCount = r.u32();

        const positions = [];
        for (let i = 0; i < basePosCount; i++) {
          positions.push([r.f32(), r.f32(), r.f32()]);
        }
        const normals = [];
        for (let i = 0; i < baseNormCount; i++) {
          normals.push([r.f32(), r.f32(), r.f32()]);
        }
        for (let i = 0; i < baseDiffCount; i++) {
          r.f32(); r.f32(); r.f32(); r.f32();
        }
        for (let i = 0; i < baseSpecCount; i++) {
          r.f32(); r.f32(); r.f32(); r.f32();
        }
        for (let i = 0; i < baseTexCount; i++) {
          r.f32(); r.f32(); r.f32(); r.f32();
        }

        const decl = meshDecls.get(meshName);
        const excludeNormals = decl ? (decl.meshAttrs & 1) !== 0 : (baseNormCount === 0);
        const shadings = (decl && decl.shadings) || [];

        const faces = [];
        const faceShadingIds = [];
        const faceNormalIndices = [];

        for (let f = 0; f < baseFaceCount; f++) {
          const shadingId = r.readCompressedU32(U3D_CTX.BaseShadingID);
          const sh = shadings[shadingId] || { shAttr: 0, texLayerCount: 0 };
          const tri = [0, 0, 0];
          const nTri = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const pIdx = basePosCount > 0
              ? r.readCompressedU32(U3D_AC_STATIC_FULL + basePosCount)
              : 0;
            let nIdx = 0;
            if (!excludeNormals && baseNormCount > 0) {
              nIdx = r.readCompressedU32(U3D_AC_STATIC_FULL + baseNormCount);
            }
            if ((sh.shAttr & 1) !== 0 && baseDiffCount > 0) {
              r.readCompressedU32(U3D_AC_STATIC_FULL + baseDiffCount);
            }
            if ((sh.shAttr & 2) !== 0 && baseSpecCount > 0) {
              r.readCompressedU32(U3D_AC_STATIC_FULL + baseSpecCount);
            }
            for (let t = 0; t < sh.texLayerCount; t++) {
              if (baseTexCount > 0) {
                r.readCompressedU32(U3D_AC_STATIC_FULL + baseTexCount);
              }
            }
            tri[c] = Math.min(Math.max(0, pIdx), Math.max(0, positions.length - 1));
            nTri[c] = nIdx;
          }
          faces.push(tri);
          faceShadingIds.push(shadingId);
          faceNormalIndices.push(nTri);
        }

        const progMesh = new U3DCLODProgressiveMesh(positions, faces, faceShadingIds, normals, faceNormalIndices);
        meshes.set(meshName, {
          meshName,
          chainIdx,
          positions,
          normals,
          faces,
          faceShadingIds,
          progMesh
        });
      } else if (blockType === 0xFFFFFF3C) {
        // CLOD Progressive Mesh Continuation (ECMA-363 Section 9.6.1.3)
        try {
          const meshName = r.str();
          r.u32(); // chainIdx
          const startRes = r.u32();
          const endRes = r.u32();
          const decl = meshDecls.get(meshName);
          let meshEntry = meshes.get(meshName);
          if (!meshEntry) {
            const progMesh = new U3DCLODProgressiveMesh([], [], [], [], []);
            meshEntry = { meshName, chainIdx: 0, positions: progMesh.positions, normals: progMesh.normals, faces: progMesh.faces, faceShadingIds: progMesh.faceShadingIds, progMesh };
            meshes.set(meshName, meshEntry);
          }
          const pm = meshEntry.progMesh;
          const excludeNormals = decl ? (decl.meshAttrs & 1) !== 0 : true;
          const invQuantPos = (decl && decl.invQuantPos) || 1.0;
          const invQuantNorm = (decl && decl.invQuantNorm) || 1.0;
          const shadings = (decl && decl.shadings) || [];

          for (let currPosInd = startRes; currPosInd < endRes; currPosInd++) {
            const splitPosInd = currPosInd === 0
              ? r.readCompressedU32(U3D_AC_STATIC_FULL + 1)
              : r.readCompressedU32(U3D_AC_STATIC_FULL + currPosInd);

            const splitFaceSet = pm.posToFaces[splitPosInd] ? [...pm.posToFaces[splitPosInd]] : [];
            if (!excludeNormals) {
              const numNewNormals = r.readCompressedU32(U3D_CTX.NewNormalCnt);
              for (let n = 0; n < numNewNormals; n++) {
                const ns = r.readCompressedU8(U3D_CTX.NewNormalDiffSign);
                const nx = r.readCompressedU32(U3D_CTX.NewNormalDiffMagX);
                const ny = r.readCompressedU32(U3D_CTX.NewNormalDiffMagY);
                const nz = r.readCompressedU32(U3D_CTX.NewNormalDiffMagZ);
                const dx = ((ns & 1) ? -1 : 1) * nx * invQuantNorm;
                const dy = ((ns & 2) ? -1 : 1) * ny * invQuantNorm;
                const dz = ((ns & 4) ? -1 : 1) * nz * invQuantNorm;
                pm.normals.push([dx, dy, dz]);
              }
            }

            // New Position Info (9.6.1.3.4.3)
            const posSigns = r.readCompressedU8(U3D_CTX.NewPosDiffSign);
            const posDiffX = r.readCompressedU32(U3D_CTX.NewPosDiffMagX);
            const posDiffY = r.readCompressedU32(U3D_CTX.NewPosDiffMagY);
            const posDiffZ = r.readCompressedU32(U3D_CTX.NewPosDiffMagZ);
            const sp = pm.positions[splitPosInd] || [0, 0, 0];
            const dx = ((posSigns & 1) ? -1 : 1) * posDiffX * invQuantPos;
            const dy = ((posSigns & 2) ? -1 : 1) * posDiffY * invQuantPos;
            const dz = ((posSigns & 4) ? -1 : 1) * posDiffZ * invQuantPos;
            const newPosInd = pm.addPos([sp[0] + dx, sp[1] + dy, sp[2] + dz]);

            const numNewFaces = r.readCompressedU32(U3D_CTX.NewFacesCount);
            let prevShadingId = 0;
            const newFacesMeta = [];

            for (let f = 0; f < numNewFaces; f++) {
              const orntChange = r.readCompressedU8(U3D_CTX.OrientChange);
              const faceType = r.readCompressedU8(U3D_CTX.FaceType);
              const shadingChange = r.readCompressedU8(U3D_CTX.ShadingChange);
              let shId = prevShadingId;
              if (shadingChange || f === 0) {
                shId = r.readCompressedU32(U3D_CTX.NewShadingID);
                prevShadingId = shId;
              }
              const sh = shadings[shId] || { shAttr: 0, texLayerCount: 0 };
              if (sh.shAttr & 1) {
                const dupDiff = r.readCompressedU8(U3D_CTX.DupCornerIndex);
                for (let ci = 0; ci < 3; ci++) {
                  if (!(dupDiff & (1 << ci))) {
                    const bLocal = r.readCompressedU8(U3D_CTX.ColorLocalIndex);
                    if (!bLocal) {
                      r.readCompressedU8(U3D_CTX.DiffColorSign);
                      r.readCompressedU32(U3D_CTX.DiffColorMagR);
                      r.readCompressedU32(U3D_CTX.DiffColorMagG);
                      r.readCompressedU32(U3D_CTX.DiffColorMagB);
                      r.readCompressedU32(U3D_CTX.DiffColorMagA);
                    } else {
                      r.readCompressedU32(U3D_CTX.DiffColorSplitIndex);
                    }
                  }
                }
              }
              if (sh.shAttr & 2) {
                const dupSpec = r.readCompressedU8(U3D_CTX.DupCornerIndex);
                for (let ci = 0; ci < 3; ci++) {
                  if (!(dupSpec & (1 << ci))) {
                    const bLocal = r.readCompressedU8(U3D_CTX.ColorLocalIndex);
                    if (!bLocal) {
                      r.readCompressedU8(U3D_CTX.SpecColorSign);
                      r.readCompressedU32(U3D_CTX.SpecColorMagR);
                      r.readCompressedU32(U3D_CTX.SpecColorMagG);
                      r.readCompressedU32(U3D_CTX.SpecColorMagB);
                      r.readCompressedU32(U3D_CTX.SpecColorMagA);
                    } else {
                      r.readCompressedU32(U3D_CTX.SpecColorSplitIndex);
                    }
                  }
                }
              }
              for (let tl = 0; tl < sh.texLayerCount; tl++) {
                const dupTex = r.readCompressedU8(U3D_CTX.DupCornerIndex);
                for (let ci = 0; ci < 3; ci++) {
                  if (!(dupTex & (1 << ci))) {
                    const bLocal = r.readCompressedU8(U3D_CTX.TexCoordLocalIndex);
                    if (!bLocal) {
                      r.readCompressedU8(U3D_CTX.TexCoordSign);
                      r.readCompressedU32(U3D_CTX.TexCoordMagU);
                      r.readCompressedU32(U3D_CTX.TexCoordMagV);
                      r.readCompressedU32(U3D_CTX.TexCoordMagS);
                      r.readCompressedU32(U3D_CTX.TexCoordMagT);
                    } else {
                      r.readCompressedU32(U3D_CTX.TexCoordSplitIndex);
                    }
                  }
                }
              }
              newFacesMeta.push({ orntChange, faceType, shId });
            }

            // Stay or Move array for existing faces in splitFaceSet
            const thirdIndexSet = [];
            const stayMove = [];
            for (let f = 0; f < splitFaceSet.length; f++) {
              const fIdx = splitFaceSet[f];
              const tri = pm.faces[fIdx];
              for (const v of tri) {
                if (v !== splitPosInd && !thirdIndexSet.includes(v)) {
                  thirdIndexSet.push(v);
                }
              }
            }
            thirdIndexSet.sort((a, b) => b - a);

            const faceThirdInd = new Array(numNewFaces).fill(0);
            for (let f = 0; f < numNewFaces; f++) {
              if (newFacesMeta[f].faceType === 1) {
                const tLocal = r.readCompressedU32(U3D_AC_STATIC_FULL + Math.max(1, thirdIndexSet.length));
                faceThirdInd[f] = thirdIndexSet[Math.min(tLocal, Math.max(0, thirdIndexSet.length - 1))] || 0;
              } else {
                faceThirdInd[f] = r.readCompressedU32(U3D_AC_STATIC_FULL + Math.max(1, currPosInd));
              }
              if (!thirdIndexSet.includes(faceThirdInd[f])) {
                thirdIndexSet.push(faceThirdInd[f]);
                thirdIndexSet.sort((a, b) => b - a);
              }
            }

            for (let f = 0; f < splitFaceSet.length; f++) {
              const sm = r.readCompressedU8(U3D_CTX.StayOrMove);
              stayMove.push(sm);
            }

            // Apply vertex move to existing faces marked Move (sm === 1)
            for (let f = 0; f < splitFaceSet.length; f++) {
              if (stayMove[f] === 1) {
                pm.replaceFaceVertex(splitFaceSet[f], splitPosInd, newPosInd);
              }
            }

            // Add new faces created by split
            for (let f = 0; f < numNewFaces; f++) {
              const meta = newFacesMeta[f];
              const thirdV = faceThirdInd[f];
              const tri = meta.orntChange
                ? [splitPosInd, thirdV, newPosInd]
                : [newPosInd, thirdV, splitPosInd];
              pm.addFace(tri[0], tri[1], tri[2], meta.shId);
            }
          }
        } catch (_) {
          // Keep progressive mesh decoded up to the last complete resolution step
        }
      }
    }

    while (offset + 12 <= u8.length) {
      const blockType = dv.getUint32(offset, true);
      const dataSize = dv.getUint32(offset + 4, true);
      const metaSize = dv.getUint32(offset + 8, true);

      const dataStart = offset + 12;
      const metaStart = dataStart + pad4(dataSize);
      const nextBlockOffset = metaStart + pad4(metaSize);
      if (dataStart + dataSize > u8.length) break;

      parseSingleBlock(blockType, dataStart, dataSize, metaStart, metaSize, offset, false);
      offset = nextBlockOffset;
    }

    // Resolve full world 4x4 transform matrix for any node by walking parent chain
    function getWorldMatrix(nodeName, visited = new Set()) {
      if (!nodeName || visited.has(nodeName)) return identityMat4();
      visited.add(nodeName);
      const node = nodesByName.get(nodeName);
      if (!node) return identityMat4();
      const parentWorld = node.parentName ? getWorldMatrix(node.parentName, visited) : identityMat4();
      return multiplyMat4(parentWorld, node.localMatrix || identityMat4());
    }

    // Assemble CAD parts from scene-graph Model Nodes (supporting instancing & world transforms)
    const parts = [];
    let partIndex = 0;

    if (modelNodes.length > 0) {
      for (const mn of modelNodes) {
        const mesh = meshes.get(mn.resourceName);
        if (!mesh || !mesh.positions || mesh.positions.length === 0 || !mesh.faces || mesh.faces.length === 0) {
          continue;
        }
        const worldMat = getWorldMatrix(mn.nodeName);
        const det = mat4Determinant3x3(worldMat);
        const transformedPositions = mesh.positions.map((pt) => transformPointMat4(pt, worldMat));
        const transformedFaces = det < 0
          ? mesh.faces.map(([a, b, c]) => [a, c, b])
          : mesh.faces.map(([a, b, c]) => [a, b, c]);

        // Resolve material color via ShadingModifier -> ShaderList -> Material, or heuristic fallback
        let color = PALETTE[partIndex % PALETTE.length];
        let matName = `Mat_${mn.nodeName}`;
        const shModName = shadingModifiers.get(mn.nodeName);
        if (shModName && shaderLists.has(shModName)) {
          const resolvedMat = shaderLists.get(shModName);
          if (resolvedMat && materials.has(resolvedMat)) {
            matName = resolvedMat;
            color = materials.get(resolvedMat).color;
          }
        } else {
          for (const [mKey, mVal] of materials.entries()) {
            const stem = mn.nodeName.split('_')[0];
            if (stem && mKey.includes(stem)) {
              matName = mKey;
              color = mVal.color;
              break;
            }
          }
        }

        parts.push({
          name: mn.nodeName || mesh.meshName,
          meshName: mesh.meshName,
          materialName: matName,
          color,
          visible: true,
          positions: transformedPositions,
          faces: transformedFaces,
          analyticFeatures: []
        });
        partIndex++;
      }
    }

    // Fallback: include any mesh resources not referenced by any Model Node
    for (const [meshName, mesh] of meshes.entries()) {
      if (parts.some((p) => p.meshName === meshName)) continue;
      if (!mesh.positions || mesh.positions.length === 0 || !mesh.faces || mesh.faces.length === 0) continue;
      let color = PALETTE[partIndex % PALETTE.length];
      let matName = `Mat_${meshName}`;
      for (const [mKey, mVal] of materials.entries()) {
        if (mKey.includes(meshName.replace(/_Mesh$/, '').split('_')[0])) {
          matName = mKey;
          color = mVal.color;
          break;
        }
      }
      parts.push({
        name: meshName.replace(/_Mesh$/, ''),
        meshName,
        materialName: matName,
        color,
        visible: true,
        positions: mesh.positions,
        faces: mesh.faces,
        analyticFeatures: []
      });
      partIndex++;
    }

    return {
      format: 'U3D (ECMA-363)',
      profileId,
      unitsScalingFactor,
      blocks,
      parts
    };
  }

  // -------------------------------------------------------------------------
  // 4. ISO 14739-1 (PRC) Binary Stream Decoder
  // -------------------------------------------------------------------------
  // Companion decoders are separate <script> files (prc-brep.js, prc-decoder.js, pdf-extract.js, ...);
  // in Node (tests) they are require()d from the app directory.
  function getModule(globalName, file) {
    const g = (typeof window !== 'undefined' && window[globalName]) || (typeof globalThis !== 'undefined' && globalThis[globalName]);
    if (g) return g;
    if (typeof require === 'function') { try { return require('./' + file); } catch (_) { /* fall through */ } }
    return null;
  }

  // Legacy container written by generate-sample-pdf.js (bundled sample): "PRC" + header + zlib(JSON).
  async function tryParseLegacySamplePRC(u8) {
    if (u8.length < 60) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const compLen = dv.getUint32(48, true);
    if (!(compLen > 0 && 52 + compLen <= u8.length && u8[52] === 0x78)) return null;
    try {
      const inflated = await inflateFlateStream(u8.subarray(52, 52 + compLen));
      if (inflated[0] !== 0x7b) return null; // '{'
      const data = JSON.parse(new TextDecoder('utf-8').decode(inflated));
      return { data, minVer: dv.getUint32(4, true), authVer: dv.getUint32(8, true), numStructs: dv.getUint32(44, true), compLen };
    } catch (_) { return null; }
  }

  async function parsePRCStream(u8, opts) {
    const typed = !!(opts && opts.typed);
    const magic = asciiSlice(u8, 0, 3);
    if (magic !== 'PRC') {
      throw new Error('Invalid PRC header signature');
    }
    const legacy = await tryParseLegacySamplePRC(u8);
    if (legacy) {
      const parts = (legacy.data.parts || []).map((p, idx) => ({
        name: p.name || `PRC_Body_${idx + 1}`, meshName: `${p.name}_BRep`, materialName: p.materialName || 'CAD_BRep_Solid',
        color: p.color || PALETTE[idx % PALETTE.length], visible: true,
        positions: p.positions || [], faces: p.faces || [], analyticFeatures: p.analyticFeatures || []
      }));
      return {
        format: 'PRC (bundled sample container)', decodePath: 'sample', minVer: legacy.minVer, authVer: legacy.authVer, numStructs: legacy.numStructs,
        unitsScalingFactor: 0.001, warnings: [], wires: [], tree: null,
        blocks: [
          { blockType: 0x50524300, name: 'PRC_FileHeader', dataSize: 52, metaSize: 0, offset: 0 },
          { blockType: 0x50524301, name: 'PRC_BRepStructureTree', dataSize: legacy.compLen, metaSize: 0, offset: 52 }
        ],
        parts
      };
    }
    const scaleFlat = (a, k) => { for (let i = 0; i < a.length; i++) a[i] = a[i] * k; return a; }; // typed pos is per-instance, scale in place
    const D = getModule('PRCDecoder', 'prc-decoder.js');
    if (!D) throw new Error('PRC decoder (prc-decoder.js) is not loaded');
    const popts = { warnings: [], typed };
    const r = D.parsePRC(u8, popts);
    const warnings = (r.warnings || popts.warnings || []).slice();
    const mm = r.units && r.units.unitsInMM > 0 ? r.units.unitsInMM : 1;
    const toMM = (q) => [q[0] * mm, q[1] * mm, q[2] * mm];
    const parts = r.parts.filter((p) => p.faces && p.faces.length).map((p, idx) => ({
      name: p.name || `PRC_Body_${idx + 1}`, meshName: `${p.name || 'PRC_Body_' + (idx + 1)}_Mesh`, materialName: 'PRC_Style',
      color: p.color || PALETTE[idx % PALETTE.length], opacity: p.opacity, visible: p.visible !== false,
      positions: p.pos ? null : mm === 1 ? p.positions : p.positions.map(toMM),
      pos: p.pos ? (mm === 1 ? p.pos : scaleFlat(p.pos, mm)) : undefined, idx: p.idx,
      faces: p.faces, analyticFeatures: p.analyticFeatures || [], faceIndexPerTriangle: p.faceIndexPerTriangle,
      numTessFaces: p.numTessFaces, source: p.source || 'tess'
    }));
    r.parts.length = 0; // let the decoder's per-part arrays go as soon as possible
    const wires = (r.wires || []).map((w, i) => ({
      name: w.name || `PRC_Wire_${i + 1}`, color: w.color, visible: w.visible !== false,
      positions: mm === 1 ? w.positions : w.positions.map(toMM), polylines: w.polylines || []
    }));
    const fsInfo = (r.info && r.info.fileStructures) || [];
    const exactParts = parts.filter((p) => p.source === 'brep').length;
    const decodePath = !parts.length ? 'none' : exactParts === parts.length ? 'PRC exact B-Rep' : exactParts ? 'PRC tess + exact B-Rep' : 'PRC tess';
    if (!parts.length) {
      const geomBytes = fsInfo.reduce((s, f) => s + ((f.geometry && f.geometry.sizeBytes) || 0), 0);
      const tess = fsInfo.reduce((s, f) => s + (f.tessellations || []).filter((t) => t.kind === '3d' && t.numFaces).length, 0);
      warnings.push(geomBytes > 64 && !tess
        ? `PRC has no face tessellation; its ${geomBytes} bytes of exact geometry could not be tessellated${wires.length ? ' (' + wires.length + ' wire(s) shown)' : ''}`
        : `PRC decoded but no product occurrence references a tessellated representation item (${tess} tessellations, ${fsInfo.length} file structures)`);
    }
    return {
      format: 'PRC (ISO 14739-1)', decodePath, minVer: r.info && r.info.minVersion, authVer: r.info && r.info.authoringVersion,
      numStructs: fsInfo.length, unitsScalingFactor: 0.001, units: { source: r.units, positionsIn: 'mm' },
      tree: r.tree || null, wires, warnings,
      blocks: fsInfo.map((f, i) => ({ blockType: 0x50524310 + (i & 0xf), name: `PRC_FileStructure_${i}`, dataSize: (f.geometry && f.geometry.sizeBytes) || 0, metaSize: 0, offset: 0 })),
      parts
    };
  }

  // -------------------------------------------------------------------------
  // 5. Coplanar B-Rep Face Merger & Analytic Feature / Hole Loop Reconstructor
  // -------------------------------------------------------------------------
  // Input normalisation: every part ends up with flat typed geometry
  //   part.pos : Float64Array(3*nVerts)   part.idx : Uint32Array(3*nTris), 0xFFFFFFFF = invalid index
  // (the PRC decoder emits this directly with {typed:true}; U3D / sample parts are packed here).
  const BAD_INDEX = 0xFFFFFFFF;
  function packPartInput(part) {
    if (part.pos && part.idx) return;
    const P = part.positions || [], F = part.faces || [];
    const nv = P.length;
    const pos = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { const q = P[i]; pos[3 * i] = q[0]; pos[3 * i + 1] = q[1]; pos[3 * i + 2] = q[2]; }
    const idx = new Uint32Array(F.length * 3);
    for (let f = 0; f < F.length; f++) {
      const t = F[f];
      for (let k = 0; k < 3; k++) { const v = t ? t[k] : undefined; idx[3 * f + k] = Number.isInteger(v) && v >= 0 && v < nv ? v : BAD_INDEX; }
    }
    part.pos = pos; part.idx = idx;
  }

  // Unit triangle normal exactly as the B-Rep builder computes it (shared by every exporter).
  // Returns the doubled area (0 => degenerate) and writes the normal into out.
  function triNormalInto(vx, a, b, c, out) {
    const a3 = 3 * a, b3 = 3 * b, c3 = 3 * c;
    const ux = vx[b3] - vx[a3], uy = vx[b3 + 1] - vx[a3 + 1], uz = vx[b3 + 2] - vx[a3 + 2];
    const wx = vx[c3] - vx[a3], wy = vx[c3 + 1] - vx[a3 + 1], wz = vx[c3 + 2] - vx[a3 + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const area2 = Math.hypot(nx, ny, nz);
    out[0] = nx / area2; out[1] = ny / area2; out[2] = nz / area2;
    return area2;
  }

  // Full (transient) B-Rep of one part: welded verts, triangle records, coplanar merged faces with
  // boundary loops, feature edges and the manifold check. Exporters expand one part at a time and
  // drop the result, so peak memory is bounded by the largest part rather than the assembly.
  function computeFullBRep(pos, idx, analyticFeatures, withFeatures) {
    // 1. Weld coincident vertices within 1e-4 source units so topological half-edges match
    const nIn = (pos.length / 3) | 0;
    const weldMap = new Map();
    const weldedVerts = [];
    const vertRemap = new Int32Array(nIn);
    for (let i = 0; i < nIn; i++) {
      const x = pos[3 * i], y = pos[3 * i + 1], z = pos[3 * i + 2];
      const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      let wIdx = weldMap.get(key);
      if (wIdx === undefined) {
        wIdx = weldedVerts.length;
        weldedVerts.push([x, y, z]);
        weldMap.set(key, wIdx);
      }
      vertRemap[i] = wIdx;
    }
    weldMap.clear();
    const NV = Math.max(1, weldedVerts.length);

    // 2. Build non-degenerate welded triangles & per-triangle normals
    const tris = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const [x, y, z] of weldedVerts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const nF = (idx.length / 3) | 0;
    for (let f = 0; f < nF; f++) {
      const i0 = idx[3 * f], i1 = idx[3 * f + 1], i2 = idx[3 * f + 2];
      if (i0 >= nIn || i1 >= nIn || i2 >= nIn) continue;
      const a = vertRemap[i0], b = vertRemap[i1], c = vertRemap[i2];
      if (a === b || b === c || c === a) continue;
      const p0 = weldedVerts[a], p1 = weldedVerts[b], p2 = weldedVerts[c];
      const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
      const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const area2 = Math.hypot(nx, ny, nz);
      if (area2 < 1e-8) continue;
      nx /= area2; ny /= area2; nz /= area2;
      const planeD = nx * p0[0] + ny * p0[1] + nz * p0[2];
      tris.push({ verts: [a, b, c], normal: [nx, ny, nz], planeD, area: area2 * 0.5 });
    }

    // 3. Group triangles into connected coplanar faces & check 2-manifold watertightness
    //    (numeric edge keys: undirected min*NV+max, directed u*NV+v; Map order == insertion order)
    const edgeToTris = new Map();
    const directedHalfEdges = new Map();
    const undirectedKey = (u, v) => (u < v ? u * NV + v : v * NV + u);
    for (let tIdx = 0; tIdx < tris.length; tIdx++) {
      const [a, b, c] = tris[tIdx].verts;
      for (let e = 0; e < 3; e++) {
        const u = e === 0 ? a : e === 1 ? b : c, v = e === 0 ? b : e === 1 ? c : a;
        const k = undirectedKey(u, v);
        const l = edgeToTris.get(k);
        if (l) l.push(tIdx); else edgeToTris.set(k, [tIdx]);
        const dk = u * NV + v;
        directedHalfEdges.set(dk, (directedHalfEdges.get(dk) || 0) + 1);
      }
    }

    let unmatchedHalfEdges = 0;
    const featureEdges = [];
    for (const [k, list] of edgeToTris) {
      const u = Math.floor(k / NV), v = k - u * NV;
      const fwdCount = directedHalfEdges.get(u * NV + v) || 0;
      const revCount = directedHalfEdges.get(v * NV + u) || 0;
      if (list.length !== 2 || fwdCount !== 1 || revCount !== 1) {
        unmatchedHalfEdges += Math.max(1, Math.abs(2 - list.length));
      }
      if (list.length === 1) {
        featureEdges.push([u, v]);
      } else if (list.length >= 2) {
        const n0 = tris[list[0]].normal;
        const n1 = tris[list[1]].normal;
        const dot = n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2];
        if (dot < 0.96) featureEdges.push([u, v]);
      }
    }
    directedHalfEdges.clear();

    // First pass: flood-fill coplanar triangle clusters & collect raw boundary half-edges
    const visited = new Uint8Array(tris.length);
    const rawClusters = [];
    // number of distinct clusters touching each vertex on their boundary (clusters are built one
    // after another, so "last cluster seen" is enough to count distinct ones)
    const vClusterCount = new Int32Array(NV);
    const vLastCluster = new Int32Array(NV).fill(-1);
    for (let i = 0; i < tris.length; i++) {
      if (visited[i]) continue;
      visited[i] = 1;
      const seed = tris[i];
      const pSeed = weldedVerts[seed.verts[0]];
      const cluster = [i];
      const queue = [i];
      while (queue.length > 0) {
        const curr = queue.pop();
        const [a, b, c] = tris[curr].verts;
        for (let e = 0; e < 3; e++) {
          const u = e === 0 ? a : e === 1 ? b : c, v = e === 0 ? b : e === 1 ? c : a;
          const neighbors = edgeToTris.get(undirectedKey(u, v));
          if (!neighbors || neighbors.length !== 2) continue; // Do not merge across non-manifold edges
          for (const nb of neighbors) {
            if (visited[nb]) continue;
            const n = tris[nb].normal;
            const dot = seed.normal[0] * n[0] + seed.normal[1] * n[1] + seed.normal[2] * n[2];
            if (dot > 0.9999) {
              let maxDist = 0;
              for (const vIdx of tris[nb].verts) {
                const pv = weldedVerts[vIdx];
                const dist = Math.abs(
                  (pv[0] - pSeed[0]) * seed.normal[0] +
                  (pv[1] - pSeed[1]) * seed.normal[1] +
                  (pv[2] - pSeed[2]) * seed.normal[2]
                );
                if (dist > maxDist) maxDist = dist;
              }
              if (maxDist < 1e-4) {
                visited[nb] = 1;
                cluster.push(nb);
                queue.push(nb);
              }
            }
          }
        }
      }

      let boundaryHalfEdges;
      if (cluster.length === 1) {
        const [a, b, c] = seed.verts;
        boundaryHalfEdges = [a, b, b, c, c, a];
      } else {
        const halfEdgeSet = new Set();
        for (const tIdx of cluster) {
          const [a, b, c] = tris[tIdx].verts;
          halfEdgeSet.add(a * NV + b); halfEdgeSet.add(b * NV + c); halfEdgeSet.add(c * NV + a);
        }
        boundaryHalfEdges = [];
        for (const tIdx of cluster) {
          const [a, b, c] = tris[tIdx].verts;
          if (!halfEdgeSet.has(b * NV + a)) boundaryHalfEdges.push(a, b);
          if (!halfEdgeSet.has(c * NV + b)) boundaryHalfEdges.push(b, c);
          if (!halfEdgeSet.has(a * NV + c)) boundaryHalfEdges.push(c, a);
        }
      }
      const cIdx = rawClusters.length;
      for (let h = 0; h < boundaryHalfEdges.length; h++) {
        const w = boundaryHalfEdges[h];
        if (vLastCluster[w] !== cIdx) { vLastCluster[w] = cIdx; vClusterCount[w]++; }
      }
      rawClusters.push({ seed, cluster, boundaryHalfEdges });
    }
    edgeToTris.clear();

    // Second pass: chain boundary half-edges into closed loops & simplify only degree-2 collinear vertices
    const mergedFaces = [];
    for (let cIdx = 0; cIdx < rawClusters.length; cIdx++) {
      const { seed, cluster, boundaryHalfEdges: bh } = rawClusters[cIdx];
      rawClusters[cIdx] = null;
      const nextMap = new Map();
      for (let h = 0; h < bh.length; h += 2) {
        const l = nextMap.get(bh[h]);
        if (l) l.push(bh[h + 1]); else nextMap.set(bh[h], [bh[h + 1]]);
      }
      const loops = [];
      const usedHE = new Set();
      for (let h = 0; h < bh.length; h += 2) {
        const startU = bh[h], startV = bh[h + 1];
        const heKey = startU * NV + startV;
        if (usedHE.has(heKey)) continue;
        const loop = [startU];
        usedHE.add(heKey);
        let curr = startV;
        let safety = 0;
        while (curr !== startU && safety++ < 4000) {
          loop.push(curr);
          const candidates = nextMap.get(curr) || [];
          let chosen = -1;
          for (const cand of candidates) {
            if (!usedHE.has(curr * NV + cand)) { chosen = cand; break; }
          }
          if (chosen === -1) break;
          usedHE.add(curr * NV + chosen);
          curr = chosen;
        }
        if (loop.length >= 3) {
          // Only simplify collinear vertex vCurr if at most 2 coplanar clusters meet at vCurr
          const simplified = [];
          for (let k = 0; k < loop.length; k++) {
            const vCurr = loop[k];
            if (vClusterCount[vCurr] <= 2) {
              const pPrev = weldedVerts[loop[(k - 1 + loop.length) % loop.length]];
              const pCurr = weldedVerts[vCurr];
              const pNext = weldedVerts[loop[(k + 1) % loop.length]];
              const d1x = pCurr[0] - pPrev[0], d1y = pCurr[1] - pPrev[1], d1z = pCurr[2] - pPrev[2];
              const d2x = pNext[0] - pCurr[0], d2y = pNext[1] - pCurr[1], d2z = pNext[2] - pCurr[2];
              const l1 = Math.hypot(d1x, d1y, d1z), l2 = Math.hypot(d2x, d2y, d2z);
              if (l1 > 1e-6 && l2 > 1e-6) {
                const cx = (d1y * d2z - d1z * d2y) / (l1 * l2);
                const cy = (d1z * d2x - d1x * d2z) / (l1 * l2);
                const cz = (d1x * d2y - d1y * d2x) / (l1 * l2);
                if (Math.hypot(cx, cy, cz) < 1e-4) continue; // collinear & shared by at most 2 faces
              }
            }
            simplified.push(vCurr);
          }
          loops.push(simplified.length >= 3 ? simplified : loop);
        }
      }
      // Sort loops by 3D polygon perimeter descending so loops[0] is Outer loop and loops[1..] are Inner hole loops
      if (loops.length > 1) loops.sort((la, lb) => polygonPerimeter(lb, weldedVerts) - polygonPerimeter(la, weldedVerts));
      mergedFaces.push({
        normal: seed.normal,
        planeD: seed.planeD,
        tris: cluster,
        loops: loops.length > 0 ? loops : [tris[cluster[0]].verts]
      });
    }

    // 4. Detect Cylindrical Bores/Bosses & Planar Datums if not already supplied by PRC
    const detectedFeatures = !withFeatures ? null
      : analyticFeatures && analyticFeatures.length > 0 ? [...analyticFeatures]
      : detectAnalyticFeatures(weldedVerts, mergedFaces);

    return {
      weldedVerts,
      tris,
      mergedFaces,
      featureEdges,
      unmatchedHalfEdges,
      isWatertight: unmatchedHalfEdges === 0 && tris.length >= 4,
      bbox: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        size: [maxX - minX, maxY - minY, maxZ - minZ],
        center: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5]
      },
      detectedFeatures
    };
  }

  // Full B-Rep is kept in memory only for models up to this many triangles (fast path for normal
  // models); above it, exporters re-expand each part from the compact arrays (welding is idempotent).
  const FULL_CACHE_TRIS = (typeof globalThis !== 'undefined' && globalThis.PDF3D_FULL_CACHE_TRIS != null) ? globalThis.PDF3D_FULL_CACHE_TRIS : 300000;
  let fullCacheEnabled = true;

  // Compact B-Rep summary stored on part.brep (what the UI and the mesh exporters need):
  //   vx Float64Array welded verts, tv Uint32Array kept triangles, triFace Int32Array merged-face id,
  //   fev Uint32Array feature edge pairs, plus counts. weldedVerts/tris/mergedFaces/featureEdges are
  //   {length} stubs for count-only consumers. The part's raw input is replaced by the welded arrays.
  function computePartBRep(part) {
    if (part.brep && part.brep.compact) return part.brep;
    packPartInput(part);
    const nInTris = (part.idx.length / 3) | 0;
    const full = computeFullBRep(part.pos, part.idx, part.analyticFeatures, true);
    const wv = full.weldedVerts, T = full.tris, MF = full.mergedFaces, FE = full.featureEdges;
    const nv = wv.length, nt = T.length;
    const vx = new Float64Array(nv * 3);
    for (let i = 0; i < nv; i++) { const q = wv[i]; vx[3 * i] = q[0]; vx[3 * i + 1] = q[1]; vx[3 * i + 2] = q[2]; }
    const tv = new Uint32Array(nt * 3);
    for (let i = 0; i < nt; i++) { const v = T[i].verts; tv[3 * i] = v[0]; tv[3 * i + 1] = v[1]; tv[3 * i + 2] = v[2]; }
    const triFace = new Int32Array(nt);
    let holeCount = 0;
    for (let f = 0; f < MF.length; f++) {
      const mf = MF[f];
      for (const t of mf.tris) triFace[t] = f;
      if (mf.loops.length > 1) holeCount += mf.loops.length - 1;
    }
    const fev = new Uint32Array(FE.length * 2);
    for (let i = 0; i < FE.length; i++) { fev[2 * i] = FE[i][0]; fev[2 * i + 1] = FE[i][1]; }
    const brep = {
      compact: true, nv, nt, vx, tv, triFace, fev,
      faceCount: MF.length, holeCount,
      weldedVerts: { length: nv }, tris: { length: nt }, mergedFaces: { length: MF.length }, featureEdges: { length: FE.length },
      unmatchedHalfEdges: full.unmatchedHalfEdges, isWatertight: full.isWatertight,
      bbox: full.bbox, detectedFeatures: full.detectedFeatures,
      _full: null
    };
    if (fullCacheEnabled) { full.detectedFeatures = null; brep._full = full; }
    // Replace raw input with the welded compact data (re-welding it reproduces the same B-Rep).
    part.pos = vx; part.idx = tv;
    part.positions = null; part.faces = { length: nInTris };
    part.triCount = nInTris;
    part.faceIndexPerTriangle = null;
    part.brep = brep;
    return brep;
  }

  // Compact a list of parts in place; caches the full B-Rep only for small models.
  function compactParts(parts) {
    let total = 0;
    for (const p of parts) total += p.idx ? p.idx.length / 3 : (p.faces ? p.faces.length : 0);
    const prev = fullCacheEnabled;
    fullCacheEnabled = total <= FULL_CACHE_TRIS;
    try { for (const p of parts) computePartBRep(p); } finally { fullCacheEnabled = prev; }
    return total;
  }

  // Full B-Rep for one part (cached for small models, else rebuilt from the compact arrays).
  function getFullBRep(part) {
    const b = computePartBRep(part);
    if (b._full) return b._full;
    return computeFullBRep(b.vx, b.tv, null, false);
  }

  function polygonPerimeter(loop, verts) {
    let sum = 0;
    for (let i = 0; i < loop.length; i++) {
      const a = verts[loop[i]];
      const b = verts[loop[(i + 1) % loop.length]];
      sum += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    return sum;
  }

  function detectAnalyticFeatures(verts, mergedFaces) {
    const features = [];
    const seenRadii = new Set();
    for (const mf of mergedFaces) {
      if (Math.abs(mf.normal[2]) > 0.99 && mf.loops[0] && verts[mf.loops[0][0]]) {
        const zVal = verts[mf.loops[0][0]][2];
        if (mf.loops.length > 1) {
          for (let li = 1; li < mf.loops.length; li++) {
            const holeLoop = mf.loops[li];
            if (holeLoop.length >= 8) {
              let cx = 0, cy = 0;
              for (const vIdx of holeLoop) {
                cx += verts[vIdx][0];
                cy += verts[vIdx][1];
              }
              cx /= holeLoop.length;
              cy /= holeLoop.length;
              let rSum = 0;
              for (const vIdx of holeLoop) {
                rSum += Math.hypot(verts[vIdx][0] - cx, verts[vIdx][1] - cy);
              }
              const rAvg = rSum / holeLoop.length;
              const rKey = `${rAvg.toFixed(1)}_${cx.toFixed(1)}_${cy.toFixed(1)}`;
              if (!seenRadii.has(rKey)) {
                seenRadii.add(rKey);
                features.push({
                  type: 'CYLINDER',
                  label: `Cylindrical Bore Ø${(rAvg * 2).toFixed(1)} mm`,
                  radius: Number(rAvg.toFixed(3)),
                  axis: [0, 0, 1],
                  origin: [Number(cx.toFixed(2)), Number(cy.toFixed(2)), Number(zVal.toFixed(2))],
                  sense: '-'
                });
              }
            }
          }
        }
        features.push({
          type: 'PLANE',
          label: `Planar Datum Face (Z = ${zVal.toFixed(1)}, ${mf.loops.length - 1} hole loop${mf.loops.length - 1 === 1 ? '' : 's'})`,
          normal: mf.normal.map((c) => Number(c.toFixed(4))),
          origin: [0, 0, Number(zVal.toFixed(2))]
        });
      }
    }
    return features.slice(0, 8);
  }

  // -------------------------------------------------------------------------
  // 6. Parasolid XT (.x_t) ASCII Transmit Exporter (SCH_1200000_120060)
  //    Native Parasolid units = meters (m), res_size = 1000+, res_linear = 1e-8
  //    Supports:
  //      - Closed 2-Manifold Solid Bodies (body_type = 1)
  //      - Open / Architectural Sheet Bodies (body_type = 3) with Dummy Fins &
  //        Exact Plane-Projected Vertices (ideal for House / Deck / Landscaping recovery)
  //      - Multi-Body Assembly (10 ASSEMBLY + 11 INSTANCE) or Single Combined Body
  // -------------------------------------------------------------------------
  function getScaleFromMM(units) {
    if (units === 'cm') return 0.1;
    if (units === 'in') return 1 / 25.4;
    if (units === 'ft') return 1 / 304.8;
    if (units === 'm') return 0.001;
    return 1.0; // mm
  }

  function getScaleToMeters(units) {
    if (units === 'cm') return 0.01;
    if (units === 'in') return 0.0254;
    if (units === 'ft') return 0.3048;
    if (units === 'm') return 1.0;
    return 0.001; // mm -> meters (1e-3)
  }

  function normalizeVec3(v) {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  function orthoBasis(normal) {
    const [nx, ny, nz] = normalizeVec3(normal);
    const rx = Math.abs(nx) < 0.8 ? 1 : 0;
    const ry = Math.abs(nx) < 0.8 ? 0 : 1;
    const rz = 0;
    // Two-pass Gram-Schmidt for < 1e-16 orthogonality (Parasolid res_angular = 1e-11)
    let dot = rx * nx + ry * ny + rz * nz;
    let ux = rx - dot * nx;
    let uy = ry - dot * ny;
    let uz = rz - dot * nz;
    [ux, uy, uz] = normalizeVec3([ux, uy, uz]);
    dot = ux * nx + uy * ny + uz * nz;
    return normalizeVec3([ux - dot * nx, uy - dot * ny, uz - dot * nz]);
  }

  function fmtNum(v) {
    if (!isFinite(v) || Math.abs(v) < 1e-15) return '0';
    return Number(v.toPrecision(16)).toString();
  }

  // -------------------------------------------------------------------------
  // Streaming text output. Exporters push lines into a TextSink which flushes them into ~8 Mi-char
  // line-aligned chunks (or Blob parts in the browser), so no exporter ever holds a giant lines[] array.
  // result() == lines.join('\n') exactly: a single string below TEXT_SINGLE_LIMIT, else a chunk array.
  // -------------------------------------------------------------------------
  const SINK_FLUSH = 1 << 23;
  class TextSink {
    constructor(blob) { this.buf = []; this.bufLen = 0; this.chunks = []; this.total = 0; this.blob = !!blob && typeof Blob !== 'undefined'; this.lines = 0; }
    push(line) {
      this.buf.push(line); this.bufLen += line.length + 1; this.lines++;
      if (this.bufLen >= SINK_FLUSH) this._flush(true);
    }
    // keepLast: retain the last line so result() can omit the final '\n' without touching chunks
    _flush(keepLast) {
      const n = keepLast ? this.buf.length - 1 : this.buf.length;
      if (n <= 0) return;
      const part = this.buf.slice(0, n);
      const s = part.join('\n') + '\n';
      this.buf = keepLast ? [this.buf[this.buf.length - 1]] : [];
      this.bufLen = keepLast ? this.buf[0].length + 1 : 0;
      this.total += s.length;
      this.chunks.push(this.blob ? new Blob([s]) : s);
    }
    // Move all lines of another sink (each followed by '\n') to the end of this one.
    append(other) {
      if (!other.lines) return;
      this._flush(false); other._flush(false);
      for (const c of other.chunks) this.chunks.push(c);
      this.total += other.total; this.lines += other.lines;
      other.chunks = []; other.total = 0; other.lines = 0;
    }
    result() {
      const last = this.buf.join('\n');
      this.buf = []; this.bufLen = 0;
      const total = this.total + last.length;
      const chunks = this.chunks; this.chunks = []; this.total = 0;
      if (this.blob) { chunks.push(last); return chunks; }
      if (total < TEXT_SINGLE_LIMIT) { chunks.push(last); return chunks.length === 1 ? chunks[0] : chunks.join(''); }
      if (last.length) chunks.push(last);
      else if (chunks.length) chunks[chunks.length - 1] = chunks[chunks.length - 1].slice(0, -1);
      return chunks;
    }
  }
  // Doubly linked record chain (XT EDGE/VERTEX/PLANE/LINE/POINT): holds one pending record until its
  // successor is known. fmt(prev, next) renders the line.
  class ChainSink {
    constructor(blob) { this.sink = new TextSink(blob); this.pendIdx = 0; this.pendPrev = 0; this.pendFmt = null; this.first = 0; this.count = 0; }
    push(idx, fmt) {
      let prev = 0;
      if (this.pendFmt) { this.sink.push(this.pendFmt(this.pendPrev, idx)); prev = this.pendIdx; }
      else this.first = idx;
      this.pendIdx = idx; this.pendPrev = prev; this.pendFmt = fmt; this.count++;
    }
    end() { if (this.pendFmt) { this.sink.push(this.pendFmt(this.pendPrev, 0)); this.pendFmt = null; } return this.sink; }
  }

  // Parts to export: visible ones, optionally replaced by a reduced-detail copy (state.exportDetail < 1).
  function exportPartList(parts, options) {
    const detail = options && options.detail != null ? options.detail : (state.exportDetail || 1);
    const vis = parts.filter((p) => p.visible);
    for (const p of vis) computePartBRep(p);
    if (!(detail > 0 && detail < 1)) return vis;
    return vis.map((p) => decimatedPart(p, detail));
  }

  function buildParasolidXT(parts, options = {}) {
    const visibleParts = exportPartList(parts, options);
    const brepMode = options.brepMode || state.brepMode || 'merged';
    const useMerged = brepMode !== 'faceted';
    const forceSheet = brepMode === 'sheet-unsewn' || brepMode === 'faceted';
    const useAssemblyRoot = brepMode === 'merged-assembly' && visibleParts.length > 1;
    const units = options.units || state.units || 'mm';
    const scaleM = getScaleToMeters(units);
    const fileName = (options.fileName || state.fileName || 'assembly').replace(/\.(pdf|u3d|prc)$/i, '') + '.x_t';

    const headerLines = [
      '**ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz**************************',
      '**PARASOLID !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~0123456789**************************',
      '**PART1;',
      'MC=x86_64;',
      'MC_MODEL=web_cad_workbench;',
      'OS=Linux;',
      'FRU=sdl_parasolid_3d_pdf_extractor;',
      'APPL=pdf_3d_extractor_nx;',
      'SITE=siemens_nx_cad;',
      'USER=steven;',
      'FORMAT=text;',
      'GUISE=transmit;',
      `FILE=${fileName};`,
      'DATE=23-oct-2026;',
      '**PART2;',
      'SCH=SCH_1200000_12006;',
      'USFLD_SIZE=0;',
      'UIO=1000;',
      '**PART3;',
      '**END_OF_HEADER*****************************************************************',
      'T51 : TRANSMIT FILE created by modeller version 120000017 SCH_1200000_120060'
    ];
    const out = new TextSink(options.blob);
    for (const l of headerLines) out.push(l);

    let nextIdx = 1;
    const allocIdx = () => nextIdx++;

    // Compute dynamic size box (res_size >= 1000) so large architectural models in ft/m never exceed size box
    let maxCoordAbsM = 1.0;
    for (const p of visibleParts) {
      const vx = p.brep.vx;
      for (let i = 0; i < vx.length; i++) {
        const a = Math.abs(vx[i] * scaleM);
        if (a > maxCoordAbsM) maxCoordAbsM = a;
      }
    }
    const resSize = Math.max(1000, Math.ceil((maxCoordAbsM * 2.5) / 1000) * 1000);

    // Helper: check if a part's sourceFaces form a strict 2-manifold closed solid within Parasolid 1e-8 m plane tolerance
    function getValidSolidFaces(part, B) {
      if (forceSheet || !part.brep.isWatertight) return null;
      const verts = B.weldedVerts;
      const candidateFaces = [];
      const rawFaces = useMerged ? B.mergedFaces : B.tris.map((t) => ({ normal: t.normal, loops: [t.verts], tris: [] }));
      for (const mf of rawFaces) {
        const n = normalizeVec3(mf.normal);
        const p0 = verts[mf.loops[0][0]];
        let maxDevM = 0;
        let hasSelfRepeat = false;
        const seenInFace = new Set();
        for (const lp of mf.loops) {
          for (const vIdx of lp) {
            if (seenInFace.has(vIdx)) hasSelfRepeat = true;
            seenInFace.add(vIdx);
            const pv = verts[vIdx];
            const devM = Math.abs(((pv[0] - p0[0]) * n[0] + (pv[1] - p0[1]) * n[1] + (pv[2] - p0[2]) * n[2]) * scaleM);
            if (devM > maxDevM) maxDevM = devM;
          }
        }
        if ((maxDevM <= 4e-9 && !hasSelfRepeat) || !mf.tris || mf.tris.length === 0) {
          candidateFaces.push({ normal: n, loops: mf.loops });
        } else {
          for (const tIdx of mf.tris) {
            const t = B.tris[tIdx];
            candidateFaces.push({ normal: normalizeVec3(t.normal), loops: [t.verts] });
          }
        }
      }
      // Verify every undirected edge across candidateFaces has exactly 1 '+' fin and 1 '-' fin
      const NV = Math.max(1, verts.length);
      const edgeCheck = new Map();
      for (const sf of candidateFaces) {
        for (const lp of sf.loops) {
          if (lp.length < 3) return null;
          for (let k = 0; k < lp.length; k++) {
            const u = lp[k], v = lp[(k + 1) % lp.length];
            if (u === v) return null;
            const key = u < v ? u * NV + v : v * NV + u;
            const st = edgeCheck.get(key) || 0;
            edgeCheck.set(key, st + (u < v ? 1 : 65536));
          }
        }
      }
      for (const st of edgeCheck.values()) {
        if (st !== 65537) return null;
      }
      return candidateFaces;
    }

    // Emit one Parasolid 12 BODY record + all topological/geometric children, one part at a time.
    // Returns false (nothing written) if solid mode was requested and a part is not a valid solid.
    function emitBody(bodyIdx, refInstanceIdx, bodyParts, isSolidBody) {
      let nodeIdCounter = 1;
      const allocNodeId = () => nodeIdCounter++;
      const BL = options.blob;
      const faceS = new TextSink(BL), loopS = new TextSink(BL), finS = new TextSink(BL);
      const edgeC = new ChainSink(BL), vertC = new ChainSink(BL), planeC = new ChainSink(BL), lineC = new ChainSink(BL), pointC = new ChainSink(BL);
      const shellC = new ChainSink(BL);
      const regionRecords = [];
      const shellRecords = [];
      let vertexEntities, edgeEntities, faceEntities, loopEntities, finEntities, planeEntities;
      const resetPart = () => { vertexEntities = []; edgeEntities = []; faceEntities = []; loopEntities = []; finEntities = []; planeEntities = []; };
      const flushPart = () => {
        for (const f of faceEntities) {
          faceS.push(`14 ${f.fIdx} ${f.nodeIdF} 0 ? ${f.nextF} ${f.prevF} ${f.firstLoopIdx} ${f.backShellIdx} ${f.surfIdx} + 0 0 ${f.nextF} ${f.prevF} ${f.frontShellIdx}`);
        }
        for (const lp of loopEntities) loopS.push(`15 ${lp.lpIdx} ${lp.nodeIdLp} 0 ${lp.firstFinIdx} ${lp.fIdx} ${lp.nextLoopIdx}`);
        for (const fn of finEntities) {
          finS.push(`17 ${fn.fnIdx} 0 ${fn.lpIdx} ${fn.fwdFin} ${fn.bwdFin} ${fn.fwdVxIdx} ${fn.otherFin} ${fn.edge.eIdx} 0 ${fn.nextAtVx} ${fn.sense}`);
        }
        for (const e of edgeEntities) {
          const primaryFin = e.posFin ? e.posFin.fnIdx : (e.negFin ? e.negFin.fnIdx : 0);
          const s0 = `16 ${e.eIdx} ${e.nodeIdE} 0 ? ${primaryFin} `, s1 = ` ${e.lIdx} 0 0 ${bodyIdx}`;
          edgeC.push(e.eIdx, (prevE, nextE) => s0 + prevE + ' ' + nextE + s1);
        }
        for (const v of vertexEntities) {
          const s0 = `18 ${v.vIdx} ${v.nodeIdV} 0 ${v.firstFinIdx} `, s1 = ` ${v.pIdx} ? ${bodyIdx}`;
          vertC.push(v.vIdx, (prevV, nextV) => s0 + prevV + ' ' + nextV + s1);
        }
        for (const s of planeEntities) {
          const [px, py, pz] = s.pOrig;
          const [nx, ny, nz] = s.normal;
          const [ux, uy, uz] = s.uAxis;
          const s0 = `50 ${s.surfIdx} ${s.nodeIdS} 0 ${s.fIdx} `;
          const s1 = ` 0 + ${fmtNum(px)} ${fmtNum(py)} ${fmtNum(pz)} ${fmtNum(nx)} ${fmtNum(ny)} ${fmtNum(nz)} ${fmtNum(ux)} ${fmtNum(uy)} ${fmtNum(uz)}`;
          planeC.push(s.surfIdx, (prevS, nextS) => s0 + nextS + ' ' + prevS + s1);
        }
        for (const e of edgeEntities) {
          const [px, py, pz] = e.originM;
          const [dx, dy, dz] = e.dir;
          const s0 = `30 ${e.lIdx} ${e.nodeIdL} 0 ${e.eIdx} `;
          const s1 = ` 0 + ${fmtNum(px)} ${fmtNum(py)} ${fmtNum(pz)} ${fmtNum(dx)} ${fmtNum(dy)} ${fmtNum(dz)}`;
          lineC.push(e.lIdx, (prevL, nextL) => s0 + nextL + ' ' + prevL + s1);
        }
        for (const v of vertexEntities) {
          const [x, y, z] = v.xyzM;
          const s0 = `29 ${v.pIdx} ${v.nodeIdP} 0 ${v.vIdx} `, s1 = ` ${fmtNum(x)} ${fmtNum(y)} ${fmtNum(z)}`;
          pointC.push(v.pIdx, (prevP, nextP) => s0 + nextP + ' ' + prevP + s1);
        }
        resetPart();
      };
      resetPart();

      const regVoidIdx = allocIdx();
      const regVoidNodeId = allocNodeId();
      let bodyShellPtr = 0;

      if (isSolidBody) {
        // Closed 2-Manifold Solid Body (body_type = 1) with K >= 1 disjoint solid lumps
        const lumpInfos = [];
        for (let pPos = 0; pPos < bodyParts.length; pPos++) {
          const part = bodyParts[pPos];
          const B = getFullBRep(part);
          const sourceFaces = getValidSolidFaces(part, B);
          if (!sourceFaces) return false;
          const verts = B.weldedVerts;

          const regSolidIdx = allocIdx();
          const regSolidNodeId = allocNodeId();
          const shellVoidIdx = allocIdx();
          const shellVoidNodeId = allocNodeId();
          const shellSolidIdx = allocIdx();
          const shellSolidNodeId = allocNodeId();

          // Allocate VERTEX & POINT ONLY for vertices actually used by sourceFaces (preventing fin=0 orphan vertices!)
          const localVertMap = new Map();
          const getOrCreateVert = (rawVIdx) => {
            let vEnt = localVertMap.get(rawVIdx);
            if (!vEnt) {
              const xyz = verts[rawVIdx];
              vEnt = {
                vIdx: allocIdx(),
                pIdx: allocIdx(),
                nodeIdV: allocNodeId(),
                nodeIdP: allocNodeId(),
                xyzM: [xyz[0] * scaleM, xyz[1] * scaleM, xyz[2] * scaleM],
                firstFinIdx: 0
              };
              localVertMap.set(rawVIdx, vEnt);
              vertexEntities.push(vEnt);
            }
            return vEnt;
          };

          const NV = Math.max(1, verts.length);
          const localEdgeMap = new Map();
          const getOrCreateEdge = (uRaw, vRaw) => {
            const minRaw = Math.min(uRaw, vRaw), maxRaw = Math.max(uRaw, vRaw);
            const key = minRaw * NV + maxRaw;
            let e = localEdgeMap.get(key);
            if (!e) {
              const vMinEnt = getOrCreateVert(minRaw);
              const vMaxEnt = getOrCreateVert(maxRaw);
              const p0 = vMinEnt.xyzM;
              const p1 = vMaxEnt.xyzM;
              const dir = normalizeVec3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
              e = {
                eIdx: allocIdx(),
                lIdx: allocIdx(),
                nodeIdE: allocNodeId(),
                nodeIdL: allocNodeId(),
                uRaw: minRaw,
                vRaw: maxRaw,
                originM: p0,
                dir,
                posFin: null,
                negFin: null
              };
              localEdgeMap.set(key, e);
              edgeEntities.push(e);
            }
            return e;
          };

          const lumpFaces = [];
          for (const sf of sourceFaces) {
            const fIdx = allocIdx();
            const surfIdx = allocIdx();
            const nodeIdF = allocNodeId();
            const nodeIdS = allocNodeId();

            const firstVEnt = getOrCreateVert(sf.loops[0][0]);
            const pOrig = firstVEnt.xyzM;
            const normal = normalizeVec3(sf.normal);
            const uAxis = orthoBasis(normal);

            const faceLoops = [];
            for (const loopVerts of sf.loops) {
              if (loopVerts.length < 3) continue;
              const lpIdx = allocIdx();
              const nodeIdLp = allocNodeId();
              const loopFins = [];

              for (let k = 0; k < loopVerts.length; k++) {
                const uRaw = loopVerts[k];
                const vRaw = loopVerts[(k + 1) % loopVerts.length];
                const vEndEnt = getOrCreateVert(vRaw);
                const edge = getOrCreateEdge(uRaw, vRaw);
                const sense = uRaw === edge.uRaw ? '+' : '-';
                const fnIdx = allocIdx();
                const finObj = {
                  fnIdx,
                  lpIdx,
                  fwdFin: 0,
                  bwdFin: 0,
                  fwdVxIdx: vEndEnt.vIdx,
                  vxEntity: vEndEnt,
                  nextAtVx: 0,
                  otherFin: 0,
                  edge,
                  sense
                };
                if (sense === '+') edge.posFin = finObj;
                else edge.negFin = finObj;
                loopFins.push(finObj);
                finEntities.push(finObj);
              }

              for (let k = 0; k < loopFins.length; k++) {
                loopFins[k].fwdFin = loopFins[(k + 1) % loopFins.length].fnIdx;
                loopFins[k].bwdFin = loopFins[(k - 1 + loopFins.length) % loopFins.length].fnIdx;
                const vx = loopFins[k].vxEntity;
                loopFins[k].nextAtVx = vx.firstFinIdx;
                vx.firstFinIdx = loopFins[k].fnIdx;
              }

              const lpObj = { lpIdx, nodeIdLp, firstFinIdx: loopFins[0].fnIdx, fIdx, nextLoopIdx: 0 };
              faceLoops.push(lpObj);
              loopEntities.push(lpObj);
            }

            for (let k = 0; k < faceLoops.length - 1; k++) {
              faceLoops[k].nextLoopIdx = faceLoops[k + 1].lpIdx;
            }

            const fObj = {
              fIdx,
              nodeIdF,
              firstLoopIdx: faceLoops[0].lpIdx,
              backShellIdx: shellSolidIdx,
              frontShellIdx: shellVoidIdx,
              surfIdx,
              nextF: 0,
              prevF: 0
            };
            lumpFaces.push(fObj);
            faceEntities.push(fObj);
            planeEntities.push({ surfIdx, nodeIdS, fIdx, pOrig, normal, uAxis });
          }

          for (let i = 0; i < lumpFaces.length; i++) {
            lumpFaces[i].nextF = i + 1 < lumpFaces.length ? lumpFaces[i + 1].fIdx : 0;
            lumpFaces[i].prevF = i > 0 ? lumpFaces[i - 1].fIdx : 0;
          }

          lumpInfos.push({
            regSolidIdx,
            regSolidNodeId,
            shellVoidIdx,
            shellVoidNodeId,
            shellSolidIdx,
            shellSolidNodeId,
            firstFaceIdx: lumpFaces.length > 0 ? lumpFaces[0].fIdx : 0
          });

          // Link 2-fin rings on this lump's edges (edges never span parts)
          for (const e of edgeEntities) {
            if (e.posFin && e.negFin) {
              e.posFin.otherFin = e.negFin.fnIdx;
              e.negFin.otherFin = e.posFin.fnIdx;
            }
          }
          flushPart();
        }

        // Build Void Region + Solid Regions and Void Shells + Solid Shells
        const firstVoidShellIdx = lumpInfos.length > 0 ? lumpInfos[0].shellVoidIdx : 0;
        const firstSolidRegIdx = lumpInfos.length > 0 ? lumpInfos[0].regSolidIdx : 0;
        regionRecords.push(`19 ${regVoidIdx} ${regVoidNodeId} 0 ${bodyIdx} ${firstSolidRegIdx} 0 ${firstVoidShellIdx} V`);

        for (let i = 0; i < lumpInfos.length; i++) {
          const L = lumpInfos[i];
          const nextReg = i + 1 < lumpInfos.length ? lumpInfos[i + 1].regSolidIdx : 0;
          const prevReg = i === 0 ? regVoidIdx : lumpInfos[i - 1].regSolidIdx;
          regionRecords.push(`19 ${L.regSolidIdx} ${L.regSolidNodeId} 0 ${bodyIdx} ${nextReg} ${prevReg} ${L.shellSolidIdx} S`);

          const nextVoidSh = i + 1 < lumpInfos.length ? lumpInfos[i + 1].shellVoidIdx : 0;
          shellRecords.push(`13 ${L.shellVoidIdx} ${L.shellVoidNodeId} 0 0 ${nextVoidSh} 0 0 0 ${regVoidIdx} ${L.firstFaceIdx}`);
          shellRecords.push(`13 ${L.shellSolidIdx} ${L.shellSolidNodeId} 0 ${bodyIdx} 0 ${L.firstFaceIdx} 0 0 ${L.regSolidIdx} 0`);
        }
        bodyShellPtr = lumpInfos.length >= 1 ? lumpInfos[0].shellSolidIdx : 0;
      } else {
        // Open / Architectural Sheet Body (body_type = 3)
        // Each merged planar B-Rep face (with outer + hole loops) is emitted as a connected 13 SHELL
        // in regVoidIdx with exact plane-projected loop vertices and a [posFin (+), dummy negFin (-)] pair per edge.
        for (const part of bodyParts) {
          const B = getFullBRep(part);
          const verts = B.weldedVerts;
          const sourceFaces = useMerged
            ? B.mergedFaces.map((mf) => ({ normal: mf.normal, loops: mf.loops }))
            : B.tris.map((t) => ({ normal: t.normal, loops: [t.verts] }));

          for (const sf of sourceFaces) {
            const validLoops = sf.loops.filter((lp) => lp && lp.length >= 3);
            if (validLoops.length === 0) continue;

            const shIdx = allocIdx();
            const shNodeId = allocNodeId();
            const fIdx = allocIdx();
            const surfIdx = allocIdx();
            const nodeIdF = allocNodeId();
            const nodeIdS = allocNodeId();

            const normal = normalizeVec3(sf.normal);
            const uAxis = orthoBasis(normal);
            const rawOrig = verts[validLoops[0][0]];
            const pOrig = [rawOrig[0] * scaleM, rawOrig[1] * scaleM, rawOrig[2] * scaleM];

            const faceLoops = [];
            for (const loopVerts of validLoops) {
              const lpIdx = allocIdx();
              const nodeIdLp = allocNodeId();

              // Create dedicated loop vertices projected orthogonally onto the exact 50 PLANE (deviation < 1e-16 m)
              const lpVertEnts = loopVerts.map((vRawIdx) => {
                const raw = verts[vRawIdx];
                const px = raw[0] * scaleM, py = raw[1] * scaleM, pz = raw[2] * scaleM;
                const dist = (px - pOrig[0]) * normal[0] + (py - pOrig[1]) * normal[1] + (pz - pOrig[2]) * normal[2];
                const vEnt = {
                  vIdx: allocIdx(),
                  pIdx: allocIdx(),
                  nodeIdV: allocNodeId(),
                  nodeIdP: allocNodeId(),
                  xyzM: [px - dist * normal[0], py - dist * normal[1], pz - dist * normal[2]],
                  firstFinIdx: 0
                };
                vertexEntities.push(vEnt);
                return vEnt;
              });

              const loopFins = [];
              for (let k = 0; k < lpVertEnts.length; k++) {
                const vStartEnt = lpVertEnts[k];
                const vEndEnt = lpVertEnts[(k + 1) % lpVertEnts.length];
                const p0 = vStartEnt.xyzM;
                const p1 = vEndEnt.xyzM;
                // Project edge direction into plane and normalize for < 1e-16 orthogonality with plane normal
                let dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
                const nDot = dx * normal[0] + dy * normal[1] + dz * normal[2];
                const dir = normalizeVec3([dx - nDot * normal[0], dy - nDot * normal[1], dz - nDot * normal[2]]);

                const posFnIdx = allocIdx();
                const dummyNegFnIdx = allocIdx();
                const edge = {
                  eIdx: allocIdx(),
                  lIdx: allocIdx(),
                  nodeIdE: allocNodeId(),
                  nodeIdL: allocNodeId(),
                  originM: p0,
                  dir,
                  posFin: null,
                  negFin: null
                };
                edgeEntities.push(edge);

                // Real '+' fin along loop edge (vStart -> vEnd, points to vEnd)
                const posFin = {
                  fnIdx: posFnIdx, lpIdx, fwdFin: 0, bwdFin: 0, fwdVxIdx: vEndEnt.vIdx, vxEntity: vEndEnt,
                  nextAtVx: 0, otherFin: dummyNegFnIdx, edge, sense: '+'
                };
                // Dummy '-' fin on open boundary edge (vEnd -> vStart, points to vStart, loop/fwd/bwd = 0)
                // Per Parasolid XT Spec 5.3.9.1 & 5.3.9.2, dummy fin provides the start vertex of the edge
                const dummyNegFin = {
                  fnIdx: dummyNegFnIdx, lpIdx: 0, fwdFin: 0, bwdFin: 0, fwdVxIdx: vStartEnt.vIdx, vxEntity: vStartEnt,
                  nextAtVx: 0, otherFin: posFnIdx, edge, sense: '-'
                };

                edge.posFin = posFin;
                edge.negFin = dummyNegFin;
                loopFins.push(posFin);
                finEntities.push(posFin, dummyNegFin);

                // Link dummy '-' fin into vStart's vertex fin chain
                dummyNegFin.nextAtVx = vStartEnt.firstFinIdx;
                vStartEnt.firstFinIdx = dummyNegFin.fnIdx;
              }

              for (let k = 0; k < loopFins.length; k++) {
                loopFins[k].fwdFin = loopFins[(k + 1) % loopFins.length].fnIdx;
                loopFins[k].bwdFin = loopFins[(k - 1 + loopFins.length) % loopFins.length].fnIdx;
                const vx = loopFins[k].vxEntity;
                loopFins[k].nextAtVx = vx.firstFinIdx;
                vx.firstFinIdx = loopFins[k].fnIdx;
              }

              const lpObj = { lpIdx, nodeIdLp, firstFinIdx: loopFins[0].fnIdx, fIdx, nextLoopIdx: 0 };
              faceLoops.push(lpObj);
              loopEntities.push(lpObj);
            }

            for (let k = 0; k < faceLoops.length - 1; k++) {
              faceLoops[k].nextLoopIdx = faceLoops[k + 1].lpIdx;
            }

            faceEntities.push({
              fIdx, nodeIdF, firstLoopIdx: faceLoops[0].lpIdx, backShellIdx: shIdx, frontShellIdx: shIdx, surfIdx, nextF: 0, prevF: 0
            });
            planeEntities.push({ surfIdx, nodeIdS, fIdx, pOrig, normal, uAxis });

            const sfIdx = fIdx;
            shellC.push(shIdx, (prevSh, nextSh) => `13 ${shIdx} ${shNodeId} 0 ${bodyIdx} ${nextSh} ${sfIdx} 0 0 ${regVoidIdx} ${sfIdx}`);
          }
          flushPart();
        }

        const firstShellIdx = shellC.count > 0 ? shellC.first : 0;
        regionRecords.push(`19 ${regVoidIdx} ${regVoidNodeId} 0 ${bodyIdx} 0 0 ${firstShellIdx} V`);
        bodyShellPtr = firstShellIdx;
      }

      const highestNodeId = nodeIdCounter;
      const bodyTypeCode = isSolidBody ? 1 : 3;
      const firstSurfIdx = planeC.count > 0 ? planeC.first : 0;
      const firstCurveIdx = lineC.count > 0 ? lineC.first : 0;
      const firstPointIdx = pointC.count > 0 ? pointC.first : 0;
      const firstEdgeIdx = edgeC.count > 0 ? edgeC.first : 0;
      const firstVxIdx = vertC.count > 0 ? vertC.first : 0;

      // 12 = BODY (standard top-level or instance-referenced body: next = 0, previous = 0)
      out.push(`12 ${bodyIdx} ${highestNodeId} 0 0 0 0 0 0 ${resSize} 1e-8 ${refInstanceIdx} 0 0 1 0 ${bodyTypeCode} 1 ${bodyShellPtr} ${firstSurfIdx} ${firstCurveIdx} ${firstPointIdx} ${regVoidIdx} ${firstEdgeIdx} ${firstVxIdx}`);
      for (const rLine of regionRecords) out.push(rLine);   // 19 = REGION
      for (const sLine of shellRecords) out.push(sLine);    // 13 = SHELL (solid)
      out.append(shellC.end());                            // 13 = SHELL (sheet)
      out.append(faceS);                                   // 14 = FACE
      out.append(loopS);                                   // 15 = LOOP
      out.append(finS);                                    // 17 = FIN
      out.append(edgeC.end());                             // 16 = EDGE chain
      out.append(vertC.end());                             // 18 = VERTEX chain
      out.append(planeC.end());                            // 50 = PLANE chain
      out.append(lineC.end());                             // 30 = LINE chain
      out.append(pointC.end());                            // 29 = POINT chain
      return true;
    }

    function emitBodyRecord(bodyIdx, refInstanceIdx, bodyParts) {
      // Solid (body_type 1) only if every part is a valid closed 2-manifold; parts are expanded one at a
      // time, so try solid first (fast reject on the cached watertight flag) and fall back to sheet.
      const solidPossible = !forceSheet && bodyParts.length > 0 && bodyParts.every((p) => p.brep.isWatertight);
      const saveIdx = nextIdx;
      if (solidPossible && emitBody(bodyIdx, refInstanceIdx, bodyParts, true)) return;
      nextIdx = saveIdx;
      emitBody(bodyIdx, refInstanceIdx, bodyParts, false);
    }

    if (useAssemblyRoot) {
      const asmIdx = allocIdx(); // #1 = 10 ASSEMBLY
      const instIndices = visibleParts.map(() => allocIdx());
      const bodyIndices = visibleParts.map(() => allocIdx());
      const highestAsmNodeId = visibleParts.length + 1;
      out.push(`10 ${asmIdx} ${highestAsmNodeId} 0 0 0 0 0 0 0 ${resSize} 1e-8 0 0 0 1 0 1 ${instIndices[0]}`);
      for (let i = 0; i < visibleParts.length; i++) {
        const instIdx = instIndices[i];
        const nextInst = i + 1 < instIndices.length ? instIndices[i + 1] : 0;
        const prevInst = i > 0 ? instIndices[i - 1] : 0;
        out.push(`11 ${instIdx} ${i + 1} 0 ${asmIdx} ${bodyIndices[i]} 0 1 ${nextInst} ${prevInst} 0 0`);
      }
      for (let i = 0; i < visibleParts.length; i++) {
        emitBodyRecord(bodyIndices[i], instIndices[i], [visibleParts[i]]);
      }
    } else {
      const rootBodyIdx = allocIdx(); // #1 = 12 BODY containing all visible parts' lumps/shells
      emitBodyRecord(rootBodyIdx, 0, visibleParts);
    }

    // End of transmit file
    out.push('1 0');
    out.push('');
    return out.result();
  }

  // -------------------------------------------------------------------------
  const TEXT_SINGLE_LIMIT = 1 << 27;
  const TEXT_CHUNK = 1 << 25;
  function joinLarge(lines) {
    let total = 0;
    for (let i = 0; i < lines.length; i++) total += lines[i].length + 1;
    if (total < TEXT_SINGLE_LIMIT) return lines.join('\n');
    const out = [];
    let start = 0, n = 0;
    for (let i = 0; i < lines.length; i++) {
      n += lines[i].length + 1;
      if (n >= TEXT_CHUNK) { out.push(lines.slice(start, i + 1).join('\n') + '\n'); start = i + 1; n = 0; }
    }
    if (start < lines.length) out.push(lines.slice(start).join('\n'));
    else if (out.length) out[out.length - 1] = out[out.length - 1].slice(0, -1);
    return out;
  }
  function textChunks(t) { return t == null ? [] : Array.isArray(t) ? t : [t]; }
  function textLength(t) { return textChunks(t).reduce((n, c) => n + c.length, 0); }
  // First `max` lines + total line count, without splitting / copying the whole text.
  function previewLines(t, max) {
    const lines = []; let count = 1, cur = '';
    for (const c of textChunks(t)) {
      let p = 0;
      for (;;) {
        const q = c.indexOf('\n', p);
        if (q < 0) { if (lines.length < max) cur += c.slice(p); break; }
        if (lines.length < max) lines.push(cur + c.slice(p, q));
        cur = ''; count++; p = q + 1;
      }
    }
    if (lines.length < max) lines.push(cur);
    return { lines, count };
  }
  function forEachLine(t, fn) {
    for (const c of textChunks(t)) { const ls = c.split('\n'); for (let i = 0; i < ls.length; i++) fn(ls[i]); }
  }

  // -------------------------------------------------------------------------
  // 7. STEP AP214 (ISO-10303-21 .stp) Solid & Open-Shell Surface B-Rep Exporter
  // -------------------------------------------------------------------------
  function buildSTEPAP214(parts, options = {}) {
    const visibleParts = exportPartList(parts, options);
    const brepMode = options.brepMode || state.brepMode || 'merged';
    const useMerged = brepMode !== 'faceted';
    const forceSheet = brepMode === 'sheet-unsewn' || brepMode === 'faceted';
    const units = options.units || state.units || 'mm';
    const unitScale = getScaleFromMM(units);

    const out = new TextSink(options.blob);
    out.push('ISO-10303-21;');
    out.push('HEADER;');
    out.push("FILE_DESCRIPTION(('3D PDF Extracted B-Rep Assembly - STEP AP214'),'2;1');");
    out.push(`FILE_NAME('${(state.fileName || 'assembly').replace(/\.pdf$/i, '')}.stp','2026-10-23T12:00:00',('Steven Moran'),('CAD Engineering Workbench'),'3D PDF Geometry Extractor','1.0','');`);
    out.push("FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));");
    out.push('ENDSEC;');
    out.push('DATA;');

    let id = 1;
    const add = (expr) => {
      const curr = id++;
      out.push(`#${curr} = ${expr};`);
      return curr;
    };

    const appCtx = add("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`);
    const prodCtx = add(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);

    let lenUnit;
    if (units === 'in' || units === 'ft') {
      const siMm = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
      const dimExp = add('DIMENSIONAL_EXPONENTS(1.0,0.0,0.0,0.0,0.0,0.0,0.0)');
      const factor = units === 'ft' ? '304.8' : '25.4';
      const uName = units === 'ft' ? 'FOOT' : 'INCH';
      const lmu = add(`LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(${factor}),#${siMm})`);
      lenUnit = add(`(CONVERSION_BASED_UNIT('${uName}',#${lmu})LENGTH_UNIT()NAMED_UNIT(#${dimExp}))`);
    } else if (units === 'cm') {
      lenUnit = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.CENTI.,.METRE.))');
    } else if (units === 'm') {
      lenUnit = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT($,.METRE.))');
    } else {
      lenUnit = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
    }

    const angUnit = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
    const solidAng = add('(NAMED_UNIT(*)SOLID_ANGLE_UNIT()SI_UNIT($,.STERADIAN.))');
    const unc = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.0E-06),#${lenUnit},'distance_accuracy_value','confusion accuracy')`);
    const geomCtx = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solidAng}))REPRESENTATION_CONTEXT('3D_CAD_Assembly','3D'))`);

    const originPt = add("CARTESIAN_POINT('',(0.0,0.0,0.0))");
    const zDir = add("DIRECTION('',(0.0,0.0,1.0))");
    const xDir = add("DIRECTION('',(1.0,0.0,0.0))");
    const worldAxis = add(`AXIS2_PLACEMENT_3D('',#${originPt},#${zDir},#${xDir})`);

    const repItems = [worldAxis];
    let hasOpenShell = false;

    for (const part of visibleParts) {
      const brep = getFullBRep(part);
      const verts = brep.weldedVerts;
      const isPartSolid = !forceSheet && part.brep.isWatertight;

      // Allocate CARTESIAN_POINT & VERTEX_POINT lazily so only used vertices are emitted
      const stepVertMap = new Map();
      const getStepVert = (vIdx) => {
        let sv = stepVertMap.get(vIdx);
        if (!sv) {
          const [x, y, z] = verts[vIdx];
          const sx = x * unitScale, sy = y * unitScale, sz = z * unitScale;
          const cp = add(`CARTESIAN_POINT('',(${fmtNum(sx)},${fmtNum(sy)},${fmtNum(sz)}))`);
          const vp = add(`VERTEX_POINT('',#${cp})`);
          sv = { cp, vp, xyz: [sx, sy, sz] };
          stepVertMap.set(vIdx, sv);
        }
        return sv;
      };

      const edgeCurveMap = new Map();
      const NV = Math.max(1, verts.length);
      const getEdgeCurve = (u, v) => {
        const minV = Math.min(u, v), maxV = Math.max(u, v);
        const key = minV * NV + maxV;
        let ec = edgeCurveMap.get(key);
        if (!ec) {
          const sv0 = getStepVert(minV);
          const sv1 = getStepVert(maxV);
          const p0 = sv0.xyz, p1 = sv1.xyz;
          const [dx, dy, dz] = normalizeVec3([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]);
          const dirId = add(`DIRECTION('',(${fmtNum(dx)},${fmtNum(dy)},${fmtNum(dz)}))`);
          const vecId = add(`VECTOR('',#${dirId},1.0)`);
          const lineId = add(`LINE('',#${sv0.cp},#${vecId})`);
          const ecId = add(`EDGE_CURVE('',#${sv0.vp},#${sv1.vp},#${lineId},.T.)`);
          ec = { ecId, minV, maxV };
          edgeCurveMap.set(key, ec);
        }
        return ec;
      };

      const sourceFaces = useMerged
        ? brep.mergedFaces.map((mf) => ({ normal: mf.normal, loops: mf.loops }))
        : brep.tris.map((t) => ({ normal: t.normal, loops: [t.verts] }));

      const advFaceIds = [];

      for (const sf of sourceFaces) {
        const bounds = [];
        for (let li = 0; li < sf.loops.length; li++) {
          const loop = sf.loops[li];
          if (loop.length < 3) continue;
          const oEdges = [];
          for (let k = 0; k < loop.length; k++) {
            const u = loop[k];
            const v = loop[(k + 1) % loop.length];
            if (u === v) continue;
            const ec = getEdgeCurve(u, v);
            const sense = u === ec.minV ? '.T.' : '.F.';
            oEdges.push(`#${add(`ORIENTED_EDGE('',*,*,#${ec.ecId},${sense})`)}`);
          }
          if (oEdges.length < 3) continue;
          const elId = add(`EDGE_LOOP('',(${oEdges.join(',')}))`);
          const bId = li === 0
            ? add(`FACE_OUTER_BOUND('',#${elId},.T.)`)
            : add(`FACE_BOUND('',#${elId},.T.)`);
          bounds.push(`#${bId}`);
        }
        if (bounds.length === 0) continue;

        const nVec = normalizeVec3(sf.normal);
        const uVec = orthoBasis(nVec);
        const firstSv = getStepVert(sf.loops[0][0]);
        const normId = add(`DIRECTION('',(${fmtNum(nVec[0])},${fmtNum(nVec[1])},${fmtNum(nVec[2])}))`);
        const refId = add(`DIRECTION('',(${fmtNum(uVec[0])},${fmtNum(uVec[1])},${fmtNum(uVec[2])}))`);
        const axId = add(`AXIS2_PLACEMENT_3D('',#${firstSv.cp},#${normId},#${refId})`);
        const planeId = add(`PLANE('',#${axId})`);
        const afId = add(`ADVANCED_FACE('',(${bounds.join(',')}),#${planeId},.T.)`);
        advFaceIds.push(`#${afId}`);
      }

      if (advFaceIds.length === 0) continue;

      if (isPartSolid) {
        const shellId = add(`CLOSED_SHELL('${part.name}_ClosedShell',(${advFaceIds.join(',')}))`);
        const msbId = add(`MANIFOLD_SOLID_BREP('${part.name}',#${shellId})`);
        repItems.push(msbId);
      } else {
        hasOpenShell = true;
        const openShellId = add(`OPEN_SHELL('${part.name}_OpenShell',(${advFaceIds.join(',')}))`);
        const sbsmId = add(`SHELL_BASED_SURFACE_MODEL('${part.name}',(#${openShellId}))`);
        repItems.push(sbsmId);
      }
    }

    const repType = hasOpenShell ? 'SHAPE_REPRESENTATION' : 'ADVANCED_BREP_SHAPE_REPRESENTATION';
    const shapeRep = add(`${repType}('3D_PDF_Extracted_Assembly',(${repItems.map((x) => '#' + x).join(',')}),#${geomCtx})`);
    const prod = add(`PRODUCT('3D_PDF_Assembly','3D_PDF_Assembly','',(#${prodCtx}))`);
    const pdf = add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('1','',#${prod},.NOT_KNOWN.)`);
    const pdCtx = add(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
    const pd = add(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
    const pds = add(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
    add(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${shapeRep})`);

    out.push('ENDSEC;');
    out.push('END-ISO-10303-21;');
    out.push('');
    return out.result();
  }

  // -------------------------------------------------------------------------
  // 8. STL (Binary & ASCII), Wavefront OBJ, and IGES 5.3 Exporters
  // -------------------------------------------------------------------------
  function buildBinarySTL(parts, units = 'mm', options = {}) {
    const visibleParts = exportPartList(parts, options);
    const scale = getScaleFromMM(units);
    let totalTris = 0;
    for (const p of visibleParts) totalTris += p.brep.nt;

    const buf = new ArrayBuffer(84 + totalTris * 50);
    const dv = new DataView(buf);
    const hdr = `3D PDF CAD Extractor Binary STL (${units}) - ${visibleParts.length} solids`;
    for (let i = 0; i < 80; i++) {
      dv.setUint8(i, i < hdr.length ? hdr.charCodeAt(i) : 32);
    }
    dv.setUint32(80, totalTris, true);

    let offset = 84;
    const n = [0, 0, 0];
    for (const p of visibleParts) {
      const { vx, tv, nt } = p.brep;
      for (let t = 0; t < nt; t++) {
        const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2];
        triNormalInto(vx, a, b, c, n);
        dv.setFloat32(offset, n[0], true);
        dv.setFloat32(offset + 4, n[1], true);
        dv.setFloat32(offset + 8, n[2], true);
        offset += 12;
        for (let k = 0; k < 3; k++) {
          const v3 = 3 * (k === 0 ? a : k === 1 ? b : c);
          dv.setFloat32(offset, vx[v3] * scale, true);
          dv.setFloat32(offset + 4, vx[v3 + 1] * scale, true);
          dv.setFloat32(offset + 8, vx[v3 + 2] * scale, true);
          offset += 12;
        }
        dv.setUint16(offset, 0, true);
        offset += 2;
      }
    }
    return new Uint8Array(buf);
  }

  function buildASCIISTL(parts, units = 'mm', options = {}) {
    const visibleParts = exportPartList(parts, options);
    const scale = getScaleFromMM(units);
    const out = new TextSink(options.blob);
    out.push('solid CAD_3D_PDF_Assembly');
    const n = [0, 0, 0];
    for (const p of visibleParts) {
      const { vx, tv, nt } = p.brep;
      for (let t = 0; t < nt; t++) {
        const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2];
        triNormalInto(vx, a, b, c, n);
        out.push(`  facet normal ${fmtNum(n[0])} ${fmtNum(n[1])} ${fmtNum(n[2])}`);
        out.push('    outer loop');
        for (let k = 0; k < 3; k++) {
          const v3 = 3 * (k === 0 ? a : k === 1 ? b : c);
          out.push(`      vertex ${fmtNum(vx[v3] * scale)} ${fmtNum(vx[v3 + 1] * scale)} ${fmtNum(vx[v3 + 2] * scale)}`);
        }
        out.push('    endloop');
        out.push('  endfacet');
      }
    }
    out.push('endsolid CAD_3D_PDF_Assembly');
    out.push('');
    return out.result();
  }

  function buildWavefrontOBJ(parts, units = 'mm', options = {}) {
    const visibleParts = exportPartList(parts, options);
    const scale = getScaleFromMM(units);
    const out = new TextSink(options.blob);
    out.push('# 3D PDF Geometry Extractor - Multi-Body CAD Mesh (.obj)');
    out.push(`# Units: ${units}`);
    out.push('');
    let vOffset = 1;
    let nOffset = 1;
    const n = [0, 0, 0];
    for (const p of visibleParts) {
      const { vx, tv, nt, nv } = p.brep;
      out.push(`o ${p.name}`);
      out.push(`g ${p.name}`);
      for (let i = 0; i < nv; i++) {
        out.push(`v ${fmtNum(vx[3 * i] * scale)} ${fmtNum(vx[3 * i + 1] * scale)} ${fmtNum(vx[3 * i + 2] * scale)}`);
      }
      for (let t = 0; t < nt; t++) {
        triNormalInto(vx, tv[3 * t], tv[3 * t + 1], tv[3 * t + 2], n);
        out.push(`vn ${fmtNum(n[0])} ${fmtNum(n[1])} ${fmtNum(n[2])}`);
      }
      for (let t = 0; t < nt; t++) {
        const ni = nOffset + t;
        out.push(`f ${tv[3 * t] + vOffset}//${ni} ${tv[3 * t + 1] + vOffset}//${ni} ${tv[3 * t + 2] + vOffset}//${ni}`);
      }
      vOffset += nv;
      nOffset += nt;
      out.push('');
    }
    return out.result();
  }

  function buildIGESWireframe(parts, units = 'mm', options = {}) {
    const visibleParts = exportPartList(parts, options);
    const scale = getScaleFromMM(units);
    const pad72 = (s) => s.slice(0, 72).padEnd(72, ' ');
    const line80 = (s, sec, seq) => `${pad72(s)}${sec}${String(seq).padStart(7, ' ')}`;

    const sLines = [
      line80('3D PDF Geometry Extractor IGES 5.3 Feature Edge Wireframe', 'S', 1)
    ];
    const gLines = [
      line80('1H,,1H;,14H3D_PDF_CAD_ASM,14H3D_PDF_CAD.igs,10H3D_PDF_EXT,5H1.0.0,32,38,', 'G', 1),
      line80('6,308,15,14H3D_PDF_CAD_ASM,1.0,2,2HMM,1,0.01,13H261023.120000;', 'G', 2)
    ];
    const dSink = new TextSink(options.blob), pSink = new TextSink(options.blob);
    let dSeq = 1, pSeq = 1;

    for (const p of visibleParts) {
      const { vx, fev } = p.brep;
      for (let e = 0; e < fev.length; e += 2) {
        const u3 = 3 * fev[e], v3 = 3 * fev[e + 1];
        const pStr = `110,${(vx[u3] * scale).toFixed(5)},${(vx[u3 + 1] * scale).toFixed(5)},${(vx[u3 + 2] * scale).toFixed(5)},${(vx[v3] * scale).toFixed(5)},${(vx[v3 + 1] * scale).toFixed(5)},${(vx[v3 + 2] * scale).toFixed(5)};`;
        const pStart = pSeq;
        const dIdx = dSeq;
        pSink.push(`${pad72(pStr).slice(0, 64)}${String(dIdx).padStart(8, ' ')}P${String(pSeq++).padStart(7, ' ')}`);
        dSink.push(line80(`     110${String(pStart).padStart(8, ' ')}       0       0       1       0       0       000000001`, 'D', dSeq++));
        dSink.push(line80('     110       0       2       1       0                        LINE   1', 'D', dSeq++));
      }
    }

    const tLine = line80(
      `S${String(sLines.length).padStart(7, ' ')}G${String(gLines.length).padStart(7, ' ')}D${String(dSeq - 1).padStart(7, ' ')}P${String(pSeq - 1).padStart(7, ' ')}`,
      'T',
      1
    );
    const out = new TextSink(options.blob);
    for (const l of sLines) out.push(l);
    for (const l of gLines) out.push(l);
    out.append(dSink);
    out.append(pSink);
    out.push(tLine);
    out.push('');
    return out.result();
  }

  // -------------------------------------------------------------------------
  // Optional "reduce detail" (export) and decimated viewer preview: vertex clustering on a uniform
  // grid over the part bbox. Triangles whose corners collapse into one cell are dropped; the
  // representative vertex of a cell is the mean of its members. Result is a compact pseudo-part.
  // -------------------------------------------------------------------------
  function clusterDecimate(vx, tv, nt, grid) {
    const nv = vx.length / 3;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < nv; i++) {
      const x = vx[3 * i], y = vx[3 * i + 1], z = vx[3 * i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const ext = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const cell = ext / Math.max(1, grid);
    const cellMap = new Map();
    const remap = new Int32Array(nv);
    const acc = [];
    for (let i = 0; i < nv; i++) {
      const gx = Math.floor((vx[3 * i] - minX) / cell), gy = Math.floor((vx[3 * i + 1] - minY) / cell), gz = Math.floor((vx[3 * i + 2] - minZ) / cell);
      const key = (gx * 4096 + gy) * 4096 + gz;
      let c = cellMap.get(key);
      if (c === undefined) { c = acc.length / 4; cellMap.set(key, c); acc.push(0, 0, 0, 0); }
      acc[4 * c] += vx[3 * i]; acc[4 * c + 1] += vx[3 * i + 1]; acc[4 * c + 2] += vx[3 * i + 2]; acc[4 * c + 3]++;
      remap[i] = c;
    }
    const nc = acc.length / 4;
    const pos = new Float64Array(nc * 3);
    for (let c = 0; c < nc; c++) { const k = acc[4 * c + 3]; pos[3 * c] = acc[4 * c] / k; pos[3 * c + 1] = acc[4 * c + 1] / k; pos[3 * c + 2] = acc[4 * c + 2] / k; }
    const seen = new Set();
    const idx = [];
    for (let t = 0; t < nt; t++) {
      const a = remap[tv[3 * t]], b = remap[tv[3 * t + 1]], c = remap[tv[3 * t + 2]];
      if (a === b || b === c || a === c) continue;
      // drop exact duplicates (same cell triple, same orientation)
      const r = a < b ? (a < c ? 0 : 2) : (b < c ? 1 : 2);
      const k0 = r === 0 ? a : r === 1 ? b : c, k1 = r === 0 ? b : r === 1 ? c : a, k2 = r === 0 ? c : r === 1 ? a : b;
      const key = (k0 * 2097152 + k1) * 2097152 + k2;
      if (nc < 2097152 && seen.has(key)) continue;
      if (nc < 2097152) seen.add(key);
      idx.push(a, b, c);
    }
    return { pos, idx: Uint32Array.from(idx), nt: idx.length / 3 };
  }
  // Decimate one compact part to ~ratio of its triangles: binary search on the grid resolution
  // (cluster count grows roughly monotonically with the grid), keeping the evaluated result whose
  // triangle count is closest to the target. The search runs to convergence (~11 steps over 2..2048);
  // it used to stop after 9 steps and fall back to the coarsest grid, which on low-poly parts
  // (e.g. a 224-tri die: 50% -> 18 tris) kept only ~8%. Returns null when no grid reduces the part.
  function decimateCompact(b, ratio) {
    const target = Math.max(4, Math.floor(b.nt * ratio));
    if (b.nt <= target) return null;
    let lo = 2, hi = 2048, best = null, bestErr = Infinity;
    while (lo <= hi) {
      const g = (lo + hi) >> 1;
      const d = clusterDecimate(b.vx, b.tv, b.nt, g);
      if (d.nt < b.nt && d.nt > 0) {
        const err = Math.abs(d.nt - target);
        if (err < bestErr || (err === bestErr && d.nt < best.nt)) { best = d; bestErr = err; }
      }
      if (d.nt > target) hi = g - 1;
      else if (d.nt < target) lo = g + 1;
      else break;
    }
    return best;
  }
  // Reduced-detail export copy of a part (cached per ratio on the part's brep).
  function decimatedPart(part, ratio) {
    const b = computePartBRep(part);
    b._dec = b._dec || {};
    if (b._dec[ratio]) return b._dec[ratio];
    const d = decimateCompact(b, ratio);
    let dp;
    if (!d) dp = part;
    else {
      dp = { name: part.name, color: part.color, visible: true, analyticFeatures: [], pos: d.pos, idx: d.idx, brep: null };
      const prev = fullCacheEnabled; fullCacheEnabled = false;
      try { computePartBRep(dp); } finally { fullCacheEnabled = prev; }
    }
    b._dec[ratio] = dp;
    return dp;
  }

  // -------------------------------------------------------------------------
  // 9. Interactive 3D CAD Viewport Renderer (Shaded + Feature Edges + B-Rep Groups + X-Ray)
  // -------------------------------------------------------------------------
  function computeAssemblyBounds(parts) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let totalVerts = 0, totalTris = 0, totalParsedTris = 0, totalMergedFaces = 0, totalEdges = 0, totalHoles = 0;
    let allWatertight = true;

    const visibleParts = parts.filter((p) => p.visible);
    const list = visibleParts.length > 0 ? visibleParts : parts;

    for (const p of list) {
      const b = computePartBRep(p);
      if (b.bbox.min[0] < minX) minX = b.bbox.min[0];
      if (b.bbox.min[1] < minY) minY = b.bbox.min[1];
      if (b.bbox.min[2] < minZ) minZ = b.bbox.min[2];
      if (b.bbox.max[0] > maxX) maxX = b.bbox.max[0];
      if (b.bbox.max[1] > maxY) maxY = b.bbox.max[1];
      if (b.bbox.max[2] > maxZ) maxZ = b.bbox.max[2];
      totalVerts += b.weldedVerts.length;
      totalTris += b.tris.length;
      totalParsedTris += p.triCount != null ? p.triCount : b.tris.length;
      totalMergedFaces += b.mergedFaces.length;
      totalEdges += b.featureEdges.length;
      totalHoles += b.holeCount;
      if (!b.isWatertight) allWatertight = false;
    }

    if (!isFinite(minX)) {
      minX = -50; minY = -50; minZ = -50;
      maxX = 50; maxY = 50; maxZ = 50;
    }

    const size = [maxX - minX, maxY - minY, maxZ - minZ];
    const center = [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5];
    const radius = Math.max(10, Math.hypot(size[0], size[1], size[2]) * 0.5);

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size,
      center,
      radius,
      totalVerts,
      totalTris,
      totalParsedTris, // as decoded, before the B-Rep drops degenerate triangles
      totalMergedFaces,
      totalEdges,
      totalHoles,
      allWatertight
    };
  }

  const PREVIEW_MAX_TRIS = 200000;   // viewer draws a vertex-clustered preview above this
  const PREVIEW_MAX_EDGES = 150000;
  const INSPECTOR_MAX_TRIS = 200000; // XT/STEP inspector preview is skipped above this (use Export)
  const BIG_MODEL_TRIS = 1000000;    // warning banner threshold
  // Preview geometry of one compact part (vertex-clustered decimation cached per ratio when ratio < 1).
  function previewGeometry(b, ratio) {
    if (ratio >= 1) return b;
    const key = Math.round(ratio * 1e4) / 1e4;
    b._preview = b._preview || {};
    if (!b._preview[key]) {
      const d = decimateCompact(b, ratio);
      b._preview[key] = d ? { vx: d.pos, tv: d.idx, nt: d.nt, nv: d.pos.length / 3, triFace: null, fev: null } : b;
    }
    return b._preview[key];
  }

  // WebGL path (viewer-gl.js): real depth buffer, smooth normals, depth-tested edges/wires, render on demand.
  function renderViewportGL(glv) {
    const bounds = computeAssemblyBounds(state.parts);
    const explodeRatio = (state.explodeFactor || 0) / 100;
    const vis = [];
    let totalTris = 0;
    state.parts.forEach((part, pIdx) => {
      if (!part.visible) return;
      const b = computePartBRep(part);
      totalTris += b.nt;
      vis.push({ part, pIdx, b });
    });
    const cap = window.PDF3DViewerGL.MAX_TRIS;
    const ratio = totalTris > cap ? cap / totalTris : 1;
    state.previewRatio = ratio;
    let nDraw = 0;
    const items = vis.map(({ part, pIdx, b }) => {
      const g = previewGeometry(b, ratio);
      nDraw += g.nt;
      const pc = b.bbox.center;
      return {
        g, pIdx, color: part.color,
        offset: [(pc[0] - bounds.center[0]) * explodeRatio * 0.9, (pc[1] - bounds.center[1]) * explodeRatio * 0.9,
          (pIdx - (state.parts.length - 1) * 0.5) * 28 * explodeRatio]
      };
    });
    glv.render({
      epoch: state.parts, center: bounds.center, radius: bounds.radius, camera: state.camera,
      renderMode: state.renderMode || 'shaded-edges', selectedPartIdx: state.selectedPartIdx,
      items, wires: state.wires || [], palette: PALETTE, grid: { z: bounds.min[2], step: 20, extent: 80 },
      note: ratio < 1 ? `Preview decimated to ~${nDraw.toLocaleString()} of ${totalTris.toLocaleString()} tris (exports use full detail)` : ''
    });
  }

  // Camera orientation: free quaternion arcball (default) or legacy Z-up turntable, via window.PDF3DCamera (viewer-gl.js).
  function viewBasis(cam) {
    if (window.PDF3DCamera) return window.PDF3DCamera.basis(cam);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    return { r: [cy, -sy, 0], u: [sp * sy, sp * cy, cp], d: [cp * sy, cp * cy, -sp] };
  }
  function setCameraYawPitch(yaw, pitch) {
    if (window.PDF3DCamera) window.PDF3DCamera.setYawPitch(state.camera, yaw, pitch);
    else { state.camera.yaw = yaw; state.camera.pitch = pitch; }
  }
  function syncOrbitButtons() {
    document.querySelectorAll('[data-orbit]').forEach((b) => {
      const on = b.getAttribute('data-orbit') === state.camera.mode;
      b.classList.toggle('btn-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // Coalesce pointer-driven redraws into one per animation frame (the Canvas 2D fallback renders synchronously).
  let viewportRaf = 0;
  function requestViewportRender() {
    if (viewportRaf) return;
    const raf = window.requestAnimationFrame || ((f) => setTimeout(f, 16));
    viewportRaf = raf(() => { viewportRaf = 0; renderViewport(); });
  }

  function renderViewport() {
    const canvas = document.getElementById('viewportCanvas');
    if (!canvas) return;
    const glv = window.PDF3DViewerGL ? window.PDF3DViewerGL.attach(canvas) : null;
    if (glv) { renderViewportGL(glv); return; }
    const hudRender = document.getElementById('hudRenderStats');
    if (hudRender) hudRender.textContent = 'Canvas 2D renderer (no WebGL)';
    // ---- Canvas 2D fallback (no WebGL): painter's algorithm ----
    const viewOpts = (window.PDF3DViewerGL && window.PDF3DViewerGL.options) || { wires: true };
    const rect = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(240, Math.floor(rect.height));
    if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const bounds = computeAssemblyBounds(state.parts);
    const cam = state.camera;
    const camB = viewBasis(cam), vR = camB.r, vU = camB.u, vD = camB.d;

    const baseScale = (Math.min(w, h) * 0.39) / bounds.radius;
    const scale = baseScale * cam.zoom;
    const cxScreen = w * 0.5 + cam.panX;
    const cyScreen = h * 0.52 + cam.panY;

    function projectPoint(x, y, z) {
      const dx = x - bounds.center[0];
      const dy = y - bounds.center[1];
      const dz = z - bounds.center[2];
      // view basis (free arcball or Z-up turntable): x1 = right, z2 = up, y2 = depth
      const x1 = dx * vR[0] + dy * vR[1] + dz * vR[2];
      const y2 = dx * vD[0] + dy * vD[1] + dz * vD[2];
      const z2 = dx * vU[0] + dy * vU[1] + dz * vU[2];
      return {
        sx: cxScreen + x1 * scale,
        sy: cyScreen - z2 * scale,
        depth: y2
      };
    }

    function rotateVec(nx, ny, nz) {
      return [nx * vR[0] + ny * vR[1] + nz * vR[2], nx * vD[0] + ny * vD[1] + nz * vD[2], nx * vU[0] + ny * vU[1] + nz * vU[2]];
    }

    // 1. Draw subtle CAD XY datum grid on Z = bounds.min[2]
    const zGrid = bounds.min[2];
    const gridStep = 20;
    const gridExtent = 80;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.14)';
    ctx.beginPath();
    for (let g = -gridExtent; g <= gridExtent; g += gridStep) {
      const pA = projectPoint(g, -gridExtent, zGrid);
      const pB = projectPoint(g, gridExtent, zGrid);
      ctx.moveTo(pA.sx, pA.sy);
      ctx.lineTo(pB.sx, pB.sy);
      const pC = projectPoint(-gridExtent, g, zGrid);
      const pD = projectPoint(gridExtent, g, zGrid);
      ctx.moveTo(pC.sx, pC.sy);
      ctx.lineTo(pD.sx, pD.sy);
    }
    ctx.stroke();

    // 2. Collect triangles & feature edges across visible parts (typed buffers; huge models are drawn
    //    from a decimated preview so the canvas stays interactive and memory stays bounded).
    const explodeRatio = (state.explodeFactor || 0) / 100;
    const items = [];
    let totalTris = 0;
    state.parts.forEach((part, pIdx) => {
      if (!part.visible) return;
      const b = computePartBRep(part);
      totalTris += b.nt;
      items.push({ part, pIdx, b });
    });
    const ratio = totalTris > PREVIEW_MAX_TRIS ? PREVIEW_MAX_TRIS / totalTris : 1;
    state.previewRatio = ratio;
    let nDraw = 0, nEdge = 0;
    for (const it of items) {
      const g = previewGeometry(it.b, ratio);
      it.g = g; nDraw += g.nt;
      if (g.fev) nEdge += g.fev.length / 2;
    }
    const drawEdgesOn = nEdge <= PREVIEW_MAX_EDGES;
    const triScr = new Float32Array(nDraw * 6);
    const triDepth = new Float32Array(nDraw);
    const triNrm = new Float32Array(nDraw * 3);
    const triItem = new Uint32Array(nDraw);
    const triFaceG = new Int32Array(nDraw);
    const edgeScr = new Float32Array(drawEdgesOn ? nEdge * 4 : 0);
    const edgeSel = new Uint8Array(drawEdgesOn ? nEdge : 0);
    let ti = 0, ei = 0;
    const nrm = [0, 0, 0];
    items.forEach((it, itemIdx) => {
      const { b, g, pIdx } = it;
      const pCenter = b.bbox.center;
      const exX = (pCenter[0] - bounds.center[0]) * explodeRatio * 0.9;
      const exY = (pCenter[1] - bounds.center[1]) * explodeRatio * 0.9;
      const exZ = (pIdx - (state.parts.length - 1) * 0.5) * 28 * explodeRatio;
      const vx = g.vx, nv = vx.length / 3;
      const pv = new Float32Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        const q = projectPoint(vx[3 * i] + exX, vx[3 * i + 1] + exY, vx[3 * i + 2] + exZ);
        pv[3 * i] = q.sx; pv[3 * i + 1] = q.sy; pv[3 * i + 2] = q.depth;
      }
      const tv = g.tv;
      for (let t = 0; t < g.nt; t++, ti++) {
        const a = tv[3 * t], bb = tv[3 * t + 1], c = tv[3 * t + 2];
        triScr[6 * ti] = pv[3 * a]; triScr[6 * ti + 1] = pv[3 * a + 1];
        triScr[6 * ti + 2] = pv[3 * bb]; triScr[6 * ti + 3] = pv[3 * bb + 1];
        triScr[6 * ti + 4] = pv[3 * c]; triScr[6 * ti + 5] = pv[3 * c + 1];
        triDepth[ti] = (pv[3 * a + 2] + pv[3 * bb + 2] + pv[3 * c + 2]) / 3;
        triNormalInto(vx, a, bb, c, nrm);
        triNrm[3 * ti] = nrm[0]; triNrm[3 * ti + 1] = nrm[1]; triNrm[3 * ti + 2] = nrm[2];
        triItem[ti] = itemIdx;
        triFaceG[ti] = g.triFace ? g.triFace[t] : 0;
      }
      if (drawEdgesOn && g.fev) {
        const sel = state.selectedPartIdx === pIdx ? 1 : 0;
        for (let e = 0; e < g.fev.length; e += 2, ei++) {
          const u = g.fev[e], v = g.fev[e + 1];
          edgeScr[4 * ei] = pv[3 * u]; edgeScr[4 * ei + 1] = pv[3 * u + 1];
          edgeScr[4 * ei + 2] = pv[3 * v]; edgeScr[4 * ei + 3] = pv[3 * v + 1];
          edgeSel[ei] = sel;
        }
      }
    });

    // Painter's algorithm sort (back to front: higher y2 is further away in our camera convention)
    const order = new Uint32Array(nDraw);
    for (let i = 0; i < nDraw; i++) order[i] = i;
    order.sort((x, y) => triDepth[y] - triDepth[x]);

    const renderMode = state.renderMode || 'shaded-edges';
    const pathTri = (k) => {
      ctx.beginPath();
      ctx.moveTo(triScr[6 * k], triScr[6 * k + 1]);
      ctx.lineTo(triScr[6 * k + 2], triScr[6 * k + 3]);
      ctx.lineTo(triScr[6 * k + 4], triScr[6 * k + 5]);
      ctx.closePath();
    };

    if (renderMode !== 'wireframe') {
      for (let oi = 0; oi < nDraw; oi++) {
        const k = order[oi];
        const it = items[triItem[k]];
        const [rx, ry, rz] = rotateVec(triNrm[3 * k], triNrm[3 * k + 1], triNrm[3 * k + 2]);
        // Two-point CAD studio lighting
        const keyLight = Math.max(0, rx * 0.45 - ry * 0.55 + rz * 0.70);
        const fillLight = Math.max(0, -rx * 0.40 + ry * 0.30 + rz * 0.35);
        const shade = 0.30 + 0.62 * keyLight + 0.22 * fillLight;

        let baseRGB = it.part.color;
        if (renderMode === 'brep-faces') {
          baseRGB = PALETTE[(triFaceG[k] + it.pIdx * 2) % PALETTE.length];
        }

        let r = Math.min(255, Math.round(baseRGB[0] * 255 * shade));
        let g = Math.min(255, Math.round(baseRGB[1] * 255 * shade));
        let b = Math.min(255, Math.round(baseRGB[2] * 255 * shade));

        if (state.selectedPartIdx === it.pIdx) {
          r = Math.min(255, r + 28);
          g = Math.min(255, g + 38);
          b = Math.min(255, b + 45);
        }

        pathTri(k);
        if (renderMode === 'xray') {
          ctx.fillStyle = `rgba(${r},${g},${b},0.34)`;
          ctx.fill();
        } else {
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fill();
          // same-colour hairline stroke closes the per-triangle antialiasing seams (background bleeding
          // through between adjacent triangles = "tiger stripes")
          ctx.strokeStyle = ctx.fillStyle;
          ctx.lineWidth = 0.6;
          ctx.lineJoin = 'round';
          ctx.stroke();
        }
      }
    }

    // PRC wires / curves and exact B-Rep edges
    if (viewOpts.wires !== false && (state.wires || []).length) {
      let segBudget = 400000;
      ctx.lineWidth = 1;
      for (const wr of state.wires) {
        if (wr.visible === false || segBudget <= 0) continue;
        const c = (wr.color || [0, 0, 0]).map((v) => Math.round(v * 255));
        ctx.strokeStyle = (c[0] + c[1] + c[2] < 60) ? 'rgba(226,232,240,0.55)' : `rgb(${c[0]},${c[1]},${c[2]})`;
        ctx.beginPath();
        for (const pl of wr.polylines || []) {
          for (let k = 0; k < pl.length; k++) {
            const q = wr.positions[pl[k]]; if (!q) continue;
            const pv = projectPoint(q[0], q[1], q[2]);
            if (k === 0) ctx.moveTo(pv.sx, pv.sy); else ctx.lineTo(pv.sx, pv.sy);
          }
          segBudget -= pl.length; if (segBudget <= 0) break;
        }
        ctx.stroke();
      }
    }

    // Draw edges
    if (renderMode === 'wireframe') {
      ctx.lineWidth = 0.85;
      for (let oi = 0; oi < nDraw; oi++) {
        const k = order[oi];
        const it = items[triItem[k]];
        const [r, g, b] = it.part.color.map((c) => Math.round(c * 255));
        ctx.strokeStyle = state.selectedPartIdx === it.pIdx ? '#22d3ee' : `rgba(${r},${g},${b},0.78)`;
        pathTri(k);
        ctx.stroke();
      }
    } else if (renderMode === 'shaded-edges' || renderMode === 'brep-faces' || renderMode === 'xray') {
      for (let e = 0; e < ei; e++) {
        const selected = edgeSel[e] === 1;
        ctx.lineWidth = selected ? 1.65 : 1.05;
        ctx.strokeStyle = selected
          ? '#22d3ee'
          : renderMode === 'xray'
            ? 'rgba(148, 210, 255, 0.68)'
            : 'rgba(9, 14, 23, 0.82)';
        ctx.beginPath();
        ctx.moveTo(edgeScr[4 * e], edgeScr[4 * e + 1]);
        ctx.lineTo(edgeScr[4 * e + 2], edgeScr[4 * e + 3]);
        ctx.stroke();
      }
    }
    if (ratio < 1) {
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
      ctx.fillText(`Preview decimated to ~${nDraw.toLocaleString()} of ${totalTris.toLocaleString()} tris (exports use full detail)`, 12, h - 12);
    }

    // 3. Draw CAD XYZ orientation triad in bottom-right corner
    const triadCx = w - 54;
    const triadCy = h - 48;
    const triadLen = 28;
    const axes = [
      { label: 'X', vec: [1, 0, 0], color: '#f43f5e' },
      { label: 'Y', vec: [0, 1, 0], color: '#10b981' },
      { label: 'Z', vec: [0, 0, 1], color: '#3b82f6' }
    ];
    ctx.font = 'bold 11px "JetBrains Mono", monospace';
    for (const ax of axes) {
      const [rx, , rz] = rotateVec(ax.vec[0], ax.vec[1], ax.vec[2]);
      const ex = triadCx + rx * triadLen;
      const ey = triadCy - rz * triadLen;
      ctx.strokeStyle = ax.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(triadCx, triadCy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      ctx.fillStyle = ax.color;
      ctx.fillText(ax.label, ex + (rx >= 0 ? 4 : -10), ey + (rz >= 0 ? -4 : 10));
    }

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // 10. UI Panels, Inspector Drawer & File Export Triggers
  // -------------------------------------------------------------------------
  function escHTML(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Product tree (PRC product occurrences) + wires + embedded file attachments
  function renderTreeAndAttachments() {
    const treeEl = document.getElementById('treeList');
    if (treeEl) {
      const rows = []; let budget = 2000;
      const walk = (n, depth) => {
        if (!n || budget-- <= 0) return;
        const items = (n.part && n.part.items) || [];
        const meshes = items.filter((it) => it.partName).length, wires = items.filter((it) => it.wireName).length;
        rows.push(`<div class="tree-row" style="padding-left:${6 + depth * 12}px" title="${escHTML(n.matrix ? 'transformed' : '')}">` +
          `<span>${n.children && n.children.length ? '▾' : '•'} ${escHTML(n.name || (n.part && n.part.name) || 'product')}</span>` +
          `<code>${meshes ? meshes + ' mesh' : ''}${wires ? ' ' + wires + ' wire' : ''}</code></div>`);
        for (const c of n.children || []) walk(c, depth + 1);
      };
      const tree = Array.isArray(state.tree) ? state.tree : state.tree ? [state.tree] : [];
      tree.forEach((n) => walk(n, 0));
      if (budget <= 0) rows.push('<div class="tree-row">… (truncated)</div>');
      const wires = state.wires || [];
      if (wires.length) rows.push(`<div class="tree-row"><span>Wires / curves</span><code>${wires.length}</code></div>`);
      treeEl.innerHTML = rows.join('') || '<div class="tree-row" style="color:var(--text-2)">No product structure in this stream</div>';
    }
    const badge = document.getElementById('treeCountBadge');
    if (badge) badge.textContent = `${(state.attachments || []).length} Attachment${(state.attachments || []).length === 1 ? '' : 's'}`;
    const attEl = document.getElementById('attachList');
    if (attEl) {
      const atts = state.attachments || [];
      attEl.innerHTML = atts.map((a, i) => `
        <div class="feature-item">
          <div><strong>${escHTML(a.name)}</strong>
            <div style="font-size:10px;color:var(--text-2);font-family:var(--mono);">${a.isCAD ? 'CAD file • ' : ''}${a.size.toLocaleString()} B • ${escHTML(a.where)}${a.error ? ' • ' + escHTML(a.error) : ''}</div></div>
          ${a.bytes ? `<button class="btn btn-sm" data-att="${i}">Save</button>` : '<code>unreadable</code>'}
        </div>`).join('');
      attEl.querySelectorAll('button[data-att]').forEach((b) => b.addEventListener('click', () => {
        const a = atts[+b.getAttribute('data-att')]; if (a && a.bytes) triggerDownload(a.bytes, a.name.split(/[\\/]/).pop() || 'attachment.bin', 'application/octet-stream');
      }));
    }
  }

  function refreshAllUI() {
    compactParts(state.parts);

    const bounds = computeAssemblyBounds(state.parts);
    const banner = document.getElementById('bigModelBanner');
    if (banner) {
      // Count the triangles as parsed from the file (the STL/B-Rep count excludes degenerate ones).
      const big = bounds.totalParsedTris > BIG_MODEL_TRIS;
      banner.style.display = big ? '' : 'none';
      if (big) {
        banner.textContent = `Large model: ${bounds.totalParsedTris.toLocaleString()} triangles. The viewer shows a decimated preview; ` +
          'exports stream part-by-part at full detail (STL/OBJ are the lightest). Use "Reduce detail" to shrink exported files.';
      }
    }
    const unitScale = getScaleFromMM(state.units);

    // Document & stream badges
    const docFileName = document.getElementById('docFileName');
    if (docFileName) docFileName.textContent = state.fileName;

    const streamCountBadge = document.getElementById('streamCountBadge');
    if (streamCountBadge) {
      streamCountBadge.textContent = `${state.streams.length} Stream${state.streams.length === 1 ? '' : 's'}`;
    }

    const statusBadge = document.getElementById('statusBadge');
    if (statusBadge) {
      const ap = (state.streams[state.activeStreamIdx] || {}).parsed || {};
      const path = ap.decodePath ? `${ap.decodePath.toUpperCase()} • ` : '';
      const warns = ap.warnings || [];
      const cadAtt = (state.attachments || []).filter((a) => a.isCAD);
      statusBadge.textContent = !state.streams.length && (state.attachments || []).length
        ? `NO 3D STREAM • ${cadAtt.length ? 'EMBEDDED CAD ATTACHMENT' : 'EMBEDDED ATTACHMENT'}: ${(cadAtt[0] || state.attachments[0]).name}`
        : !state.parts.length
        ? `${path}NO MESH${warns.length ? ' • ' + warns[0].slice(0, 120) : ''}`
        : bounds.allWatertight
          ? `${path}WATER-TIGHT 2-MANIFOLD (${state.parts.length} SOLIDS)`
          : `${path}${state.parts.length} BODIES EXTRACTED`;
      statusBadge.title = warns.join('\n');
      statusBadge.className = 'badge ' + (state.parts.length ? (warns.length ? 'badge-amber' : 'badge-emerald') : 'badge-amber');
    }

    // Stream list
    const streamListEl = document.getElementById('streamList');
    if (streamListEl) {
      streamListEl.innerHTML = '';
      state.streams.forEach((st, idx) => {
        const item = document.createElement('div');
        item.className = `stream-item${idx === state.activeStreamIdx ? ' active' : ''}`;
        item.innerHTML = `
          <div class="stream-meta">
            <div class="stream-name">${st.title}</div>
            <div class="stream-sub">Filter: /${st.filter} • Raw: ${(st.rawBytes.length / 1024).toFixed(1)} KB</div>
          </div>
          <span class="badge ${st.subtype === 'PRC' ? 'badge-emerald' : 'badge-cyan'}">${st.subtype}</span>
        `;
        item.addEventListener('click', () => activateStream(idx));
        streamListEl.appendChild(item);
      });
    }

    // Part hierarchy list
    const partListEl = document.getElementById('partList');
    if (partListEl) {
      partListEl.innerHTML = '';
      state.parts.forEach((p, idx) => {
        const [r, g, b] = p.color.map((c) => Math.round(c * 255));
        const item = document.createElement('div');
        item.className = `part-item${state.selectedPartIdx === idx ? ' selected' : ''}`;
        item.innerHTML = `
          <div class="part-top">
            <div class="part-left">
              <input type="checkbox" class="part-chk" data-idx="${idx}" ${p.visible ? 'checked' : ''} />
              <span class="swatch" style="background:rgb(${r},${g},${b})"></span>
              <span class="part-name" title="${p.name}">${p.name}</span>
            </div>
            <span class="badge ${p.brep.isWatertight ? 'badge-emerald' : 'badge-amber'}">
              ${p.brep.mergedFaces.length} B-Rep Faces
            </span>
          </div>
          <div class="part-stats">
            <span>${p.materialName}</span>
            <span>${p.brep.weldedVerts.length}v • ${p.brep.tris.length}t</span>
          </div>
        `;
        item.addEventListener('click', (ev) => {
          if (ev.target && ev.target.classList.contains('part-chk')) return;
          state.selectedPartIdx = state.selectedPartIdx === idx ? -1 : idx;
          refreshAllUI();
        });
        const chk = item.querySelector('.part-chk');
        if (chk) {
          chk.addEventListener('change', (ev) => {
            p.visible = ev.target.checked;
            state.cachedXT = null;
            state.cachedSTEP = null;
            refreshAllUI();
          });
        }
        partListEl.appendChild(item);
      });
    }

    // Bounding Box & Topology KV Grid
    const unitBadge = document.getElementById('unitBadge');
    if (unitBadge) unitBadge.textContent = state.units;

    const bboxGrid = document.getElementById('bboxGrid');
    if (bboxGrid) {
      const sx = (bounds.size[0] * unitScale).toFixed(2);
      const sy = (bounds.size[1] * unitScale).toFixed(2);
      const sz = (bounds.size[2] * unitScale).toFixed(2);
      bboxGrid.innerHTML = `
        <div class="kv-box">
          <div class="kv-label">Size (ΔX × ΔY × ΔZ)</div>
          <div class="kv-val">${sx} × ${sy} × ${sz} ${state.units}</div>
        </div>
        <div class="kv-box">
          <div class="kv-label">B-Rep Faces / Loops</div>
          <div class="kv-val">${bounds.totalMergedFaces} Faces (${bounds.totalHoles} Holes)</div>
        </div>
        <div class="kv-box">
          <div class="kv-label">Welded Verts / Tris</div>
          <div class="kv-val">${bounds.totalVerts} / ${bounds.totalTris}</div>
        </div>
        <div class="kv-box">
          <div class="kv-label">2-Manifold Topology</div>
          <div class="kv-val" style="color:${bounds.allWatertight ? '#34d399' : '#fbbf24'}">
            ${bounds.allWatertight ? 'Closed Solid (0 Open)' : 'Surface Shell'}
          </div>
        </div>
      `;
    }

    // Analytic CAD features list
    const allFeatures = [];
    for (const p of state.parts) {
      if (!p.visible) continue;
      for (const ft of (p.brep.detectedFeatures || [])) {
        allFeatures.push({ partName: p.name, ...ft });
      }
    }
    const featureCountBadge = document.getElementById('featureCountBadge');
    if (featureCountBadge) featureCountBadge.textContent = `${allFeatures.length} Detected`;

    const featureList = document.getElementById('featureList');
    if (featureList) {
      featureList.innerHTML = allFeatures.map((ft) => `
        <div class="feature-item">
          <div>
            <strong>${ft.label}</strong>
            <div style="font-size:10px;color:var(--text-2);font-family:var(--mono);">${ft.partName}</div>
          </div>
          <code>${ft.type}</code>
        </div>
      `).join('');
    }

    renderTreeAndAttachments();

    // Viewport HUD
    const activeStream = state.streams[state.activeStreamIdx];
    const hudStreamTitle = document.getElementById('hudStreamTitle');
    if (hudStreamTitle && activeStream) {
      hudStreamTitle.textContent = `Stream: ${activeStream.title} (${activeStream.subtype === 'PRC' ? 'ISO 14739-1' : 'ECMA-363'})`;
    }
    const hudAssemblyStats = document.getElementById('hudAssemblyStats');
    if (hudAssemblyStats) {
      hudAssemblyStats.textContent = `Solids: ${state.parts.filter((p) => p.visible).length}/${state.parts.length} | Merged B-Rep Faces: ${bounds.totalMergedFaces} | Hole Loops: ${bounds.totalHoles} | Tris: ${bounds.totalTris}`;
    }
    const hudBounds = document.getElementById('hudBounds');
    if (hudBounds && bounds.size) {
      hudBounds.textContent = `Bounds: ${bounds.size.map((v) => (+v).toFixed(1)).join(' \u00d7 ')} ${state.units}`;
    }
    const hudScaleInfo = document.getElementById('hudScaleInfo');
    if (hudScaleInfo) {
      hudScaleInfo.textContent = XT_UI_ENABLED
        ? `Parasolid XT: 1e-3 m/mm (UIO=1000, res_size=1000, res_linear=1e-8) • Units: ${state.units}`
        : `Units: ${state.units} • STEP AP214 export`;
    }

    updateInspectorDrawer();
    renderViewport();
  }

  function updateInspectorDrawer() {
    const summaryEl = document.getElementById('drawerSummary');
    const codeEl = document.getElementById('drawerCode');
    if (!summaryEl || !codeEl) return;
    if (state.activeTab === 'xt' && !XT_UI_ENABLED) state.activeTab = 'step';

    // Built lazily, only for the tab that is showing (huge models take seconds per exporter).
    if (state.activeTab === 'xt' || state.activeTab === 'step') {
      let nt = 0;
      for (const p of state.parts) if (p.visible && p.brep) nt += p.brep.nt;
      if (nt > INSPECTOR_MAX_TRIS) {
        summaryEl.innerHTML = `<div style="font-weight:700;color:var(--text-0);margin-bottom:6px;">${state.activeTab === 'xt' ? 'Parasolid XT' : 'STEP AP214'} preview skipped</div>` +
          `<div class="entity-row"><span>Visible triangles</span><strong>${nt.toLocaleString()}</strong></div>`;
        codeEl.textContent = `Model too large for an in-page text preview (> ${INSPECTOR_MAX_TRIS.toLocaleString()} tris). Use the Export buttons: the file is streamed part-by-part straight to disk.`;
        return;
      }
    }
    if (state.activeTab === 'xt' && !state.cachedXT) {
      state.cachedXT = buildParasolidXT(state.parts, { brepMode: state.brepMode, fileName: state.fileName });
    }
    if (state.activeTab === 'step' && !state.cachedSTEP) {
      state.cachedSTEP = buildSTEPAP214(state.parts, { brepMode: state.brepMode, units: state.units });
    }

    if (state.activeTab === 'xt') {
      const xtPrev = previewLines(state.cachedXT, 140);
      const counts = { ASSEMBLY: 0, INSTANCE: 0, BODY: 0, REGION: 0, SHELL: 0, FACE: 0, LOOP: 0, FIN: 0, EDGE: 0, VERTEX: 0, PLANE: 0, LINE: 0, POINT: 0 };
      let bodyKindLabel = 'Solid / Sheet B-Rep';
      forEachLine(state.cachedXT, (ln) => {
        const m = ln.match(/^(\d+)\s+/);
        if (!m) return;
        const code = Number(m[1]);
        if (code === 10) counts.ASSEMBLY++;
        else if (code === 11) counts.INSTANCE++;
        else if (code === 12) {
          counts.BODY++;
          const tok = ln.trim().split(/\s+/);
          if (tok[16] === '3') bodyKindLabel = 'Sheet Body (body_type=3)';
          else if (tok[16] === '1') bodyKindLabel = 'Solid Body (body_type=1)';
        }
        else if (code === 19) counts.REGION++;
        else if (code === 13) counts.SHELL++;
        else if (code === 14) counts.FACE++;
        else if (code === 15) counts.LOOP++;
        else if (code === 17) counts.FIN++;
        else if (code === 16) counts.EDGE++;
        else if (code === 18) counts.VERTEX++;
        else if (code === 50) counts.PLANE++;
        else if (code === 30) counts.LINE++;
        else if (code === 29) counts.POINT++;
      });

      summaryEl.innerHTML = `
        <div style="font-weight:700;color:var(--text-0);margin-bottom:6px;">Parasolid XT Entity Table (SCH_1200000_120060)</div>
        <div class="entity-row"><span>12 BODY (${bodyKindLabel})</span><strong>${counts.BODY}${counts.ASSEMBLY ? ' (' + counts.INSTANCE + ' Inst)' : ''}</strong></div>
        <div class="entity-row"><span>19 REGION (Void / Solid)</span><strong>${counts.REGION}</strong></div>
        <div class="entity-row"><span>13 SHELL (Connected Shells)</span><strong>${counts.SHELL}</strong></div>
        <div class="entity-row"><span>14 FACE (Planar B-Rep)</span><strong>${counts.FACE}</strong></div>
        <div class="entity-row"><span>15 LOOP (Outer + Hole Loops)</span><strong>${counts.LOOP}</strong></div>
        <div class="entity-row"><span>17 FIN (Real + Dummy Half-Edges)</span><strong>${counts.FIN}</strong></div>
        <div class="entity-row"><span>16 EDGE / 30 LINE</span><strong>${counts.EDGE}</strong></div>
        <div class="entity-row"><span>18 VERTEX / 29 POINT</span><strong>${counts.VERTEX}</strong></div>
        <div class="entity-row"><span>50 PLANE Surfaces</span><strong>${counts.PLANE}</strong></div>
      `;
      codeEl.textContent = xtPrev.lines.join('\n') +
        (xtPrev.count > 140 ? `\n... (${xtPrev.count - 140} more Parasolid XT records — click "Export Parasolid XT (.x_t)" for full file)` : '');
    } else if (state.activeTab === 'step') {
      const stepPrev = previewLines(state.cachedSTEP, 140);
      summaryEl.innerHTML = `
        <div style="font-weight:700;color:var(--text-0);margin-bottom:6px;">STEP AP214 (ISO 10303-21) Summary</div>
        <div class="entity-row"><span>Schema</span><strong>AUTOMOTIVE_DESIGN</strong></div>
        <div class="entity-row"><span>Total STEP Entities</span><strong>${stepPrev.count - 10}</strong></div>
        <div class="entity-row"><span>MANIFOLD_SOLID_BREP</span><strong>${state.parts.filter((p) => p.visible).length}</strong></div>
        <div class="entity-row"><span>Units</span><strong>${state.units.toUpperCase()}</strong></div>
      `;
      codeEl.textContent = stepPrev.lines.join('\n') +
        (stepPrev.count > 140 ? `\n... (${stepPrev.count - 140} more STEP entities)` : '');
    } else {
      const st = state.streams[state.activeStreamIdx];
      const blocks = (st && st.parsed && st.parsed.blocks) || [];
      summaryEl.innerHTML = `
        <div style="font-weight:700;color:var(--text-0);margin-bottom:6px;">PDF /3D Stream &amp; Block Directory</div>
        <div class="entity-row"><span>Active Stream</span><strong>${st ? st.subtype : 'None'}</strong></div>
        <div class="entity-row"><span>Compressed Size</span><strong>${st ? st.compressedLength : 0} B</strong></div>
        <div class="entity-row"><span>Decompressed Size</span><strong>${st ? st.rawBytes.length : 0} B</strong></div>
        <div class="entity-row"><span>Parsed Blocks</span><strong>${blocks.length}</strong></div>
      `;
      codeEl.textContent = blocks.map((b, i) =>
        `Block[${String(i).padStart(2, '0')}] @ 0x${b.offset.toString(16).padStart(6, '0')} | Type: 0x${(b.blockType >>> 0).toString(16).toUpperCase().padStart(8, '0')} | Data: ${b.dataSize} B | Meta: ${b.metaSize} B`
      ).join('\n');
    }
  }

  async function activateStream(idx) {
    if (idx < 0 || idx >= state.streams.length) return;
    state.activeStreamIdx = idx;
    const st = state.streams[idx];
    if (!st.parsed) {
      try {
        if (st.subtype === 'PRC') {
          st.parsed = await parsePRCStream(st.rawBytes, { typed: true });
        } else {
          st.parsed = parseU3DStream(st.rawBytes);
        }
        // weld + pack every part right away (typed arrays) so the raw per-corner data can be freed
        compactParts(st.parsed.parts || []);
      } catch (err) {
        console.error(err);
        st.parsed = { format: st.subtype, decodePath: 'none', parts: [], wires: [], blocks: [], warnings: [String((err && err.message) || err)] };
      }
    }
    state.wires = st.parsed.wires || [];
    state.tree = st.parsed.tree || null;
    state.parts = (st.parsed.parts || []).map((p, i) => ({
      ...p,
      color: p.color || PALETTE[i % PALETTE.length],
      visible: true
    }));
    state.selectedPartIdx = -1;
    state.cachedXT = null;
    state.cachedSTEP = null;
    refreshAllUI();
  }

  async function loadPDFBuffer(u8, fileName) {
    state.fileName = fileName || 'document-3d.pdf';
    state.fileSize = u8.length;
    const streams = await extract3DStreamsFromPDF(u8, state.fileName);
    state.attachments = (streams && streams.attachments) || [];
    if (streams.length === 0) {
      if (state.attachments.length) {
        // no 3D annotation, but the PDF carries embedded files (e.g. the native STEP/CAD model): offer them
        state.streams = []; state.activeStreamIdx = -1; state.parts = []; state.wires = []; state.tree = null;
        state.selectedPartIdx = -1; state.cachedXT = null; state.cachedSTEP = null;
        refreshAllUI();
        return;
      }
      alert('No embedded /3D (U3D / PRC) streams or file attachments found in this file.');
      return;
    }
    state.streams = streams;
    await activateStream(0);
  }

  function base64ToUint8Array(b64) {
    const bin = atob(b64.trim());
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      u8[i] = bin.charCodeAt(i);
    }
    return u8;
  }

  function triggerDownload(content, filename, mimeType) {
    const blob = content instanceof Uint8Array
      ? new Blob([content], { type: mimeType })
      : new Blob(textChunks(content), { type: `${mimeType};charset=utf-8` });
    content = null;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 250);
  }

  function stemName() {
    return (state.fileName || 'cad-3d-pdf-assembly').replace(/\.(pdf|u3d|prc)$/i, '');
  }

  // -------------------------------------------------------------------------
  // 11. Event Listeners & Interactive Camera Controls
  // -------------------------------------------------------------------------
  // Dev-only (?xt=1): re-create the Parasolid XT export button and inspector tab that were removed from index.html.
  function injectXTControls() {
    if (!document.getElementById('btnExportXT')) {
      const stepBtn = document.getElementById('btnExportSTEP');
      if (stepBtn && stepBtn.parentNode) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.id = 'btnExportXT';
        b.title = 'DEV ONLY (?xt=1): ASCII Parasolid Transmit (.x_t) - known NX import issues';
        b.textContent = 'Export Parasolid XT (.x_t) [dev]';
        stepBtn.parentNode.insertBefore(b, stepBtn.nextSibling);
      }
    }
    if (!document.querySelector('.tab-btn[data-tab="xt"]')) {
      const stepTab = document.querySelector('.tab-btn[data-tab="step"]');
      if (stepTab && stepTab.parentNode) {
        const t = document.createElement('button');
        t.className = 'tab-btn';
        t.setAttribute('data-tab', 'xt');
        t.textContent = 'Parasolid .x_t Inspector [dev]';
        stepTab.parentNode.insertBefore(t, stepTab.nextSibling);
      }
    }
  }

  function initEvents() {
    const canvas = document.getElementById('viewportCanvas');
    if (canvas) {
      canvas.addEventListener('mousedown', (ev) => {
        state.camera.Dragging = true;
        // Shift/right-drag: pan; Ctrl/Alt/Meta+drag or middle-drag: twist about the view axis; plain drag: orbit
        state.camera.dragMode = (ev.shiftKey || ev.button === 2) ? 'pan'
          : (ev.ctrlKey || ev.altKey || ev.metaKey || ev.button === 1) ? 'twist' : 'orbit';
        if (ev.button === 1) ev.preventDefault();
        state.camera.lastX = ev.clientX;
        state.camera.lastY = ev.clientY;
      });
      window.addEventListener('mousemove', (ev) => {
        if (!state.camera.Dragging) return;
        const dx = ev.clientX - state.camera.lastX;
        const dy = ev.clientY - state.camera.lastY;
        state.camera.lastX = ev.clientX;
        state.camera.lastY = ev.clientY;
        if (state.camera.dragMode === 'pan') {
          state.camera.panX += dx;
          state.camera.panY += dy;
        } else if (window.PDF3DCamera) {
          window.PDF3DCamera.drag(state.camera, dx, dy, state.camera.dragMode === 'twist');
        } else {
          state.camera.yaw += dx * 0.01;
          state.camera.pitch = Math.max(-1.48, Math.min(1.48, state.camera.pitch + dy * 0.01));
        }
        requestViewportRender();
      });
      window.addEventListener('mouseup', () => {
        state.camera.Dragging = false;
      });
      canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
      canvas.addEventListener('wheel', (ev) => {
        ev.preventDefault();
        const factor = ev.deltaY < 0 ? 1.12 : 0.89;
        state.camera.zoom = Math.max(0.25, Math.min(8.0, state.camera.zoom * factor));
        requestViewportRender();
      }, { passive: false });
      window.addEventListener('resize', () => renderViewport());
      if (window.PDF3DViewerGL) {
        window.PDF3DViewerGL.onOptionsChange = () => renderViewport();
        // read-only renderer stats -> muted HUD text (not a control)
        window.PDF3DViewerGL.onStats = (st) => {
          const el = document.getElementById('hudRenderStats');
          if (el) el.textContent = `${st.api} \u2022 drawn ${Number(st.drawnTris || 0).toLocaleString()} tris \u2022 ${(st.cpuMs || 0).toFixed(1)} ms/frame \u2022 GPU ${Math.round((st.gpuBytes || 0) / 1048576)} MB`;
        };
      }
    }

    // Render mode buttons
    document.querySelectorAll('[data-render]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-render]').forEach((b) => b.classList.remove('btn-active'));
        btn.classList.add('btn-active');
        state.renderMode = btn.getAttribute('data-render');
        renderViewport();
      });
    });

    // Camera preset buttons
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const v = btn.getAttribute('data-view');
        state.camera.panX = 0;
        state.camera.panY = 0;
        const free = state.camera.mode !== 'turntable';
        if (v === 'iso') setCameraYawPitch(-0.68, 0.52);
        else if (v === 'top') setCameraYawPitch(0, free ? Math.PI / 2 : 1.48);
        else if (v === 'front') setCameraYawPitch(0, 0);
        else if (v === 'right') setCameraYawPitch(-Math.PI / 2, 0);
        else if (v === 'reset') { setCameraYawPitch(-0.68, 0.52); state.camera.zoom = 1.0; }
        renderViewport();
      });
    });

    // Orbit mode toggle (Free arcball / Turntable Z-up), persisted in localStorage
    if (window.PDF3DCamera) {
      state.camera.mode = window.PDF3DCamera.loadMode();
      if (state.camera.mode === 'free') state.camera.q = window.PDF3DCamera.fromYawPitch(state.camera.yaw, state.camera.pitch);
    }
    syncOrbitButtons();
    document.querySelectorAll('[data-orbit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!window.PDF3DCamera) return;
        const m = btn.getAttribute('data-orbit') === 'turntable' ? 'turntable' : 'free';
        window.PDF3DCamera.setMode(state.camera, m);
        window.PDF3DCamera.saveMode(m);
        syncOrbitButtons();
        renderViewport();
      });
    });

    const btnFitView = document.getElementById('btnFitView');
    if (btnFitView) {
      btnFitView.addEventListener('click', () => {
        state.camera.zoom = 1.0;
        state.camera.panX = 0;
        state.camera.panY = 0;
        renderViewport();
      });
    }

    const explodeSlider = document.getElementById('explodeSlider');
    if (explodeSlider) {
      explodeSlider.addEventListener('input', (ev) => {
        state.explodeFactor = Number(ev.target.value) || 0;
        renderViewport();
      });
    }

    // Units & B-Rep mode selectors
    const unitSelect = document.getElementById('unitSelect');
    if (unitSelect) {
      unitSelect.addEventListener('change', (ev) => {
        state.units = ev.target.value;
        state.cachedXT = null;
        state.cachedSTEP = null;
        refreshAllUI();
      });
    }

    const brepModeSelect = document.getElementById('brepModeSelect');
    if (brepModeSelect) {
      brepModeSelect.addEventListener('change', (ev) => {
        state.brepMode = ev.target.value;
        state.cachedXT = null;
        state.cachedSTEP = null;
        refreshAllUI();
      });
    }

    const detailSelect = document.getElementById('detailSelect');
    if (detailSelect) {
      detailSelect.addEventListener('change', (ev) => {
        state.exportDetail = Number(ev.target.value) || 1;
        state.cachedXT = null;
        state.cachedSTEP = null;
        refreshAllUI();
      });
    }

    if (XT_UI_ENABLED) injectXTControls();

    // Drawer tabs
    document.querySelectorAll('.tab-btn[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn[data-tab]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.activeTab = btn.getAttribute('data-tab');
        updateInspectorDrawer();
      });
    });

    const btnCopyInspector = document.getElementById('btnCopyInspector');
    if (btnCopyInspector) {
      btnCopyInspector.addEventListener('click', () => {
        // Full text for normal models; for chunked (huge) output only the visible preview is copied.
        const full = state.activeTab === 'xt' ? state.cachedXT : state.activeTab === 'step' ? state.cachedSTEP : null;
        const text = typeof full === 'string' && full.length < (1 << 24)
          ? full
          : (document.getElementById('drawerCode').textContent || '');
        if (navigator.clipboard) navigator.clipboard.writeText(text);
        btnCopyInspector.textContent = 'Copied!';
        setTimeout(() => { btnCopyInspector.textContent = 'Copy Preview'; }, 1200);
      });
    }

    // Show All / Invert Parts
    const btnShowAllParts = document.getElementById('btnShowAllParts');
    if (btnShowAllParts) {
      btnShowAllParts.addEventListener('click', () => {
        state.parts.forEach((p) => { p.visible = true; });
        state.cachedXT = null;
        state.cachedSTEP = null;
        refreshAllUI();
      });
    }
    const btnInvertParts = document.getElementById('btnInvertParts');
    if (btnInvertParts) {
      btnInvertParts.addEventListener('click', () => {
        state.parts.forEach((p) => { p.visible = !p.visible; });
        if (!state.parts.some((p) => p.visible) && state.parts.length > 0) {
          state.parts[0].visible = true;
        }
        state.cachedXT = null;
        state.cachedSTEP = null;
        refreshAllUI();
      });
    }

    // File open & drag-and-drop
    const fileInput = document.getElementById('fileInput');
    const btnOpenFile = document.getElementById('btnOpenFile');
    const dropZone = document.getElementById('dropZone');

    const handleFileObj = async (file) => {
      if (!file) return;
      const ab = await file.arrayBuffer();
      await loadPDFBuffer(new Uint8Array(ab), file.name);
    };

    if (btnOpenFile && fileInput) {
      btnOpenFile.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (ev) => {
        if (ev.target.files && ev.target.files[0]) handleFileObj(ev.target.files[0]);
      });
    }
    if (dropZone && fileInput) {
      dropZone.addEventListener('click', () => fileInput.click());
      dropZone.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (ev) => {
        ev.preventDefault();
        dropZone.classList.remove('dragover');
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) {
          handleFileObj(ev.dataTransfer.files[0]);
        }
      });
    }

    const btnLoadSample = document.getElementById('btnLoadSample');
    if (btnLoadSample) {
      btnLoadSample.addEventListener('click', () => {
        if (window.SAMPLE_3D_PDF_B64) {
          loadPDFBuffer(base64ToUint8Array(window.SAMPLE_3D_PDF_B64), 'sample-cad-assembly-3d.pdf');
        }
      });
    }

    // Export Buttons
    const btnExportXT = XT_UI_ENABLED ? document.getElementById('btnExportXT') : null;
    if (btnExportXT) {
      btnExportXT.addEventListener('click', () => {
        const xt = buildParasolidXT(state.parts, { brepMode: state.brepMode, fileName: state.fileName, blob: true });
        triggerDownload(xt, `${stemName()}.x_t`, 'text/plain');
      });
    }

    const btnExportSTEP = document.getElementById('btnExportSTEP');
    if (btnExportSTEP) {
      btnExportSTEP.addEventListener('click', () => {
        const stp = buildSTEPAP214(state.parts, { brepMode: state.brepMode, units: state.units, blob: true });
        triggerDownload(stp, `${stemName()}.stp`, 'application/step');
      });
    }

    const btnExportSTL = document.getElementById('btnExportSTL');
    if (btnExportSTL) {
      btnExportSTL.addEventListener('click', () => {
        const stl = buildBinarySTL(state.parts, state.units);
        triggerDownload(stl, `${stemName()}.stl`, 'application/sla');
      });
    }

    const btnExportSTLText = document.getElementById('btnExportSTLText');
    if (btnExportSTLText) {
      btnExportSTLText.addEventListener('click', () => {
        const stlTxt = buildASCIISTL(state.parts, state.units, { blob: true });
        triggerDownload(stlTxt, `${stemName()}-ascii.stl`, 'text/plain');
      });
    }

    const btnExportOBJ = document.getElementById('btnExportOBJ');
    if (btnExportOBJ) {
      btnExportOBJ.addEventListener('click', () => {
        const obj = buildWavefrontOBJ(state.parts, state.units, { blob: true });
        triggerDownload(obj, `${stemName()}.obj`, 'text/plain');
      });
    }

    const btnExportIGES = document.getElementById('btnExportIGES');
    if (btnExportIGES) {
      btnExportIGES.addEventListener('click', () => {
        const igs = buildIGESWireframe(state.parts, state.units, { blob: true });
        triggerDownload(igs, `${stemName()}.igs`, 'text/plain');
      });
    }

    const btnExportRaw = document.getElementById('btnExportRaw');
    if (btnExportRaw) {
      btnExportRaw.addEventListener('click', () => {
        const st = state.streams[state.activeStreamIdx];
        if (!st) return;
        const ext = st.subtype === 'PRC' ? 'prc' : 'u3d';
        triggerDownload(st.rawBytes, `${stemName()}.${ext}`, 'application/octet-stream');
      });
    }
  }

  // Expose programmatic API for automated verification & CAD testing
  window.CAD3DExtractor = { U3DBitStreamReader, U3DHistogram, U3D_CTX, U3D_AC_STATIC_FULL, parseU3DStream,
    getState: () => state, computeAssemblyBounds,
    loadPDFBuffer,
    activateStream,
    // opts: { blob: true } -> array of Blob parts; { detail: 0.25 } -> reduced-detail export
    buildParasolidXT: (o = {}) => buildParasolidXT(state.parts, { brepMode: state.brepMode, fileName: state.fileName, ...o }),
    buildSTEPAP214: (o = {}) => buildSTEPAP214(state.parts, { brepMode: state.brepMode, units: state.units, ...o }),
    buildBinarySTL: (o = {}) => buildBinarySTL(state.parts, state.units, o),
    buildASCIISTL: (o = {}) => buildASCIISTL(state.parts, state.units, o),
    buildWavefrontOBJ: (o = {}) => buildWavefrontOBJ(state.parts, state.units, o),
    buildIGESWireframe: (o = {}) => buildIGESWireframe(state.parts, state.units, o)
  };

  window.addEventListener('DOMContentLoaded', () => {
    initEvents();
    if (window.SAMPLE_3D_PDF_B64) {
      loadPDFBuffer(base64ToUint8Array(window.SAMPLE_3D_PDF_B64), 'sample-cad-assembly-3d.pdf');
    }
  });
})();
