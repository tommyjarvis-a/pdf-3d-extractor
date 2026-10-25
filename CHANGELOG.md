# Changelog

## 1.5.0 — Unreleased

### Added
- **Export as CAD surfaces (STEP)**, in both modes through Designer's export UI (`cad-export-ui.js` / `cad-export-ui.css`):
  a **CAD surfaces (STEP)** item with a **Fitted solid only** option in Simple's Export ▾ menu, and a **CAD Surfaces (.stp)**
  button with a **Fitted only** checkbox in Advanced. Rebuilds a CAD model from a PRC part's triangle
  mesh: it fits planes, cylinders, cones, spheres, tori, B-splines and helical faces (screw threads), trims them, and
  sews them into a closed, validated solid with OpenCascade. The STEP AP214 file holds the fitted `<part>_fitted`
  body plus the app's usual mesh body as `<part>_mesh` (*fitted only* leaves the mesh body out).
  - Runs in a Web Worker; the viewer stays usable. A progress toast shows the stage, percent, elapsed time and **Cancel**,
    then a plain-language result (fitted solid, open shell, mesh body only, nothing exported, cancelled).
  - The CAD kernel (opencascade.js 2.0-beta, LGPL-2.1, `recon/vendor/opencascade/`) loads only on first use: 13.7 MB
    gzip / 50.3 MB raw. The worker is terminated after each export, which frees its memory.
  - Reference parts compared with the Python pipeline (`score.py`):
    - NX 2512 head_test: 421 faces, closed and valid, volume +0.145% (Python +0.102%), fit→ref RMS 0.024 mm (Python 0.024 mm), mesh→fit max 0.106 mm (Python 0.119 mm), 237/329 face types matched (same as Python), about 45 s in Chrome.
    - screw: 34 faces including 5 helical, closed and valid, volume −0.012% (Python −0.013%), fit→ref max 0.0123 mm (Python 0.0127 mm), about 22–25 s in Chrome.
  - Fallbacks:
    - U3D models, the bundled legacy sample, and PRC selections above 200k triangles (e.g. r16, r17 engine) export the mesh body only (`mesh_only`).
    - Selections above 1M triangles (r05 grinder, r13) are refused (`too_large`).
    - Fit failures or out-of-memory fall back to the mesh body.
  - Not available in the single-file offline build or from `file://`. The menu item and button are disabled with an explanation.
  - Scripting API for the UI: `PDF3D.canExportCadSurfaces(partIds)` and `PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal })`. See `recon/README.md`.
- `CAD3DExtractor.buildSTEPAP214({ parts })` accepts an explicit part list. The PRC decoder can return per-corner
  normal indices (`withNormals`, opt-in, used by the fitter); default output is unchanged.

## 1.4.1 — 2026-10-25

### Fixed
- Simple mode on macOS Safari: every item inside the Simple-mode drop-down menus did nothing. That covers the Export ▾ formats, Display ▾, View ▾, More ▾ orbit and line toggles, and ⋯ About formats / Load sample. They only seemed to work after switching to Advanced and back, because the work was then done with the Advanced controls.
  - Root cause, found by Designer: Safari on macOS never focuses a clicked button. Pressing a menu item moved focus to `<body>`, so the popover's `focusout` handler closed the menu before the click landed and the item's action never ran. Firefox on macOS behaves the same way.
  - Fix (Designer, `simple-mode.js`): `bindPopover` ignores focus loss while a pointer is down inside the popover.
- The Simple | Advanced switch no longer jumps when you change modes. Before, it sat in the Simple top bar left of Open and floated at the top-right in Advanced, 292 px apart at 1280 and 1920 px.
  - Above 720 px it is now pinned at `top: 12px; right: 16px` in both modes, and Simple reserves its width with an empty slot at the end of the top bar. Fix by Designer (`simple-mode.js`, `simple-mode.css`).
  - Phones (720 px and below) are unchanged. Advanced on 721–900 px screens now keeps the switch at the top-right instead of the bottom-right corner.
- `sample-pdf-b64.js` now has a `?v=` cache-bust like every other script, so browsers don't keep a stale copy after an update.

### Tests
- Designer's `test/safari-focus.test.js` simulates Safari's focus behaviour in Chrome (`SAFARI=1`).
- Designer's suite (`test/test.js`) gains R141 regression checks:
  - **R141-A** opens a fresh profile, stays in Simple only, opens sample2 and an NX 2512 PDF through Open, and checks app state or downloaded file names for every Simple control, including the selects and the Explode slider. It runs in Chromium and Playwright WebKit, both with native focus and with Safari-style focus.
  - **R141-B** checks that the switch keeps the same rect (within 1 px) across mode switches at 1024, 1280, 1440 and 1920 px.

## 1.4.0 — 2026-10-25

### Fixed
- 3D preview glitches: polygons disappearing/reappearing and "tiger striping" while rotating, dark sliver triangles from back faces over bore walls, the bottom fan showing through walls, and PRC wires / B-Rep edges drawn over solid geometry. The cause was the Canvas 2D painter's-algorithm renderer: per-triangle depth sorting, per-triangle antialiasing seams, and no depth test for lines.

### Changed
- New WebGL preview renderer (`viewer-gl.js`, no dependencies). It uses WebGL2, falls back to WebGL1 (with `OES_element_index_uint` for 32-bit indices, or de-indexed draws without it), and falls back to the old Canvas 2D path only when WebGL is unavailable or when you add `?gl=0`.
  - Real 24-bit depth buffer. Near/far planes are fitted to the visible model's bounding sphere every frame (`near = max(d - 1.05r, 0.001r)`, `far = d + 1.05r`). The camera is the same orthographic Z-up turntable as before.
  - Smooth per-vertex normals with a 30° crease angle, split by B-Rep face group. These are tolerant of inconsistent winding because opposite-facing neighbours are sign-aligned. Lighting is two-sided via `gl_FrontFacing` with no backface culling. A "Flat" option gives faceted shading.
  - Feature edges, PRC wires and the optional triangle-mesh overlay are depth-tested. Faces use `polygonOffset` and lines get a small depth bias, so hole outlines do not shimmer. Edges and wires are drawn as screen-space quads, so their width is consistent at any devicePixelRatio.
  - New "Lines:" toolbar options: **Wires** (PRC wires/curves, now off by default), **Hidden** (dimmed hidden edges/wires), **Mesh** (triangle wireframe overlay) and **Flat**. All viewer controls sit in one container, `#viewerControls`.
  - Renders on demand: frames are coalesced into `requestAnimationFrame` and drawn only when the camera or state changes. Handles resize and devicePixelRatio, and context loss/restore. GPU buffers are cached per part, freed when a new file or stream is loaded, and capped at about 900 MB (LRU).
  - The preview cap in WebGL mode is raised from 200k to 2M triangles, with vertex-clustered decimation above that. The Canvas 2D fallback keeps the 200k cap.
- Free rotation: the default orbit is now an unclamped quaternion arcball. The model spins fully around every axis, including over the top and upside down, with no gimbal lock. Previously pitch was clamped to ±1.48 rad (about ±85°) in the Z-up turntable. Ctrl/Alt/Cmd+drag or middle-drag twists about the view axis; Shift/right-drag still pans.
  - New "Orbit: Free / Turntable (Z-up)" toggle keeps the old turntable available. The choice is saved in `localStorage` (`pdf3d.orbitMode`).
  - New "Reset view" button. The Iso/Top/Front/Right presets work in both modes. Both renderers share one camera basis (`window.PDF3DCamera`), and pointer redraws are coalesced to one per animation frame.
- Clearer viewer UI. Every interactive control is a button or toggle with hover, keyboard focus ring and pointer cursor. The Lines options are now toggle buttons with an on/off indicator instead of bare checkboxes, and Explode is a bordered slider control. Group captions (Display / View / Orbit / Lines) are plain uppercase labels. Read-only info in the viewport (stream, solids/faces/tris, bounds, units, renderer + tris drawn + ms/frame + GPU MB) is muted plain text with no panel or button styling, kept apart from the toolbar.
- Canvas 2D fallback: every filled triangle also gets a same-colour hairline stroke, which closes the antialiasing seams between adjacent triangles. It also respects the Wires toggle.

### Added (Simple mode)
- Designer's **Simple mode** (`simple-mode.js`, `simple-mode.css`) is now the default UI. It offers a floating viewer toolbar, a More menu, and Parts/Export sheets that proxy the original controls, so nothing is duplicated or lost. Switch to **Advanced** from the header. The choice is saved in `localStorage` (`pdf3d-extractor.uiMode`), and `?ui=advanced` (or `?ui=simple`) forces a mode without saving it.
- `affordance.css` (Designer) applies in both modes: clearer buttons, segmented tracks for Display/View, and focus rings. The 1.4.0 `#viewerControls` styles (Orbit track, Lines toggles, Explode slider) are scoped so they don't fight it.
- Viewport hint: "Click part in tree to highlight" now reads "Click a part in Parts to highlight" in Simple mode and "Click a part in the part list to highlight" in Advanced (rewritten by `simple-mode.js`; the markup keeps the old phrase it keys on).
- `tools/build-standalone.js` now inlines stylesheets as well as scripts, and fails if any external script or stylesheet is left over.

### Fixed (QA)
- "Reduce detail" on low-poly parts: at 50%, the 22-part dice (g01–g05, g10, r15) kept only 8.3% of its triangles. `decimateCompact` stopped its grid search after 9 steps and fell back to the coarsest grid. The search now runs to convergence and keeps the grid whose triangle count is closest to the target. Measured at 50%: g01 0.44 (was 0.08), r12 0.52, r11 0.50, r14 0.50. A part that no grid can reduce is kept as is.
- The large-model banner now counts triangles as parsed from the file (r05 1,290,707), not the B-Rep/STL count (1,290,550), which excludes degenerate triangles. `computeAssemblyBounds` also returns `totalParsedTris`.
- Dense models (r17 engine, r05 grinder) looked dark and cluttered in the default Shaded + edges mode because a B-Rep edge was drawn on nearly every facet. The viewer now draws only feature edges, meaning boundary/non-manifold edges and edges with a dihedral angle above 30° (`displayEdges` in `viewer-gl.js`). It also fades a part's edges out when they would be packed only a few pixels apart on screen (under about 4–16 px² of projected part surface per edge), so zoomed-out dense parts look like 1.3.0 and their edges come back as you zoom in. The selected part's edges are always drawn. Exports (IGES feature edges included) are unchanged.
- All version strings now say 1.4.0 (`APP_VERSION`, header brand, the `?v=` cache-busts in `index.html`, README, standalone build), so returning visitors don't mix the new page with cached 1.3.0 scripts.

### Known limitations
- Touch controls on phones are deferred to a later release: one-finger orbit, pinch zoom and two-finger pan in the viewport don't work yet, and the viewport hint shows mouse wording. On a phone, use the View presets and Fit/Reset.

## 1.3.0 — 2026-10-24

Large models (1M+ triangles) no longer exhaust memory, and the vendor U3D mesh in RHAdobeMeshResource files is decoded. Much of this release builds on the QA Tester's root-cause analysis and prototypes (`pdf-3d-extractor-qa/fixes/`, REPORT.md "Problem files").

### Fixed
- Out-of-memory on very large models (corpus r05 1.29M tris, r07 650k, r13 1.99M). The Tester traced it to the legacy per-part B-Rep (about 1.1 KB per triangle, cached for the session and rebuilt for each of r05's 956 instances of 247 tessellations). Now:
  - PRC parts are kept as typed arrays (`Float64Array` positions, `Uint32Array` indices).
  - Each part gets one compact, welded B-Rep (`vx`/`tv`/`fev` typed arrays). The full object form is re-expanded per part only while exporting XT/STEP, and cached only for models of 300k tris or fewer.
  - Every exporter (STL, ASCII STL, OBJ, IGES, STEP AP214, Parasolid X_T) streams part by part into line-aligned chunks that become a chunked `Blob`, so no single huge string or array is ever built. STL and OBJ never build a B-Rep.
    - *Correction (1.4.0):* STL and OBJ **do** build the compact B-Rep: `exportPartList` calls `computePartBRep` for every visible part, and the STL triangles are its non-degenerate, welded triangles. What they skip is the full object-form B-Rep that XT/STEP re-expand per part.
  - Measured peak RSS (headless, Node) for parse plus STL/OBJ: r05 0.48 GB, r13 0.61 GB, r07 0.50 GB. Before, r05 hit 1.9 GB after STL and 2.7 GB after OBJ, r13 hit 3.0 GB after STL, and STEP/XT ran out of memory at 9–10 GB.
    - *Correction (1.4.0):* the QA harness re-measured 667668f at r05 0.57 GB, r13 0.87 GB and r07 0.39 GB peak RSS. The figures above were partly optimistic; the out-of-memory fix itself stands.
- U3D `RHAdobeMeshResource` (Right Hemisphere / Adobe mesh compression, corpus r09): geometry is now decoded (142k tris, 2 bodies) instead of "unsupported". Uses the Tester's `u3d-rhadobe-mesh.js`, written from the Acrobat SDK 8.1 "U3D Supported Elements" spec. Encodings 8/9 (U3D arithmetic) are not implemented; a file that uses them still gets the clear "unsupported" message.
  - *Note (1.4.0):* r09 decodes to 142,104 triangles per stream (99,211 verts), which matches the Tester's standalone decoder and `test/expect.json`. The viewer HUD and STL/OBJ/STEP show 142,042 because 62 source triangles are degenerate: each has two distinct vertex indices with bit-identical positions (zero area, no duplicate indices), and the B-Rep weld drops them. No real triangles are lost.
- Standalone `prc-decoder.js`: `extractPRCFromPDF` now raises a clear `PDF_ENCRYPTED` error rather than failing to inflate encrypted streams. The new `extractPRCFromPDFAsync` / `parsePRCFromPDF` use `pdf-extract.js` + `crypto-lite.js` to read owner-password RC4/AES files (corpus r11, r12, g06).

### Added
- Decimated viewer preview: the viewport draws at most 200k triangles and 150k edges, using vertex clustering with a per-part cached preview. The inspector skips the XT/STEP text preview above 200k tris.
- Banner for models above 1M triangles explaining the preview and memory behaviour.
- Optional "Export detail" setting (100% / 50% / 25% / 10%) that decimates exported meshes. It defaults to 100%, so exports are unchanged unless you choose otherwise.
- Export builders in the `window.CAD3DExtractor` API accept options (`{blob:true, detail}`), and `computeAssemblyBounds` is exposed.

### Changed
- Parasolid .x_t export hidden pending NX compatibility fix (code retained, ?xt=1 to re-enable for testing). STEP AP214 is now the primary export and the default inspector tab; unit labels and the viewport HUD no longer mention XT.
- Exports at full detail are byte-identical to 1.2.0 on the 9-file reference set (STL/OBJ/IGES/STEP/XT hashes).
- `pdf-3d-extractor-standalone.html` regenerated.

### Credits
- QA Tester: root-cause memory analysis, the `prc-stream-extract.js` streaming prototype (r05 at 219 MB, r13 at 244 MB peak), the `u3d-rhadobe-mesh.js` RHAdobeMeshResource decoder, the regression harness and corpus.

## 1.2.0 — 2026-10-24

### Added
- PRC decoder (`prc-decoder.js`):
  - reads the full file structure, schema and model trees
  - supports `TESS_3D`, `TESS_3D_Compressed` and wire tessellation
  - builds the product-occurrence tree, with transforms and the `/3DU` unit scale
  - handles multiple annotations per PDF
- Exact B-Rep path (`prc-brep.js`): decodes `TOPO_BrepData` and `TOPO_BrepDataCompress` and tessellates it for display and export, for files that contain no tessellation.
- Robust PDF layer (`pdf-extract.js`, `crypto-lite.js`):
  - xref streams, object streams, recovery, all common filters
  - RC4 and AES-128/256 decryption
  - `/RichMedia` support
- Embedded CAD attachment detection and saving (`/EmbeddedFiles` and `/FileAttachment`).
- "Product Tree & Attachments" panel and wire rendering.
- `u3d-guard.js`: bounded U3D reads; `RHAdobeMeshResource` is reported as unsupported.
- `test/run.js` corpus regression runner and `tools/build-standalone.js`.

### Fixed
- `RangeError: Invalid string length` on large exports: chunked output plus a `Blob` download, and the inspector preview is truncated.
- Large `TESS_3D_Compressed` models decode without overflow (corpus r17: 402,680 tris).
- Streams that decoded with 0 triangles because the tessellation was compressed or the geometry was exact B-Rep only.

### Changed
- Status badge now reports the decode path: PRC tess, exact B-Rep, U3D, embedded CAD attachment, or none.
- `pdf-3d-extractor-standalone.html` regenerated with all scripts inlined.
