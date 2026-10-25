// cad-ui-real.test.cjs - Designer's CAD export UI (cad-export-ui.js) driven against the REAL engine (recon/cad-export.js,
// worker + opencascade.js), in Chrome via Playwright. Complements Designer's stub-driven test/cad-export.test.js.
// Usage: NODE_PATH=/tmp/pwrun/node_modules BASE=http://127.0.0.1:PORT/ [STANDALONE=file:///…/standalone.html] [OUT=dir]
//        node recon/tools/cad-ui-real.test.cjs
// BASE must serve this worktree (or a git-archive copy of it). Uses sample2.pdf (screw) and the g01 dice (U3D).
const { chromium } = require('playwright-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8951/';
const OUT = (process.env.OUT || '/tmp/pwrun/cad-ui-real') + '/'; fs.mkdirSync(OUT, { recursive: true });
const SCREW = process.env.SCREW || '/workspace/nx-prc-analysis/sample2/sample2.pdf';
const DICE = process.env.DICE || '/workspace/pdf-3d-extractor-qa/corpus/g01_media9_richmedia_u3d_dice.pdf';
const MENU = '#smMenuExport', TRIG = '[aria-controls="smMenuExport"]', MI = '[data-cad="simple"]', OPT = '#smMenuExport [data-cad="fitted-only"]';
const results = [], errors = [];
const ok = (name, cond, extra) => { results.push({ name, pass: !!cond, extra: extra == null ? '' : String(extra) }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra != null ? '  [' + extra + ']' : '')); };
const settle = (p, ms = 300) => p.waitForTimeout(ms);
const toast = (p) => p.evaluate(() => { const t = document.querySelector('.cad-toast'); return t && { hidden: t.hidden, state: t.dataset.state, status: t.dataset.status, tone: t.dataset.tone, title: t.querySelector('.cad-t-title').textContent, stage: (document.querySelector('.cad-t-stage') || {}).textContent, text: t.innerText }; });
const waitDone = (p, ms = 240000) => p.waitForFunction(() => { const t = document.querySelector('.cad-toast'); return t && !t.hidden && t.dataset.state === 'done'; }, null, { timeout: ms, polling: 250 });
const openMenu = async (p) => { if (!(await p.isVisible(MENU))) await p.click(TRIG); await settle(p, 250); };
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  async function page(q, file) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage(); p.downloads = []; p.on('download', (d) => p.downloads.push(d));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(q + ' :: ' + m.text()); });
    p.on('pageerror', (e) => errors.push(q + ' :: PAGEERROR ' + e.message));
    await p.goto(BASE + q);
    await p.waitForFunction(() => window.CAD3DExtractor && window.CAD3DExtractor.getState().parts.length > 0, null, { timeout: 60000 });
    if (file) {
      await p.evaluate(() => { window.__oldParts = window.CAD3DExtractor.getState().parts; });
      await p.setInputFiles('#fileInput', file);
      const base = require('path').basename(file);
      await p.waitForFunction((b) => { const s = window.CAD3DExtractor.getState(); return s.fileName === b && s.parts !== window.__oldParts && s.parts.length > 0; }, base, { timeout: 120000 });
    }
    await settle(p, 800);
    await p.evaluate(() => window.PDF3DCadExportUI && window.PDF3DCadExportUI.refresh());
    return { p, ctx };
  }
  const saveDl = async (p, i, name) => { const f = OUT + name; await p.downloads[i].saveAs(f); return f; };

  // 1. Simple, screw, full run (fitted + mesh) through the menu item
  {
    const { p, ctx } = await page('index.html?ui=simple', SCREW);
    ok('no legacy Advanced CAD button in the page', (await p.$$('#btnExportCAD, #cadExportPanel')).length === 0);
    await openMenu(p);
    const mi = await p.$eval(MI, (e) => ({ dis: e.getAttribute('aria-disabled'), label: e.querySelector('.sm-mi-label').textContent, sub: e.querySelector('.cad-mi-sub').textContent, sub2: e.querySelector('.cad-mi-sub2').textContent }));
    ok('simple: CAD item enabled with real preflight', mi.dis === 'false' && mi.label === 'CAD surfaces (STEP)' && mi.sub === 'Fitted solid + mesh fallback', JSON.stringify(mi));
    ok('simple: uncached kernel wording from real estimate', /First use downloads 13\.1 MB/.test(mi.sub2), mi.sub2);
    const stages = new Set();
    await p.exposeFunction('__stage', (s) => stages.add(s));
    await p.evaluate(() => new MutationObserver(() => { const s = document.querySelector('.cad-t-stage'); if (s) window.__stage(s.textContent); }).observe(document.body, { subtree: true, childList: true, characterData: true }));
    const t0 = Date.now();
    await p.click(MI);
    await settle(p, 300);
    let t = await toast(p);
    ok('simple: progress toast running', t && !t.hidden && t.state === 'running', t && t.state);
    await waitDone(p);
    t = await toast(p);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    ok('simple: real result = Fitted solid exported', t.status === 'solid' && t.title === 'Fitted solid exported' && /34 faces fitted into a closed solid/.test(t.text) && /mesh body is included/.test(t.text), t.title + ' / ' + secs + ' s');
    ok('simple: face breakdown from real byType', /34 \(24 B-splines?, 8 cylinders, 2 planes\)/i.test(t.text) || /34 \(/.test(t.text), (t.text.match(/Fitted faces[^\n]*\n?[^\n]*/) || [''])[0].replace(/\s+/g, ' '));
    ok('simple: stages shown from API labels (kernel, fitting, writing)', [...stages].some((s) => /kernel/i.test(s)) && [...stages].some((s) => /fit/i.test(s)) && [...stages].some((s) => /writ/i.test(s)), [...stages].slice(0, 6).join(' | '));
    await settle(p, 800);
    ok('simple: downloaded sample2-surfaces.stp', p.downloads.length === 1 && p.downloads[0].suggestedFilename() === 'sample2-surfaces.stp', p.downloads.map((d) => d.suggestedFilename()).join(','));
    if (p.downloads.length) { const f = await saveDl(p, 0, 'ui-simple-sample2-surfaces.stp'); const txt = fs.readFileSync(f, 'utf8');
      ok('simple: download is STEP with screw_fitted + screw_mesh', /^ISO-10303-21;/.test(txt) && /'screw_fitted'/.test(txt) && /'screw_mesh'/.test(txt), (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'); }
    await p.keyboard.press('Escape');
    await openMenu(p);
    ok('simple: kernel now cached, download wording dropped', !/downloads/.test(await p.textContent(MI)));
    // 2. cancel mid-run (fit stage) from the toast
    await p.click(MI);
    await p.waitForFunction(() => /fit/i.test((document.querySelector('.cad-t-stage') || {}).textContent || ''), null, { timeout: 60000 });
    await p.click('.cad-t-cancel');
    await waitDone(p, 30000);
    t = await toast(p);
    ok('simple: Cancel during fitting -> Export cancelled, no download', t.status === 'cancelled' && t.title === 'Export cancelled' && p.downloads.length === 1, t.title);
    // too_large via the real limit object (preflight, no load of a 1M-triangle model)
    await p.evaluate(() => { window.__lim = window.PDF3D.cadSurfaceLimits.maxTris; window.PDF3D.cadSurfaceLimits.maxTris = 1000; window.PDF3DCadExportUI.refresh(); });
    await settle(p, 300); await p.keyboard.press('Escape'); await openMenu(p);
    const dis = await p.$eval(MI, (e) => ({ dis: e.getAttribute('aria-disabled'), reason: e.dataset.reason, sub: e.querySelector('.cad-mi-sub').textContent }));
    ok('simple: too_large preflight disables item with real message', dis.dis === 'true' && dis.reason === 'too_large' && /Model too large/.test(dis.sub), JSON.stringify(dis));
    const before = await toast(p);
    await p.click(MI, { force: true, timeout: 5000 }).catch(() => {}); await settle(p, 600);
    const after = await toast(p);
    ok('simple: disabled item does nothing', p.downloads.length === 1 && (!after || after.state !== 'running') && JSON.stringify(before) === JSON.stringify(after), await p.$eval(MI, (e) => (e.disabled ? 'disabled' : '') + ' aria-disabled=' + e.getAttribute('aria-disabled')));
    await p.evaluate(() => { window.PDF3D.cadSurfaceLimits.maxTris = window.__lim; window.PDF3DCadExportUI.refresh(); });
    await ctx.close();
  }
  // 3. Advanced, screw, fitted only via the checkbox
  {
    const { p, ctx } = await page('index.html?ui=advanced', SCREW);
    ok('advanced: one CAD button (Designer), legacy button absent', (await p.$$('#cadExportBtn')).length === 1 && (await p.$$('#btnExportCAD')).length === 0);
    await p.check('#cadFittedOnly');
    await p.click('#cadExportBtn');
    await waitDone(p);
    const t = await toast(p);
    ok('advanced: fitted-only result', t.status === 'solid' && /No mesh body \(fitted solid only\)/.test(t.text) && /Mesh body\s*not included/.test(t.text), t.title);
    await settle(p, 800);
    ok('advanced: downloaded sample2-surfaces-only.stp', p.downloads.length === 1 && p.downloads[0].suggestedFilename() === 'sample2-surfaces-only.stp', p.downloads.map((d) => d.suggestedFilename()).join(','));
    if (p.downloads.length) { const f = await saveDl(p, 0, 'ui-advanced-sample2-surfaces-only.stp'); const txt = fs.readFileSync(f, 'utf8');
      ok('advanced: fitted-only STEP has no mesh body', /'screw_fitted'/.test(txt) && !/'screw_mesh'/.test(txt), (fs.statSync(f).size / 1048576).toFixed(1) + ' MB'); }
    await ctx.close();
  }
  // 4. U3D dice: mesh body only
  {
    const { p, ctx } = await page('index.html?ui=simple', DICE);
    await openMenu(p);
    ok('dice: item enabled (mesh-only export allowed)', (await p.$eval(MI, (e) => e.getAttribute('aria-disabled'))) === 'false');
    await p.click(MI);
    await waitDone(p, 120000);
    const t = await toast(p);
    ok('dice: No clean fit: mesh body exported', t.status === 'mesh_only' && /U3D stream stores triangles only/.test(t.text), t.title);
    await settle(p, 800);
    ok('dice: mesh-only STEP downloaded', p.downloads.length === 1 && /-surfaces\.stp$/.test(p.downloads[0].suggestedFilename()), p.downloads.map((d) => d.suggestedFilename()).join(','));
    await ctx.close();
  }
  // 5. standalone single-file build: disabled with the unavailable message
  if (process.env.STANDALONE) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push('standalone :: PAGEERROR ' + e.message));
    await p.goto(process.env.STANDALONE + '?ui=simple');
    await p.waitForFunction(() => window.CAD3DExtractor && window.CAD3DExtractor.getState().parts.length > 0, null, { timeout: 60000 }); await settle(p, 800);
    await openMenu(p);
    const s = await p.$eval(MI, (e) => ({ dis: e.getAttribute('aria-disabled'), reason: e.dataset.reason, sub: e.querySelector('.cad-mi-sub').textContent }));
    ok('standalone: Simple item disabled, reason unavailable', s.dis === 'true' && s.reason === 'unavailable' && /single-file/.test(s.sub), JSON.stringify(s));
    await p.goto(process.env.STANDALONE + '?ui=advanced');
    await p.waitForFunction(() => window.CAD3DExtractor && window.CAD3DExtractor.getState().parts.length > 0, null, { timeout: 60000 }); await settle(p, 800);
    const a = await p.$eval('#cadExportBtn', (e) => ({ dis: e.getAttribute('aria-disabled'), note: document.querySelector('#cadAdvNote').textContent }));
    ok('standalone: Advanced button disabled with note', a.dis === 'true' && /single-file/.test(a.note), JSON.stringify(a));
    await ctx.close();
  }
  ok('no console/page errors', errors.length === 0, errors.slice(0, 5).join(' || '));
  const pass = results.filter((r) => r.pass).length;
  console.log(`\nRESULT ${pass}/${results.length}`);
  fs.writeFileSync(OUT + 'results.json', JSON.stringify({ pass, total: results.length, results, errors }, null, 1));
  await browser.close(); process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
