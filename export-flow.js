/*
 * export-flow.js — single "Export" button → format list → per-format options → "Save as…" (pdf-3d-extractor add-on).
 *
 * SIMPLE MODE ONLY: replaces the Simple-mode split button (Export STEP + ▾ menu) with ONE flow. Advanced mode keeps its
 * original export bar and the .cad-adv group untouched. The original #btnExport* buttons are still the mesh writers.
 *
 * Engine hooks (all optional, feature-detected, never faked):
 *   PDF3D.capabilities.parasolid === true   → show "Parasolid (.x_t)" (needs PDF3D.exportFormat or #btnExportXT).
 *       1.5.2 writer is merged-only: one faceted body (list line "Faceted body, flat faces"), note "Faceted solid, merged into one body (no B-spline surfaces yet)",
 *       no body/mode choice; exportFormat('xt', opts) always gets brepMode: 'merged'.
 *       Result keys (summary.<k>, else top-level <k>): faces === 0 → amber "Nothing to export", no file;
 *       bodyType === 'sheet' || openEdges > 0 || sewn === false → amber "Parasolid sheet body exported (open model)".
 *       No blob + reasonCode XT_TOO_LARGE (estimated output > 8 GB) → amber "Model too large to export" (own text only, the
 *       engine's reason is not appended). Reason codes are matched case-insensitively; xt_too_large = too_large.
 *   PDF3D.exportFormat(format, opts)       → Promise<{ blob, filename, status, reasonCode, summary }>
 *       preferred writer when present (format: step|stl|obj|iges|raw|xt). For STEP, opts = { body: 'fitted'|'mesh'|'both',
 *       onNoFit: 'mesh'|'omit', fittedOnly (= body==='fitted'), partIds, units, detail, brepMode, encoding, signal, onProgress }
 *       summary.parts = [{ index?, name, status: solid|shell|mesh_only|skipped, faces, reasonCode, reason?, written: solid|mesh|omitted }]
 *   PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal })  → used only when exportFormat is missing:
 *       Fitted = fittedOnly:true, Both = fittedOnly:false. With onNoFit 'mesh' the unfitted parts' mesh bodies (named
 *       <part>_mesh, from CAD3DExtractor.buildSTEPAP214) are merged into the same file with PDF3DStepMerge; if no part fits,
 *       the whole mesh STEP is saved instead.
 * Without exportFormat, mesh formats are written by clicking the original button and capturing the blob it downloads.
 *
 *   PDF3D.estimateBytes(format, opts)      → number | {estimatedBytes} | Promise of either (optional): estimated output size, asked (debounced) when
 *       STEP / STL / OBJ / Parasolid options are shown or change. Download path only (no save picker): > 300 MB → amber note
 *       above Save. Errors / non-numbers / absent hook = no note.
 *   Result extras (optional): delivery: 'picker'|'download', size (bytes; overrides blob.size), summary.estimatedBytes
 *       (fallback when there is no blob size). Downloaded (no picker, or delivery === 'download') and > 300 MB → the green
 *       card becomes amber "Check that the download finished" (Chrome can cancel huge blob downloads silently, 0-byte file).
 * Saving: showSaveFilePicker (Chrome/Edge) is called FIRST, inside the click gesture. Then handle.createWritable() (retried once
 *   if it rejects) is opened BEFORE the export and passed as opts.writable: the writer streams parts into it and returns
 *   { blob: null, delivery: 'picker', size } without closing; we close() and only then show the green card. A returned blob
 *   (old writer / no hook) is written by us. Both createWritable() attempts fail → the empty picked file is removed and the
 *   export goes out as a browser download ("Downloaded as {name}", > 300 MB check applies).
 *   WRITE_FAILED, a browser error while writing, or write()/close() rejecting → abort(), remove the file (handle.remove(),
 *   else truncate to 0 bytes) and an amber "Couldn’t finish saving {name}" card; raw browser text is never shown. The
 *   free-space line only for QuotaExceededError / a quota-like writer result; otherwise "Try again, or export as a smaller format."
 * Elsewhere: an inline file-name field + <a download> ("Your browser will download the file."; card says "Downloaded as").
 * Wording never names a folder and never says whether a dialog appeared: the browser decides (Brave can ask where to save).
 * Picker cancel = quiet no-op.
 * Every export ends in a visible result card that stays until dismissed or the next export starts; it is hidden while the
 * Export popover is open (it would cover Save) and comes back if the popover closes without a new export.
 *
 * Partial loads (PDF3D.partialNote() non-null, else lastLoad.damaged on an 'ok' load, or damaged / summary.damaged on the export result): the suggested name
 * gets "_partial" before the extension (part_partial.x_t, part-ascii_partial.stl; PDF3D.suggestedFileName when the engine has it), the popover shows "Only part of this model
 * loaded. The file may be missing parts." above Save, and a card for a saved file is amber (never green) with the first
 * line "This model was only partly read. Check it against the drawing before using it." (other lines kept).
 * Fitting-limit card: title "Exported as mesh STEP"; the triangle count is lastLoad.trisParsed, else summary.tris, else
 * parsed from the reason.
 * Embedded files: saveAttachment(index, { button, label }) — Simple's attachment card Save buttons (see the function).
 *
 * API: window.PDF3DExportFlow = { open(), close(), select(fmt), save(), dismiss(), saveAttachment(i, o), state, formats(), storageKey }
 * Events: 'pdf3d:export' on document, detail { phase: 'start'|'done', format, status }; 'pdf3d:attachment' { phase: 'done',
 *   format: 'attachment', status: 'attachment_saved'|'attachment_failed' }.
 */
(function () {
  'use strict';
  if (window.PDF3DExportFlow) return;
  const $ = (id) => document.getElementById(id);
  const LS = 'pdf3d-extractor.exportFlow';
  const NS = () => window.PDF3D || {};
  const appState = () => { try { return window.CAD3DExtractor.getState(); } catch (e) { return null; } };

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = v;
      else if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    return el;
  }

  // ------------------------------------------------------------------ formats (only what the app can write today)
  const FORMATS = [
    { id: 'step', label: 'STEP', ext: '.stp', sub: 'CAD solid for NX, SolidWorks, Fusion…', mime: 'application/step', btn: 'btnExportSTEP' },
    { id: 'stl', label: 'STL', ext: '.stl', sub: 'Triangle mesh for 3D printing', mime: 'model/stl', btn: 'btnExportSTL' },
    { id: 'obj', label: 'OBJ', ext: '.obj', sub: 'Mesh with part groups', mime: 'model/obj', btn: 'btnExportOBJ' },
    { id: 'iges', label: 'IGES', ext: '.igs', sub: 'Wireframe edges only', mime: 'model/iges', btn: 'btnExportIGES' },
    { id: 'raw', label: 'Raw stream', ext: '.u3d', sub: 'The embedded U3D / PRC bytes', mime: 'application/octet-stream', btn: 'btnExportRaw' },
    { id: 'xt', label: 'Parasolid', ext: '.x_t', sub: 'Faceted body, flat faces', mime: 'text/plain', btn: 'btnExportXT', cap: 'parasolid' }
  ];
  const FMT = Object.fromEntries(FORMATS.map((f) => [f.id, f]));
  const caps = () => (NS().capabilities || {});
  const hasCad = () => typeof NS().exportCadSurfaces === 'function';
  const hasHook = () => typeof NS().exportFormat === 'function';
  // capabilities.cadSurfaces === false (1.6.0): Fitted / Both shown but inert, STEP body is Mesh for now (saved pref kept).
  // Absent / undefined = previous behavior. Read live, so it is re-checked every time the popover opens.
  const cadOff = () => caps().cadSurfaces === false;
  const CAD_REASON = {
    file_url: 'Fitting needs the page opened from a web address, not a local file.',
    single_file: 'Fitting isn\u2019t included in the single-file version.',
    kernel_download: 'The CAD kernel couldn\u2019t download. Check your connection and try again.',
    browser_unsupported: 'This browser can\u2019t run surface fitting. Try a recent version of Chrome, Edge, Safari or Firefox.'
  };
  const cadReason = () => CAD_REASON[caps().cadSurfacesReason] || 'Surface fitting isn\u2019t available here.';
  function available(f) {
    if (f.cap) return caps()[f.cap] === true && (hasHook() || !!$(f.btn));     // capability flag AND a writer
    return hasHook() || !!$(f.btn);
  }
  function extOf(f) {
    if (f.id !== 'raw') return f.ext;
    const s = appState(); const st = s && s.streams && s.streams[s.activeStreamIdx];
    return st && st.subtype === 'PRC' ? '.prc' : '.u3d';
  }
  function stem() {
    const s = appState();
    return ((s && s.fileName) || 'model').replace(/\.(pdf|u3d|prc)$/i, '');
  }

  // ------------------------------------------------------------------ persisted choices
  // step.body: fitted|mesh|both; step.onNoFit: 'mesh' (save mesh STEP instead, default) | 'omit' (leave unfitted parts out)
  const DEF = { format: 'step', step: { body: 'fitted', onNoFit: 'mesh' }, stl: { enc: 'binary' } };
  let prefs = load();
  function load() {
    try {
      const p = JSON.parse(localStorage.getItem(LS) || 'null');
      if (p && typeof p === 'object') {
        const st = { ...DEF.step, ...(p.step || {}) };
        if ('fittedOnly' in st) { if (!(p.step && p.step.onNoFit)) st.onNoFit = st.fittedOnly ? 'omit' : 'mesh'; delete st.fittedOnly; }  // pre-v2 checkbox
        if (!/^(fitted|mesh|both)$/.test(st.body)) st.body = DEF.step.body;
        if (st.onNoFit !== 'omit') st.onNoFit = 'mesh';
        return { ...DEF, ...p, step: st, stl: { ...DEF.stl, ...(p.stl || {}) } };
      }
    } catch (e) { /* ignore */ }
    return JSON.parse(JSON.stringify(DEF));
  }
  function save() { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch (e) { /* private mode */ } }

  const pickerOK = () => typeof window.showSaveFilePicker === 'function' && window.isSecureContext !== false && window.self === window.top;

  // ------------------------------------------------------------------ UI
  const ui = {};
  let open = false, running = null, lastTrigger = null, ptrInside = false;
  let stashed = false;   // result card hidden while the Export popover is open (it would cover Save / the options)

  function radio(name, value, label, hint, checked, onchange, off) {
    const inp = h('input', { type: 'radio', name, value, checked: !!checked });
    if (off) {
      // inert but still focusable: aria-disabled (not disabled), and clicks / arrow-key selection are cancelled
      inp.setAttribute('aria-disabled', 'true');
      if (off.describedBy) inp.setAttribute('aria-describedby', off.describedBy);
      inp.addEventListener('click', (ev) => { ev.preventDefault(); });
    }
    inp.addEventListener('change', () => { if (inp.checked && !off) onchange(value); });
    return h('label', { class: 'xf-radio' + (off ? ' xf-radio--off' : '') }, inp, h('span', { class: 'xf-radio-l', text: label }), hint ? h('small', { text: hint }) : null);
  }
  function proxySelect(origId, label) {
    const o = $(origId);
    if (!o) return null;
    const sel = h('select', { class: 'select-ctrl', 'data-xf-proxy': origId });
    for (const op of o.options) sel.append(h('option', { value: op.value, text: op.text }));
    sel.value = o.value;
    sel.addEventListener('change', () => {
      const t = $(origId); if (!t || t.value === sel.value) return;
      t.value = sel.value; t.dispatchEvent(new Event('input', { bubbles: true })); t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return h('label', { class: 'xf-field' }, h('span', { text: label }), sel);
  }

  function build() {
    ui.btnSimple = h('button', { type: 'button', class: 'btn btn-primary xf-btn', 'data-xf': 'export', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'aria-controls': 'xfPop' },
      'Export', h('span', { class: 'sm-caret xf-caret', 'aria-hidden': 'true', text: '▼' }));
    for (const b of [ui.btnSimple]) {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); if (open) close(false); else openPop(b); });
      b.addEventListener('keydown', (ev) => { if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !open) { ev.preventDefault(); openPop(b); } });
    }

    ui.list = h('div', { class: 'xf-list', role: 'radiogroup', 'aria-label': 'Format' });
    ui.opts = h('div', { class: 'xf-opts', role: 'group', 'aria-label': 'Options' });
    ui.name = h('input', { type: 'text', class: 'xf-name-in', 'aria-label': 'File name', spellcheck: 'false', autocomplete: 'off' });
    ui.nameExt = h('span', { class: 'xf-name-ext' });
    ui.nameRow = h('div', { class: 'xf-name', 'data-xf': 'name-row' },
      h('label', { class: 'xf-field' }, h('span', { text: 'File name' }), h('span', { class: 'xf-name-box' }, ui.name, ui.nameExt)),
      h('p', { class: 'xf-note', 'data-xf': 'downloads-note', text: 'Your browser will download the file.' }));
    ui.go = h('button', { type: 'button', class: 'btn btn-primary xf-go', 'data-xf': 'save', text: 'Save as…' });
    ui.go.addEventListener('click', (ev) => { ev.stopPropagation(); doSave(); });
    ui.name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doSave(); } });
    ui.pop = h('div', { id: 'xfPop', class: 'sm-pop xf-pop', role: 'dialog', 'aria-label': 'Export', hidden: true },
      h('div', { class: 'sm-pop-h', id: 'xfFmtH', text: 'Format' }), ui.list,
      ui.optsWrap = h('div', { class: 'xf-opts-wrap' }, h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', id: 'xfOptH', text: 'Options' }), ui.opts),
      h('hr', { class: 'sm-sep' }), ui.nameRow,
      ui.big = h('p', { class: 'xf-note xf-note--warn xf-big', 'data-xf': 'big-note', role: 'note', hidden: true }),
      ui.dmgNote = h('p', { class: 'xf-note xf-note--warn xf-dmg', 'data-xf': 'damaged-note', role: 'note', hidden: true, text: DMG_NOTE }),
      h('div', { class: 'xf-foot' }, ui.go));

    // Safari never focuses a pressed button: ignore focus loss while a pointer is down in the popover
    ui.pop.addEventListener('pointerdown', () => { ptrInside = true; }, true);
    document.addEventListener('pointerup', () => { if (ptrInside) setTimeout(() => { ptrInside = false; }, 0); }, true);
    document.addEventListener('pointercancel', () => { ptrInside = false; }, true);
    ui.pop.addEventListener('focusout', () => setTimeout(() => {
      if (ptrInside || !open) return;
      const a = document.activeElement;
      if (!ui.pop.contains(a) && a !== lastTrigger && document.hasFocus()) close(false);
    }, 0));
    ui.pop.addEventListener('keydown', popKeys);
    ui.opts.addEventListener('change', () => estimateSoon());    // units / detail / B-Rep proxies, radios
    document.addEventListener('pointerdown', (ev) => {
      if (open && !ui.pop.contains(ev.target) && !(lastTrigger && lastTrigger.contains(ev.target))) close(false);
    }, true);
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && open) { ev.preventDefault(); ev.stopPropagation(); close(true); } }, true);
    window.addEventListener('resize', () => { if (open) position(); });

    // result card (persistent)
    ui.rTitle = h('div', { class: 'xf-r-title', id: 'xfResTitle' });
    ui.rBody = h('div', { class: 'xf-r-body' });
    ui.rFile = h('div', { class: 'xf-r-file' });
    ui.rBar = h('div', { class: 'xf-r-bar', role: 'progressbar', 'aria-label': 'Export progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span'));
    ui.rCancel = h('button', { type: 'button', class: 'btn btn-sm xf-r-cancel', text: 'Cancel', onclick: () => { if (running && running.ctrl) { running.ctrl.abort(); ui.rCancel.disabled = true; ui.rCancel.textContent = 'Cancelling…'; } } });
    ui.rClose = h('button', { type: 'button', class: 'btn btn-sm xf-r-close', 'aria-label': 'Dismiss export message', text: '×', onclick: () => dismiss(true) });
    ui.result = h('section', { class: 'xf-result', 'data-xf': 'result', role: 'region', 'aria-labelledby': 'xfResTitle', tabindex: '-1', hidden: true },
      h('span', { class: 'xf-r-ico', 'aria-hidden': 'true' }),
      h('div', { class: 'xf-r-main' }, ui.rTitle, ui.rBody, ui.rFile, ui.rBar),
      h('div', { class: 'xf-r-act' }, ui.rCancel, ui.rClose));
    ui.result.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !running) { ev.preventDefault(); dismiss(true); } });
    ui.live = h('div', { class: 'xf-sr', 'aria-live': 'polite', role: 'status' });
    document.body.append(ui.pop, ui.result, ui.live);
    place();
  }

  // place the button in the Simple top bar, next to (and instead of) the split button. Advanced is left alone.
  function place() {
    const split = document.querySelector('.sm-topbar .sm-split');
    if (split && !ui.btnSimple.isConnected) split.after(ui.btnSimple);
    document.body.classList.add('xf-on');
  }
  const trigger = () => ui.btnSimple;
  const simpleMode = () => document.body.classList.contains('sm-simple');

  // ------------------------------------------------------------------ popover
  function openPop(btn) {
    if (!simpleMode()) return;
    lastTrigger = btn || trigger();
    if (!available(FMT[prefs.format] || {})) prefs.format = (FORMATS.find(available) || {}).id;
    renderList(); renderOpts(); syncDamagedNote();
    if (!ui.result.hidden) { ui.result.hidden = true; stashed = true; }
    ui.pop.hidden = false;
    open = true;
    ui.btnSimple.setAttribute('aria-expanded', 'true');
    position();
    const cur = ui.list.querySelector('[aria-checked="true"]') || ui.list.querySelector('.xf-fmt');
    if (cur) cur.focus({ preventScroll: true });
  }
  function close(returnFocus) {
    if (!open) return;
    open = false;
    ui.pop.hidden = true;
    ui.btnSimple.setAttribute('aria-expanded', 'false');
    if (stashed) { stashed = false; ui.result.hidden = false; }   // closed without a new export: the last card comes back
    if (returnFocus && lastTrigger && simpleMode()) lastTrigger.focus({ preventScroll: true });
  }
  function position() {
    const t = lastTrigger, pop = ui.pop;
    pop.style.maxHeight = ''; pop.style.left = '0px'; pop.style.top = '0px';
    const r = t.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
    let left = r.right - pw;
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > vh - 8) pop.style.maxHeight = Math.max(200, vh - top - 8) + 'px';
    pop.style.left = Math.round(left) + 'px'; pop.style.top = Math.round(top) + 'px';
  }
  function tabbables() {
    return [...ui.pop.querySelectorAll('button, select, input, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && !el.closest('[hidden]') && el.offsetParent !== null && el.tabIndex >= 0 && !(el.type === 'radio' && !el.checked));
  }
  function popKeys(ev) {
    const t = ev.target, k = ev.key;
    if (k === 'Tab') {
      const f = tabbables(); if (!f.length) return;
      if (ev.shiftKey && t === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
      else if (!ev.shiftKey && t === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
      return;
    }
    if (t.classList && t.classList.contains('xf-fmt')) {
      const items = [...ui.list.querySelectorAll('.xf-fmt')];
      const i = items.indexOf(t);
      let n = null;
      if (k === 'ArrowDown' || k === 'ArrowRight') n = items[(i + 1) % items.length];
      else if (k === 'ArrowUp' || k === 'ArrowLeft') n = items[(i - 1 + items.length) % items.length];
      else if (k === 'Home') n = items[0];
      else if (k === 'End') n = items[items.length - 1];
      if (n) { ev.preventDefault(); n.focus(); select(n.dataset.xfFormat, true); }
      else if (k === 'Enter') { ev.preventDefault(); const f = tabbables(); const nx = f[f.indexOf(ui.list.querySelector('[aria-checked="true"]')) + 1]; if (nx) nx.focus(); }
    }
  }

  function renderList() {
    ui.list.textContent = '';
    for (const f of FORMATS) {
      if (!available(f)) continue;
      const on = f.id === prefs.format;
      const b = h('button', { type: 'button', class: 'xf-fmt', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'data-xf-format': f.id },
        h('span', { class: 'xf-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'xf-fmt-t' }, h('span', { class: 'xf-fmt-l', text: f.label }), h('span', { class: 'xf-fmt-s', text: f.sub })),
        h('span', { class: 'sm-mi-ext', text: extOf(f) }));
      b.addEventListener('click', (ev) => { ev.stopPropagation(); select(f.id, true); });
      ui.list.append(b);
    }
  }
  function select(id, keepFocus) {
    if (!FMT[id] || !available(FMT[id])) return;
    prefs.format = id; save();
    for (const b of ui.list.querySelectorAll('.xf-fmt')) {
      const on = b.dataset.xfFormat === id;
      b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1;
      if (on && keepFocus && document.activeElement !== b && ui.pop.contains(document.activeElement)) b.focus({ preventScroll: true });
    }
    renderOpts();
    if (open) position();
  }

  function renderOpts() {
    const f = FMT[prefs.format];
    ui.opts.textContent = '';
    ui.pop.dataset.format = f ? f.id : '';
    if (!f) { ui.optsWrap.hidden = true; return; }
    const add = (...n) => ui.opts.append(...n.filter(Boolean));
    if (f.id === 'step') {
      const cad = hasCad() || hasHook();
      const p = prefs.step;
      if (!cad) p.body = 'mesh';
      const off = cad && cadOff();                         // fitting unavailable: Mesh for now, prefs.step.body untouched
      const body = off ? 'mesh' : p.body;
      if (cad) {
        const pick = (v) => { p.body = v; save(); rerender('input[name="xfBody"][value="' + v + '"]'); };
        const dis = off ? { describedBy: 'xfCadReason' } : null;
        add(h('div', { class: 'xf-field xf-seg', role: 'radiogroup', 'aria-label': 'Body' }, h('span', { text: 'Body' }),
          h('div', { class: 'xf-seg-row' },
            radio('xfBody', 'fitted', 'Fitted solid', null, body === 'fitted', pick, dis),
            radio('xfBody', 'mesh', 'Mesh', null, body === 'mesh', off ? () => {} : pick),
            radio('xfBody', 'both', 'Both', null, body === 'both', pick, dis)),
          h('small', { class: 'xf-hint', 'data-xf': 'body-hint', text: BODY_HINT[body] }),
          off ? reasonRow() : null));
        if (body === 'fitted') {
          add(h('div', { class: 'xf-field xf-seg xf-seg--wrap', role: 'radiogroup', 'aria-label': 'If a face can\u2019t be fitted', 'data-xf': 'on-no-fit' },
            h('span', { text: 'If a face can\u2019t be fitted' }),
            h('div', { class: 'xf-seg-row' },
              radio('xfNoFit', 'mesh', 'Save mesh STEP instead', null, p.onNoFit !== 'omit', (v) => { p.onNoFit = v; save(); }),
              radio('xfNoFit', 'omit', 'Leave unfitted parts out', null, p.onNoFit === 'omit', (v) => { p.onNoFit = v; save(); }))));
        }
      }
      if (body !== 'fitted') add(proxySelect('brepModeSelect', 'Mesh B-Rep'));
      // Fitted / Both STEP is always written in mm (STEP records its unit, NX imports at true size): no Units choice,
      // the saved #unitSelect value is left alone. capabilities.fittedUnits === true (writer honours units) shows it again.
      if (body === 'mesh' || caps().fittedUnits === true) add(proxySelect('unitSelect', 'Units'));
      if (body !== 'fitted') add(proxySelect('detailSelect', 'Reduce detail'));
      const pre = cad && body !== 'mesh' ? preflight() : null;
      if (pre && pre.estimate && pre.estimate.kernelCached === false) add(h('p', { class: 'xf-note', text: 'First fitted export downloads the CAD kernel (' + mb(pre.estimate.kernelBytes || 13719175) + ' MB).' }));
      if (pre && pre.ok === false && pre.message) add(h('p', { class: 'xf-note xf-note--warn', text: pre.message }));
    } else if (f.id === 'stl') {
      add(h('div', { class: 'xf-field xf-seg', role: 'radiogroup', 'aria-label': 'Encoding' }, h('span', { text: 'Encoding' }),
        h('div', { class: 'xf-seg-row' },
          radio('xfEnc', 'binary', 'Binary', null, prefs.stl.enc !== 'ascii', (v) => { prefs.stl.enc = v; save(); syncName(); }),
          radio('xfEnc', 'ascii', 'ASCII', null, prefs.stl.enc === 'ascii', (v) => { prefs.stl.enc = v; save(); syncName(); }))));
      add(proxySelect('unitSelect', 'Units'), proxySelect('detailSelect', 'Reduce detail'));
    } else if (f.id === 'obj') {
      add(proxySelect('unitSelect', 'Units'), proxySelect('detailSelect', 'Reduce detail'));
    } else if (f.id === 'iges') {
      add(proxySelect('unitSelect', 'Units'));
    } else if (f.id === 'xt') {
      add(h('p', { class: 'xf-note', 'data-xf': 'xt-note', text: XT_NOTE }));   // 1.5.2: merged mode only, no body/mode choice
    } else if (f.id === 'raw') {
      add(h('p', { class: 'xf-note', text: 'The stream exactly as embedded in the PDF. No options.' }));
    }
    ui.optsWrap.hidden = !ui.opts.childNodes.length;
    syncName();
  }
  // re-render the options and keep focus on the control that caused it (the old node is gone, so the popover would close)
  function rerender(focusSel) {
    const had = ui.pop.contains(document.activeElement) || document.activeElement === document.body;
    renderOpts();
    if (open) position();
    const el = had && ui.opts.querySelector(focusSel);
    if (el) el.focus({ preventScroll: true });
  }
  // unavailable reason line; for kernel_download a quiet "Try again" text button sits next to it. It calls Dev's
  // PDF3D.retryCadKernel() when present (should clear the failed state and re-probe), then re-reads capabilities and
  // re-renders: Fitted / Both come back without a reload once cadSurfaces is no longer false.
  let retrying = false;
  function reasonRow() {
    const line = h('small', { class: 'xf-hint xf-hint--off', id: 'xfCadReason', 'data-xf': 'cad-reason', text: cadReason() });
    if (caps().cadSurfacesReason !== 'kernel_download') return line;
    const btn = h('button', { type: 'button', class: 'xf-retry', 'data-xf': 'cad-retry', text: retrying ? 'Trying again\u2026' : 'Try again',
      'aria-describedby': 'xfCadReason', onclick: () => retryKernel() });
    if (retrying) btn.setAttribute('aria-disabled', 'true');
    return h('div', { class: 'xf-reason-row' }, line, btn);
  }
  async function retryKernel() {
    if (retrying) return;
    retrying = true;
    const b = ui.opts.querySelector('[data-xf="cad-retry"]');
    if (b) { b.textContent = 'Trying again\u2026'; b.setAttribute('aria-disabled', 'true'); }
    const t0 = Date.now();
    const fn = NS().retryCadKernel;
    try { if (typeof fn === 'function') await fn.call(NS()); } catch (e) { /* engine text never shown; caps decide */ }
    const wait = 400 - (Date.now() - t0);                              // let "Trying again…" be seen
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    retrying = false;
    if (!open || prefs.format !== 'step') return;
    const back = !cadOff();
    rerender(back ? 'input[name="xfBody"]:checked' : '[data-xf="cad-retry"]');
    say(back ? 'Fitting is available again.' : 'The CAD kernel still couldn\u2019t download.');
  }
  const BODY_HINT = {
    fitted: 'Real CAD surfaces (planes, cylinders, B-splines).',
    mesh: 'Triangles as a B-Rep. Fast, always works.',
    both: 'Fitted solid plus the mesh body in one file.'
  };
  function preflight() { try { const fn = NS().canExportCadSurfaces; if (typeof fn !== 'function') return null; const r = fn(sel()); return r && typeof r === 'object' && !r.then ? r : null; } catch (e) { return null; } }
  const mb = (b) => (b / 1e6).toFixed(1).replace(/\.0$/, '');
  function sel() { const s = appState(); const i = s && s.selectedPartIdx; return typeof i === 'number' && i >= 0 && s.parts && i < s.parts.length ? [i] : null; }

  // 1.6.2 (9ba8d26): PDF3D.suggestedFileName(format, opts) is the engine's own default name (with _partial while the load is
  // damaged), so the dialog offers what exportFormat will call the file. Older engines: the same rule locally.
  function fileName() {
    const f = FMT[prefs.format];
    const dev = NS().suggestedFileName;
    if (typeof dev === 'function') {
      try { const n = dev.call(NS(), f.id, { encoding: prefs.stl.enc }); if (nonEmpty(n)) return n.trim(); } catch (e) { /* fall back */ }
    }
    const suffix = f.id === 'stl' && prefs.stl.enc === 'ascii' ? '-ascii' : '';
    return stem() + suffix + (loadDamaged() ? '_partial' : '') + extOf(f);   // part-ascii_partial.stl, like the engine
  }
  // ------------------------------------------------------------------ partial (damaged) loads
  // lastLoad.damaged (1.6.2, 'ok' loads only) = some of the model couldn't be read. Exports from such a load get a _partial
  // file name, a note in the popover and an amber card. Export results may carry it too (damaged / summary.damaged).
  const DMG_NOTE = 'Only part of this model loaded. The file may be missing parts.';
  const DMG_LINE = 'This model was only partly read. Check it against the drawing before using it.';
  const nonEmpty = (v) => typeof v === 'string' && !!v.trim();
  // 1.6.2 (9ba8d26): PDF3D.partialNote() (note text while damaged, else null) is the trigger; older engines: lastLoad.damaged
  function loadDamaged() {
    const pn = NS().partialNote;
    if (typeof pn === 'function') { try { return nonEmpty(pn.call(NS())); } catch (e) { /* fall back */ } }
    const ll = NS().lastLoad; return !!(ll && ll.status === 'ok' && nonEmpty(ll.damaged));
  }
  function resDamaged(res) { return !!(res && (nonEmpty(res.damaged) || (res.summary && nonEmpty(res.summary.damaged)))) || loadDamaged(); }
  function syncDamagedNote() {
    const on = loadDamaged();
    if (ui.dmgNote.hidden === !on) return;
    ui.dmgNote.hidden = !on;
    if (open) position();
  }
  function syncName() {
    const f = FMT[prefs.format]; if (!f) return;
    const fb = !pickerOK();
    ui.nameRow.hidden = !fb;
    ui.go.textContent = fb ? 'Save' : 'Save as…';
    const full = fileName(), ext = extOf(f);
    if (!ui.name.dataset.touched || ui.name.dataset.fmt !== f.id) { ui.name.value = full.slice(0, -ext.length); ui.name.dataset.fmt = f.id; delete ui.name.dataset.touched; }
    ui.nameExt.textContent = ext;
    syncDamagedNote();
    estimateSoon();
  }

  // ------------------------------------------------------------------ big-download warning (download path only)
  const BIG = 300e6;
  const EST_FMTS = /^(step|stl|obj|xt)$/;
  let estTimer = 0, estSeq = 0;
  function estimateSoon() {
    clearTimeout(estTimer);
    const seq = ++estSeq;
    const f = FMT[prefs.format];
    if (!f || pickerOK() || !EST_FMTS.test(f.id) || typeof NS().estimateBytes !== 'function') { setBig(0); return; }
    estTimer = setTimeout(async () => {
      let n = 0;
      try { const v = await NS().estimateBytes(f.id, optsFor(f)); n = +(v && typeof v === 'object' ? v.estimatedBytes : v); } catch (e) { n = 0; }
      if (seq !== estSeq) return;                                           // options changed meanwhile
      setBig(open && FMT[prefs.format] === f && !pickerOK() && isFinite(n) && n > BIG ? n : 0);
    }, 250);
  }
  function setBig(n) {
    const show = n > 0;
    if (show) ui.big.textContent = 'This file will be about ' + fmtGB(n) + '. Your browser may not save downloads this large. Chrome or Edge can save it straight to a folder.';
    if (ui.big.hidden === !show && (!show || ui.big.dataset.bytes === String(n))) return;
    ui.big.hidden = !show; ui.big.dataset.bytes = show ? String(n) : '';
    if (open) position();
  }
  // bytes handed to the browser: result.size (hook override), else blob.size, else summary.estimatedBytes
  function bytesOf(res, blob) {
    const s = (res && res.summary) || {};
    for (const v of [res && res.size, blob && blob.size, s.estimatedBytes, res && res.estimatedBytes]) if (isFinite(+v) && +v > 0) return +v;
    return 0;
  }

  // ------------------------------------------------------------------ save
  async function doSave() {
    if (running) { close(true); showCard(); return; }
    const f = FMT[prefs.format];
    if (!f || !available(f)) return;
    const opts = optsFor(f);
    let name = fileName(), handle = null;
    if (pickerOK()) {
      // Must be the first await in the click gesture (Chrome throws SecurityError after long async work).
      try {
        // Chrome rejects accept extensions with characters other than letters / digits / + / . ('.x_t' → TypeError, which
        // silently turned every Parasolid save into a download), so those go without a type filter
        const po = { suggestedName: name };
        if (/^\.[a-z0-9+.]{1,16}$/i.test(extOf(f))) po.types = [{ description: f.label + ' file', accept: { [f.mime]: [extOf(f)] } }];
        handle = await window.showSaveFilePicker(po);
      } catch (e) {
        if (e && e.name === 'AbortError') return;                 // user cancelled: quiet no-op, popover stays open
        handle = null;                                           // SecurityError etc.: fall back to a download
      }
      if (handle && handle.name) name = handle.name;
    } else {
      const base = (ui.name.value || '').trim().replace(/[\\/:*?"<>|]+/g, '-') || stem();
      name = base.toLowerCase().endsWith(extOf(f).toLowerCase()) ? base : base + extOf(f);
    }
    stashed = false;                                             // a new export replaces the hidden card
    close(true);
    const t = lastTrigger || trigger();
    const run = running = { ctrl: new AbortController(), format: f.id, t0: performance.now(), writable: null };
    progress(f, opts);
    document.dispatchEvent(new CustomEvent('pdf3d:export', { detail: { phase: 'start', format: f.id } }));
    // Save-as: open the writable BEFORE the export (one retry if the first createWritable() fails), so Dev's hook gets it as
    // opts.writable and streams parts into it (one huge Blob can't be read in Chrome, RECHECK-5e700b8 F1). The writer never
    // closes it; this flow owns close() / abort(). Both attempts fail → the export goes out as a browser download instead:
    // the empty file the picker created is removed first and the card says "Downloaded as {name}".
    let cleanup = '', dl = !handle;
    if (handle) {
      run.writable = await openWritable(handle);
      if (!run.writable) { cleanup = await discard(handle, run); handle = null; dl = true; }
    }
    let res, err = null;
    try { res = await runExport(f, opts, run); } catch (e) { err = e; }
    let out;
    try {
      if (handle && (err || writeFailed(res))) throw new SaveError(err);
      out = describe(f, opts, res, err);
      if (out.blob) {
        // the file goes where the flow actually put it: into the picked file (card "Saved as"), or, when there is no
        // picker or neither createWritable() attempt worked, as a browser download ("Downloaded as"). result.delivery is not
        // used for the wording: a 'download' result with a picker just means the writer handed back a blob, which we write.
        const w = handle ? run.writable : null;
        if (w) {
          if (out.blob !== STREAMED) await w.write(out.blob);    // writer returned a blob (old hook / fallback): we write it
          await w.close();                                       // green only once close() has resolved
          run.writable = null;
        } else if (out.blob === STREAMED) throw new SaveError(null);
        else download(out.blob, name);
        out.saved = name;
        if (dl) out.fileVerb = 'Downloaded as';
        // downloads can't be confirmed; Chrome silently cancels very large blob downloads (0-byte file). Any card that
        // was a download: green becomes the amber check card; an amber card keeps its title and lines and gets the
        // check as its first line. Never on picker saves.
        const bytes = dl ? bytesOf(res, out.blob) : 0;
        if (bytes > BIG) {
          const chk = 'Your browser was given a ' + fmtGB(bytes) + ' file but can\u2019t confirm it saved. If the file is missing or 0 bytes, try Chrome or Edge, or hide some parts.';
          out = out.tone === 'ok'
            ? Object.assign({}, out, { tone: 'warn', status: 'check_download', title: 'Check that the download finished', lines: [chk, f.id === 'xt' ? XT_UNITS : null] })
            : Object.assign({}, out, { lines: ['Check that the download finished. ' + chk].concat(out.lines || []) });
          out.check = 'download';
        }
      } else if (handle) {
        cleanup = await discard(handle, run);                    // no file (0 faces, too large, cancelled, engine error)
      }
    } catch (e) {
      if (handle) cleanup = await discard(handle, run);
      out = writeFailedCard(name, f, opts, res, e);
    }
    running = null;
    // partial load: a saved file is never green; the first line says to check it (other lines kept)
    if (out.saved && resDamaged(res)) out = Object.assign({}, out, { tone: out.tone === 'err' ? 'err' : 'warn', lines: [DMG_LINE].concat(out.lines || []), damaged: true });
    out.format = f.id;
    finish(out, t);
    ui.result.dataset.kind = 'export';
    ui.result.dataset.delivery = '';
    ui.result.dataset.damaged = out.damaged ? '1' : '';
    ui.result.dataset.cleanup = cleanup;                         // 'removed' | 'truncated' | 'failed' | '' (nothing to clean)
    ui.result.dataset.check = out.check || '';                   // 'download': big download, check card or check line
    ui.result.dataset.limit = out.limit ? '1' : '';                  // whole-model fitting limit card (no part rows)
  }
  // marker blob: the writer streamed the file into opts.writable itself (result { blob: null, delivery: 'picker' })
  const STREAMED = { streamed: true, size: 0 };
  function SaveError(cause) { this.name = 'SaveError'; this.cause = cause; }
  const writeFailed = (r) => !!r && (normCode(r.reasonCode) === 'write_failed' || (r.status === 'error' && r.delivery === 'picker'));
  // Save-as failure (writer WRITE_FAILED / throw while streaming, write() or close() rejected): amber, own words only
  // (no DOMException text, no writer reason). Free space is blamed only when the failure is clearly about quota / disk space
  // (QuotaExceededError, or a quota flag / reasonCode / reason from the writer); any other failure (Blob too big to read,
  // NotReadableError, …) gets the neutral line. Engine errors that aren't about writing keep their own cards.
  const WF_QUOTA = 'Nothing was kept. Check there\u2019s enough free space, then try again.';
  const WF_OTHER = 'Nothing was kept. Try again, or export as a smaller format.';
  function writeFailedCard(name, f, o, res, e) {
    const cause = e instanceof SaveError ? e.cause : e;
    if (e instanceof SaveError && cause && !isBrowserErr(cause) && !writeFailed(res)) return Object.assign(describe(f, o, res, cause), { blob: null });
    const quota = isQuota(cause) || (writeFailed(res) && quotaResult(res));
    return { tone: 'warn', status: 'write_failed', title: 'Couldn\u2019t finish saving ' + name, lines: [quota ? WF_QUOTA : WF_OTHER], quota };
  }
  const QUOTA_CODE = /quota|disk_?full|no_?space|out_?of_?space|storage_?full|insufficient_?space/;
  const QUOTA_TEXT = /\bquota|QuotaExceeded|not enough (free |disk |storage )?space|(disk|drive|storage) (is )?full|no space left|out of (disk |storage )?space|insufficient (disk |storage )?space/i;
  const isQuota = (e) => !!e && typeof e === 'object' && (e.name === 'QuotaExceededError' || (typeof DOMException !== 'undefined' && e instanceof DOMException && e.code === 22));
  // writer result about quota: quota/quotaExceeded flag, errorName 'QuotaExceededError' (top level, summary or error/cause
  // object), a quota-like reasonCode / errorCode, or a reason that clearly says so
  function quotaResult(r) {
    if (!r) return false;
    const s = r.summary || {};
    for (const x of [r, s]) {
      if (x.quota === true || x.quotaExceeded === true) return true;
      if (/^QuotaExceededError$/i.test(String(x.errorName || x.errorType || ''))) return true;
      if (isQuota(x.error) || isQuota(x.cause)) return true;
      for (const c of [x.reasonCode, x.errorCode]) if (c != null && c !== '' && QUOTA_CODE.test(String(normCode(c)))) return true;
    }
    return typeof r.reason === 'string' && QUOTA_TEXT.test(r.reason);
  }
  // createWritable() on the picked handle, once more if the first attempt rejects; null when both fail
  async function openWritable(handle) {
    if (typeof handle.createWritable !== 'function') return null;
    for (let i = 0; i < 2; i++) { try { return await handle.createWritable(); } catch (e) { /* retry once */ } }
    return null;
  }
  const isBrowserErr = (e) => !!e && ((typeof DOMException !== 'undefined' && e instanceof DOMException) || /^(NotReadableError|QuotaExceededError|InvalidStateError|NotAllowedError|NoModificationAllowedError|NotFoundError|TypeMismatchError|SecurityError|AbortError)$/.test(e.name || ''));
  // drop whatever the Save-as picker left behind: abort the open writable (errors ignored), then delete the file with
  // handle.remove() (Chrome 110+); where remove() is missing, truncate it to 0 bytes (fresh createWritable() + close()).
  async function discard(handle, run) {
    const w = run.writable; run.writable = null;
    if (w) { try { await w.abort(); } catch (e) { /* ignore */ } }
    if (typeof handle.remove === 'function') { try { await handle.remove(); return 'removed'; } catch (e) { /* fall through */ } }
    try { const t = await handle.createWritable({ keepExistingData: false }); await t.close(); return 'truncated'; } catch (e) { return 'failed'; }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name, hidden: true, 'data-xf-own': '1' });
    document.body.append(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 30000);
  }
  function optsFor(f) {
    const o = { units: ($('unitSelect') || {}).value, detail: ($('detailSelect') || {}).value, brepMode: ($('brepModeSelect') || {}).value, partIds: sel() };
    if (f.id === 'step') {
      const body = (hasCad() || hasHook()) && !cadOff() ? prefs.step.body : 'mesh';
      Object.assign(o, { body, onNoFit: prefs.step.onNoFit === 'omit' ? 'omit' : 'mesh', fittedOnly: body === 'fitted' });
    }
    if (f.id === 'stl') o.encoding = prefs.stl.enc;
    if (f.id === 'xt') o.brepMode = 'merged';   // 1.5.2 Parasolid writer: one merged faceted body only, no choice shown
    return o;
  }

  // engine: Dev's hook if present, else CAD API for fitted STEP, else the original button (blob captured)
  async function runExport(f, o, run) {
    const onProgress = (p) => setPct(p);
    const cadStep = f.id === 'step' && o.body !== 'mesh';
    let r;
    try {
      if (hasHook()) r = streamed(await NS().exportFormat(f.id, Object.assign({}, o, { signal: run.ctrl.signal, onProgress }, run.writable ? { writable: run.writable } : {})), run);
      else if (cadStep) r = await NS().exportCadSurfaces(o.partIds, { fittedOnly: o.body === 'fitted', onProgress, signal: run.ctrl.signal });
    } catch (e) { if (e && e.name === 'AbortError') return { status: 'cancelled' }; throw e; }
    if (hasHook() && !cadStep) return r || {};
    if (cadStep) {
      r = Object.assign({}, r || {});
      if (r.status === 'cancelled' || o.body !== 'fitted' || o.onNoFit !== 'mesh') return r;
      const parts = partsOf(r);
      const noFile = !r.blob;
      // nothing fitted (or the engine could not run) → the whole mesh STEP, so the user always gets a file
      if (noFile && !/^(too_large|no_parts|unavailable)$/.test(normCode(r.reasonCode) || '')) {
        const m = hasHook() ? streamed(await NS().exportFormat('step', Object.assign({}, o, { body: 'mesh', fittedOnly: false, signal: run.ctrl.signal }, run.writable ? { writable: run.writable } : {})), run) : await capture('btnExportSTEP');
        if (!m || !m.blob) return r;
        if (parts) for (const p of parts) if (p.written !== 'solid') p.written = 'mesh';
        return Object.assign(r, { status: 'mesh_only', blob: m.blob, meshStep: true, summary: Object.assign({}, r.summary, parts ? { parts } : {}) });
      }
      // some parts fitted, some left out by the engine → add their mesh bodies to the same file (fallback path only)
      const left = parts ? parts.filter((p) => p.written === 'omitted') : [];
      if (!hasHook() && r.blob && left.length) {
        const merged = await addMeshBodies(r.blob, left);
        if (merged) { for (const p of left) p.written = 'mesh'; r.blob = merged; r.summary = Object.assign({}, r.summary, { parts }); }
      }
      return r;
    }
    const id = f.id === 'stl' && o.encoding === 'ascii' ? 'btnExportSTLText' : f.btn;
    const c = await capture(id);
    return { status: 'ok', blob: c.blob, filename: c.filename };
  }
  // { blob: null, delivery: 'picker' } from a writer that got opts.writable = the file was streamed into it
  function streamed(r, run) {
    if (!r || r.blob || !run.writable || r.delivery !== 'picker' || r.status === 'error' || r.status === 'cancelled' || writeFailed(r)) return r;
    return Object.assign({}, r, { blob: STREAMED });
  }
  // summary.parts, normalised (copies). shell / mesh_only count as not fitted.
  function partsOf(r) {
    const ps = r && r.summary && Array.isArray(r.summary.parts) ? r.summary.parts : null;
    if (!ps || !ps.length) return null;
    return ps.map((p, i) => {
      const q = Object.assign({}, p);
      if (!q.name) q.name = 'Part ' + (i + 1);
      if (!/^(solid|mesh|omitted)$/.test(q.written)) q.written = q.status === 'solid' ? 'solid' : 'omitted';
      return q;
    });
  }
  // mesh bodies of the given parts (named <part>_mesh), merged into the fitted STEP file. null if not possible.
  async function addMeshBodies(blob, list) {
    const app = window.CAD3DExtractor, merge = window.PDF3DStepMerge, s = appState();
    if (!app || typeof app.buildSTEPAP214 !== 'function' || !merge || !s || !s.parts) return null;
    const pick = list.map((p) => (typeof p.index === 'number' ? s.parts[p.index] : s.parts.find((q) => q && q.name === p.name))).filter(Boolean);
    if (pick.length !== list.length) return null;
    try {
      const mesh = app.buildSTEPAP214({ parts: pick.map((q) => Object.assign(Object.create(Object.getPrototypeOf(q)), q, { name: q.name + '_mesh' })) });
      const fitted = await blob.text();
      if (Array.isArray(mesh) && merge.mergeSTEPChunks) return new Blob(merge.mergeSTEPChunks([fitted, mesh]), { type: 'application/step' });
      const meshText = typeof mesh === 'string' ? mesh : await new Blob([].concat(mesh)).text();
      return new Blob([merge.mergeSTEP([fitted, meshText])], { type: 'application/step' });
    } catch (e) { return null; }
  }
  // Click the original export button and capture the Blob it hands to <a download>, instead of letting it download.
  function capture(id) {
    return new Promise((resolve, reject) => {
      const btn = $(id);
      if (!btn) { reject(new Error('This export isn\u2019t available in this build.')); return; }
      let got = null, thrown = null;
      const proto = HTMLAnchorElement.prototype, orig = proto.click;
      const onErr = (ev) => { thrown = ev.error || new Error(ev.message); ev.preventDefault(); };
      proto.click = function () {
        if (!got && this.hasAttribute('download') && /^blob:/.test(this.href) && !this.dataset.xfOwn) { got = { href: this.href, filename: this.getAttribute('download') }; return; }
        return orig.call(this);
      };
      window.addEventListener('error', onErr);
      try { btn.disabled = false; btn.click(); } finally { proto.click = orig; window.removeEventListener('error', onErr); }
      if (!got) { reject(thrown || new Error('The app produced no file. Is a model with parts loaded?')); return; }
      fetch(got.href).then((r) => r.blob()).then((blob) => resolve({ blob, filename: got.filename }), reject);
    });
  }

  // ------------------------------------------------------------------ result card
  function showCard() { if (open) stashed = true; else ui.result.hidden = false; }
  const PARTS_SHOWN = 5;
  function setCard(tone, title, lines, file, parts) {
    ui.result.dataset.tone = tone;
    ui.rTitle.textContent = title;
    ui.rBody.textContent = '';
    for (const l of lines || []) if (l) ui.rBody.append(h('p', { text: l }));
    if (parts && parts.length) {
      const ul = h('ul', { class: 'xf-parts', 'data-xf': 'parts', id: 'xfParts', 'aria-label': 'Parts' });
      parts.forEach((p, i) => ul.append(h('li', { class: 'xf-part', 'data-written': p.kind, 'data-open': p.open ? '1' : null, hidden: i >= PARTS_SHOWN },
        h('span', { class: 'xf-part-n', text: p.name }), h('span', { class: 'xf-part-w', text: p.what }),
        p.why || p.body ? h('span', { class: 'xf-part-r', text: [bodyLabel(p), cap(p.why)].filter(Boolean).join(' \u00b7 ') }) : null)));
      ui.rBody.append(ul);
      if (parts.length > PARTS_SHOWN) {
        const more = h('button', { type: 'button', class: 'xf-more', 'data-xf': 'show-all', 'aria-expanded': 'false', 'aria-controls': 'xfParts', text: 'Show all ' + parts.length + ' parts' });
        more.addEventListener('click', () => {
          const all = more.getAttribute('aria-expanded') !== 'true';
          ul.querySelectorAll('.xf-part').forEach((li, i) => { li.hidden = !all && i >= PARTS_SHOWN; });
          more.setAttribute('aria-expanded', String(all));
          more.textContent = all ? 'Show fewer' : 'Show all ' + parts.length + ' parts';
        });
        ui.rBody.append(more);
      }
    }
    ui.rBody.hidden = !ui.rBody.childNodes.length;
    ui.rFile.textContent = file || ''; ui.rFile.hidden = !file;
    showCard();
  }
  function progress(f, o) {
    ui.result.dataset.state = 'running';
    ui.rBar.hidden = false; ui.rBar.removeAttribute('aria-valuenow'); ui.rBar.firstChild.style.width = '';
    ui.rCancel.hidden = !(f.id === 'step' && o.body !== 'mesh'); ui.rCancel.disabled = false; ui.rCancel.textContent = 'Cancel';
    ui.rClose.hidden = true;
    setCard('busy', 'Exporting ' + f.label + '…', [f.id === 'step' && o.body !== 'mesh' ? 'Fitting CAD surfaces. You can keep using the viewer.' : null]);
    say('Exporting ' + f.label);
  }
  function setPct(p) {
    let pct = p && typeof p === 'object' ? (p.pct != null ? p.pct : p.percent) : null;
    if (pct != null && pct <= 1 && p.pct == null) pct *= 100;
    if (pct != null && isFinite(pct)) { ui.rBar.setAttribute('aria-valuenow', String(Math.round(pct))); ui.rBar.firstChild.style.width = Math.max(2, Math.min(100, pct)) + '%'; }
    if (p && p.label) { const b = ui.rBody.querySelector('p') || ui.rBody.appendChild(h('p')); b.textContent = p.label; ui.rBody.hidden = false; }
  }
  function finish(out, t, evt) {
    ui.result.dataset.state = 'done';
    ui.result.dataset.status = out.status;
    ui.rBar.hidden = true; ui.rCancel.hidden = true; ui.rClose.hidden = false;
    const file = out.saved ? (out.fileVerb || 'Saved as') + ' ' + out.saved : '';
    const lines = (out.lines || []).filter(Boolean).map(sentence);
    setCard(out.tone, out.title, lines, file, out.parts);
    const pl = (out.parts || []).map((p) => p.name + ': ' + p.what + (p.body ? (Array.isArray(p.body) ? ', bodies ' + p.body.join(' and ') : ' as ' + p.body) : '') + (p.why ? ', ' + p.why : '')).join('. ');
    say([sentence(out.title)].concat(lines, pl ? [sentence(pl)] : [], file ? [sentence(file)] : []).join(' ').replace(/\s{2,}/g, ' '));
    if (!document.activeElement || document.activeElement === document.body) (t || ui.result).focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent(evt || 'pdf3d:export', { detail: { phase: 'done', format: out.format, status: out.status } }));
  }

  // ------------------------------------------------------------------ embedded files (Simple's attachment card)
  // PDF3DExportFlow.saveAttachment(index, { button, label }) saves lastLoad.attachmentDetails[index] with the export
  // machinery: Save-as picker first (suggestedName = fileName), createWritable() with one retry BEFORE calling
  // PDF3D.saveAttachment(index, { writable, signal, onProgress }) (Dev streams into it and never closes it; this flow closes,
  // green only after close() resolves, or aborts + removes the file on error). No picker (or both createWritable() attempts
  // failed): called without a writable, its blob is downloaded. Picker cancel = no-op. Progress goes on the button
  // ("Saving… N%"); the result uses the export result card (announced). Raw error text is never shown.
  const ATT_UNREADABLE = 'The attached file couldn\u2019t be read from the PDF.';
  const ATT_OTHER = 'Nothing was kept. Try again.';
  let attRun = null;
  function attFailCard(name, res, e) {
    const unreadable = !!res && normCode(res.reasonCode) === 'attachment_unreadable';
    const quota = !unreadable && (isQuota(e) || (!!res && quotaResult(res)));
    return { tone: 'warn', status: 'attachment_failed', title: 'Couldn\u2019t save ' + name, lines: [unreadable ? ATT_UNREADABLE : quota ? WF_QUOTA : ATT_OTHER], quota };
  }
  async function saveAttachment(index, opts) {
    const o = opts || {};
    if (attRun || running) return { status: 'busy' };
    const ll = NS().lastLoad || {}, a = (Array.isArray(ll.attachmentDetails) ? ll.attachmentDetails : [])[index];
    const fn = NS().saveAttachment;
    if (!a || typeof fn !== 'function') return { status: 'unavailable' };
    const name0 = String(a.fileName || 'attachment-' + (index + 1) + '.bin');
    const btn = o.button || null, label = o.label || (btn ? btn.textContent : '');
    let handle = null, name = name0;
    if (pickerOK()) {
      // first await in the click gesture. Chrome only accepts accept-extensions of letters / digits / + / . (".x_t" throws a
      // TypeError), so such types are left out instead of losing the picker
      const ext = String(a.ext || (name0.match(/\.([^.]+)$/) || [])[1] || '').toLowerCase();
      const mime = typeof a.mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(a.mime) ? a.mime : 'application/octet-stream';
      const po = { suggestedName: name0 };
      if (/^[a-z0-9+]{1,16}$/.test(ext)) po.types = [{ description: ext.toUpperCase() + ' file', accept: { [mime]: ['.' + ext] } }];
      try { handle = await window.showSaveFilePicker(po); } catch (e) {
        if (e && e.name === 'AbortError') return { status: 'cancelled' };   // user cancelled: nothing happens
        handle = null;                                                   // SecurityError etc.: download instead
      }
      if (handle && handle.name) name = handle.name;
    }
    const run = attRun = { ctrl: new AbortController(), writable: null, index };
    const setBtn = (pct) => { if (btn) btn.textContent = pct == null ? label : 'Saving\u2026 ' + pct + '%'; };
    if (btn) { btn.setAttribute('aria-disabled', 'true'); btn.dataset.saving = '1'; }
    setBtn(0);
    let cleanup = '', dl = !handle;
    if (handle) {
      run.writable = await openWritable(handle);
      if (!run.writable) { cleanup = await discard(handle, run); handle = null; dl = true; }
    }
    const onProgress = (p) => { const v = p && typeof p === 'object' ? +p.pct : NaN; if (isFinite(v)) setBtn(Math.max(0, Math.min(100, Math.round(v)))); };
    let res = null, out = null;
    try {
      res = await fn.call(NS(), index, Object.assign({ signal: run.ctrl.signal, onProgress }, handle ? { writable: run.writable } : {}));
      if (!res || res.status === 'cancelled') { if (handle) cleanup = await discard(handle, run); }
      else if (res.status !== 'ok') { if (handle) cleanup = await discard(handle, run); out = attFailCard(name0, res, null); }
      else {
        const w = handle ? run.writable : null;
        let fileName;
        if (w) {
          if (res.blob) await w.write(res.blob);                         // engine handed back a blob anyway: we write it
          else if (res.delivery !== 'picker') throw new SaveError(null);
          await w.close(); run.writable = null;                          // green only once close() has resolved
          fileName = name;
        } else if (res.blob) { fileName = res.filename || name0; download(res.blob, fileName); }
        else throw new SaveError(null);
        out = { tone: 'ok', status: 'attachment_saved', title: (dl ? 'Downloaded as ' : 'Saved as ') + fileName, lines: [] };
      }
    } catch (e) {
      if (handle) cleanup = await discard(handle, run);
      out = attFailCard(name0, res, e instanceof SaveError ? e.cause : e);
    }
    attRun = null;
    if (btn) { btn.removeAttribute('aria-disabled'); delete btn.dataset.saving; }
    setBtn(null);
    if (!out) return { status: 'cancelled' };
    stashed = false; close(false);
    out.format = 'attachment';
    finish(out, btn && btn.isConnected ? btn : trigger(), 'pdf3d:attachment');
    Object.assign(ui.result.dataset, { kind: 'attachment', cleanup, check: '', limit: '', damaged: '', delivery: dl ? 'download' : 'picker' });
    return { status: out.status, quota: !!out.quota, cleanup, delivery: dl ? 'download' : 'picker' };
  }
  function dismiss(giveFocus) {
    if (running || ui.result.hidden) { if (!running) stashed = false; return; }
    const had = ui.result.contains(document.activeElement);
    ui.result.hidden = true;
    if ((giveFocus || had) && trigger()) trigger().focus({ preventScroll: true });
  }
  // every card line / announced piece ends in a full stop (engine reasons like "No visible part to export" don't)
  const sentence = (t) => { t = String(t).trim(); return /[.!?\u2026:]$/.test(t) ? t : t + '.'; };
  function say(t) { ui.live.textContent = ''; setTimeout(() => { ui.live.textContent = t; }, 40); }

  // plain-language outcome. Whole-file CAD wording comes from cad-export-ui.js when it is loaded.
  const REASONS = {
    no_fit: 'surfaces couldn\u2019t be fitted cleanly',
    open_shell: 'fitted faces don\u2019t close into a solid',
    fit_limit: 'too many triangles to fit in the browser',
    no_face_data: 'no face data to fit',
    kernel_download: 'the CAD kernel didn\u2019t download',
    browser_unsupported: 'this browser can\u2019t run surface fitting',
    offline: 'you\u2019re offline, so the CAD kernel couldn\u2019t load',
    worker_failed: 'the surface-fitting worker stopped',
    out_of_memory: 'the browser ran out of memory',
    too_large: 'the model is too large to fit in the browser'
  };
  const ENGINE = /^(kernel_download|offline|worker_failed|out_of_memory)$/;
  // reason codes are compared case-insensitively; 1.5.2 Parasolid writer's XT_TOO_LARGE (> 8 GB estimate) = too_large
  const CODE_ALIAS = { xt_too_large: 'too_large' };
  function normCode(c) { if (c == null || c === '') return c; const k = String(c).trim().toLowerCase(); return CODE_ALIAS[k] || k; }
  function codeOf(c) { c = normCode(c); return c && ENGINE.test(c) && navigator.onLine === false ? 'offline' : c; }
  function reasonText(code, reason, status) {
    const c = codeOf(code);
    if (c && REASONS[c] && (ENGINE.test(c) || !reason)) return REASONS[c];
    if (reason) return String(reason).replace(/\.$/, '');
    if (status === 'shell') return REASONS.open_shell;
    if (status === 'mesh_only' || status === 'skipped') return REASONS.no_fit;
    return '';
  }
  const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  function partLine(p) {
    if (p.written === 'solid') return { kind: 'solid', name: p.name, what: p.faces != null ? 'Solid, ' + plural(+p.faces, 'face') : 'Solid', why: p.status === 'solid' ? '' : reasonText(p.reasonCode, p.reason, p.status) };
    const why = reasonText(p.reasonCode, p.reason, p.status);
    return p.written === 'mesh' ? { kind: 'mesh', name: p.name, what: 'Mesh', body: p.name + '_mesh', why } : { kind: 'omitted', name: p.name, what: 'Left out', why };
  }

  // body names on a part row: one name, or [fitted, mesh] for a Both part that has both bodies in the file
  const bodyLabel = (p) => (!p.body ? '' : Array.isArray(p.body) ? 'Bodies ' + p.body.join(' and ') : 'Body ' + p.body);
  // STEP "Both": the file holds a fitted body (<name>_fitted) for every part that could be fitted, plus a mesh body
  // (<name>_mesh) for every part. 78ee997+ reports this as fittedBody / meshBody on each part (`written` stays 'mesh' for
  // an open shell even though its fitted body is in the file). Older builds: fitted = written 'solid', mesh = not omitted.
  const bothFitted = (p) => ('fittedBody' in p ? !!p.fittedBody : p.written === 'solid');
  const bothMesh = (p) => ('meshBody' in p ? !!p.meshBody : p.written !== 'omitted');
  function bothLine(p) {
    const fitted = bothFitted(p), mesh = bothMesh(p), solid = fitted && p.status !== 'shell' && (p.status === 'solid' || p.written === 'solid');
    const why = solid ? '' : reasonText(p.reasonCode, p.reason, p.status);
    const fb = fitted ? (p.fittedBody || null) : null, mb = mesh ? (p.meshBody || p.name + '_mesh') : null;
    const faces = p.faces != null && fitted ? ', ' + plural(+p.faces, 'face') : '';
    if (fitted) return { kind: 'both', open: !solid, name: p.name, what: (solid ? 'Solid' : 'Open surfaces') + faces + (mesh ? ', plus mesh' : ''), body: fb && mb ? [fb, mb] : (fb || mb), why };
    if (mesh) return { kind: 'mesh', name: p.name, what: 'Mesh only', body: mb, why };
    return { kind: 'omitted', name: p.name, what: 'Left out', why };
  }
  function describeBoth(res, parts, blob, why) {
    const list = parts.map(bothLine);
    const n = parts.length, fit = list.filter((l) => l.kind === 'both').length, open = list.filter((l) => l.kind === 'both' && l.open).length;
    const meshOnly = list.filter((l) => l.kind === 'mesh').length, out = list.filter((l) => l.kind === 'omitted').length, solids = fit - open;
    const faces = parts.reduce((a, p) => a + (bothFitted(p) ? (+p.faces || 0) : 0), 0) || (res.summary && res.summary.faces);
    const allMesh = list.every((l) => l.kind !== 'omitted');
    const meshLine = allMesh ? (n > 1 ? 'Every part\u2019s mesh body is in the file too.' : 'The mesh body is included too.') : null;
    if (fit === 0 && limitHit(res, parts)) return { tone: 'warn', status: 'mesh_only', limit: true, blob, parts: limitRows(parts, list), title: LIMIT_TITLE, lines: [limitLine(res)] };
    if (fit === 0) {
      return { tone: 'warn', status: 'mesh_only', blob, parts: list, title: 'Mesh STEP exported',
        lines: ['No part could be fitted, so the file has only mesh bodies.', why ? cap(why) : null] };
    }
    if (solids === n) {
      return { tone: res.summary && res.summary.valid === false ? 'warn' : 'ok', status: 'solid', blob, parts: list,
        title: 'Fitted solid exported' + (faces ? ' (' + plural(+faces, 'face') + ')' : ''),
        lines: [n > 1 ? 'All ' + n + ' parts fitted into closed solids.' : 'Fitted into a closed solid.', meshLine] };
    }
    const openLine = open ? (open === 1 ? (n === 1 ? 'The fitted surfaces don\u2019t close into a solid.' : '1 fitted part has open surfaces, not a closed solid.') : open + ' fitted parts have open surfaces, not closed solids.') : null;
    const meshOnlyLine = meshOnly ? (meshOnly === 1 ? '1 part couldn\u2019t be fitted, so it has only its mesh body.' : meshOnly + ' parts couldn\u2019t be fitted, so they have only their mesh body.') : null;
    const outLine = out ? (out === 1 ? '1 part was left out of the file.' : out + ' parts were left out of the file.') : null;
    const title = fit === n
      ? (n === 1 ? 'Fitted surfaces exported (open, not a solid)' : 'Fitted: ' + solids + ' of ' + n + ' parts are closed solids')
      : 'Partly fitted: ' + fit + ' of ' + n + ' parts fitted' + [meshOnly ? meshOnly + ' mesh only' : null, out ? out + ' left out' : null].filter(Boolean).map((t) => ', ' + t).join('');
    return { tone: 'warn', status: fit === n ? 'open' : 'partial', blob, parts: list, title, lines: [meshLine, openLine, meshOnlyLine, outLine] };
  }

  // Whole-model fitting limit (r08: 429k triangles over the 200k limit): nothing was fitted for one model-wide reason, so the
  // card says so once ("Exported as mesh STEP" / "Too large to fit surfaces in the browser (429k triangles, limit 200k).") and
  // lists no part rows. Triggers: top-level reasonCode fit_limit, every part fit_limit, or the engine's too-many-triangles text.
  // Counts: PDF3D.lastLoad.trisParsed (1.6.2), else summary.tris, else the reason text; limit: summary.fitLimit / PDF3D.cadSurfaceLimits.maxFitTris (else the reason).
  const LIMIT_TEXT = /too many (triangles|faces) to fit/i;
  function limitHit(res, parts) {
    if (codeOf(res.reasonCode) === 'fit_limit' || LIMIT_TEXT.test(String(res.reason || ''))) return true;
    return !!(parts && parts.length && parts.every((p) => normCode(p.reasonCode) === 'fit_limit'));
  }
  function numK(m) { if (!m) return NaN; const n = parseFloat(m[1].replace(/,/g, '')); const u = (m[2] || '').toLowerCase(); return n * (u === 'k' ? 1e3 : u === 'm' ? 1e6 : 1); }
  const fmtK = (n) => (n >= 1e6 ? (Math.round(n / 1e5) / 10).toString().replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)));
  function limitLine(res) {
    const s = res.summary || {}, r = String(res.reason || '');
    // the count the fitting limit was checked against: lastLoad.trisParsed (1.6.2, before welding), else summary.tris, else the reason text
    const ll = NS().lastLoad || {};
    let tris = +ll.trisParsed > 0 ? +ll.trisParsed : +s.tris > 0 ? +s.tris : numK(r.match(/(\d[\d.,]*)\s*([kKmM])?\s*triangles/));
    const lim0 = NS().cadSurfaceLimits && NS().cadSurfaceLimits.maxFitTris;
    let lim = +s.fitLimit > 0 ? +s.fitLimit : +lim0 > 0 ? +lim0 : numK(r.match(/limit\D{0,12}?(\d[\d.,]*)\s*([kKmM])?/i));
    const bits = [isFinite(tris) && tris > 0 ? fmtK(tris) + ' triangles' : null, isFinite(lim) && lim > 0 ? 'limit ' + fmtK(lim) : null].filter(Boolean);
    return 'Too large to fit surfaces in the browser' + (bits.length ? ' (' + bits.join(', ') + ')' : '') + '.';
  }
  const LIMIT_TITLE = 'Exported as mesh STEP';   // not 'Saved as': the file line says Saved as / Downloaded as
  // part rows only when the parts don't all share the one limit reason (some part has its own outcome)
  const limitRows = (parts, list) => (parts.every((p) => normCode(p.reasonCode) === 'fit_limit' || p.reasonCode == null) ? undefined : list);
  const fmtGB = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB');
  const XT_UNITS = 'Stored in meters, opens at true size in NX.';
  const XT_NOTE = 'All parts merged into one faceted body. No B-spline surfaces yet.';   // same words as the list sub-line

  function describe(f, o, res, err) {
    const label = f.id === 'stl' ? 'STL (' + (o.encoding === 'ascii' ? 'ASCII' : 'binary') + ')' : f.label;
    if (err) return { tone: 'err', status: 'error', title: label + ' export failed', lines: [isBrowserErr(err) ? 'The browser stopped the export.' : String((err && err.message) || err), 'Nothing was saved.'] };
    res = res || {};
    const isCad = f.id === 'step' && o.body !== 'mesh' && res.status !== 'ok';
    if (!isCad) {
      const blob = res.blob || (res.data != null ? new Blob([res.data], { type: f.mime }) : null);
      if (f.id === 'xt') {
        // Parasolid result checks (summary first, then the top-level result): summary.faces, summary.bodyType, summary.openEdges, summary.sewn
        const s = res.summary || {}, g = (k) => (s[k] != null ? s[k] : res[k]);
        // XT_TOO_LARGE (estimated output > 8 GB): own wording only; the engine's reason text also says "Nothing was saved"
        if (!blob && normCode(res.reasonCode) === 'too_large') {
          return { tone: 'warn', status: 'too_large', title: 'Model too large to export' + (+g('estimatedBytes') > 0 ? ' (about ' + fmtGB(+g('estimatedBytes')) + ')' : ''),
            lines: ['This model is too large for the browser to write as Parasolid.', 'Nothing was saved. Try hiding some parts, or export STEP or STL instead.'] };
        }
        if (g('faces') != null && +g('faces') === 0) {
          return { tone: 'warn', status: 'empty', title: 'Nothing to export', lines: ['The model has no faces to write.', 'No file was saved.'] };
        }
        if (blob && (g('bodyType') === 'sheet' || +g('openEdges') > 0 || g('sewn') === false)) {
          return { tone: 'warn', status: 'sheet', blob, title: 'Parasolid sheet body exported (open model)',
            lines: ['This part isn\u2019t closed, so it was saved as surfaces, not a solid. This form hasn\u2019t been tested in NX.',
              +g('openEdges') > 0 ? (+g('openEdges') === 1 ? '1 open edge.' : Math.round(+g('openEdges')).toLocaleString('en-US') + ' open edges.') : null, XT_UNITS] };
        }
      }
      if (!blob) return { tone: 'err', status: res.status || 'error', title: 'Nothing exported', lines: [cap(reasonText(res.reasonCode, res.reason)) || 'The exporter returned no file.', 'Nothing was saved.'] };
      const what = f.id === 'step' ? 'Mesh STEP' : f.id === 'xt' ? 'Parasolid (one faceted body)' : label;
      return { tone: 'ok', status: 'ok', title: what + ' exported', lines: f.id === 'xt' ? [XT_UNITS] : [], blob };
    }
    if (res.status === 'cancelled') return { tone: 'muted', status: 'cancelled', title: 'Export cancelled', lines: ['Nothing was saved.'] };
    const blob = res.blob || null;
    const parts = partsOf(res);
    const omitMode = o.body === 'fitted' && o.onNoFit === 'omit';
    const why = reasonText(res.reasonCode, res.reason, res.status);

    // per-part results (summary.parts): drive everything from `written`
    if (parts) {
      const n = parts.length, fit = parts.filter((p) => p.written === 'solid').length;
      const mesh = parts.filter((p) => p.written === 'mesh').length, out = parts.filter((p) => p.written === 'omitted').length;
      const faces = parts.reduce((a, p) => a + (p.written === 'solid' ? (+p.faces || 0) : 0), 0) || (res.summary && res.summary.faces);
      if (blob && o.body === 'both') return describeBoth(res, parts, blob, why);
      const list = parts.map(partLine);
      if (!blob) {
        return { tone: 'warn', status: res.status || 'skipped', title: 'Nothing saved: no part could be fitted', parts: list,
          lines: [omitMode ? '\u201cLeave unfitted parts out\u201d is on, so no file was written.' : 'No file was written.',
            omitMode ? 'Choose \u201cSave mesh STEP instead\u201d to always get a file.' : null] };
      }
      if (fit === n) {
        return { tone: res.summary && res.summary.valid === false ? 'warn' : 'ok', status: 'solid', blob, parts: list,
          title: 'Fitted solid exported' + (faces ? ' (' + plural(+faces, 'face') + ')' : ''),
          lines: [n > 1 ? 'All ' + n + ' parts fitted into closed solids.' : 'Fitted into a closed solid.'] };
      }
      if (fit === 0 && limitHit(res, parts)) return { tone: 'warn', status: 'mesh_only', limit: true, blob, parts: limitRows(parts, list), title: LIMIT_TITLE, lines: [limitLine(res)] };
      if (fit === 0) {
        return { tone: 'warn', status: 'mesh_only', blob, parts: list, title: 'Mesh STEP exported',
          lines: ['No part could be fitted, so the mesh STEP was saved instead.', why ? cap(why) : null] };
      }
      const tail = [mesh ? mesh + ' saved as mesh' : null, out ? out + ' left out' : null].filter(Boolean).join(', ');
      return { tone: 'warn', status: 'partial', blob, parts: list, title: 'Partly fitted: ' + fit + ' of ' + n + ' parts fitted' + (tail ? ', ' + tail : ''),
        lines: [out ? 'Parts that couldn\u2019t be fitted were left out of the file.' : 'Parts that couldn\u2019t be fitted were saved as mesh bodies in the same file.'] };
    }

    // whole-file results
    if (blob && res.status === 'mesh_only' && limitHit(res, null)) return { tone: 'warn', status: 'mesh_only', limit: true, blob, title: LIMIT_TITLE, lines: [limitLine(res)] };
    if (res.meshStep || (o.body === 'fitted' && o.onNoFit === 'mesh' && res.status === 'mesh_only' && blob)) {
      return { tone: 'warn', status: 'mesh_only', blob, title: 'Mesh STEP exported',
        lines: ['Surfaces couldn\u2019t be fitted' + (why ? ': ' + why : '') + '.', 'Saved the mesh STEP instead.'] };
    }
    const cadUI = window.PDF3DCadExportUI;
    let d = null;
    if (cadUI && cadUI.describe && cadUI.normResult) { try { d = cadUI.describe(cadUI.normResult(res), null); } catch (e) { d = null; } }
    if (!d) d = { tone: blob ? 'ok' : 'warn', status: res.status || 'unknown', title: blob ? 'STEP exported' : 'Nothing saved', lines: [cap(why)] };
    const s = res.summary || {};
    let title = d.title;
    if (d.status === 'solid' && s.faces != null) title += ' (' + plural(+s.faces, 'face') + ')';
    const b = d.download === false ? null : blob;
    let lines = (d.lines || []).map((l) => (/Fitted solid only/.test(l) ? 'Choose \u201cSave mesh STEP instead\u201d to always get a file.' : l));
    if (omitMode && !b && d.status !== 'cancelled') {
      lines = lines.filter((l) => !/Save mesh STEP instead|Nothing was exported/.test(l));
      lines.push('\u201cLeave unfitted parts out\u201d is on, so no file was written.', 'Choose \u201cSave mesh STEP instead\u201d to always get a file.');
    }
    return { tone: d.tone === 'muted' && !b ? 'warn' : d.tone, status: d.status, title, lines, blob: b };
  }

  // ------------------------------------------------------------------ init
  function init() {
    if (!$('viewportCanvas') || !document.body) return;
    build();
    // simple-mode builds its top bar on init; re-place if it appears later
    new MutationObserver(() => { if (!ui.btnSimple.isConnected) place(); }).observe(document.body, { childList: true });
    // switching to Advanced closes the popover (the flow is Simple-only); the result card stays until dismissed
    new MutationObserver(() => { if (!simpleMode()) close(false); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    ui.name.addEventListener('input', () => { ui.name.dataset.touched = '1'; });
  }
  window.PDF3DExportFlow = {
    open: (b) => openPop(b || trigger()), close: () => close(true), select, save: doSave, dismiss: () => dismiss(false), saveAttachment,
    formats: () => FORMATS.filter(available).map((f) => f.id),
    get state() { return { open, running: !!running, savingAttachment: attRun ? attRun.index : null, prefs: JSON.parse(JSON.stringify(prefs)), picker: pickerOK() }; },
    storageKey: LS
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
