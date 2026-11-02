/*
 * simple-mode.js — the pdf-3d-extractor UI (3D PDF -> CAD). Since 1.7.0 this is the only UI: the Advanced
 * workbench, the Simple / Advanced switch, the ui URL parameter and the remembered mode are gone.
 *
 * Integration (index.html):
 *   <link rel="stylesheet" href="affordance.css" />       (in <head>)
 *   <link rel="stylesheet" href="simple-mode.css" />      (in <head>)
 *   <script src="simple-mode.js"></script>                (after app.js)
 *
 * index.html only holds the viewport (.viewport-wrap > #viewportCanvas) and the hidden #fileInput. This file builds
 * the top bar, the viewer pill and menus, the Solid Bodies / Info sheets and the dialogs, and gives app.js the
 * containers it writes into by id (partList, streamList, bboxGrid, featureList, treeList, attachList, the badges,
 * docFileName and the readout rows hudStreamTitle ... hudStreamSizes). Controls call the app.js APIs directly:
 * window.PDF3DView (view), CAD3DExtractor (sample, status), PDF3DViewerGL (line options).
 */
(function () {
  'use strict';
  if (window.PDF3DSimpleMode) return;

  const OLD_MODE_KEY = 'pdf3d-extractor.uiMode';   // the remembered Simple / Advanced mode (<= 1.6.2); removed at start
  const $ = (id) => document.getElementById(id);

  const RENDER_LABELS = {
    'shaded-edges': 'Shaded with edges', 'brep-faces': 'Face groups', shaded: 'Smooth', wireframe: 'Wireframe', xray: 'Transparent'
  };
  // 1.7.0 viewport preferences (window.PDF3DView in app.js; remembered in localStorage there)
  const BG_LABELS = [['default', 'Default'], ['black', 'Black'], ['white', 'White'], ['gradient', 'Black to white gradient']];
  const PROJ_LABELS = [['perspective', 'Perspective'], ['orthographic', 'Orthographic']];
  const BODIES = 'Solid Bodies';   // 1.7.0: the "Parts" tab / sheet
  // More > Help (1.7.0): the full controls list that used to sit bottom-left in the viewport
  const HELP_ROWS = [
    ['Drag', 'Orbit'],
    ['Ctrl / Alt-drag or middle-drag', 'Twist about the view axis'],
    ['Shift-drag or right-drag', 'Pan'],
    ['Scroll', 'Zoom'],
    ['Fit', 'Reset zoom and pan'],
    ['Reset', 'Back to the starting view'],
    [BODIES, 'Click a body in the list or the view to select it; the eye shows or hides it; double-click a name to rename it'],
    ['Open or drop', 'Open a 3D PDF, .u3d or .prc file, or drop it anywhere on the page'],
    ['Esc', 'Clear the selection, or close a menu, panel or dialog']
  ];
  const VIEW_LABELS = { iso: 'Iso', top: 'Top', front: 'Front', right: 'Right' };
  const VIEW_TITLES = { iso: 'Iso', top: 'Top (XY)', front: 'Front (XZ)', right: 'Right (YZ)' };   // hover titles (as the <= 1.6.2 view buttons)
  const ORBIT_LABELS = { free: ['Free', 'tumble any axis'], turntable: ['Turntable', 'Z stays up'] };
  // Explode is a 0-100 % range; Reset view keeps the old toolbar wording
  const RESET_TITLE = 'Reset orientation, zoom and pan';
  const ORBIT_TITLES = {
    free: 'Free arcball: tumble past 180° about any axis, no gimbal lock. Ctrl/Alt+drag (or middle-drag) twists about the view axis.',
    turntable: 'Turntable: Z stays up, tilt limited to ±85°'
  };
  // line options = PDF3DViewerGL.options keys: [name, hint, title]
  const VIEWOPT_LABELS = {
    wires: ['Wires', 'PRC curves', 'PRC wires / curves'],
    hiddenLines: ['Hidden', 'dimmed hidden edges', 'Show edges and wires hidden behind geometry, dimmed (WebGL)'],
    meshWire: ['Mesh', 'triangle overlay', 'Overlay the triangle mesh (WebGL)'],
    flat: ['Flat', 'faceted shading', 'Flat (faceted) shading instead of smooth normals with a 30° crease angle (WebGL)']
  };
  const SPECS = 'ECMA-363 (U3D) & ISO 14739-1 (PRC) Decoder • STEP AP214 (.stp) • STL • OBJ • IGES';

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
  const PV = () => window.PDF3DView;
  const viewState = () => (PV() && PV().state ? PV().state() : { renderMode: 'shaded-edges', orbitMode: 'free', explode: 0 });
  const status = () => (window.CAD3DExtractor && window.CAD3DExtractor.getStatus ? window.CAD3DExtractor.getStatus() : { text: '', title: '', tone: '' });
  const visible = (el) => !el.disabled && el.getClientRects().length > 0;
  const observe = (el, fn, opts) => {
    if (!el) return;
    new MutationObserver(fn).observe(el, opts || { attributes: true, childList: true, characterData: true, subtree: true });
  };

  // ------------------------------------------------------------------ state
  let built = false;
  const ui = {};
  let openPop = null;        // { trigger, pop, onOpen, align }
  let openDialog = null;

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
  // menu item: runs its action and closes the menu (unless keepOpen)
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

    // ---------- top bar
    const version = window.CAD3DExtractorVersion ? 'v' + window.CAD3DExtractorVersion : '';
    // 1.7.0 status (upper right): exactly "File loaded: name.pdf | Bodies Detected: N"; the name truncates with an
    // ellipsis and shows in full on hover; the dot keeps the load tone and the bodies part keeps the old status tooltip
    ui.docName = h('span', { class: 'sm-doc-name', id: 'docFileName' });   // app.js writes the file name here
    ui.bodies = h('span', { class: 'sm-status-n', text: '0' });
    ui.statusT = h('span', { class: 'sm-status-t' }, ' | Bodies Detected: ', ui.bodies);
    ui.status = h('span', { class: 'sm-status', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'sm-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'sm-status-k', text: 'File loaded: ' }), ui.docName, ui.statusT);

    ui.btnOpen = h('button', { type: 'button', class: 'btn sm-btn-open', title: 'Open a 3D PDF, .u3d or .prc file' },
      h('span', null, 'Open', h('span', { class: 'sm-long', text: ' 3D PDF' }), '…'));
    ui.btnOpen.addEventListener('click', () => { const o = $('fileInput'); if (o) o.click(); });

    ui.btnMore = h('button', { type: 'button', class: 'btn sm-iconbtn', 'aria-label': 'More actions', title: 'More actions', text: '⋯' });
    ui.menuMore = h('div', { id: 'smMenuMore', class: 'sm-pop', role: 'menu', 'aria-label': 'More actions', hidden: true },
      menuItem('Load sample', { ext: 'NX-ASM-402', action: () => { if (window.CAD3DExtractor) window.CAD3DExtractor.loadSample(); } }),
      menuItem('Help', { action: () => showAbout(ui.help) }),
      menuItem('About formats', { action: () => showAbout() }));

    // the Export button (export-flow.js) is appended to .sm-actions
    // partial load (lastLoad.damaged): quiet amber note beside the status chip, tied to the current lastLoad
    ui.dmgText = h('span', { class: 'sm-damaged-t' });
    ui.dmgX = h('button', { type: 'button', class: 'sm-damaged-x', 'aria-label': 'Dismiss note', title: 'Dismiss', text: '\u00d7',
      onclick: () => { ui.dmgDismissed = (window.PDF3D || {}).lastLoad; syncDamaged(); if (ui.btnOpen) ui.btnOpen.focus({ preventScroll: true }); } });
    ui.dmg = h('span', { class: 'sm-damaged', role: 'note', 'data-sm': 'damaged-note', hidden: true }, h('span', { class: 'sm-damaged-ico', 'aria-hidden': 'true', text: '!' }), ui.dmgText, ui.dmgX);
    ui.topbar = h('header', { class: 'sm-topbar', 'aria-label': 'Toolbar' },
      h('div', { class: 'sm-brand' },
        h('div', { class: 'brand-badge', 'aria-hidden': 'true', text: '3D' }),
        h('div', { class: 'sm-brand-title' }, '3D PDF → CAD', version ? h('span', { class: 'sm-brand-ver', text: version }) : null)),
      h('div', { class: 'sm-doc' }, ui.dmg, ui.status),
      h('div', { class: 'sm-actions' }, ui.btnOpen, ui.btnMore));
    document.body.insertBefore(ui.topbar, document.body.firstChild);

    // ---------- floating viewport pill
    const wrap = document.querySelector('.viewport-wrap');
    ui.btnParts = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false', 'aria-pressed': 'false', 'aria-controls': 'smSheetParts', title: 'Show / hide solid bodies' },
      BODIES, ui.partCount = h('span', { class: 'sm-count', text: '0' }));
    ui.btnInfo = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false', 'aria-pressed': 'false', 'aria-controls': 'smSheetInfo', title: 'Streams, size, features, product tree', text: 'Info' });
    ui.btnDisplay = h('button', { type: 'button', class: 'btn btn-sm' }, h('span', { class: 'sm-pill-k', text: 'Display' }), ui.displayLabel = h('span', { class: 'sm-pill-v' }), h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.btnView = h('button', { type: 'button', class: 'btn btn-sm' }, 'View', h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.btnFit = h('button', { type: 'button', class: 'btn btn-sm', text: 'Fit', title: 'Reset zoom & pan' });
    ui.btnFit.addEventListener('click', () => { if (PV()) PV().fit(); });
    ui.btnReset = h('button', { type: 'button', class: 'btn btn-sm', text: 'Reset', title: RESET_TITLE });
    ui.btnReset.addEventListener('click', () => { if (PV()) PV().preset('reset'); });
    ui.btnViewMore = h('button', { type: 'button', class: 'btn btn-sm' }, 'More', h('span', { class: 'sm-caret', 'aria-hidden': 'true', text: '▼' }));
    ui.pill = h('div', { class: 'sm-pill', role: 'toolbar', 'aria-label': 'Viewer' },
      ui.btnParts, h('span', { class: 'sm-pill-sep', 'aria-hidden': 'true' }),
      ui.btnDisplay, ui.btnView, ui.btnFit, ui.btnReset, ui.btnViewMore,
      h('span', { class: 'sm-pill-sep', 'aria-hidden': 'true' }), ui.btnInfo);   // 1.7.0: Info at the far right
    ui.btnParts.addEventListener('click', () => toggleSheet(ui.partsSheet));
    ui.btnInfo.addEventListener('click', () => toggleSheet(ui.infoSheet));

    ui.menuDisplay = h('div', { id: 'smMenuDisplay', class: 'sm-pop', role: 'menu', 'aria-label': 'Display mode', hidden: true });
    ui.displayItems = Object.keys(RENDER_LABELS).map((key) => {
      const it = menuItem(RENDER_LABELS[key], { role: 'menuitemradio', check: true, action: () => { if (PV()) PV().setRenderMode(key); } });
      it.dataset.smRender = key;
      ui.menuDisplay.append(it);
      return { it, key };
    });
    // 1.7.0: background choice + floor grid (window.PDF3DView)
    ui.bgItems = BG_LABELS.map(([key, label]) => {
      const it = menuItem(label, { role: 'menuitemradio', check: true, keepOpen: true, action: () => { if (PV()) PV().set('background', key); syncDisplay(); } });
      it.dataset.smBg = key;
      return { it, key };
    });
    ui.gridItem = menuItem('Floor grid', { role: 'menuitemcheckbox', check: true, keepOpen: true,
      action: () => { if (PV()) PV().set('grid', !PV().get().grid); syncDisplay(); } });
    ui.gridItem.classList.add('sm-mi--box');
    ui.menuDisplay.append(h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Background' }),
      h('div', { role: 'group', 'aria-label': 'Background' }, ui.bgItems.map((b) => b.it)),
      h('hr', { class: 'sm-sep' }), ui.gridItem);
    ui.menuView = h('div', { id: 'smMenuView', class: 'sm-pop', role: 'menu', 'aria-label': 'Camera view', hidden: true },
      Object.keys(VIEW_LABELS).map((key) => menuItem(VIEW_LABELS[key], { title: VIEW_TITLES[key], action: () => { if (PV()) PV().preset(key); } })));
    // 1.7.0: Perspective / Orthographic (window.PDF3DView projection)
    ui.projItems = PROJ_LABELS.map(([key, label]) => {
      const it = menuItem(label, { role: 'menuitemradio', check: true, keepOpen: true,
        action: () => { if (window.PDF3DView) window.PDF3DView.set('projection', key); syncProjection(); } });
      it.dataset.smProj = key;
      return { it, key };
    });
    ui.menuView.append(h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Projection' }),
      h('div', { role: 'group', 'aria-label': 'Projection' }, ui.projItems.map((p) => p.it)));

    // "More": explode, orbit mode, line options
    ui.explode = h('input', { type: 'range', min: '0', max: '100', value: String(viewState().explode || 0), 'aria-label': 'Explode bodies' });
    ui.explodeOut = h('output', { text: ui.explode.value + '%' });
    ui.explode.addEventListener('input', () => {
      ui.explodeOut.textContent = ui.explode.value + '%';
      if (PV()) PV().setExplode(Number(ui.explode.value) || 0);
    });
    ui.orbitItems = Object.keys(ORBIT_LABELS).map((key) => {
      const [name, hint] = ORBIT_LABELS[key];
      const it = menuItem(name, { role: 'menuitemradio', check: true, ext: hint, keepOpen: true, title: ORBIT_TITLES[key],
        action: () => { if (PV()) PV().setOrbitMode(key); syncViewMore(); } });
      return { it, key };
    });
    // line toggles: PDF3DViewerGL.options / setOption (WebGL viewer only)
    const GL = window.PDF3DViewerGL;
    ui.viewOpts = GL ? Object.keys(VIEWOPT_LABELS).filter((k) => k in GL.options).map((key) => {
      const [name, hint, title] = VIEWOPT_LABELS[key];
      const it = menuItem(name, { role: 'menuitemcheckbox', check: true, ext: hint, keepOpen: true, title,
        action: () => { GL.setOption(key, !GL.options[key]); syncViewMore(); } });
      it.classList.add('sm-mi--box');
      return { it, key };
    }) : [];
    ui.menuViewMore = h('div', { id: 'smMenuViewMore', class: 'sm-pop', role: 'dialog', 'aria-label': 'More view options', hidden: true },
      h('div', { class: 'sm-pop-h', text: 'Explode' }), h('div', { class: 'sm-range' }, ui.explode, ui.explodeOut),
      ui.orbitItems.length ? [h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Orbit' }),
        h('div', { role: 'group', 'aria-label': 'Orbit mode' }, ui.orbitItems.map((o) => o.it))] : null,
      ui.viewOpts.length ? [h('hr', { class: 'sm-sep' }), h('div', { class: 'sm-pop-h', text: 'Lines' }),
        h('div', { role: 'group', 'aria-label': 'Line options' }, ui.viewOpts.map((v) => v.it))] : null);

    // drop veil + empty hint
    ui.dropVeil = h('div', { class: 'sm-dropveil', hidden: true, 'aria-hidden': 'true' },
      h('div', null, 'Drop to open', h('small', { text: '3D PDF (.pdf), .u3d or .prc' })));
    ui.emptyTitle = h('strong', { class: 'sm-empty-title', hidden: true });
    ui.emptyLine = h('span', { class: 'sm-empty-line', hidden: true });
    ui.emptyText = h('span', { text: 'Drop a 3D PDF here or click Open' });
    ui.attBox = h('div', { class: 'sm-att', 'data-sm': 'attachments', hidden: true });
    ui.emptyCard = h('div', null, ui.emptyTitle, ui.emptyLine, ui.attBox, ui.emptyText);
    ui.empty = h('div', { class: 'sm-empty', hidden: true }, ui.emptyCard);
    if (wrap) wrap.append(ui.pill, ui.empty, ui.dropVeil);

    // ---------- sheets
    const parts = makeSheet('smSheetParts', BODIES, 'left', 'sm-sheet--parts');
    ui.partsSheet = parts.sheet; ui.partsBody = parts.body;
    const info = makeSheet('smSheetInfo', 'Info', 'right', 'sm-sheet--info');
    ui.infoSheet = info.sheet; ui.infoBody = info.body;
    // 1.7.0: the viewport readout (stream, stream sizes, bodies / faces / tris, bounds, units, renderer); app.js writes
    // each row by id. Empty rows hide (CSS :empty).
    ui.readout = h('div', { class: 'sm-readout', 'data-sm': 'readout' },
      ['hudStreamTitle', 'hudStreamSizes', 'hudAssemblyStats', 'hudBounds', 'hudScaleInfo', 'hudRenderStats'].map((id) =>
        h('div', { class: 'sm-readout-r', id, 'data-hud': id })));
    ui.infoBody.append(h('details', { class: 'sm-sec', open: true }, h('summary', null, h('span', { text: 'File & geometry' })),
      h('div', { class: 'sm-sec-b' }, ui.readout)));
    // sections: [title, badge id, open, content]; app.js fills the lists and badges by id
    const badge = (id, cls) => h('span', { class: 'badge ' + cls, id });
    for (const [title, badgeEl, open, content] of [
      ['Streams', badge('streamCountBadge', 'badge-cyan'), false, h('div', { class: 'stream-list', id: 'streamList' })],
      ['Bounding box & topology', badge('unitBadge', 'badge-cyan'), true, h('div', { class: 'kv-grid', id: 'bboxGrid' })],
      ['Detected features', badge('featureCountBadge', 'badge-emerald'), false, h('div', { class: 'feature-list', id: 'featureList' })],
      ['Product tree & attachments', badge('treeCountBadge', 'badge-cyan'), false, [
        h('div', { class: 'feature-list', id: 'treeList', style: 'max-height:220px;overflow:auto;font-size:11px;' }),
        h('div', { class: 'feature-list', id: 'attachList' })]]
    ]) {
      ui.infoBody.append(h('details', { class: 'sm-sec', open: !!open }, h('summary', null, h('span', { text: title }), badgeEl),
        h('div', { class: 'sm-sec-b' }, h('div', { class: 'sm-panel' }, content))));
    }
    // Solid Bodies sheet: Show all / Invert (app.js binds them by id) above the body list
    ui.partsBody.append(
      h('div', { class: 'sm-parts-actions' },
        h('button', { type: 'button', class: 'btn btn-sm', id: 'btnShowAllParts', text: 'Show All' }),
        h('button', { type: 'button', class: 'btn btn-sm', id: 'btnInvertParts', text: 'Invert' })),
      h('div', { class: 'part-list', id: 'partList' }));

    // ---------- About dialog
    ui.about = h('div', { id: 'smAbout', class: 'sm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'smAboutTitle', tabindex: '-1', hidden: true },
      h('div', { class: 'sm-sheet-h' }, h('h2', { id: 'smAboutTitle', text: 'Supported formats' }),
        h('button', { type: 'button', class: 'btn btn-sm sm-close', 'aria-label': 'Close', text: '×', onclick: () => hideAbout() })),
      h('dl', null,
        h('dt', { text: 'Opens' }), h('dd', null, '3D PDF (', h('code', { text: '.pdf' }), ') with embedded U3D (ECMA-363) or PRC (ISO 14739-1) streams, plus raw ', h('code', { text: '.u3d' }), ' / ', h('code', { text: '.prc' }), ' files.'),
        h('dt', { text: 'STEP' }), h('dd', null, h('code', { text: '.stp' }), ' AP214 B-Rep, ready for Siemens NX and most CAD tools.'),
        h('dt', { text: 'STL' }), h('dd', null, h('code', { text: '.stl' }), ' triangle mesh, binary or ASCII.'),
        h('dt', { text: 'OBJ' }), h('dd', null, h('code', { text: '.obj' }), ' mesh with body groups and normals.'),
        h('dt', { text: 'IGES' }), h('dd', null, h('code', { text: '.igs' }), ' 5.3 feature-edge wireframe curves.'),
        h('dt', { text: 'Raw' }), h('dd', null, 'The extracted ', h('code', { text: '.u3d' }), ' / ', h('code', { text: '.prc' }), ' stream bytes.'),
        h('dt', { text: 'Settings' }), h('dd', { text: 'Units, body type and reduce detail are in the Export dialog. Stream sizes, bounds and the product tree are under Info.' }),
        h('dt', { text: 'Specs' }), h('dd', { text: SPECS })));

    // ---------- Help dialog (More > Help, 1.7.0)
    ui.help = h('div', { id: 'smHelp', class: 'sm-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'smHelpTitle', tabindex: '-1', hidden: true },
      h('div', { class: 'sm-sheet-h' }, h('h2', { id: 'smHelpTitle', text: 'Controls' }),
        h('button', { type: 'button', class: 'btn btn-sm sm-close', 'aria-label': 'Close', text: '×', onclick: () => hideAbout() })),
      h('dl', null, HELP_ROWS.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])));

    document.body.append(ui.menuMore, ui.menuDisplay, ui.menuView, ui.menuViewMore, ui.partsSheet, ui.infoSheet, ui.about, ui.help);

    // ---------- popover wiring
    bindPopover(ui.btnMore, ui.menuMore, { align: 'right' });
    bindPopover(ui.btnDisplay, ui.menuDisplay, { onOpen: syncDisplay });
    bindPopover(ui.btnView, ui.menuView, { onOpen: syncProjection });
    document.addEventListener('pdf3d:viewprefs', () => { syncDisplay(); syncProjection(); });
    document.addEventListener('pdf3d:viewchange', () => { syncDisplay(); syncViewMore(); });
    bindPopover(ui.btnViewMore, ui.menuViewMore, { align: 'right', onOpen: syncViewMore });

    // ---------- live state
    observe(ui.docName, () => { ui.docName.title = ui.docName.textContent; syncEmpty(); }, { childList: true, characterData: true, subtree: true });
    document.addEventListener('pdf3d:status', syncStatus);
    // a new PDF3D.lastLoad without a status change (stream switch, test stubs): re-read it
    document.addEventListener('pdf3d:lastload', () => syncStatus());
    observe($('partList'), syncPartCount, { childList: true });

    // ---------- global keyboard / pointer handling
    document.addEventListener('pointerdown', (ev) => {
      if (openPop && !openPop.pop.contains(ev.target) && !openPop.trigger.contains(ev.target)) closePop(false);
      if (openDialog && !openDialog.contains(ev.target) && !ui.menuMore.contains(ev.target)) hideAbout();
    }, true);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (openDialog) { ev.preventDefault(); hideAbout(); return; }
      if (openPop) { ev.preventDefault(); closePop(true); return; }
      const s = [ui.infoSheet, ui.partsSheet].find((x) => !x.hidden && x.contains(document.activeElement)) ||
                [ui.infoSheet, ui.partsSheet].find((x) => !x.hidden);
      if (s) { ev.preventDefault(); toggleSheet(s, false, true); }
    });
    window.addEventListener('resize', () => {
      if (openPop) positionPop(openPop);
      syncSheetTop();
    });

    // ---------- whole-page drag & drop
    let depth = 0;
    const hasFiles = (ev) => ev.dataTransfer && [...(ev.dataTransfer.types || [])].includes('Files');
    const veil = (on) => { ui.dropVeil.hidden = !on; };
    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      depth++; veil(true);
    });
    window.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      veil(true);
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) veil(false);
    });
    window.addEventListener('drop', (ev) => {
      depth = 0; veil(false);
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      forwardFiles(ev.dataTransfer.files);
    });

    // ---------- keyboard-reachable selectable rows
    enhanceRows($('partList'), '.part-item', 'selected', BODIES);
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

  // Hand dropped files to app.js through its own #fileInput 'change' handler (reads ev.target.files[0]).
  function forwardFiles(files) {
    if (!files || !files.length) return;
    const input = $('fileInput');
    try {
      const dt = new DataTransfer();
      dt.items.add(files[0]);
      input.files = dt.files;
      fire(input, 'change');
    } catch (e) { console.warn('[PDF3D] could not open the dropped file:', e); }
  }

  // ------------------------------------------------------------------ sync helpers (read app.js state)
  function syncStatus() {
    const b = status();
    const t = (b.text || '').trim();
    const tone = b.tone || '';
    let m, short;
    if (/NO 3D STREAM/.test(t)) short = 'Attachment only';
    else if (/NO MESH/.test(t)) short = 'No mesh found';
    else if ((m = t.match(/WATER-TIGHT[^(]*\((\d+) SOLIDS?\)/))) short = `${m[1]} watertight solid${m[1] === '1' ? '' : 's'}`;
    else if ((m = t.match(/(\d+) BODIES EXTRACTED/))) short = `${m[1]} bod${m[1] === '1' ? 'y' : 'ies'} extracted`;
    else if (/^READY/.test(t)) short = 'Ready';
    else short = t.length > 30 ? t.slice(0, 30) + '…' : t;
    if (tone === 'warn' && b.title && !/No mesh|Attachment/.test(short)) short += ' · warnings';
    ui.status.dataset.tone = tone;
    ui.status.dataset.short = short;   // the old chip wording, kept for the tooltip
    syncBodies();
    // A decode error's raw text stays in the console (app.js console.error + syncEmpty's console.warn); the chip's
    // hover text uses the approved card line instead.
    const ll = (window.PDF3D || {}).lastLoad;
    let tip = t + (b.title ? '\n' + b.title : '');
    // the damaged-load warning text stays in the console (syncDamaged); the note beside the chip says it in plain words
    const dmg = ll && typeof ll.damaged === 'string' ? ll.damaged.trim() : '';
    if (dmg) tip = tip.split('\n').filter((l) => l.trim() !== dmg).join('\n');
    // NO 3D STREAM: the status text carries the raw attachment name; the UI shows the sanitized fileName (attachment card line)
    const ac = /NO 3D STREAM/.test(t) ? attCard(ll) : null;
    ui.statusT.title = /NO MESH/.test(t) && ll && ll.reasonCode === 'DECODE_ERROR' ? loadCard(ll).line : ac ? ac.lines[0] : tip;
    syncDamaged();
    syncEmpty();
  }
  // N in "Bodies Detected: N" = solid bodies (parts) of the loaded stream
  function syncBodies() {
    if (!ui.bodies) return;
    let n = 0;
    try { n = window.CAD3DExtractor.getState().parts.length; } catch (e) { /* ignore */ }
    const t = String(n);
    if (ui.bodies.textContent !== t) ui.bodies.textContent = t;
  }
  function syncProjection() {
    const p = window.PDF3DView ? window.PDF3DView.get() : null;
    for (const it of ui.projItems || []) setChecked(it.it, !!p && p.projection === it.key);
  }
  function syncDisplay() {
    if (!ui.displayItems) return;
    const vp = window.PDF3DView ? window.PDF3DView.get() : null;
    for (const b of ui.bgItems || []) setChecked(b.it, !!vp && vp.background === b.key);
    if (ui.gridItem) setChecked(ui.gridItem, !!vp && !!vp.grid);
    const mode = viewState().renderMode;
    for (const d of ui.displayItems) setChecked(d.it, d.key === mode);
    ui.displayLabel.textContent = RENDER_LABELS[mode] || '';
  }
  function syncViewMore() {
    const v = viewState();
    ui.explode.value = String(v.explode || 0);
    ui.explodeOut.textContent = ui.explode.value + '%';
    const GL = window.PDF3DViewerGL;
    for (const o of ui.viewOpts || []) setChecked(o.it, !!(GL && GL.options[o.key]));
    for (const o of ui.orbitItems || []) setChecked(o.it, v.orbitMode === o.key);
  }
  function syncPartCount() {
    const list = $('partList');
    if (!list || !ui.partCount) return;
    // 1.8.0: the eye button replaced the checkbox; a hidden body's row has class is-hidden
    const rows = list.querySelectorAll('.part-item');
    const vis = [...rows].filter((r) => !r.classList.contains('is-hidden')).length;
    ui.partCount.textContent = rows.length ? (vis === rows.length ? String(rows.length) : `${vis}/${rows.length}`) : '0';
    ui.btnParts.title = rows.length ? `${vis} of ${rows.length} bodies visible` : 'No bodies';
    syncBodies();
    syncEmpty();
  }
  function syncEmpty() {
    if (!ui.empty) return;
    let nParts = 0;
    try { nParts = window.CAD3DExtractor.getState().parts.length; } catch (e) { /* ignore */ }
    const t = status().text || '';
    const loaded = /NO MESH|NO 3D STREAM/.test(t);
    ui.empty.hidden = nParts > 0;
    const ll = (window.PDF3D || {}).lastLoad;
    const card = loaded && ll ? loadCard(ll) : null;
    if (card && ll.reasonCode === 'DECODE_ERROR' && warnedLoad !== ll) { warnedLoad = ll; console.warn('[PDF3D] 3D decode error:', ll.detail); }
    ui.emptyCard.dataset.tone = card ? card.tone : '';
    ui.emptyTitle.hidden = ui.emptyLine.hidden = !card;
    // embedded files (1.6.2 attachmentDetails): NO_3D becomes the attachment card; other load cards keep their own
    // title and line and list the files under it
    const att = card ? attCard(ll) : null;
    if (att && ll.reasonCode === 'NO_3D') { card.tone = 'att'; card.title = att.title; card.line = att.lines[0]; }
    if (att) ui.emptyCard.dataset.tone = card.tone;
    ui.emptyTitle.textContent = card ? card.title : '';
    ui.emptyLine.textContent = card ? card.line : '';
    renderAtt(att, ll, att && ll.reasonCode === 'NO_3D');
    ui.emptyText.className = card ? 'sm-empty-hint' : '';
    ui.emptyText.textContent = card
      ? 'Drop another 3D PDF here or click Open.'
      : loaded
      ? `No 3D geometry found in ${(ui.docName.textContent || 'this file').trim()}. Drop another 3D PDF here or click Open.`
      : 'Drop a 3D PDF here or click Open';
  }

  // Load-result cards (Designer wording). The raw decode error never goes on the card; it is console.warn'ed once.
  var warnedLoad = null;
  function loadCard(ll) {
    switch (ll.reasonCode) {
      case 'UNSUPPORTED_MESH': return { tone: 'warn', title: "This 3D model can't be read yet",
        line: `The PDF has a 3D model, but it's saved in a format the app doesn't support yet (${ll.format}, ${ll.detail}).` };
      case 'NO_3D': return { tone: 'muted', title: 'No 3D model in this PDF',
        line: 'This PDF has no 3D content. A 3D PDF shows a model you can rotate in Acrobat.' };
      case 'DECODE_ERROR': return { tone: 'warn', title: "Couldn't read this 3D model",
        line: 'The PDF has a 3D model, but part of it is damaged or saved in an unexpected way.' };
      default: return null;
    }
  }

  // ------------------------------------------------------------------ attachment card (lastLoad.attachmentDetails)
  // Names shown are always attachmentDetails[i].fileName (Dev's sanitized save name), never the raw PDF name.
  function attList(ll) { return ll && Array.isArray(ll.attachmentDetails) ? ll.attachmentDetails : []; }
  const attName = (a, i) => String((a && typeof a.fileName === 'string' && a.fileName) || `attachment-${i + 1}.bin`);
  function humanSize(n) {
    n = Math.max(0, +n || 0);
    if (n < 1024) return n + (n === 1 ? ' byte' : ' bytes');
    const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, k = 0;
    while (v >= 1024 && k < u.length - 1) { v /= 1024; k++; }
    const r = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    return (r >= 1024 && k < u.length - 1 ? (r / 1024).toFixed(1) + ' ' + u[k + 1] : r + ' ' + u[k]);
  }
  // up to 3 names, then "and {k} more": a / a and b / a, b and c / a, b, c and 5 more
  function nameList(names) {
    if (names.length <= 1) return names.join('');
    if (names.length <= 3) return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
    return names.slice(0, 3).join(', ') + ' and ' + (names.length - 3) + ' more';
  }
  function attCard(ll) {
    const atts = attList(ll);
    if (!atts.length) return null;
    const all = atts.map((a, i) => ({ i, a: a || {}, name: attName(a, i), bad: !!(a && a.error) }));
    const ordered = all.filter((x) => x.a.isCAD).concat(all.filter((x) => !x.a.isCAD));   // CAD first, PDF order within
    const one = all.length === 1 && all[0].a.isCAD && !all[0].bad;
    const lines = [one ? `This PDF has ${all[0].name} (${humanSize(all[0].a.size)}) attached.`
      : `It has ${all.length} attached file${all.length === 1 ? '' : 's'}: ${nameList(ordered.map((x) => x.name))}.`];
    for (const x of ordered) if (x.bad) lines.push(`${x.name} couldn\u2019t be read.`);
    return { tone: 'att', title: one ? 'No 3D model, but a CAD file is attached' : 'No 3D model in this PDF', lines,
      items: ordered.filter((x) => !x.bad), one };
  }
  function renderAtt(att, ll, titled) {
    const box = ui.attBox;
    if (!att) { box.hidden = true; box.textContent = ''; ui.attFor = null; return; }
    box.hidden = false;
    // rebuild only for a new load or new content (syncEmpty runs on every DOM change; a rebuild would drop focus and progress)
    const sig = att.lines.join('\n') + '\n' + att.items.map((x) => x.i + ':' + x.name + ':' + x.a.size).join('|');
    if (ui.attFor === ll && ui.attSig === sig && box.dataset.titled === String(!!titled)) return;
    ui.attFor = ll; ui.attSig = sig; box.dataset.titled = String(!!titled); box.textContent = '';
    // lines: under the attachment title the first line is already ui.emptyLine; under another load card all lines go here
    for (const l of titled ? att.lines.slice(1) : att.lines) {
      box.append(h('span', { class: 'sm-att-line' + (/couldn\u2019t be read\.$/.test(l) ? ' sm-att-line--warn' : ''), text: l }));
    }
    const items = att.items;
    if (!items.length) return;
    const list = h('div', { class: 'sm-att-list', id: 'smAttList', role: 'list', 'aria-label': 'Attached files' });
    const rows = items.map((x, k) => {
      const label = `Save ${x.name}`;
      const sz = h('span', { class: 'sm-att-size', id: 'smAttSz' + x.i, text: humanSize(x.a.size) });
      const btn = h('button', { type: 'button', class: 'btn ' + (k === 0 ? 'btn-primary ' : '') + 'sm-att-save', 'data-att': String(x.i),
        'aria-describedby': 'smAttSz' + x.i, text: label });
      btn.dataset.label = label;
      btn.addEventListener('click', () => saveAtt(x, btn));
      const row = h('div', { class: 'sm-att-row', role: 'listitem' }, btn, sz);
      if (k >= 3) row.hidden = true;
      list.append(row);
      return row;
    });
    box.append(list);
    if (items.length > 3) {
      const more = h('button', { type: 'button', class: 'sm-att-more', 'aria-expanded': 'false', 'aria-controls': 'smAttList', 'data-sm': 'att-more',
        text: `Show all ${items.length}` });
      more.addEventListener('click', () => {
        const open = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Show fewer' : `Show all ${items.length}`;
        rows.forEach((r, k) => { if (k >= 3) r.hidden = !open; });
        if (open && rows[3]) rows[3].querySelector('button').focus({ preventScroll: true });
      });
      box.append(more);
    }
  }
  function saveAtt(x, btn) {
    if (ui.attBusy || btn.getAttribute('aria-disabled') === 'true') return;
    const XF = window.PDF3DExportFlow;
    const btns = [...ui.attBox.querySelectorAll('.sm-att-save')];
    const busy = (on) => { ui.attBusy = on; for (const b of btns) if (b !== btn) { if (on) b.setAttribute('aria-disabled', 'true'); else b.removeAttribute('aria-disabled'); } };
    busy(true);
    let p;
    // the Save-as picker, streaming, close / abort and the result card live in export-flow.js (same machinery as exports)
    if (XF && typeof XF.saveAttachment === 'function') p = XF.saveAttachment(x.i, { button: btn, label: btn.dataset.label });
    else p = plainDownload(x);
    Promise.resolve(p).catch(() => {}).then(() => busy(false));
  }
  // no export-flow.js: plain download of the engine's blob (no card; errors only go to the console)
  async function plainDownload(x) {
    const NS = window.PDF3D || {};
    if (typeof NS.saveAttachment !== 'function') return;
    const r = await NS.saveAttachment(x.i, {});
    if (!r || r.status !== 'ok' || !r.blob) { console.warn('[PDF3D] attachment not saved:', r && r.reasonCode); return; }
    const url = URL.createObjectURL(r.blob);
    const a = h('a', { href: url, download: r.filename || x.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ------------------------------------------------------------------ partial (damaged) load note
  var warnedDamaged = null;
  function syncDamaged() {
    if (!ui.dmg) return;
    const ll = (window.PDF3D || {}).lastLoad;
    const raw = ll && ll.status === 'ok' && typeof ll.damaged === 'string' ? ll.damaged.trim() : '';
    if (raw && warnedDamaged !== ll) { warnedDamaged = ll; console.warn('[PDF3D] model loaded partly:', ll.damaged); }
    const on = !!raw && ui.dmgDismissed !== ll;
    ui.dmg.hidden = !on;
    if (!on) return;
    const n = Number.isFinite(+ll.parts) && +ll.parts > 0 && typeof ll.parts !== 'boolean' ? Math.round(+ll.parts) : 0;
    const t = n ? `Part of this model couldn\u2019t be read, so only ${n} ${n === 1 ? 'body' : 'bodies'} loaded.`
      : 'Part of this model couldn\u2019t be read, so some bodies may be missing.';
    if (ui.dmgText.textContent !== t) { ui.dmgText.textContent = t; ui.dmg.title = t; }
  }

  // ------------------------------------------------------------------ About dialog
  // About formats and Help (1.7.0) share this: one modal dialog at a time
  function showAbout(dlg) {
    const d = dlg || ui.about;
    closePop(false);
    if (openDialog && openDialog !== d) openDialog.hidden = true;
    d.hidden = false;
    openDialog = d;
    const c = d.querySelector('.sm-close');
    if (c) c.focus();
  }
  function hideAbout() {
    if (!openDialog) return;
    openDialog.hidden = true;
    openDialog = null;
    ui.btnMore.focus({ preventScroll: true });
  }

  function init() {
    if (!$('viewportCanvas') || !document.body) return;   // not the extractor page
    try { localStorage.removeItem(OLD_MODE_KEY); } catch (e) { /* private mode */ }
    document.body.classList.add('sm-simple');
    build();
    syncSheetTop();
  }

  window.PDF3DSimpleMode = {
    labels: { render: RENDER_LABELS, bodies: BODIES, background: BG_LABELS, projection: PROJ_LABELS, help: HELP_ROWS, specs: SPECS }
  };

  // Script is loaded after app.js at the end of <body>, so the viewport markup already exists: build the UI now.
  // app.js binds its listeners (#fileInput, Show All / Invert) on DOMContentLoaded, after these elements exist.
  if (document.readyState === 'loading' && !$('viewportCanvas')) document.addEventListener('DOMContentLoaded', init);
  else init();
})();
