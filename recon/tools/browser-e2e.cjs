// Browser e2e: serve the worktree, load a PDF, call PDF3D.exportCadSurfaces, save the blob + summary.
// usage: node e2e-browser.cjs <pdf> <out.step> [--fitted-only] [--cancel-at=fit] [--parts=0,1]
const { chromium } = require('playwright-core'); const fs = require('fs'); const path = require('path'); const http = require('http');
const ROOT = process.env.ROOT || '/workspace/pdf3d-recon-wt';
const args = process.argv.slice(2); const [pdf, out] = args.filter(a => !a.startsWith('--'));
const opt = k => { const a = args.find(x => x.startsWith('--' + k)); return a ? (a.split('=')[1] ?? true) : null; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(ROOT, u === '/' ? 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); });
(async () => {
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--enable-precise-memory-info', '--cadE2E-tag=' + process.pid, '--js-flags=--max-old-space-size=4096'] });
  const page = await browser.newPage(); const logs = [];
  page.on('console', m => logs.push(m.type() + ': ' + m.text())); page.on('pageerror', e => logs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 6).join('\n')));
  await page.goto(`http://127.0.0.1:${port}/index.html`); await page.waitForFunction(() => window.CAD3DExtractor && window.PDF3D);
  const b64 = fs.readFileSync(pdf).toString('base64');
  await page.evaluate(async ({ b64, name }) => { const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const api = window.CAD3DExtractor; await api.loadPDFBuffer(u8, name); const st = api.getState(); const i = st.streams.findIndex(s => s.subtype === 'PRC'); if (i >= 0 && i !== st.activeStreamIdx) await api.activateStream(i); }, { b64, name: path.basename(pdf) });
  const parts = opt('parts') ? String(opt('parts')).split(',').map(Number) : null;
  const pre = await page.evaluate(p => window.PDF3D.canExportCadSurfaces(p), parts); console.log('preflight', JSON.stringify(pre));
  // sample browser process memory (all chrome processes RSS) while running
  let peakRss = 0; const pid = browser.process ? null : null; void pid;
  const cp = require('child_process'); let peakSum = 0;
  const sampler = setInterval(() => { try {
    const rows = cp.execSync('ps -eo pid=,ppid=,rss=,args=').toString().split('\n').filter(Boolean).map(l => { const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); return m && { pid: +m[1], ppid: +m[2], rss: +m[3] * 1024, args: m[4] }; }).filter(Boolean);
    const root = rows.find(r => r.args.includes('--cadE2E-tag=' + process.pid) && !r.args.includes('--type=')); if (!root) return;
    const set = new Set([root.pid]); let grew = true; while (grew) { grew = false; for (const r of rows) if (!set.has(r.pid) && set.has(r.ppid)) { set.add(r.pid); grew = true; } }
    let sum = 0, mx = 0; for (const r of rows) if (set.has(r.pid)) { sum += r.rss; if (r.rss > mx) mx = r.rss; }
    if (mx > peakRss) peakRss = mx; if (sum > peakSum) peakSum = sum; } catch (e) {} }, 500);
  const t0 = Date.now();
  const res = await page.evaluate(async ({ parts, fittedOnly, cancelAt }) => {
    const prog = []; const ctl = new AbortController(); let lastStage = ''; let lastRec = -1;
    const r = await window.PDF3D.exportCadSurfaces(parts, { fittedOnly, signal: ctl.signal, onProgress: p => { if (p.stage !== lastStage || p.pct - lastRec >= 5 || p.pct < lastRec) { lastRec = p.pct; prog.push({ t: Math.round(performance.now()), stage: p.stage, pct: p.pct, label: p.label }); } lastStage = p.stage; if (cancelAt && p.stage === cancelAt) ctl.abort(); } });
    const lateAbort = (() => { try { ctl.abort(); return 'ok'; } catch (e) { return String(e); } })();
    let text = null; if (r.blob && r.blob.size < 150e6) { const buf = new Uint8Array(await r.blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); text = btoa(s); }
    return { status: r.status, reason: r.reason, reasonCode: r.reasonCode, filename: r.filename, size: r.blob ? r.blob.size : 0, summary: r.summary, prog, text, lateAbort,
      jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null };
  }, { parts, fittedOnly: !!opt('fitted-only'), cancelAt: opt('cancel-at') });
  clearInterval(sampler); const wall = Date.now() - t0;
  if (res.text) fs.writeFileSync(out, Buffer.from(res.text, 'base64')); delete res.text;
  res.wallMs = wall; res.peakChromeProcRss = peakRss; res.peakChromeTreeRss = peakSum;
  fs.writeFileSync(out + '.browser.json', JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ status: res.status, reason: res.reason, file: res.filename, size: res.size, wallMs: wall, peakProcRssMB: Math.round(peakRss / 1e6), peakTreeRssMB: Math.round(peakSum / 1e6), heapMB: res.summary && Math.round(res.summary.wasmHeapPeak / 1e6), faces: res.summary && res.summary.faces, byType: res.summary && res.summary.byType, timings: res.summary && res.summary.timings, parts: res.summary && res.summary.parts && res.summary.parts.map(p => [p.name, p.status, p.faces, p.check && p.check.volume]) }));
  console.log('progress stages', res.prog.map(p => p.stage + '@' + p.pct).join(' '));
  if (logs.length) console.log('console:\n' + logs.slice(-30).join('\n'));
  await browser.close(); srv.close();
})().catch(e => { console.error(e); process.exit(1); });
