// Node driver: decode a PDF's PRC with normals, run recon/fit.js, dump JSON (dev/validation tool)
const D = require('../../prc-decoder.js'); const Fit = require('../fit.js'); const fs = require('fs');
function partMesh(p, mm) {
  const nV = p.positions.length; const V = new Float64Array(3 * nV); const M = p.matrix;
  for (let i = 0; i < nV; i++) { let [x, y, z] = p.positions[i]; if (M) { const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; x = X; y = Y; z = Z; } V[3 * i] = x * mm; V[3 * i + 1] = y * mm; V[3 * i + 2] = z * mm; }
  const m = p.faces.length; const T = new Int32Array(3 * m); for (let t = 0; t < m; t++) { T[3 * t] = p.faces[t][0]; T[3 * t + 1] = p.faces[t][1]; T[3 * t + 2] = p.faces[t][2]; }
  const F = Int32Array.from(p.faceIndexPerTriangle); let NN = null, CN = null;
  if (p.cornerNormalIdx && p.tessNormals) { NN = Float64Array.from(p.tessNormals); if (M) for (let i = 0; i < NN.length; i += 3) { const x = NN[i], y = NN[i + 1], z = NN[i + 2]; const a = M[0] * x + M[4] * y + M[8] * z, b = M[1] * x + M[5] * y + M[9] * z, c = M[2] * x + M[6] * y + M[10] * z; const l = Math.hypot(a, b, c) || 1; NN[i] = a / l; NN[i + 1] = b / l; NN[i + 2] = c / l; }
    CN = new Int32Array(3 * m); for (let t = 0; t < m; t++) for (let k = 0; k < 3; k++) { const v = p.cornerNormalIdx[t][k]; CN[3 * t + k] = v >= 0 ? v / 3 : -1; } }
  return { V, T, F, NN, CN };
}
module.exports = { partMesh };
if (require.main === module) (async () => {
  const [pdf, out] = process.argv.slice(2); const u8 = new Uint8Array(fs.readFileSync(pdf)); const prc = (await D.extractPRCFromPDFAsync(u8))[0];
  const r = D.parsePRC(prc, { warnings: [], withNormals: true }); const p = r.parts.filter(q => q.faces.length)[0];
  const mesh = partMesh(p, r.units.unitsInMM || 1); const t0 = Date.now(); let last = 0;
  const res = Fit.fitMesh(mesh, { onProgress: e => { if (Date.now() - last > 2000) { last = Date.now(); console.log(e.stage, e.sub || '', e.done + '/' + e.total, ((Date.now() - t0) / 1000).toFixed(1) + 's'); } } });
  console.log('fit ms', Date.now() - t0, res.timings, res.byType, res.stats, 'unfit', res.unfit);
  const fi = Object.entries(res.fitInfo).map(([f, x]) => [+f, x.method, x.nu + 'x' + x.nv, +(x.maxdev || 0).toFixed(5), x.error || '']);
  console.log(fi.sort((a, b) => b[3] - a[3]).slice(0, 20));
  console.log('rss MB', (process.memoryUsage().rss / 1e6).toFixed(0));
  if (out) fs.writeFileSync(out, JSON.stringify({ F: Array.from(res.F), R: res.regions, ff: res.ff, unfit: res.unfit, fitInfo: res.fitInfo, name: p.name }));
})();
