/*
 * simple-mode.js — "Simple mode" add-on for pdf-3d-extractor (3D PDF -> CAD).
 *
 * Integration (index.html only, no other edits):
 *   <link rel="stylesheet" href="affordance.css" />       (in <head>, optional, both modes)
 *   <link rel="stylesheet" href="simple-mode.css" />      (in <head>)
 *   <script src="simple-mode.js"></script>                (after app.js)
 *
 * Works against 1.3.0 (toolbar is a plain .viewport-toolbar) and 1.4.0 (#viewerControls with Reset view,
 * Orbit mode and line toggles): every original control is looked up at build time and only the ones that
 * exist get a Simple equivalent.
 *
 * Design rules:
 *  - Advanced mode == the original UI, untouched. Simple mode is just body.sm-simple + add-on chrome.
 *  - Every Simple control PROXIES to the original control (button.click(), select.value + 'change',
 *    checkbox.checked + 'change', range.value + 'input'/'change'). app.js stays the single source of truth.
 *  - Original panel nodes shown in Simple sheets are MOVED (listeners intact) and restored to their exact
 *    original positions via placeholder comments when switching back to Advanced.
 *  - Add-on elements never carry data-render / data-view / data-viewopt / data-tab, so app.js and
 *    viewer-gl.js selector bindings never pick them up.
 */
(function () {
  'use strict';
  if (window.PDF3DSimpleMode) return;

  const STORE_KEY = 'pdf3d-extractor.uiMode';
  const MODES = ['simple', 'advanced'];
  const $ = (id) => document.getElementById(id);

  const RENDER_LABELS = {
    'shaded-edges': 'Shaded with edges', 'brep-faces': 'Face groups', shaded: 'Smooth', wireframe: 'Wireframe', xray: 'X-ray'
  };
  const VIEW_LABELS = { iso: 'Iso', top: 'Top', front: 'Front', right: 'Right' };
  const ORBIT_LABELS = { free: ['Free', 'tumble any axis'], turntable: ['Turntable', 'Z stays up'] };
  const HINT_RE = /Click (?:a )?part in (?:the )?tree to highlight/;
  const HINT_TEXT = { simple: 'Click a part in Parts to highlight', advanced: 'Click a part in the part list to highlight' };
  const VIEWOPT_LABELS = {
    wires: ['Wires', 'PRC curves'], hiddenLines: ['Hidden', 'dimmed hidden edges'],
    meshWire: ['Mesh', 'triangle overlay'], flat: ['Flat', 'faceted shading']
  };
  const EXPORTS = [
    ['btnExportSTL', 'STL (binary)', '.stl'],
    ['btnExportSTLText', 'STL (ASCII)', '.stl'],
    ['btnExportOBJ', 'OBJ', '.obj'],
    ['btnExportIGES', 'IGES wireframe', '.igs'],
    ['btnExportRaw', 'Raw stream', '.u3d / .prc']
  ];
  const SETTINGS = [
    ['unitSelect', 'Units', 'Unit scale of the source model'],
    ['brepModeSelect', 'Body type', 'How bodies are written to STEP'],
    ['detailSelect', 'Reduce detail', 'Applies to exported files only']
  ];

  // ------------------------------------------------------------------ tiny DOM helper
  function h(tag, props, ...kids) {
    const n = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (k in n && typeof v !== 'string') n[k] = v;
        else n.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : String(kid));
    return n;
  }
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const isOwnShown = (el) => {
    if (!el || el.hidden) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  };
  // Original viewer toolbar: #viewerControls (1.4.0+) or the plain .viewport-toolbar (1.3.0).
  const viewerRoot = () => $('viewerControls') || document.querySelector('.viewport-toolbar');
  const ADDON = '.sm-pop, .sm-pill, .sm-sheet, .sm-topbar, .sm-dialog';
  const viewerAll = (sel) => [...(viewerRoot() || document).querySelectorAll(sel)].filter((el) => !el.closest(ADDON));
  const visible = (el) => !el.disabled && el.getClientRects().length > 0;
  const observe = (el, fn, opts) => {
    if (!el) return;
    new MutationObserver(fn).observe(el, opts || { attributes: true, childList: true, characterData: true, subtree: true });
  };

  // ------------------------------------------------------------------ mode resolution
  function readStored() { try { return localStorage.getItem(STORE_KEY); } catch (e) { return null; } }
  function store(m) { try { localStorage.setItem(STORE_KEY, m); } catch (e) { /* private mode */ } }
  function initialMode() {
    let q = null;
    try { q = new URLSearchParams(location.search).get('ui'); } catch (e) { /* ignore */ }
    if (MODES.includes(q)) return q;
    const s = readStored();
    return MODES.includes(s) ? s : 'simple';   // first-time visitors get Simple
  }

  // ------------------------------------------------------------------ state
  let mode = null;
  let built = false;
  const ui = {};
  const moved = [];          // [{ node, ph }]
  let openPop = null;        // { trigger, pop, onOpen, align }
  let openDialog = null;

  // ------------------------------------------------------------------ node relocation (exact restore)
  function moveInto(node, target) {
    if (!node || !target || node.parentNode === target) return;
    const ph = document.createComment('sm-placeholder');
    node.parentNode.insertBefore(ph, node);
    target.appendChild(node);
    moved.push({ node, ph });
  }
  function restoreAll() {
    while (moved.length) {
      const { node, ph } = moved.pop();
      if (ph.parentNode) { ph.parentNode.insertBefore(node, ph); ph.remove(); }
    }
  }

  // ------------------------------------------------------------------ popovers (menus / small dialogs)
  // Tab order inside a popover / sheet (focus trap)
  function tabbables(root) {
    return [...root.querySelectorAll('button, select, input, summary, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => visible(el) && !el.closest('[hidden]') && el.tabIndex >= 0);
  }
  // Arrow-key roving set: menu items only (never selects / inputs, so arrows can't change a setting)
  function rovers(root) { return [...root.querySelectorAll('.sm-mi')].filter(visible); }
  function trapTab(ev, root) {
    const f = tabbables(root);
    if (!f.length) { ev.preventDefault(); return; }
    const a = document.activeElement, outside = !root.contains(a) || a === root;
    if (ev.shiftKey && (outside || a === f[0])) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && (outside || a === f[f.length - 1])) { ev.preventDefault(); f[0].focus(); }
  }
  function bindPopover(trigger, pop, opts) {
    const entry = Object.assign({ trigger, pop, align: 'left', onOpen: null }, opts || {});
    trigger.setAttribute('aria-haspopup', pop.getAttribute('role') === 'menu' ? 'menu' : 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', pop.id);
    trigger.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (openPop && openPop.pop === pop) closePop(false); else openPopover(entry);
    });
    trigger.addEventListener('keydown', (ev) => {
      if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !(openPop && openPop.pop === pop)) {
        ev.preventDefault();
        openPopover(entry, ev.key === 'ArrowUp' ? 'last' : 'first');
      }
    });
    pop.addEventListener('keydown', (ev) => popKeys(ev, pop));
    // Safari (macOS) never focuses a clicked button, so pressing a menu item moves focus to <body>
    // and fires focusout before the click lands. Ignore focus loss while a pointer is down in the popover.
    let ptrInside = false;
    pop.addEventListener('pointerdown', () => { ptrInside = true; }, true);
    document.addEventListener('pointerup', () => { if (ptrInside) setTimeout(() => { ptrInside = false; }, 0); }, true);
    document.addEventListener('pointercancel', () => { ptrInside = false; }, true);
    pop.addEventListener('focusout', () => {
      setTimeout(() => {
        if (ptrInside) return;
        if (openPop && openPop.pop === pop && !pop.contains(document.activeElement) &&
            document.activeElement !== trigger && document.hasFocus()) closePop(false);
      }, 0);
    });
    return entry;
  }
  function openPopover(entry, focusWhich) {
    closePop(false);
    if (entry.onOpen) entry.onOpen();
    entry.pop.hidden = false;
    entry.trigger.setAttribute('aria-expanded', 'true');
    openPop = entry;
    positionPop(entry);
    const f = rovers(entry.pop).length ? rovers(entry.pop) : tabbables(entry.pop);
    const target = focusWhich === 'last' ? f[f.length - 1] : ((entry.pop.getAttribute('role') === 'menu' && entry.pop.querySelector('.sm-mi[role="menuitemradio"][aria-checked="true"]')) || f[0]);
    if (target) target.focus({ preventScroll: true });
  }
  function positionPop(entry) {
    const { trigger, pop, align } = entry;
    pop.style.maxHeight = '';
    pop.style.left = '0px'; pop.style.top = '0px';
    const r = trigger.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = align === 'right' ? r.right - pw : (align === 'center' ? r.left + r.width / 2 - pw / 2 : r.left);
    left = Math.max(8, Math.min(left, vw - pw - 8));
    let top = r.bottom + 6;
    if (top + ph > vh - 8) {
      if (r.top - ph - 6 >= 8) top = r.top - ph - 6;
      else pop.style.maxHeight = Math.max(160, vh - top - 8) + 'px';
    }
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  }
  function closePop(returnFocus) {
    if (!openPop) return;
    const { trigger, pop } = openPop;
    openPop = null;
    pop.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  function popKeys(ev, root) {
    const t = ev.target, k = ev.key;
    if (k === 'Tab') { trapTab(ev, root); return; }
    const isSelect = t.tagName === 'SELECT';
    const isRange = t.tagName === 'INPUT' && t.type === 'range';
    if (isSelect) {
      // A closed select must never change from the keyboard by accident. Explicit open only:
      // Space / Alt+Down (native) or Enter (showPicker). Arrows rove to menu items instead.
      if (ev.altKey && (k === 'ArrowDown' || k === 'ArrowUp')) return;
      if (k === 'Enter') { ev.preventDefault(); try { t.showPicker(); } catch (e) { /* older browsers */ } return; }
      if (k === 'PageUp' || k === 'PageDown' || k === 'ArrowLeft' || k === 'ArrowRight' ||
          (k.length === 1 && k !== ' ' && !ev.ctrlKey && !ev.metaKey)) { ev.preventDefault(); return; }
    }
    if (isRange && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End' || k === 'PageUp' || k === 'PageDown')) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(k)) return;
    ev.preventDefault();             // swallow on every element: arrows only ever move focus here
    const items = rovers(root);
    if (!items.length) return;
    const i = items.indexOf(t);
    let next;
    if (k === 'Home') next = items[0];
    else if (k === 'End') next = items[items.length - 1];
    else if (i >= 0) next = items[(i + (k === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    else if (k === 'ArrowDown') next = items.find((it) => t.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_FOLLOWING) || items[0];
    else next = items.slice().reverse().find((it) => t.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_PRECEDING) || items[items.length - 1];
    next.focus();
  }
  // menu item that proxies to an original control and closes the menu
  function menuItem(label, opts) {
    const o = opts || {};
    const lab = h('span', { class: 'sm-mi-label', text: label });
    const b = h('button', { type: 'button', class: 'sm-mi' + (o.sub ? ' sm-mi--sub' : '') + (o.cls ? ' ' + o.cls : ''), role: o.role || 'menuitem', title: o.title || null },
      o.check != null ? h('span', { class: 'sm-mi-check', 'aria-hidden': 'true' }) : null,
      o.sub ? h('span', { class: 'sm-mi-text' }, lab, h('span', { class: 'sm-mi-sub', text: o.sub })) : lab,
      o.ext ? h('span', { class: 'sm-mi-ext', text: o.ext }) : null);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (b.disabled) return;
      if (!o.keepOpen) closePop(true);
      if (o.action) o.action();
    });
    return b;
  }
  function setChecked(item, on) {
    item.setAttribute('aria-checked', on ? 'true' : 'false');
    const c = item.querySelector('.sm-mi-check');
    if (c) c.textContent = on ? '✓' : '';
  }

  // ------------------------------------------------------------------ side sheets
  function makeSheet(id, title, side, extraCls) {
    const titleId = id + 'Title';
    const close = h('button', { type: 'button', class: 'btn btn-sm sm-close', 'aria-label': 'Close ' + title, text: '×' });
    const body = h('div', { class: 'sm-sheet-b' });
    const sheet = h('section', {
      id, class: `sm-sheet sm-sheet--${side} ${extraCls || ''}`, role: 'dialog', 'aria-modal': 'false',
      'aria-labelledby': titleId, tabindex: '-1', hidden: true
    }, h('div', { class: 'sm-sheet-h' }, h('h2', { id: titleId, text: title }), close), body);
    close.addEventListener('click', () => toggleSheet(sheet, false, true));
    sheet.addEventListener('keydown', (ev) => { if (ev.key === 'Tab') trapTab(ev, sheet); });
    return { sheet, body };
  }
  function toggleSheet(sheet, show, returnFocus) {
    const on = show == null ? sheet.hidden : !!show;
    if (on && window.matchMedia('(max-width: 720px)').matches) {
      // phone: bottom sheets stack, so only one at a time
      for (const s of [ui.partsSheet, ui.infoSheet]) if (s !== sheet && !s.hidden) toggleSheet(s, false, false);
    }
    sheet.hidden = !on;
    const btn = sheet === ui.partsSheet ? ui.btnParts : ui.btnInfo;
    if (btn) { btn.setAttribute('aria-expanded', on ? 'true' : 'false'); btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
    if (on) { syncSheetTop(); sheet.focus({ preventScroll: true }); }
    else if (returnFocus && btn) btn.focus({ preventScroll: true });
  }
  function syncSheetTop() {
    if (!ui.topbar) return;
    const top = Math.round(ui.topbar.getBoundingClientRect().bottom);
    for (const s of [ui.partsSheet, ui.infoSheet]) if (s) s.style.setProperty('--sm-top', top + 'px');
  }

  // ------------------------------------------------------------------ build all add-on chrome (once)
  function build() {
    if (built) return;
    built = true;

    // ---------- mode switch (lives in Simple top bar, or floats in Advanced)
    ui.btnSimple = h('button', { type: 'button', 'aria-pressed': 'false', text: 'Simple', title: 'Simple mode: essentials only' });
    ui.btnAdvanced = h('button', { type: 'button', 'aria-pressed': 'false', text: 'Advanced', title: 'Advanced mode: full workbench' });
    ui.btnSimple.addEventListener('click', () => setMode('simple', true));
    ui.btnAdvanced.addEventListener('click', () => setMode('advanced', true));
    ui.modeSwitch = h('div', { class: 'sm-modeswitch', role: 'group', 'aria-label': 'Interface mode' }, ui.btnSimple, ui.btnAdvanced);
    ui.modeSwitch.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        (document.activeElement === ui.btnSimple ? ui.btnAdvanced : ui.btnSimple).focus();
      }
    });

    // ---------- top bar
    const titleEl = document.querySelector('.brand-title');
    const verMatch = titleEl && (titleEl.textContent.match(/v\d+(?:\.\d+)+/) || [])[0];
    const version = verMatch || (window.CAD3DExtractorVersion ? 'v' + window.CAD3DExtractorVersion : '');
    ui.docName = h('span', { class: 'sm-doc-name', text: ($('docFileName') || {}).textContent || '' });
    ui.status = h('span', { class: 'sm-status', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'sm-dot', 'aria-hidden': 'true' }), h('span', { class: 'sm-status-t' }));

    ui.btnOpen = h('button', { type: 'button', class: 'btn sm-btn-open', title: 'Open a 3D PDF, .u3d or .prc file' },
      h('span', null, 'Open', h('span', { class: 'sm-long', text: ' 3D PDF' }), '…'));
    ui.btnOpen.addEventListener('click', () => { const o = $('btnOpenFile'); if (o) o.click(); });

    ui.btnMore = h('button', { type: 'button', class: 'btn sm-iconbtn', 'aria-label': 'More actions', title: 'More actions', text: '⋯' });
    ui.menuMore = h('div', { id: 'smMenuMore', class: 'sm-pop', role: 'menu', 'aria-label': 'More actions', hidden: true },
      menuItem('Load sample', { ext: 'NX-ASM-402', action: () => { const o = $('btnLoadSample'); if (o) o.click(); } }),
      menuItem('About formats', { action: () => showAbout() }));

    ui.btnExportMain = h('button', { type: 'button', class: 'btn btn-primary', title: 'Export STEP AP214 (.stp) — Siemens NX ready' }, 'Export STEP');
    ui.btnExportMain.addEventListener('click', () => { const o = $('btnExportSTEP'); if (o) o.click(); });
    ui.btnExportCaret = h('button', { type: 'button', class: 'btn btn-primary', 'aria-label': 'More export formats and export settings', title: 'Other formats & export settings' },
      h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.menuExport = h('div', { id: 'smMenuExport', class: 'sm-pop', role: 'dialog', 'aria-label': 'Export', hidden: true });
    ui.exportItems = h('div', { role: 'group', 'aria-label': 'Export formats' });
    ui.settingsBox = h('div', { role: 'group', 'aria-label': 'Export settings' });
    ui.settingSelects = SETTINGS.map(([origId, label, hint]) => {
      const sel = h('select', { class: 'select-ctrl', id: 'sm_' + origId, 'aria-describedby': 'sm_' + origId + '_hint' });
      sel.addEventListener('change', () => {
        const o = $(origId);
        if (!o || o.value === sel.value) return;
        o.value = sel.value;
        fire(o, 'input');
        fire(o, 'change');
      });
      ui.settingsBox.append(h('label', { class: 'sm-field' }, h('span', { text: label }), sel,
        h('span', { class: 'sm-hint', id: 'sm_' + origId + '_hint', text: hint })));
      return [origId, sel];
    });
    ui.menuExport.append(h('div', { class: 'sm-pop-h', text: 'Export as' }), ui.exportItems, h('hr', { class: 'sm-sep' }),
      h('div', { class: 'sm-pop-h', text: 'Export settings' }), ui.settingsBox);

    ui.topbar = h('header', { class: 'sm-topbar', 'aria-label': 'Simple mode toolbar' },
      h('div', { class: 'sm-brand' },
        h('div', { class: 'brand-badge', 'aria-hidden': 'true', text: '3D' }),
        h('div', { class: 'sm-brand-title' }, '3D PDF → CAD', version ? h('span', { class: 'sm-brand-ver', text: version }) : null)),
      h('div', { class: 'sm-doc' }, ui.docName, ui.status),
      h('div', { class: 'sm-actions' },
        ui.btnOpen, ui.btnMore,
        h('div', { class: 'sm-split', role: 'group', 'aria-label': 'Export' }, ui.btnExportMain, ui.btnExportCaret),
        h('span', { class: 'sm-switch-slot', 'aria-hidden': 'true' })));
    ui.switchSlot = ui.topbar.querySelector('.sm-switch-slot');
    document.body.insertBefore(ui.topbar, document.body.firstChild);

    // ---------- floating viewport pill
    const wrap = document.querySelector('.viewport-wrap');
    ui.btnParts = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false', 'aria-pressed': 'false', 'aria-controls': 'smSheetParts', title: 'Show / hide parts' },
      'Parts', ui.partCount = h('span', { class: 'sm-count', text: '0' }));
    ui.btnInfo = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false', 'aria-pressed': 'false', 'aria-controls': 'smSheetInfo', title: 'Streams, size, features, product tree', text: 'Info' });
    ui.btnDisplay = h('button', { type: 'button', class: 'btn btn-sm' }, h('span', { class: 'sm-pill-k', text: 'Display' }), ui.displayLabel = h('span', { class: 'sm-pill-v' }), h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.btnView = h('button', { type: 'button', class: 'btn btn-sm' }, 'View', h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.btnFit = h('button', { type: 'button', class: 'btn btn-sm', text: 'Fit', title: 'Reset zoom & pan' });
    ui.btnFit.addEventListener('click', () => { const o = $('btnFitView'); if (o) o.click(); });
    const resetOrig = viewerAll('[data-view="reset"]')[0];          // 1.4.0+
    ui.btnReset = resetOrig ? h('button', { type: 'button', class: 'btn btn-sm', text: 'Reset', title: resetOrig.title || 'Reset view' }) : null;
    if (ui.btnReset) ui.btnReset.addEventListener('click', () => { const o = viewerAll('[data-view="reset"]')[0]; if (o) o.click(); });
    ui.btnViewMore = h('button', { type: 'button', class: 'btn btn-sm' }, 'More', h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.pill = h('div', { class: 'sm-pill', role: 'toolbar', 'aria-label': 'Viewer' },
      ui.btnParts, ui.btnInfo, h('span', { class: 'sm-pill-sep', 'aria-hidden': 'true' }),
      ui.btnDisplay, ui.btnView, ui.btnFit, ui.btnReset, ui.btnViewMore);
    ui.btnParts.addEventListener('click', () => toggleSheet(ui.partsSheet));
    ui.btnInfo.addEventListener('click', () => toggleSheet(ui.infoSheet));

    ui.menuDisplay = h('div', { id: 'smMenuDisplay', class: 'sm-pop', role: 'menu', 'aria-label': 'Display mode', hidden: true });
    ui.displayItems = viewerAll('[data-render]').map((orig) => {
      const key = orig.getAttribute('data-render');
      const it = menuItem(RENDER_LABELS[key] || orig.textContent.trim(), { role: 'menuitemradio', check: true, title: orig.textContent.trim(), action: () => orig.click() });
      it.dataset.smRender = key;
      ui.menuDisplay.append(it);
      observe(orig, syncDisplay, { attributes: true, attributeFilter: ['class'] });
      return { it, orig, key };
    });
    ui.menuView = h('div', { id: 'smMenuView', class: 'sm-pop', role: 'menu', 'aria-label': 'Camera view', hidden: true },
      viewerAll('[data-view]').filter((o) => o.getAttribute('data-view') !== 'reset').map((orig) => {
        const key = orig.getAttribute('data-view');
        return menuItem(VIEW_LABELS[key] || orig.textContent.trim(), { title: orig.textContent.trim(), action: () => orig.click() });
      }));

    // "More": explode + line options
    const explode = $('explodeSlider');
    ui.explode = h('input', { type: 'range', min: explode ? explode.min : '0', max: explode ? explode.max : '100', value: explode ? explode.value : '0', 'aria-label': 'Explode parts' });
    ui.explodeOut = h('output', { text: '0%' });
    ui.explode.addEventListener('input', () => {
      const o = $('explodeSlider');
      ui.explodeOut.textContent = ui.explode.value + '%';
      if (!o) return;
      o.value = ui.explode.value;
      fire(o, 'input');
      fire(o, 'change');
    });
    // Orbit mode (1.4.0+): radio items proxied to the original [data-orbit] buttons
    ui.orbitItems = viewerAll('[data-orbit]').map((orig) => {
      const key = orig.getAttribute('data-orbit');
      const [name, hint] = ORBIT_LABELS[key] || [orig.textContent.trim(), ''];
      const it = menuItem(name, { role: 'menuitemradio', check: true, ext: hint, keepOpen: true, title: orig.title || null,
        action: () => { orig.click(); syncViewMore(); } });
      observe(orig, syncViewMore, { attributes: true, attributeFilter: ['class', 'aria-pressed'] });
      return { it, orig };
    });
    // Line toggles (1.4.0+): checkbox items proxied to the original input[data-viewopt] (toggle + 'change')
    ui.viewOpts = viewerAll('input[data-viewopt]').map((orig) => {
      const key = orig.getAttribute('data-viewopt');
      const lab = orig.closest('label');
      const [name, hint] = VIEWOPT_LABELS[key] || [(lab ? lab.textContent : key).trim(), ''];
      const it = menuItem(name, { role: 'menuitemcheckbox', check: true, ext: hint, keepOpen: true, title: lab ? lab.title : null,
        action: () => {
          const o = viewerAll('input[data-viewopt="' + key + '"]')[0] || orig;
          o.checked = !o.checked;
          fire(o, 'change');
          syncViewMore();
        } });
      it.classList.add('sm-mi--box');
      if (lab) observe(lab, syncViewMore, { attributes: true, attributeFilter: ['class'] });
      return { it, orig, key };
    });
    ui.menuViewMore = h('div', { id: 'smMenuViewMore', class: 'sm-pop', role: 'dialog', 'aria-label': 'More view options', hidden: true },
      h('div', { class: 'sm-pop-h', text: 'Explode' }), h('div', { class: 'sm-range' }, ui.explode, ui.explodeOut),
      ui.orbitItems.length ? [h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Orbit' }),
        h('div', { role: 'group', 'aria-label': 'Orbit mode' }, ui.orbitItems.map((o) => o.it))] : null,
      ui.viewOpts.length ? [h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Lines' }),
        h('div', { role: 'group', 'aria-label': 'Line options' }, ui.viewOpts.map((v) => v.it))] : null);

    // drop veil + empty hint
    ui.dropVeil = h('div', { class: 'sm-dropveil', hidden: true, 'aria-hidden': 'true' },
      h('div', null, 'Drop to open', h('small', { text: '3D PDF (.pdf), .u3d or .prc' })));
    ui.emptyText = h('span', { text: 'Drop a 3D PDF here or click Open' });
    ui.empty = h('div', { class: 'sm-empty', hidden: true }, h('div', null, ui.emptyText));
    if (wrap) wrap.append(ui.pill, ui.empty, ui.dropVeil);

    // ---------- sheets
    const parts = makeSheet('smSheetParts', 'Parts', 'left', 'sm-sheet--parts');
    ui.partsSheet = parts.sheet; ui.partsBody = parts.body;
    const info = makeSheet('smSheetInfo', 'Info', 'right', 'sm-sheet--info');
    ui.infoSheet = info.sheet; ui.infoBody = info.body;
    ui.infoSections = [
      ['streamList', 'Streams', 'streamCountBadge', false],
      ['bboxGrid', 'Bounding box & topology', 'unitBadge', true],
      ['featureList', 'Detected features', 'featureCountBadge', false],
      ['treeList', 'Product tree & attachments', 'treeCountBadge', false]
    ].map(([anchorId, title, badgeId, open]) => {
      const badge = $(badgeId);
      const mirror = h('span', { class: badge ? badge.className : 'badge' });
      const syncBadge = () => { if (badge) { mirror.className = badge.className; mirror.textContent = badge.textContent; } };
      syncBadge();
      observe(badge, syncBadge);
      const body = h('div', { class: 'sm-sec-b' });
      const det = h('details', { class: 'sm-sec', open: !!open }, h('summary', null, h('span', { text: title }), mirror), body);
      ui.infoBody.append(det);
      const anchor = $(anchorId);
      return { card: anchor ? anchor.closest('.panel-card') : null, body };
    });

    // ---------- About dialog
    const sub = document.querySelector('.brand-sub');
    ui.about = h('div', { id: 'smAbout', class: 'sm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'smAboutTitle', tabindex: '-1', hidden: true },
      h('div', { class: 'sm-sheet-h' }, h('h2', { id: 'smAboutTitle', text: 'Supported formats' }),
        h('button', { type: 'button', class: 'btn btn-sm sm-close', 'aria-label': 'Close', text: '×', onclick: () => hideAbout() })),
      h('dl', null,
        h('dt', { text: 'Opens' }), h('dd', null, '3D PDF (', h('code', { text: '.pdf' }), ') with embedded U3D (ECMA-363) or PRC (ISO 14739-1) streams, plus raw ', h('code', { text: '.u3d' }), ' / ', h('code', { text: '.prc' }), ' files.'),
        h('dt', { text: 'STEP' }), h('dd', null, h('code', { text: '.stp' }), ' AP214 B-Rep, ready for Siemens NX and most CAD tools.'),
        h('dt', { text: 'STL' }), h('dd', null, h('code', { text: '.stl' }), ' triangle mesh, binary or ASCII.'),
        h('dt', { text: 'OBJ' }), h('dd', null, h('code', { text: '.obj' }), ' mesh with part groups and normals.'),
        h('dt', { text: 'IGES' }), h('dd', null, h('code', { text: '.igs' }), ' 5.3 feature-edge wireframe curves.'),
        h('dt', { text: 'Raw' }), h('dd', null, 'The extracted ', h('code', { text: '.u3d' }), ' / ', h('code', { text: '.prc' }), ' stream bytes.'),
        h('dt', { text: 'Settings' }), h('dd', { text: 'Units, body type and reduce detail live under Export ▼ → Export settings. The STEP / stream inspector is in Advanced mode.' }),
        sub ? h('dt', { text: 'Specs' }) : null, sub ? h('dd', { text: sub.textContent.trim() }) : null));

    document.body.append(ui.menuMore, ui.menuExport, ui.menuDisplay, ui.menuView, ui.menuViewMore, ui.partsSheet, ui.infoSheet, ui.about);

    // ---------- popover wiring
    bindPopover(ui.btnMore, ui.menuMore, { align: 'right' });
    bindPopover(ui.btnExportCaret, ui.menuExport, { align: 'right', onOpen: syncExportMenu });
    bindPopover(ui.btnDisplay, ui.menuDisplay, { onOpen: syncDisplay });
    bindPopover(ui.btnView, ui.menuView);
    bindPopover(ui.btnViewMore, ui.menuViewMore, { align: 'right', onOpen: syncViewMore });

    // ---------- live mirrors of original state
    observe($('docFileName'), () => { ui.docName.textContent = $('docFileName').textContent; ui.docName.title = ui.docName.textContent; syncEmpty(); });
    observe($('statusBadge'), syncStatus);
    observe($('partList'), syncPartCount, { childList: true, subtree: true, attributes: true, attributeFilter: ['checked'] });
    ($('partList') || document).addEventListener('change', () => setTimeout(syncPartCount, 0));
    observe($('btnExportSTEP'), () => { ui.btnExportMain.disabled = !!$('btnExportSTEP').disabled; }, { attributes: true, attributeFilter: ['disabled'] });

    // ---------- global keyboard / pointer handling
    document.addEventListener('pointerdown', (ev) => {
      if (openPop && !openPop.pop.contains(ev.target) && !openPop.trigger.contains(ev.target)) closePop(false);
      if (openDialog && !openDialog.contains(ev.target) && !ui.menuMore.contains(ev.target)) hideAbout();
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (openDialog) { ev.preventDefault(); hideAbout(); return; }
      if (openPop) { ev.preventDefault(); closePop(true); return; }
      if (mode === 'simple') {
        const s = [ui.infoSheet, ui.partsSheet].find((x) => !x.hidden && x.contains(document.activeElement)) ||
                  [ui.infoSheet, ui.partsSheet].find((x) => !x.hidden);
        if (s) { ev.preventDefault(); toggleSheet(s, false, true); }
      }
    });
    window.addEventListener('resize', () => {
      if (openPop) positionPop(openPop);
      syncSheetTop();
      placeSwitch();
    });

    // ---------- whole-viewport drag & drop (Simple mode only)
    let depth = 0;
    const hasFiles = (ev) => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files');
    const veil = (on) => { ui.dropVeil.hidden = !on; };
    window.addEventListener('dragenter', (ev) => {
      if (mode !== 'simple' || !hasFiles(ev)) return;
      depth++; veil(true);
    });
    window.addEventListener('dragover', (ev) => {
      if (mode !== 'simple' || !hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      veil(true);
    });
    window.addEventListener('dragleave', () => {
      if (mode !== 'simple') return;
      depth = Math.max(0, depth - 1);
      if (!depth) veil(false);
    });
    window.addEventListener('drop', (ev) => {
      if (mode !== 'simple') return;
      depth = 0; veil(false);
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      forwardFiles(ev.dataTransfer.files);
    });

    // ---------- keyboard-reachable selectable rows (both modes; app.js untouched)
    enhanceRows($('partList'), '.part-item', 'selected', 'Parts');
    enhanceRows($('streamList'), '.stream-item', 'active', 'Embedded 3D streams');

    syncStatus(); syncDisplay(); syncPartCount(); syncEmpty();
  }

  // app.js rebuilds these lists with innerHTML and binds 'click' on each row div. Give the rows
  // tabindex/role/aria-selected and turn Enter/Space into that same click; arrows move between rows.
  function enhanceRows(list, rowSel, onCls, label) {
    if (!list) return;
    const rows = () => [...list.children].filter((r) => r.matches(rowSel));
    let pending = null;               // { idx, until }: refocus the activated row after app.js rebuilds the list
    const refocus = () => {
      if (!pending || Date.now() > pending.until) { pending = null; return; }
      const a = document.activeElement;
      if (list.contains(a)) return;
      if (a && a !== document.body) { pending = null; return; }   // user moved focus elsewhere: leave it
      const r2 = rows()[pending.idx];
      if (r2) r2.focus({ preventScroll: true });
    };
    const apply = () => {
      if (list.getAttribute('role') !== 'listbox') { list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', label); }
      for (const r of rows()) {
        if (r.getAttribute('tabindex') !== '0') r.setAttribute('tabindex', '0');
        if (r.getAttribute('role') !== 'option') r.setAttribute('role', 'option');
        const on = r.classList.contains(onCls) ? 'true' : 'false';
        if (r.getAttribute('aria-selected') !== on) r.setAttribute('aria-selected', on);
      }
      refocus();
    };
    apply();
    new MutationObserver(apply).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    list.addEventListener('keydown', (ev) => {
      const row = ev.target;
      if (!row.matches || !row.matches(rowSel) || row.parentNode !== list) return;
      const all = rows(), idx = all.indexOf(row);
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        pending = { idx, until: Date.now() + 3000 };
        row.click();                                   // app.js rebuilds the list (sync or after an async stream load)
        apply(); requestAnimationFrame(refocus);
      } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        const n = all[idx + (ev.key === 'ArrowDown' ? 1 : -1)];
        if (n) { ev.preventDefault(); n.focus(); }
      }
    });
  }

  // HUD hint wording ("tree" there means the part list). No-op once the original text no longer says "tree".
  function syncHint() {
    const el = document.querySelector('.viewport-hud-bl');
    if (!el) return;
    if (!ui.hint) {
      const tn = [...el.childNodes].find((n) => n.nodeType === 3 && HINT_RE.test(n.nodeValue));
      ui.hint = tn ? { tn, orig: tn.nodeValue, last: tn.nodeValue } : { tn: null };
    }
    const hnt = ui.hint;
    if (!hnt.tn || !hnt.tn.isConnected) return;
    if (hnt.tn.nodeValue !== hnt.last) return;        // someone else (app.js) rewrote it: leave it alone
    hnt.tn.nodeValue = hnt.last = hnt.orig.replace(HINT_RE, HINT_TEXT[mode] || '$&');
  }

  // Hand dropped files to app.js through its own #fileInput 'change' handler (reads ev.target.files[0]).
  // Fallback: re-dispatch a synthetic drop on #dropZone (its handler reads ev.dataTransfer.files[0]).
  function forwardFiles(files) {
    if (!files || !files.length) return;
    const input = $('fileInput');
    try {
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      input.files = dt.files;
      fire(input, 'change');
    } catch (e) {
      const dz = $('dropZone');
      if (!dz) return;
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }

  // ------------------------------------------------------------------ sync helpers (read originals)
  function syncStatus() {
    const b = $('statusBadge');
    if (!b) return;
    const t = (b.textContent || '').trim();
    const tone = /badge-emerald/.test(b.className) ? 'ok' : /badge-amber/.test(b.className) ? 'warn' : '';
    let m, short;
    if (/NO 3D STREAM/.test(t)) short = 'Attachment only';
    else if (/NO MESH/.test(t)) short = 'No mesh found';
    else if ((m = t.match(/WATER-TIGHT[^(]*\((\d+) SOLIDS?\)/))) short = `${m[1]} watertight solid${m[1] === '1' ? '' : 's'}`;
    else if ((m = t.match(/(\d+) BODIES EXTRACTED/))) short = `${m[1]} bod${m[1] === '1' ? 'y' : 'ies'} extracted`;
    else if (/^READY/.test(t)) short = 'Ready';
    else short = t.length > 30 ? t.slice(0, 30) + '…' : t;
    if (tone === 'warn' && b.title && !/No mesh|Attachment/.test(short)) short += ' · warnings';
    ui.status.dataset.tone = tone;
    ui.status.querySelector('.sm-status-t').textContent = short;
    ui.status.title = t + (b.title ? '\n' + b.title : '');
    syncEmpty();
  }
  function syncDisplay() {
    if (!ui.displayItems) return;
    let cur = null;
    for (const d of ui.displayItems) {
      const on = d.orig.classList.contains('btn-active');
      setChecked(d.it, on);
      if (on) cur = d;
    }
    ui.displayLabel.textContent = cur ? (RENDER_LABELS[cur.key] || cur.orig.textContent.trim()) : '';
  }
  function syncViewMore() {
    const o = $('explodeSlider');
    if (o) { ui.explode.min = o.min; ui.explode.max = o.max; ui.explode.value = o.value; }
    ui.explodeOut.textContent = ui.explode.value + '%';
    for (const v of ui.viewOpts || []) {
      const orig = viewerAll('input[data-viewopt="' + v.key + '"]')[0] || v.orig;
      setChecked(v.it, !!orig.checked);
      v.it.disabled = !!orig.disabled;
    }
    for (const o of ui.orbitItems || []) {
      setChecked(o.it, o.orig.classList.contains('btn-active') || o.orig.getAttribute('aria-pressed') === 'true');
    }
  }
  function syncExportMenu() {
    ui.exportItems.textContent = '';
    const list = EXPORTS.slice();
    // Parasolid: only when the app writes the NX form (PDF3D.capabilities.parasolid) and its Advanced button exists.
    const caps = (window.PDF3D && window.PDF3D.capabilities) || {};
    const xt = $('btnExportXT');
    if (xt && caps.parasolid) list.unshift(['btnExportXT', 'Parasolid (.x_t)', '.x_t', '', 'Faceted solid, flat triangles']);
    for (const [id, label, ext, cls, sub] of list) {
      const orig = $(id);
      if (!orig || !isOwnShown(orig)) continue;
      const it = menuItem(label, { ext, cls, sub, title: orig.title || null, action: () => { const o = $(id); if (o) o.click(); } });
      it.disabled = !!orig.disabled;
      it.dataset.smExport = id;
      ui.exportItems.append(it);
    }
    for (const [origId, sel] of ui.settingSelects) {
      const o = $(origId);
      if (!o) continue;
      const sig = [...o.options].map((op) => op.value + '\u0001' + op.text).join('\u0002');
      if (sel.dataset.sig !== sig) {
        sel.textContent = '';
        for (const op of o.options) sel.append(h('option', { value: op.value, text: op.text }));
        sel.dataset.sig = sig;
      }
      sel.value = o.value;
      sel.disabled = !!o.disabled;
      sel.title = o.title || '';
    }
  }
  function syncPartCount() {
    const list = $('partList');
    if (!list || !ui.partCount) return;
    const chks = list.querySelectorAll('.part-chk');
    const vis = [...chks].filter((c) => c.checked).length;
    ui.partCount.textContent = chks.length ? (vis === chks.length ? String(chks.length) : `${vis}/${chks.length}`) : '0';
    ui.btnParts.title = chks.length ? `${vis} of ${chks.length} parts visible` : 'No parts';
    syncEmpty();
  }
  function syncEmpty() {
    if (!ui.empty) return;
    let nParts = 0;
    try { nParts = window.CAD3DExtractor ? window.CAD3DExtractor.getState().parts.length : $('partList').children.length; } catch (e) { /* ignore */ }
    const t = (($('statusBadge') || {}).textContent || '');
    const loaded = /NO MESH|NO 3D STREAM/.test(t);
    ui.empty.hidden = nParts > 0;
    ui.emptyText.textContent = loaded
      ? `No 3D geometry found in ${(($('docFileName') || {}).textContent || 'this file').trim()}. Drop another 3D PDF here or click Open.`
      : 'Drop a 3D PDF here or click Open';
  }

  // ------------------------------------------------------------------ About dialog
  function showAbout() {
    closePop(false);
    ui.about.hidden = false;
    openDialog = ui.about;
    const c = ui.about.querySelector('.sm-close');
    if (c) c.focus();
  }
  function hideAbout() {
    if (!openDialog) return;
    ui.about.hidden = true;
    openDialog = null;
    if (mode === 'simple') ui.btnMore.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ the mode switch stays pinned in ONE spot
  // Above 720px it is position:fixed at the same top-right point in both modes (Steven: it must not move
  // when switching). Simple reserves its width with an empty slot at the end of the top bar; Advanced
  // floats it over the free space right of the brand. On phones (<=720px) Simple keeps it in the top bar row.
  const PHONE = window.matchMedia('(max-width: 720px)');
  function placeSwitch() {
    if (!ui.modeSwitch) return;
    const sw = ui.modeSwitch;
    sw.classList.remove('sm-modeswitch--corner');
    if (mode === 'simple' && PHONE.matches) {
      sw.classList.remove('sm-modeswitch--float');
      if (sw.parentNode !== ui.switchSlot) ui.switchSlot.appendChild(sw);
      return;
    }
    sw.classList.add('sm-modeswitch--float');
    if (sw.parentNode !== document.body) document.body.appendChild(sw);
    ui.switchSlot.style.width = sw.offsetWidth + 'px';
    if (mode !== 'advanced') return;
    const r = sw.getBoundingClientRect();
    const hits = [...document.querySelectorAll('.topbar .brand, .topbar .top-controls, .exportbar')].some((el) => {
      const b = el.getBoundingClientRect();
      return b.width && !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
    });
    if (hits) sw.classList.add('sm-modeswitch--corner');
  }

  // ------------------------------------------------------------------ mode switching
  function setMode(next, persist) {
    if (!MODES.includes(next)) return;
    if (persist) store(next);
    build();
    const hadFocus = ui.modeSwitch.contains(document.activeElement);
    if (next === mode) return;
    mode = next;
    closePop(false);
    hideAbout();
    ui.btnSimple.setAttribute('aria-pressed', String(next === 'simple'));
    ui.btnAdvanced.setAttribute('aria-pressed', String(next === 'advanced'));

    if (next === 'simple') {
      document.body.classList.add('sm-simple');
      placeSwitch();
      const partsCard = ($('partList') || {}).closest ? $('partList').closest('.panel-card') : null;
      moveInto(partsCard, ui.partsBody);
      for (const s of ui.infoSections) moveInto(s.card, s.body);
      syncStatus(); syncDisplay(); syncPartCount(); syncSheetTop();
    } else {
      for (const s of [ui.partsSheet, ui.infoSheet]) toggleSheet(s, false, false);
      ui.dropVeil.hidden = true;
      restoreAll();
      document.body.classList.remove('sm-simple');
      placeSwitch();
    }
    syncHint();
    if (hadFocus) (next === 'simple' ? ui.btnSimple : ui.btnAdvanced).focus({ preventScroll: true });
    // canvas container changed size: let app.js / viewer-gl re-render at the new size
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    document.dispatchEvent(new CustomEvent('pdf3d:uimode', { detail: { mode: next } }));
  }

  function init() {
    if (!$('viewportCanvas') || !document.body) return;   // not the extractor page
    setMode(initialMode(), false);
  }

  window.PDF3DSimpleMode = {
    get mode() { return mode; },
    hintText: HINT_TEXT,
    setMode: (m) => setMode(m, true),
    toggle: () => setMode(mode === 'simple' ? 'advanced' : 'simple', true),
    storageKey: STORE_KEY
  };

  // Script is loaded after app.js at the end of <body>, so the markup already exists: apply the
  // mode immediately (no flash of the Advanced UI). app.js binds its listeners on DOMContentLoaded,
  // which is fine because Simple controls only ever proxy to the original elements at click time.
  if (document.readyState === 'loading' && !$('viewportCanvas')) document.addEventListener('DOMContentLoaded', init);
  else init();
})();
