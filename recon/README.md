# recon/ — "Export as CAD surfaces (STEP)" (feature/cad-surfaces, targeted at 1.5.0)

Turns the triangle mesh of a PRC part into a fitted B-Rep: planes, cylinders, cones, spheres, tori, B-splines and
helical sweeps. The result is sewn into a solid with OpenCascade (opencascade.js, WASM) and written as STEP AP214
next to the app's own mesh body. This is a JS port of the Python pipeline in nx-prc-analysis.

## Files

| file | role |
|---|---|
| `cad-export.js` | main thread: `window.PDF3D` API, policies (limits, fallbacks), mesh body + merge (no UI; see `cad-export-ui.js`) |
| `cad-worker.js` | classic Web Worker: fetches the kernel (with progress), decodes the PRC, fits, builds, validates, writes the fitted STEP. Started per export, terminated afterwards (frees the WASM heap) |
| `fit.js`, `fit-linalg.js` | mesh segmentation and surface fitting (primitives, B-spline grids, helical faces, rotational symmetry copies) |
| `occ-build.js` | topology, edges, trimmed faces, sewing, ShapeFix, validity check, XCAF STEP writer |
| `pipeline.js` | `runPart` (fit → build → validate, solid / shell / mesh_only per part), `writeFitted` |
| `step-merge.js` | merges STEP texts into one file (entity ids shifted). `mergeSTEPChunks` streams the app's chunked output into Blob parts |
| `tools/e2e-node.mjs`, `tools/fit-node.cjs` | Node end-to-end and fitting-only runs (no browser) |
| `spike.html`, `SPIKE.md` | feasibility spike (OCC stage on Python-fitted inputs) |
| `vendor/opencascade/` | opencascade.js 2.0.0-beta.b5ff984, LGPL-2.1, unmodified (see THIRD_PARTY.md). 50,305,130 B raw / 13.7 MB gzip |

## API

```js
PDF3D.canExportCadSurfaces(partIds)
  // sync, cheap, never loads the kernel
  // -> { ok, reason: null|'unavailable'|'too_large'|'no_parts', message,
  //      estimate: { tris, kernelBytes, kernelCached, mode: 'fit'|'mesh_only' } }
PDF3D.exportCadSurfaces(partIds, { fittedOnly, onProgress, signal })
  // -> Promise<{ blob, filename, status: 'solid'|'shell'|'mesh_only'|'skipped'|'cancelled', reason, reasonCode,
  //              summary: { faces, byType, closed, valid, unfitFaces, meshFallback, timings, tris, parts, wasmHeapPeak } }>
onProgress({ stage: 'kernel'|'segment'|'fit'|'build'|'validate'|'write', pct, done, total, bytes, totalBytes, label })
```

Extras beyond the agreed contract (all additive):
- `reasonCode`: `unavailable`, `too_large`, `no_parts`, `no_face_data`, `fit_limit`, `no_fit`, `open_shell`, `out_of_memory`,
  `kernel_download` (CAD kernel could not be downloaded: offline, blocked, or an HTTP error), `worker_failed` (the fitting
  worker could not start), `error` or `cancelled`. `reason` is always user-facing text (raw "Failed to fetch" /
  "worker error" are mapped to the two codes above). The no-face-data reason names the actual source format, read from
  the payload magic (`U3D` / `PRC`), not only the PDF `/Subtype`.
- `estimate.mode`: `'mesh_only'` when the export will not attempt a fit. `message` then says why.
- `summary.parts[]`: `{ index, name, status, reason, faces, tris, check: { valid, closed, volume, area, freeEdges, … } }`.
- `summary.tris` and `summary.wasmHeapPeak` (bytes).
- `summary.unfitFaces`: `[{ part, face }]` — mesh regions that got no fitted face.

## Policies

| case | result |
|---|---|
| single-file (standalone) build, `file://`, no Worker/WASM | preflight `unavailable`; export → `skipped` |
| no parts selected / visible | `no_parts` → `skipped` |
| selection > 1,000,000 tris (r05 grinder, r13) | `too_large` → `skipped` |
| U3D (dice), bundled legacy sample, any non-PRC stream | `mesh_only` (mesh body only), kernel not loaded |
| PRC selection > 200,000 tris (r17 engine, r16, r07, r08) | `mesh_only` (fit limit) |
| fit fails for every part / worker crashes / runs out of memory | `mesh_only` with the reason |
| some parts closed, others shells or unfit | `shell` |
| every part closed and valid | `solid` |
| `fittedOnly` and nothing fitted | `skipped`, `blob: null` |
| abort before the promise resolves | `cancelled` (worker terminated, nothing returned); never throws |

The STEP holds `<part>_fitted` bodies (OCC writer) plus, unless `fittedOnly`, the app's own mesh body: the same
exporter as *Export STEP*, merged mode, with fitted parts renamed `<part>_mesh`. Units are mm. Filenames are
`<pdf stem>-surfaces.stp` and `<pdf stem>-surfaces-only.stp`.

Progress: `pct` is overall 0–100 and monotonic. The worker's share is 0–92: kernel 0–11, then the parts weighted by
triangles. The mesh body and merge take 92–100. The kernel download reports `bytes`/`totalBytes`; these are
decompressed bytes of the 50.3 MB wasm, since the browser hides the gzip size. The `label` says
"Loading CAD kernel NN% (13.7 MB download)"; sizes in labels are decimal MB (10^6 bytes).

`estimate.kernelCached` is a real cache check. After a successful download the worker stores the wasm in Cache Storage
(`pdf3d-cad-kernel-<kernel tag>`, older tags are deleted) and reads it from there next time. `canExportCadSurfaces` is
synchronous, so it returns the result of the last `caches.match` probe (run at page load, on every preflight for the next
call, and after every run; no network request). When Cache Storage is unavailable (plain http on a non-localhost host,
some private modes) it falls back to `localStorage['pdf3d.cadKernel']`, which is set only when a run loaded the kernel
and finished (never after a cancel or a failure).

## Answers to Designer's open questions (simple-mode README)

1. **partIds** are indices into `CAD3DExtractor.getState().parts`, so `[state.selectedPartIdx]` is right. `null` or
   `undefined` means all *visible* parts and skips hidden ones. Explicit indices are exported even when hidden.
   Unknown or duplicate indices are dropped.
2. **fittedOnly with no clean fit** returns `status: 'skipped'`, `blob: null`, and a reason of the form
   "<cause>. Fitted-only export: no fitted surfaces, so no file was written" (the cause never says the mesh body is
   exported). `mesh_only` always comes with a blob.
3. **Validity:** `solid` always means every part is closed *and* valid (BRepCheck plus no free edges), so `solid` never
   pairs with `valid: false` or `closed: false`. `shell` always has `closed: false, valid: false`. Your downgrade rule
   never fires but is harmless.
4. **byType keys** are exactly `plane`, `cylinder`, `cone`, `sphere`, `torus`, `revolution`, `bspline`, always present
   (0 if none). The export total is counted from the written fitted STEP (the surface entity of every `ADVANCED_FACE`),
   not from the fitter's labels: a torus fit that covers only part of the tube, and some tori the OCC STEP writer
   re-encodes, are `SURFACE_OF_REVOLUTION` (`revolution`); a degenerate torus (major radius ~0) is a sphere. Helical
   faces are B-spline surfaces and count as `bspline`. head_test: 31 torus + 48 revolution + 4 sphere. An `other` key
   appears only if the STEP holds a surface type outside this list.
5. **pct** is overall 0–100 and monotonic (never goes back), not per stage.
6. **Preflight** stays synchronous and cheap: it reads the app state and sums triangle counts, and never loads the
   kernel. Calling it on every change is fine.
7. **Labels** are complete and user-facing. The kernel label already includes the size or percentage, so show
   `label` as is. `bytes`/`totalBytes` are there for your own bar.
8. **Cancel race:** an abort before the promise resolves gives `cancelled`, even during the final mesh-body write.
   After resolve it is a no-op, so you get the real result. Only one export runs at a time; a second concurrent call
   rejects with "A CAD surface export is already running" (your UI already prevents that).
9. **Filename:** `<base>-surfaces.stp`, or `<base>-surfaces-only.stp` with `fittedOnly`. `<base>` is the PDF name
   without `.pdf`.
10. **Script loading:** a separate script, `recon/cad-export.js`, loaded right after `app.js`. It replaces
    `window.PDF3D.canExportCadSurfaces` / `exportCadSurfaces` unless a non-stub implementation is already there.
    Please drop the stub from production `index.html`. **UI decision (1.5.0):** Designer's `cad-export-ui.js` /
    `cad-export-ui.css` is the only export UI, in both Simple and Advanced. The earlier Advanced-only `#btnExportCAD`
    button and progress panel were removed. index.html loads `cad-export-ui.css` after `simple-mode.css` and
    `cad-export-ui.js` after `simple-mode.js` (which comes after `recon/cad-export.js`). The add-on files are copied
    unmodified from `/workspace/pdf3d-simple-mode/`.

    Contract notes for the UI (no change needed on either side):
    - When `canExportCadSurfaces` returns `ok: true` with a non-empty `message` (`estimate.mode: 'mesh_only'`: U3D,
      bundled sample, above 200k triangles), the UI doesn't show that message before the run. The result toast shows it
      as the `mesh_only` reason afterwards. The old Advanced button asked for confirmation first.
    - `summary.unfitFaces` is an array of `{ part, face }`, and the UI counts it. `cancelled` has `summary: null`, which the UI tolerates.

## Testing

- Node: `node --max-old-space-size=4096 recon/tools/e2e-node.mjs <pdf> <out.step>` (see the script header).
- Score: `/workspace/pdf-3d-extractor-qa/reference/score.py <step> [--part part2]`.
- Browser: a Playwright harness served the worktree over http and called the API on the head_test and screw PDFs,
  including cancel, fitted-only, mesh_only and too_large cases. See CHANGELOG 1.5.0 for the numbers.
