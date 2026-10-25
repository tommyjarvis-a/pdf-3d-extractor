// Node driver: decode a PDF's PRC with normals, run recon/fit.js, dump JSON (dev/validation tool)
const D = require('../../prc-decoder.js'); const Fit = require('../fit.js'); const fs = require('fs');
const partMesh = (p, mm) => require('../pipeline.js').meshFromPart(p, mm);
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
