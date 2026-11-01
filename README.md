# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Client-side web workbench that extracts embedded 3D streams (`/Subtype /U3D` ECMA-363 & `/Subtype /PRC` ISO 14739-1) from 3D PDF files, reconstructs watertight 2-manifold B-Rep faces and analytic hole/boss features, and exports CAD-ready geometry:

- **Parasolid XT (`.x_t`)** — Siemens NX format (schema `SCH_3800173_37102`, the form NX 2512 writes), one merged planar B-Rep body in meters; verified importing into NX. Simple: Export → Parasolid; Advanced: Export Parasolid (.x_t).
- **STEP AP214 (`.stp`)** — Recommended for Siemens NX. ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` with outer and inner `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)** — Per-solid watertight triangle meshes.
- **Wavefront OBJ (`.obj`)** — Multi-body named groups (`o` / `g`) with vertex normals.
- **IGES 5.3 (`.igs`)** — Sharp feature-edge 3D CAD wireframe (`Entity 110`).
- **Raw `.u3d` / `.prc` stream extraction** — Direct binary payload extraction from `/3D` and `/RichMedia` dictionaries.

## Usage

Open `index.html` (multi-file, served or via `file://`) or the single-file offline build `pdf-3d-extractor-standalone.html`, then drop a 3D PDF. Everything runs client-side; no build step.

## What 1.6.0 decodes

| Source in the PDF | Decode path | Status badge |
|---|---|---|
| `/3D` or `/RichMedia` PRC stream with tessellation (`TESS_3D`, `TESS_3D_Compressed`, `TESS_3D_Wire`) | `prc-decoder.js` | `PRC TESS • …` |
| PRC stream with exact B-Rep only (`TOPO_BrepData`, `TOPO_BrepDataCompress`) | `prc-brep.js` tessellates NURBS/analytic faces | `PRC EXACT B-REP • …` |
| U3D (ECMA-363) CLOD mesh | `app.js` U3D parser plus `u3d-guard.js` (bounded reads, unsupported-block warnings) | `U3D • …` |
| U3D vendor `RHAdobeMeshResource` mesh | `u3d-rhadobe-mesh.js` (RH39 and UIC1 encodings; CoreTechnologie and SAP VEA 9.0 output; see `docs/rhadobe-mesh-resource.md`) | `U3D/RHAdobeMeshResource` |
| Embedded CAD file (`/EmbeddedFiles` name tree or `/FileAttachment` annotation: STEP, IGES, Parasolid, JT, NX/CATIA/SolidWorks, STL/OBJ/3MF, …) | `pdf-extract.js` | `NO 3D STREAM • EMBEDDED CAD ATTACHMENT: name` |
| Nothing usable | n/a | alert "No embedded /3D (U3D / PRC) streams or file attachments found" |

PDF layer (`pdf-extract.js`, `crypto-lite.js`):
- classic xref tables and xref streams, object streams, and incremental updates
- broken-xref recovery
- Flate, LZW, ASCIIHex, ASCII85 and RunLength filters, with predictors
- Standard security handler: RC4 40/128, AES-128 and AES-256 (R2–R6) with the empty user password. AES-256 needs WebCrypto.

Every 3D annotation on every page is listed. Each stream gets its product tree (PRC product occurrences, with names), part transforms, and the `/3DU` unit scale. Wire and polyline geometry is drawn as well. Embedded attachments can be saved from the "Product Tree & Attachments" panel.

Large models: parts are stored as typed arrays with one compact welded B-Rep each, and every exporter streams part by part into a chunked `Blob`, so 1–2M triangle models parse and export without `RangeError: Invalid string length` or out-of-memory. The viewport shows a decimated preview (≤200k tris) and a banner above 1M tris. An optional "Export detail" setting (off = 100% by default) decimates exports.

## Load result (API)

After every load (`CAD3DExtractor.loadPDFBuffer`) and stream switch (`activateStream`), the app sets
`window.PDF3D.lastLoad` (also returned by `CAD3DExtractor.getLastLoad()`). Use `reasonCode` for logic. `message` is a developer/log string (for `error` it includes the raw decoder error).

| `status` | `reasonCode` | When | Fields |
|---|---|---|---|
| `'ok'` | `null` | the active stream produced triangles | `format` (`'U3D'`/`'PRC'`), `stream`, `streams`, `decodePath`, `parts`, `tris` |
| `'unsupported'` | `'UNSUPPORTED_MESH'` | a U3D/PRC stream exists but yields no mesh (vendor block, missing tessellation, unimplemented encoding) | `format`, `stream`, `streams`, `decodePath` (`'none'`), `detail`, `wires`, `message` |
| `'error'` | `'DECODE_ERROR'` | the stream decoder threw | `format`, `stream`, `streams`, `decodePath`, `detail` (error text), `message` |
| `'no3d'` | `'NO_3D'` | no `/3D` or `/RichMedia` stream at all (attachment-only PDFs included) | `format: null`, `streams: 0`, `attachments` (names), `message` |

`detail` is the vendor New Object Type name(s) for U3D (e.g. `'RHAdobeMeshResource'`), otherwise
`'no supported mesh blocks'`; for PRC it is `'exact geometry without tessellation'` or `'no tessellated representation'`.
`message` for `unsupported` is `This PDF has a 3D model, but it's stored in a format the app can't read yet (<format>, <detail>).`
Example (VEA file with the RHAdobe decoder unavailable):

```json
{"status":"unsupported","reasonCode":"UNSUPPORTED_MESH","format":"U3D","stream":0,"streams":1,"decodePath":"none",
 "detail":"RHAdobeMeshResource","wires":0,
 "message":"This PDF has a 3D model, but it's stored in a format the app can't read yet (U3D, RHAdobeMeshResource)."}
```

Simple mode does not show `message`. It renders its own load card from `reasonCode` (plus `format`/`detail` for
`UNSUPPORTED_MESH`): amber "This 3D model can't be read yet", neutral "No 3D model in this PDF", or amber
"Couldn't read this 3D model". For `DECODE_ERROR` the error text goes only to `console.warn`.

## Export in Simple mode (1.6.0 alpha)

Simple mode has one **Export** button (`export-flow.js` / `export-flow.css`, by Designer): pick a format, set its
options, then **Save**. Advanced mode keeps its export bar unchanged.

- **Formats:** STEP, STL (binary or ASCII), OBJ, IGES, raw stream, and Parasolid (only while `PDF3D.capabilities.parasolid`; always one merged body).
- **STEP body:** *Fitted solid* (surfaces fitted by the CAD kernel, served pages only), *Mesh*, or *Both*.
  With *Fitted solid*, each part that closes into a solid is written as a fitted solid. Every other part (open shell,
  no clean fit, no face data) is either written as a mesh body named `<part>_mesh` in the same file
  (**Save mesh STEP instead**, the default) or left out (**Leave unfitted parts out**).
- **Saving:** Chrome and Edge open the system Save dialog first; cancelling it does nothing. Safari and Firefox show a
  file-name field and save to the Downloads folder.
- **Parasolid:** listed as "Faceted solid, flat faces"; one merged faceted body, no body or mode choice.
- **Result card:** every export ends with a card: saved, partly fitted (one line per part), fell back to mesh, nothing saved, cancelled or failed.
  A Parasolid sheet body or open model gets an amber "Parasolid sheet body exported (open model)" card; a model with no
  faces gets "Nothing to export" and no file is saved.
- A selected part (Parts list) limits the export to that part.
- The fitted kernel needs the multi-file app served over http(s); in `file://` pages and the single-file build the card says it is unavailable.

All formats go through `PDF3D.exportFormat(format, opts)` in `app.js`, which calls the same writers as the Advanced
buttons; STEP mesh, STL, OBJ, IGES, raw and Parasolid files are byte-identical to the Advanced buttons' files:

```js
const r = await PDF3D.exportFormat('step', { body: 'fitted', onNoFit: 'mesh', partIds: null, signal, onProgress });
// r = { blob, filename, status, reasonCode, reason, summary: { parts: [{ index, name, status, faces, reasonCode, written: 'solid'|'mesh'|'omitted' }] } }
// body: 'both' also gives each part fittedBody ('<name>_fitted' for a solid or open shell, else null) and meshBody ('<name>_mesh'),
// the bodies actually in the file (`written` keeps the Fitted-mode meaning: 'solid' only for closed solids)
// exportFormat('xt') summary adds: { faces, bodies, bodyType: 'solid'|'sheet', sewn, openEdges, estimatedBytes }
// too large for the Parasolid writer: { blob: null, status: 'error', reasonCode: 'XT_TOO_LARGE', summary: { estimatedBytes } }
// PDF3D.capabilities.cadSurfaces: false with cadSurfacesReason 'single_file' | 'file_url' | 'browser_unsupported' | 'kernel_download'
// PDF3D.retryCadKernel() -> Promise<boolean>: after 'kernel_download', clears the failed state and makes a real, fresh attempt
//   (a new worker downloads or reads the cached kernel and starts it), then updates capabilities. true = fitting usable again
//   (cadSurfaces true, reason null); false = still failing (reason stays 'kernel_download'). Never rejects. For 'single_file',
//   'file_url' and 'browser_unsupported' it resolves false without trying. The Export menu's "Try again" calls it.

// Delivery. exportFormat never downloads or opens a dialog itself:
//   no opts.writable -> r.blob, r.delivery = 'download', r.size (the caller saves the Blob)
//   opts.writable    -> a FileSystemWritableFileStream (showSaveFilePicker() then handle.createWritable()): the file is written
//                       into it part by part (~8 MB writes, never one large Blob) -> r.blob = null, r.delivery = 'picker', r.size.
//                       A failed write -> r.status = 'error', r.reasonCode = 'WRITE_FAILED'. exportFormat never calls close()
//                       or abort(): call close() when r.delivery === 'picker' && r.status is not 'error'/'skipped'/'cancelled',
//                       otherwise abort() (and remove the empty file if you can).
const h = await showSaveFilePicker({ suggestedName: 'model.x_t' }); const w = await h.createWritable();
const x = await PDF3D.exportFormat('xt', { writable: w });

const bytes = await PDF3D.estimateBytes('xt', { partIds: null, detail });   // same opts as exportFormat
// bytes = estimated file size (number), or null (no estimate for this format / nothing to export)
// xt: the writer's counting pre-pass (XT nodes x 92 bytes, 1.0-1.2x the real size); nothing is written, but it walks the
// whole model (seconds on large ones), so open the save dialog first or estimate ahead of the click.
```

## Known limitations

- **U3D `RHAdobeMeshResource`**: encodings 8/9 (U3D arithmetic coder) are not implemented; files using them are reported with a warning.
- **Exact B-Rep** is tessellated for display and export. Analytic hole/boss features are only derived from meshes, and trimmed NURBS faces that fail tessellation are skipped with a warning.
- **Very large models**: STEP text output is large (r13, 2M tris: STEP 1.9 GB); the exporter working set stays near 1.1–1.3 GB, but the browser must hold or spill the resulting Blob. STL/OBJ are far smaller.
- **Encryption:** only files that open without a user password are supported.

## Tests

```
node test/run.js [corpus-dir] [--only=substr] [--update] [--exports]
node tools/build-standalone.js   # regenerate pdf-3d-extractor-standalone.html after editing any script
```

`test/run.js` is dependency-free. It loads the same scripts as `index.html` into a Node `vm` context and checks:
- the built-in sample
- a synthetic attachment PDF
- every corpus file against `test/expect.json`

See `CHANGELOG.md` and `THIRD_PARTY.md` (prc-rs MIT notice).
