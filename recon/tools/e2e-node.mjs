// Node end-to-end dev/acceptance tool (same pipeline as the worker; app exporter for the mesh body, same merge as the UI):
//   node recon/tools/e2e-node.mjs <pdf> <out.step> [--fitted-only]
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import { createRequire } from 'module'; const require = createRequire(import.meta.url);
const OCC = process.env.OCC_NODE || '/tmp/occspike/b2/package/dist/node.js';
const init = (await import(OCC)).default;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const D = require('../../prc-decoder.js'); const Pipe = require('../pipeline.js'); const SM = require('../step-merge.js');
const args = process.argv.slice(2); const [pdf, out] = args.filter(a => !a.startsWith('--')); const fittedOnly = args.includes('--fitted-only');
const mem = { peakRss: 0 }; const tick = () => { const r = process.memoryUsage().rss; if (r > mem.peakRss) mem.peakRss = r; };
const T0 = Date.now(); const tm = {};
// app (vm) for the mesh body, exactly like test/run.js
function loadApp() {
  const noop = () => {}; const el = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : el()), apply: () => el(), set: () => true });
  const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: () => el(), addEventListener: noop, body: el(), documentElement: el() };
  const window = { addEventListener: noop, removeEventListener: noop, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800, requestAnimationFrame: () => 0, alert: noop };
  const ctx = { window, self: window, document, console, setTimeout, clearTimeout, TextDecoder, TextEncoder, Blob, DecompressionStream, Response, URL, atob, btoa, performance, crypto: globalThis.crypto, alert: noop, requestAnimationFrame: () => 0 };
  ctx.globalThis = ctx; vm.createContext(ctx);
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script[^>]+src="([^"?]+)/g)) vm.runInContext(fs.readFileSync(path.join(ROOT, m[1]), 'utf8'), ctx, { filename: m[1] });
  return window;
}
const win = loadApp(); const api = win.CAD3DExtractor;
const u8 = new Uint8Array(fs.readFileSync(pdf)); let t = Date.now();
await api.loadPDFBuffer(u8, path.basename(pdf)); const st = api.getState(); const sIdx = st.streams.findIndex(s => s.subtype === 'PRC'); await api.activateStream(sIdx);
tm.appLoadMs = Date.now() - t; tick();
const prcBytes = api.getState().streams[sIdx].rawBytes;
t = Date.now(); const r = D.parsePRC(prcBytes, { warnings: [], withNormals: true }); tm.decodeMs = Date.now() - t; tick();
const dparts = r.parts.filter(q => q.faces && q.faces.length);
t = Date.now(); const oc = await init(); tm.kernelMs = Date.now() - t; tick();
const bodies = [], summaries = [], meshParts = [];
const appParts = api.getState().parts;
for (let i = 0; i < dparts.length; i++) {
  const p = dparts[i]; if (appParts[i] && appParts[i].visible === false) continue;
  const mesh = Pipe.meshFromPart(p, r.units.unitsInMM); let last = 0; t = Date.now();
  const res = Pipe.runPart(oc, mesh, p.name, { post: e => { tick(); if (Date.now() - last > 5000) { last = Date.now(); console.log('  ', e.stage, e.sub || '', (e.done ?? '') + '/' + (e.total ?? '')); } } });
  tick(); console.log(p.name, 'tris', mesh.T.length / 3, 'runPart ms', Date.now() - t, res.status, res.reason || '');
  console.log(JSON.stringify(res.summary));
  if (res.res) { const bad = res.res.finfo.filter(f => f.how !== 'trimmed'); if (bad.length) console.log('not trimmed:', JSON.stringify(bad.slice(0, 15))); }
  summaries.push(res.summary);
  if (res.shape) bodies.push([res.shape, res.summary.name + '_fitted']);
  if (!fittedOnly || res.status !== 'solid') meshParts.push({ ...appParts[i], name: res.summary.name + '_mesh', visible: true });
}
t = Date.now(); const fittedText = bodies.length ? new TextDecoder().decode(Pipe.writeFitted(oc, bodies, Pipe.baseName(dparts[0].name))) : null; tm.writeFittedMs = Date.now() - t; tick();
t = Date.now(); const meshText = meshParts.length ? api.buildSTEPAP214({ parts: meshParts, units: 'mm', brepMode: 'merged', detail: 1 }) : null; tm.meshStepMs = Date.now() - t; tick();
t = Date.now(); const merged = SM.mergeSTEP([fittedText, meshText], { fileName: path.basename(out), description: '3D PDF CAD surfaces - STEP AP214' }); tm.mergeMs = Date.now() - t;
fs.writeFileSync(out, merged); tm.totalMs = Date.now() - T0;
console.log('timings', JSON.stringify(tm)); console.log('bytes', merged.length, 'peak rss MB', (mem.peakRss / 1e6).toFixed(0), 'wasm heap MB', oc.HEAP8.length / 1e6);
fs.writeFileSync(out + '.summary.json', JSON.stringify({ summaries, tm, peakRss: mem.peakRss, wasmHeap: oc.HEAP8.length }, null, 1));
