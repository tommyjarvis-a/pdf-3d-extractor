/*
 * cad-export-ui.js — "Export as CAD surfaces (STEP)" UI add-on for pdf-3d-extractor.
 *
 * Integration (index.html, after simple-mode.js and after the script that defines PDF3D.exportCadSurfaces):
 *   <link rel="stylesheet" href="cad-export-ui.css" />     (in <head>)
 *   <script src="cad-export-ui.js"></script>               (end of <body>)
 *
 * Talks ONLY to Dev's public API (see README "CAD export contract"):
 *   PDF3D.canExportCadSurfaces(partIds) -> { ok, reason, message, estimate: { tris, kernelBytes, kernelCached } }
 *   PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal }) -> Promise<{ blob, filename, status, reason, summary }>
 * Feature-detected: if PDF3D.exportCadSurfaces is missing, the add-on renders nothing (page unchanged).
 *
 * Simple mode: an item in the Export ▾ menu (found by DOM: #smMenuExport, re-inserted every time
 * simple-mode.js rebuilds the format list) + a "Fitted solid only" checkbox item.
 * Advanced mode: a button + checkbox appended to the original .exportbar export group.
 * Progress / result: a non-modal toast (role=region) with aria-live announcements; the viewer stays usable.
 * No edits to simple-mode.js or app.js.
 */
(function () {
  'use strict';
  if (window.PDF3DCadExportUI) return;

  const $ = (id) => document.getElementById(id);
  const MB = (b) => (b / 1048576).toFixed(1).replace(/\.0$/, '');
  const DEFAULT_KERNEL = 13.8 * 1048576;
  const REASON_TEXT = {
    unavailable: 'Not available in this build',
    too_large: 'Model too large for surface fitting',
    no_parts: 'Open a model with parts first',
    checking: 'Checking…',
    error: 'Unavailable (check failed)'
  };
  const REASON_ALIAS = { 'too-big': 'too_large', too_big: 'too_large', toobig: 'too_large', 'no-parts': 'no_parts', nopart: 'no_parts' };
  const STATUS_ALIAS = { fitted: 'solid', 'mesh-only': 'mesh_only', meshonly: 'mesh_only', meshOnly: 'mesh_only', canceled: 'cancelled', aborted: 'cancelled' };
  const STAGE_TEXT = {
    kernel: 'Starting CAD kernel…', segment: 'Finding faces in the mesh…', fit: 'Fitting faces…',
    build: 'Building solid…', validate: 'Checking the solid…', write: 'Writing STEP…'
  };
  const TYPE_NAMES = {
    plane: ['plane', 'planes'], cylinder: ['cylinder', 'cylinders'], cone: ['cone', 'cones'], sphere: ['sphere', 'spheres'],
    torus: ['torus', 'tori'], bspline: ['B-spline', 'B-spline'], nurbs: ['B-spline', 'B-spline'], other: ['other', 'other']
  };

  // ------------------------------------------------------------------ tiny DOM helper (same shape as simple-mode.js)
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }

  // ------------------------------------------------------------------ API access + normalisation
  const api = () => {
    const ns = window.PDF3D;
    return ns && typeof ns.exportCadSurfaces === 'function' ? ns : null;
  };
  const appState = () => { try { return window.CAD3DExtractor.getState(); } catch (e) { return null; } };
  // Selected part (the app has a single selection, state.selectedPartIdx) -> [idx]; otherwise null = all parts.
  function selection() {
    const s = appState();
    if (!s || !s.parts) return { ids: null, name: null };
    const i = s.selectedPartIdx;
    if (typeof i === 'number' && i >= 0 && i < s.parts.length) return { ids: [i], name: s.parts[i].name || 'part ' + (i + 1) };
    return { ids: null, name: null };
  }
  let asyncPre = null;   // last result of an async preflight (tolerated, not in the contract)
  function normPre(r) {
    if (r === true || r === false) r = { ok: r };
    if (!r || typeof r !== 'object') r = { ok: true };
    let reason = r.reason == null ? null : String(r.reason);
    if (reason && REASON_ALIAS[reason]) reason = REASON_ALIAS[reason];
    const ok = !!r.ok;
    const est = r.estimate || {};
    return {
      ok, reason: ok ? null : (reason || 'unavailable'),
      message: (r.message && String(r.message)) || (ok ? '' : (REASON_TEXT[reason] || REASON_TEXT.unavailable)),
      estimate: { tris: est.tris, kernelBytes: est.kernelBytes || DEFAULT_KERNEL, kernelCached: !!est.kernelCached }
    };
  }
  function preflight() {
    const ns = api();
    if (!ns) return null;
    if (typeof ns.canExportCadSurfaces !== 'function') return normPre({ ok: true });
    let r;
    try { r = ns.canExportCadSurfaces(selection().ids); } catch (e) {
      return normPre({ ok: false, reason: 'error', message: 'Check failed: ' + (e && e.message || e) });
    }
    if (r && typeof r.then === 'function') {
      r.then((v) => { asyncPre = normPre(v); refreshAll(true); }, () => { asyncPre = normPre({ ok: false, reason: 'error' }); refreshAll(true); });
      return asyncPre || normPre({ ok: false, reason: 'checking' });
    }
    return normPre(r);
  }
  function normProgress(a, b, c) {
    const p = typeof a === 'string' ? Object.assign({ stage: a, pct: b }, c || {}) : Object.assign({}, a || {});
    let pct = p.pct != null ? p.pct : (p.percent != null ? p.percent : p.progress);
    pct = Number(pct);
    if (!isFinite(pct)) pct = null;
    else {
      if (pct > 0 && pct < 1 && Math.round(pct) !== pct) run.fraction = true;
      if (run.fraction && pct <= 1) pct *= 100;
      pct = Math.max(0, Math.min(100, pct));
    }
    const total = p.total != null ? p.total : p.n, done = p.done != null ? p.done : p.i;
    let label = p.label && String(p.label);
    if (!label) {
      if (p.stage === 'kernel' && p.totalBytes) label = 'Downloading CAD kernel ' + MB(p.bytes || 0) + ' / ' + MB(p.totalBytes) + ' MB';
      else if (p.stage === 'fit' && total) label = 'Fitting faces ' + (done || 0) + '/' + total;
      else label = STAGE_TEXT[p.stage] || (p.stage ? String(p.stage) : 'Working…');
    }
    return { stage: p.stage || '', pct, label };
  }
  function normResult(r) {
    r = r || {};
    let status = String(r.status || '');
    if (STATUS_ALIAS[status]) status = STATUS_ALIAS[status];
    const s = Object.assign({}, r.summary || r.stats || {});
    if (s.unfitFaces == null && s.unfittedFaces != null) s.unfitFaces = Array.isArray(s.unfittedFaces) ? s.unfittedFaces.length : s.unfittedFaces;
    if (s.unfitFaces == null && Array.isArray(r.unfittedFaces)) s.unfitFaces = r.unfittedFaces.length;
    if (Array.isArray(s.unfitFaces)) s.unfitFaces = s.unfitFaces.length;
    let blob = r.blob || null;
    if (!blob && r.data != null) blob = new Blob([r.data], { type: 'application/step' });
    // Never present an unclosed body as a solid.
    if (status === 'solid' && s.closed === false) status = 'shell';
    return { status, reason: r.reason ? String(r.reason) : '', summary: s, blob, filename: r.filename || defaultName() };
  }
  function defaultName() {
    const s = appState();
    return ((s && s.fileName) || 'model').replace(/\.[^.]+$/, '') + '-surfaces.stp';
  }

  // ------------------------------------------------------------------ state
  const ui = {};
  let fittedOnly = false;
  let run = null;        // { ctrl, t0, timer, trigger, pct, label, stage, fraction, cancelling }
  let last = null;       // last finished result (for "Save again")
  let hideTimer = null;

  // ------------------------------------------------------------------ Simple mode: Export ▾ menu items
  function buildSimple() {
    const menu = $('smMenuExport');
    if (!menu) return;
    ui.simpleMenu = menu;
    ui.simpleTrigger = document.querySelector('[aria-controls="smMenuExport"]');
    ui.miSub = h('span', { class: 'cad-mi-sub', id: 'cadMiSub' });
    ui.miSub2 = h('span', { class: 'cad-mi-sub2', id: 'cadMiSub2' });
    ui.mi = h('button', { type: 'button', class: 'sm-mi cad-mi', role: 'menuitem', 'data-cad': 'simple', 'aria-describedby': 'cadMiSub cadMiSub2' },
      h('span', { class: 'sm-mi-check cad-mi-ico', 'aria-hidden': 'true', text: '◆' }),
      h('span', { class: 'cad-mi-text' }, h('span', { class: 'sm-mi-label', text: 'CAD surfaces (STEP)' }), ui.miSub, ui.miSub2),
      h('span', { class: 'sm-mi-ext', text: '.stp' }));
    ui.miOpt = h('button', { type: 'button', class: 'sm-mi sm-mi--box cad-mi-opt', role: 'menuitemcheckbox', 'aria-checked': 'false', 'data-cad': 'fitted-only' },
      h('span', { class: 'sm-mi-check', 'aria-hidden': 'true' }), h('span', { class: 'sm-mi-label', text: 'Fitted solid only' }),
      h('span', { class: 'sm-mi-ext', text: 'no mesh body' }));
    ui.mi.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ui.mi.getAttribute('aria-disabled') === 'true') return;          // stays open; reason is on screen
      closeSimpleMenu();
      if (run) focusToast(); else start(ui.simpleTrigger || ui.mi);
    });
    ui.miOpt.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (ui.miOpt.getAttribute('aria-disabled') === 'true') return;
      setFittedOnly(!fittedOnly);
    });
    const place = () => {
      const group = menu.querySelector('[role="group"]');
      if (!group || !group.children.length || !api()) {
        if (ui.mi.isConnected && !api()) { ui.mi.remove(); ui.miOpt.remove(); }
        return;
      }
      if (group.contains(ui.mi) && ui.mi.nextSibling === ui.miOpt) return;
      const anchor = group.querySelector('[data-sm-export="btnExportOBJ"]') ||
        [...group.querySelectorAll('[data-sm-export^="btnExportSTL"]')].pop();
      if (anchor) anchor.after(ui.mi, ui.miOpt); else group.append(ui.mi, ui.miOpt);
      refreshSimple();
      if (!menu.hidden) {               // grew after simple-mode positioned it: keep it on screen
        const r = menu.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 8) menu.style.maxHeight = Math.max(160, window.innerHeight - r.top - 8) + 'px';
      }
    };
    new MutationObserver(place).observe(menu, { childList: true, subtree: true });
    place();
  }
  function closeSimpleMenu() {
    const t = ui.simpleTrigger;
    if (t && t.getAttribute('aria-expanded') === 'true') t.click();      // simple-mode toggles it closed
    if (t) t.focus({ preventScroll: true });
  }
  function refreshSimple() {
    if (!ui.mi || !ui.mi.isConnected) return;
    const pre = preflight();
    if (!pre) return;
    const sel = selection();
    const dis = !run && !pre.ok;
    ui.mi.setAttribute('aria-disabled', dis ? 'true' : 'false');
    ui.mi.classList.toggle('is-disabled', dis);
    ui.mi.dataset.reason = pre.reason || '';
    ui.miOpt.setAttribute('aria-disabled', dis ? 'true' : 'false');
    ui.miOpt.setAttribute('aria-checked', fittedOnly ? 'true' : 'false');
    ui.miOpt.querySelector('.sm-mi-check').textContent = fittedOnly ? '✓' : '';
    let sub, sub2 = [];
    if (run) sub = 'Exporting… ' + (run.pct != null ? Math.round(run.pct) + '%' : '') + ' (show progress)';
    else if (!pre.ok) sub = pre.message;
    else {
      sub = fittedOnly ? 'Fitted solid only, no mesh body' : 'Fitted solid + mesh fallback';
      if (sel.name) sub2.push('Selected part only: ' + sel.name);
      if (!pre.estimate.kernelCached) sub2.push('First use downloads ' + MB(pre.estimate.kernelBytes) + ' MB');
    }
    ui.miSub.textContent = sub;
    ui.miSub.classList.toggle('cad-why', dis);
    ui.miSub2.textContent = sub2.join(' · ');
    ui.miSub2.hidden = !sub2.length;
    ui.mi.title = dis ? pre.message : 'Fit CAD surfaces (planes, cylinders, B-splines…) and export STEP' + (fittedOnly ? '' : ' with the mesh body as fallback');
  }

  // ------------------------------------------------------------------ Advanced mode: button in the export bar
  function buildAdvanced() {
    const stepBtn = $('btnExportSTEP');
    const group = stepBtn && stepBtn.closest('.export-group');
    if (!group) return;
    ui.advBtn = h('button', { type: 'button', class: 'btn cad-adv-btn', id: 'cadExportBtn', 'data-cad': 'advanced', 'aria-describedby': 'cadAdvNote' },
      'CAD Surfaces (.stp)');
    ui.advChk = h('input', { type: 'checkbox', id: 'cadFittedOnly', 'data-cad': 'fitted-only' });
    ui.advOpt = h('label', { class: 'cad-adv-opt', for: 'cadFittedOnly', title: 'Write only the fitted solid / surfaces, without the mesh body fallback' }, ui.advChk, 'Fitted only');
    ui.advNote = h('span', { class: 'cad-adv-note', id: 'cadAdvNote' });
    // own .export-group right after the original one: on a full bar it wraps as a unit next to the status badge
    ui.adv = h('div', { class: 'export-group cad-adv', role: 'group', 'aria-label': 'CAD surfaces export' }, ui.advBtn, ui.advOpt, ui.advNote);
    ui.advGroup = group;
    ui.advBtn.addEventListener('click', () => {
      if (ui.advBtn.getAttribute('aria-disabled') === 'true') return;
      if (run) focusToast(); else start(ui.advBtn);
    });
    ui.advChk.addEventListener('change', () => setFittedOnly(ui.advChk.checked));
  }
  function refreshAdvanced() {
    if (!ui.adv) return;
    const pre = preflight();
    if (!pre) { if (ui.adv.isConnected) ui.adv.remove(); return; }
    if (!ui.adv.isConnected) ui.advGroup.after(ui.adv);
    const dis = !run && !pre.ok;
    ui.advBtn.setAttribute('aria-disabled', dis ? 'true' : 'false');
    ui.advBtn.dataset.reason = pre.reason || '';
    ui.advChk.disabled = dis;
    ui.advChk.checked = fittedOnly;
    const sel = selection();
    ui.advNote.textContent = run ? 'Exporting… ' + (run.pct != null ? Math.round(run.pct) + '%' : '') : (dis ? pre.message : (sel.name ? 'Selected part only' : ''));
    ui.advNote.hidden = !ui.advNote.textContent;
    ui.advNote.classList.toggle('cad-why', dis);
    ui.advBtn.title = dis ? pre.message
      : 'Fit CAD surfaces and export STEP: fitted solid' + (fittedOnly ? ' only' : ' + mesh body fallback') +
        (pre.estimate.kernelCached ? '' : ' · first use downloads the ' + MB(pre.estimate.kernelBytes) + ' MB CAD kernel');
  }

  function setFittedOnly(v) { fittedOnly = !!v; refreshAll(); }
  let refreshQueued = false;
  function refreshAll(now) {
    if (now) { refreshQueued = false; refreshSimple(); refreshAdvanced(); return; }
    if (refreshQueued) return;
    refreshQueued = true;
    Promise.resolve().then(() => { if (refreshQueued) refreshAll(true); });
  }

  // ------------------------------------------------------------------ toast (progress + result)
  function buildToast() {
    ui.tTitle = h('h2', { class: 'cad-t-title', id: 'cadToastTitle', text: 'CAD surfaces (STEP)' });
    ui.tTime = h('span', { class: 'cad-t-time', 'aria-label': 'Elapsed time' });
    ui.tClose = h('button', { type: 'button', class: 'btn btn-sm cad-t-x', 'aria-label': 'Dismiss', text: '×', hidden: true });
    ui.tStage = h('p', { class: 'cad-t-stage' });
    ui.tFill = h('span', { class: 'cad-bar-fill' });
    ui.tBar = h('div', { class: 'cad-bar', role: 'progressbar', 'aria-label': 'CAD export progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, ui.tFill);
    ui.tMsg = h('div', { class: 'cad-t-msg' });
    ui.tNote = h('p', { class: 'cad-t-note' });
    ui.tCancel = h('button', { type: 'button', class: 'btn btn-sm cad-t-cancel', text: 'Cancel' });
    ui.tSave = h('button', { type: 'button', class: 'btn btn-sm cad-t-save', text: 'Save again', hidden: true });
    ui.tOk = h('button', { type: 'button', class: 'btn btn-sm cad-t-ok', text: 'Close', hidden: true });
    ui.tLive = h('div', { class: 'cad-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
    ui.toast = h('section', { class: 'cad-toast', role: 'region', 'aria-labelledby': 'cadToastTitle', tabindex: '-1', hidden: true },
      h('div', { class: 'cad-t-h' }, h('span', { class: 'cad-t-ico', 'aria-hidden': 'true' }), ui.tTitle, ui.tTime, ui.tClose),
      ui.tStage, ui.tBar, ui.tMsg, ui.tNote,
      h('div', { class: 'cad-t-actions' }, ui.tSave, ui.tCancel, ui.tOk), ui.tLive);
    document.body.append(ui.toast);
    ui.tCancel.addEventListener('click', cancel);
    ui.tClose.addEventListener('click', () => dismiss(true));
    ui.tOk.addEventListener('click', () => dismiss(true));
    ui.tSave.addEventListener('click', () => { if (last && last.blob) download(last.blob, last.filename); });
    ui.toast.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault(); ev.stopPropagation();         // don't let simple-mode close an open sheet as well
      if (run) returnFocus(); else dismiss(true);
    });
    ui.toast.addEventListener('focusin', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
  }
  const focusInToast = () => ui.toast && ui.toast.contains(document.activeElement);
  function focusToast() { if (ui.toast && !ui.toast.hidden) ui.toast.focus({ preventScroll: true }); }
  function returnFocus() {
    const t = (run && run.trigger) || (last && last.trigger);
    const tgt = t && t.isConnected && t.getClientRects().length ? t : (ui.simpleTrigger && ui.simpleTrigger.getClientRects().length ? ui.simpleTrigger : ui.advBtn);
    if (tgt) tgt.focus({ preventScroll: true });
  }
  function fmtTime(ms) { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }
  function announce(t) { ui.tLive.textContent = ''; setTimeout(() => { ui.tLive.textContent = t; }, 30); }

  function showProgress(pre, sel) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    ui.toast.hidden = false;
    ui.toast.dataset.state = 'running';
    ui.toast.dataset.tone = '';
    ui.tTitle.textContent = 'Exporting CAD surfaces';
    ui.tStage.hidden = false; ui.tBar.hidden = false;
    ui.tMsg.textContent = ''; ui.tMsg.hidden = true;
    const notes = [];
    if (sel.name) notes.push('Selected part: ' + sel.name);
    if (fittedOnly) notes.push('Fitted solid only');
    if (pre && !pre.estimate.kernelCached) notes.push('First run downloads the CAD kernel (' + MB(pre.estimate.kernelBytes) + ' MB)');
    notes.push('Usually 15–40 s. You can keep using the viewer.');
    ui.tNote.textContent = notes.join(' · ');
    ui.tNote.hidden = false;
    ui.tCancel.hidden = false; ui.tCancel.disabled = false; ui.tCancel.textContent = 'Cancel';
    ui.tSave.hidden = true; ui.tOk.hidden = true; ui.tClose.hidden = true;
    setBar(null, 'Starting…');
    ui.tTime.textContent = '0:00';
  }
  function setBar(pct, label) {
    ui.tStage.textContent = label;
    if (pct == null) {
      ui.tBar.classList.add('is-indeterminate');
      ui.tBar.removeAttribute('aria-valuenow');
      ui.tFill.style.width = '';
    } else {
      ui.tBar.classList.remove('is-indeterminate');
      ui.tBar.setAttribute('aria-valuenow', String(Math.round(pct)));
      ui.tFill.style.width = pct.toFixed(1) + '%';
    }
    ui.tBar.setAttribute('aria-valuetext', label + (pct != null ? ' (' + Math.round(pct) + '%)' : ''));
  }

  // ------------------------------------------------------------------ run
  async function start(trigger) {
    const ns = api();
    if (!ns || run) return;
    const pre = preflight();
    if (pre && !pre.ok) { refreshAll(true); return; }
    const sel = selection();
    last = null;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    run = { ctrl, t0: performance.now(), trigger, pct: null, label: '', stage: '', fraction: false, cancelling: false, lastAnn: -1 };
    const me = run;
    showProgress(pre, sel);
    ui.toast.focus({ preventScroll: true });
    announce('CAD export started. ' + (pre && !pre.estimate.kernelCached ? 'Downloading the CAD kernel first.' : ''));
    run.timer = setInterval(() => { ui.tTime.textContent = fmtTime(performance.now() - me.t0); }, 500);
    refreshAll(true);
    document.dispatchEvent(new CustomEvent('pdf3d:cadexport', { detail: { phase: 'start' } }));

    const onProgress = (a, b, c) => {
      if (run !== me || me.cancelling) return;
      const p = normProgress(a, b, c);
      me.pct = p.pct; me.label = p.label;
      setBar(p.pct, p.label);
      const q = p.pct == null ? -1 : Math.floor(p.pct / 25);
      if (p.stage !== me.stage || q > me.lastAnn) {          // announce stage changes and each 25%, not every tick
        me.stage = p.stage; me.lastAnn = Math.max(me.lastAnn, q);
        announce(p.label + (p.pct != null ? ', ' + Math.round(p.pct) + '%' : ''));
      }
      if (ui.mi && ui.simpleMenu && !ui.simpleMenu.hidden) refreshSimple();
      if (ui.advNote && ui.adv.isConnected) ui.advNote.textContent = 'Exporting… ' + (p.pct != null ? Math.round(p.pct) + '%' : '');
    };
    let res, err = null;
    try {
      const opts = { fittedOnly, onProgress, signal: ctrl ? ctrl.signal : undefined };
      res = normResult(await ns.exportCadSurfaces(sel.ids, opts));
    } catch (e) {
      if (e && e.name === 'AbortError') res = normResult({ status: 'cancelled' });
      else err = e || new Error('Unknown error');
    }
    if (run !== me) return;
    finish(me, res, err);
  }
  function cancel() {
    if (!run || run.cancelling) return;
    run.cancelling = true;
    ui.tCancel.disabled = true;
    ui.tCancel.textContent = 'Cancelling…';
    setBar(run.pct, 'Cancelling…');
    if (run.ctrl) run.ctrl.abort();
  }
  function finish(me, res, err) {
    clearInterval(me.timer);
    const elapsed = performance.now() - me.t0;
    const hadFocus = focusInToast();
    run = null;
    const out = describe(res, err, elapsed);
    last = { blob: out.download ? res.blob : null, filename: res && res.filename, trigger: me.trigger, status: out.status };
    ui.toast.dataset.state = 'done';
    ui.toast.dataset.tone = out.tone;
    ui.toast.dataset.status = out.status;
    ui.tTitle.textContent = out.title;
    ui.tTime.textContent = fmtTime(elapsed);
    ui.tStage.hidden = true; ui.tBar.hidden = true;
    ui.tMsg.textContent = '';
    for (const line of out.lines) ui.tMsg.append(h('p', null, line));
    if (out.details.length) ui.tMsg.append(h('dl', { class: 'cad-t-dl' }, out.details.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])));
    ui.tMsg.hidden = !ui.tMsg.childNodes.length;
    ui.tNote.textContent = out.note || ''; ui.tNote.hidden = !out.note;
    ui.tCancel.hidden = true;
    ui.tSave.hidden = !last.blob;
    ui.tOk.hidden = out.status === 'cancelled';
    ui.tClose.hidden = false;
    announce(out.title + '. ' + out.lines.join(' '));
    if (hadFocus) (ui.tOk.hidden ? ui.tClose : ui.tOk).focus({ preventScroll: true });
    if (out.download) download(res.blob, res.filename);
    if (out.status === 'cancelled') hideTimer = setTimeout(() => { if (!focusInToast()) dismiss(false); }, 4000);
    refreshAll(true);
    document.dispatchEvent(new CustomEvent('pdf3d:cadexport', { detail: { phase: 'done', status: out.status } }));
  }
  function dismiss(giveFocusBack) {
    if (!ui.toast || ui.toast.hidden || run) return;
    const had = focusInToast();
    ui.toast.hidden = true;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (giveFocusBack || had) returnFocus();
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function byTypeText(bt) {
    if (!bt) return '';
    return Object.keys(bt).filter((k) => bt[k] > 0).sort((a, b) => bt[b] - bt[a])
      .map((k) => { const nm = TYPE_NAMES[k] || [k, k]; return bt[k] + ' ' + (bt[k] === 1 ? nm[0] : nm[1]); }).join(', ');
  }
  // Plain-language wording per status. Never says "solid" unless the API reported a closed solid.
  function describe(res, err, elapsed) {
    if (err) {
      return { status: 'error', tone: 'err', title: 'CAD export failed', download: false, details: [],
        lines: [String((err && err.message) || err), 'Nothing was exported. The mesh exports (STEP, STL, OBJ) still work.'] };
    }
    const s = res.summary || {};
    const has = !!(res.blob && (res.blob.size == null || res.blob.size > 0));
    const unfit = +s.unfitFaces || 0;
    const types = byTypeText(s.byType);
    const details = [];
    if (s.faces != null && res.status !== 'skipped') details.push(['Fitted faces', String(s.faces) + (types ? ' (' + types + ')' : '')]);
    if (unfit > 0) details.push(['Not fitted', plural(unfit, 'face')]);
    if (res.status !== 'skipped' && res.status !== 'cancelled') details.push(['Mesh body', s.meshFallback ? 'included' : 'not included']);
    if (has && res.filename) details.push(['File', res.filename]);
    const meshLine = s.meshFallback ? 'The mesh body is included as a fallback.' : (fittedOnlyUsed(s) ? 'No mesh body (fitted solid only).' : '');
    switch (res.status) {
      case 'solid': {
        const lines = [plural(+s.faces || 0, 'face') + ' fitted into a closed solid.'];
        if (s.valid === false) lines.push('The solid did not pass validation; check it in your CAD tool.');
        if (meshLine) lines.push(meshLine);
        return { status: 'solid', tone: s.valid === false ? 'warn' : 'ok', title: s.valid === false ? 'Solid exported with warnings' : 'Fitted solid exported',
          lines, details, download: has };
      }
      case 'shell': {
        const lines = ['The fitted surfaces don\u2019t close up, so this is not a solid. CAD tools will open it as surfaces (a shell).'];
        if (res.reason) lines.push(res.reason.replace(/\.?$/, '.'));
        if (meshLine) lines.push(meshLine);
        return { status: 'shell', tone: 'warn', title: 'Surfaces exported, not a closed solid', lines, details, download: has };
      }
      case 'mesh_only':
        return { status: 'mesh_only', tone: 'warn', title: 'No clean fit: mesh body exported', download: has, details,
          lines: [(res.reason || 'The surfaces could not be fitted cleanly.').replace(/\.?$/, '.'),
            has ? 'The STEP contains the mesh body only (triangles), no fitted surfaces.' : 'Nothing was exported.'] };
      case 'skipped':
        return { status: 'skipped', tone: 'muted', title: 'Nothing exported', download: false, details: [],
          lines: [(res.reason || 'The model was skipped.').replace(/\.?$/, '.'), 'Use Export STEP / STL for a mesh export.'] };
      case 'cancelled':
        return { status: 'cancelled', tone: 'muted', title: 'Export cancelled', download: false, details: [], lines: [] };
      default:
        return { status: res.status || 'unknown', tone: 'warn', title: 'Export finished (status \u201c' + (res.status || 'unknown') + '\u201d)',
          download: has, details, lines: [res.reason || 'Check the exported file before using it.'] };
    }
  }
  function fittedOnlyUsed(s) { return s.meshFallback === false; }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename || defaultName(), hidden: true });
    document.body.append(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
  }

  // ------------------------------------------------------------------ init
  function init() {
    if (!$('viewportCanvas') || !document.body) return;
    buildToast();
    buildSimple();
    buildAdvanced();
    refreshAll(true);
    // part list changes (load / selection), status changes, mode switches, late-loaded API
    const obs = (el, opts) => { if (el) new MutationObserver(() => refreshAll()).observe(el, opts); };
    obs($('partList'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    obs($('statusBadge'), { childList: true, characterData: true, subtree: true });
    document.addEventListener('pdf3d:uimode', () => refreshAll());
    window.addEventListener('load', () => refreshAll());
    if (ui.advBtn) ui.advBtn.addEventListener('pointerenter', () => refreshAll(true));
  }

  window.PDF3DCadExportUI = {
    refresh: () => refreshAll(true),
    start: () => start(null),
    cancel,
    get running() { return !!run; },
    get fittedOnly() { return fittedOnly; },
    set fittedOnly(v) { setFittedOnly(v); }
  };
  if (document.readyState === 'loading' && !$('viewportCanvas')) document.addEventListener('DOMContentLoaded', init);
  else init();
})();
