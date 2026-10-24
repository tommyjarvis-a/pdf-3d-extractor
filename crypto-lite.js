'use strict';
// Minimal, dependency-free crypto for the PDF Standard security handler (browser + Node):
// MD5, RC4, AES-128/256 (ECB block, CBC decrypt, CBC encrypt-no-pad). SHA-2 comes from WebCrypto (crypto.subtle).
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.CryptoLite = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  // ---------------- MD5 (RFC 1321) ----------------
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = new Int32Array(64); for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
  function md5(msg) {
    const n = msg.length; const padLen = ((n + 8) >>> 6 << 6) + 64; const b = new Uint8Array(padLen); b.set(msg); b[n] = 0x80;
    const bits = n * 8; b[padLen - 8] = bits & 255; b[padLen - 7] = (bits >>> 8) & 255; b[padLen - 6] = (bits >>> 16) & 255; b[padLen - 5] = (bits >>> 24) & 255;
    b[padLen - 4] = Math.floor(n / 536870912) & 255;
    let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476; const M = new Int32Array(16);
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = b[off + i * 4] | (b[off + i * 4 + 1] << 8) | (b[off + i * 4 + 2] << 16) | (b[off + i * 4 + 3] << 24);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; } else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; } else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const tmp = D; D = C; C = B; const x = (A + F + K[i] + M[g]) | 0; B = (B + ((x << S[i]) | (x >>> (32 - S[i])))) | 0; A = tmp;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16); [a0, b0, c0, d0].forEach((v, i) => { out[i * 4] = v & 255; out[i * 4 + 1] = (v >>> 8) & 255; out[i * 4 + 2] = (v >>> 16) & 255; out[i * 4 + 3] = (v >>> 24) & 255; });
    return out;
  }
  // ---------------- RC4 ----------------
  function rc4(key, data) {
    const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
    for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; }
    const out = new Uint8Array(data.length);
    for (let k = 0, i = 0, j = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; const t = s[i]; s[i] = s[j]; s[j] = t; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  // ---------------- AES (FIPS-197) ----------------
  const SBOX = new Uint8Array(256), INV = new Uint8Array(256);
  (function () { let p = 1, q = 1; do { p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0); q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
      const x = q ^ ((q << 1) | (q >> 7)) & 0xff ^ ((q << 2) | (q >> 6)) & 0xff ^ ((q << 3) | (q >> 5)) & 0xff ^ ((q << 4) | (q >> 4)) & 0xff; SBOX[p] = (x ^ 0x63) & 0xff; } while (p !== 1);
    SBOX[0] = 0x63; for (let i = 0; i < 256; i++) INV[SBOX[i]] = i; })();
  const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
  const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
  const M2 = new Uint8Array(256), M3 = new Uint8Array(256), M9 = new Uint8Array(256), M11 = new Uint8Array(256), M13 = new Uint8Array(256), M14 = new Uint8Array(256);
  for (let i = 0; i < 256; i++) { M2[i] = mul(i, 2); M3[i] = mul(i, 3); M9[i] = mul(i, 9); M11[i] = mul(i, 11); M13[i] = mul(i, 13); M14[i] = mul(i, 14); }
  function expandKey(key) {
    const Nk = key.length / 4, Nr = Nk + 6, w = new Uint8Array(16 * (Nr + 1)); w.set(key); let rcon = 1;
    for (let i = Nk; i < 4 * (Nr + 1); i++) {
      let t0 = w[(i - 1) * 4], t1 = w[(i - 1) * 4 + 1], t2 = w[(i - 1) * 4 + 2], t3 = w[(i - 1) * 4 + 3];
      if (i % Nk === 0) { const tmp = t0; t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[tmp]; rcon = xt(rcon); }
      else if (Nk > 6 && i % Nk === 4) { t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3]; }
      w[i * 4] = w[(i - Nk) * 4] ^ t0; w[i * 4 + 1] = w[(i - Nk) * 4 + 1] ^ t1; w[i * 4 + 2] = w[(i - Nk) * 4 + 2] ^ t2; w[i * 4 + 3] = w[(i - Nk) * 4 + 3] ^ t3;
    }
    return { w, Nr };
  }
  function encBlock(ks, inp, out) {
    const { w, Nr } = ks; const s = new Uint8Array(16); for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i]; const t = new Uint8Array(16);
    for (let r = 1; r <= Nr; r++) {
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) & 3) * 4 + row]]; // SubBytes+ShiftRows
      if (r < Nr) for (let c = 0; c < 4; c++) { const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
        s[c * 4] = M2[a0] ^ M3[a1] ^ a2 ^ a3; s[c * 4 + 1] = a0 ^ M2[a1] ^ M3[a2] ^ a3; s[c * 4 + 2] = a0 ^ a1 ^ M2[a2] ^ M3[a3]; s[c * 4 + 3] = M3[a0] ^ a1 ^ a2 ^ M2[a3]; }
      else s.set(t);
      for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i];
    }
    out.set(s);
  }
  function decBlock(ks, inp, out, outOff) {
    const { w, Nr } = ks; const s = new Uint8Array(16); for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[Nr * 16 + i]; const t = new Uint8Array(16);
    for (let r = Nr - 1; r >= 0; r--) {
      for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[((c + row) & 3) * 4 + row] = INV[s[c * 4 + row]]; // InvShiftRows+InvSubBytes
      for (let i = 0; i < 16; i++) t[i] ^= w[r * 16 + i];
      if (r > 0) for (let c = 0; c < 4; c++) { const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3];
        s[c * 4] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3]; s[c * 4 + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3]; s[c * 4 + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3]; s[c * 4 + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3]; }
      else s.set(t);
    }
    out.set(s, outOff);
  }
  // CBC decrypt. data = IV(16) || ciphertext unless iv given. Strips PKCS#5 padding when pad=true (tolerant of bad padding).
  function aesCbcDecrypt(key, data, iv, pad = true) {
    const ks = expandKey(key); let off = 0; if (!iv) { iv = data.subarray(0, 16); off = 16; }
    const n = Math.floor((data.length - off) / 16) * 16; const out = new Uint8Array(n); let prev = iv; const blk = new Uint8Array(16);
    for (let i = 0; i < n; i += 16) { const c = data.subarray(off + i, off + i + 16); decBlock(ks, c, blk, 0); for (let k = 0; k < 16; k++) out[i + k] = blk[k] ^ prev[k]; prev = c; }
    if (pad && n) { const p = out[n - 1]; if (p >= 1 && p <= 16) { let ok = true; for (let k = n - p; k < n; k++) if (out[k] !== p) ok = false; if (ok) return out.subarray(0, n - p); } }
    return out;
  }
  function aesCbcEncryptNoPad(key, data, iv) {
    const ks = expandKey(key); const out = new Uint8Array(data.length); let prev = iv; const blk = new Uint8Array(16);
    for (let i = 0; i < data.length; i += 16) { for (let k = 0; k < 16; k++) blk[k] = data[i + k] ^ prev[k]; encBlock(ks, blk, blk); out.set(blk, i); prev = out.subarray(i, i + 16); }
    return out;
  }
  async function sha(alg, data) {
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto.subtle : null;
    if (!c) throw new Error('WebCrypto (crypto.subtle) unavailable: needed for AES-256 (R5/R6) PDF encryption');
    return new Uint8Array(await c.digest(alg, data));
  }
  return { md5, rc4, aesCbcDecrypt, aesCbcEncryptNoPad, sha, _expandKey: expandKey, _encBlock: encBlock };
});
