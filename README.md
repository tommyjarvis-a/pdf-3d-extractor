# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Client-side web workbench that extracts embedded 3D streams (`/Subtype /U3D` ECMA-363 & `/Subtype /PRC` ISO 14739-1) from 3D PDF files, reconstructs watertight 2-manifold B-Rep faces and analytic hole/boss features, and exports CAD-ready geometry:

- **Parasolid XT (`.x_t`)** — Siemens NX format (schema `SCH_3800173_37102`, the form NX 2512 writes), one merged planar B-Rep body in meters; verified importing into NX. Export → Parasolid.
- **STEP AP214 (`.stp`)** — Recommended for Siemens NX. ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` with outer and inner `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)** — Per-solid watertight triangle meshes.
- **Wavefront OBJ (`.obj`)** — Multi-body named groups (`o` / `g`) with vertex normals.
- **IGES 5.3 (`.igs`)** — Sharp feature-edge 3D CAD wireframe (`Entity 110`).
- **Raw `.u3d` / `.prc` stream extraction** — Direct binary payload extraction from `/3D` and `/RichMedia` dictionaries.

## Usage

Open `index.html` (multi-file, served or via `file://`) or the single-file offline build `pdf-3d-extractor-standalone.html`, then drop a 3D PDF. Everything runs client-side; no build step.

## What 1.9.0 decodes

| Source in the PDF | Decode path | Status badge |
|---|---|---|
| `/3D` or `/RichMedia` PRC stream with tessellation (`TESS_3D`, `TESS_3D_Compressed`, `TESS_3D_Wire`) | `prc-decoder.js` | `PRC TESS • …` |
| PRC stream with exact B-Rep only (`TOPO_BrepData`, `TOPO_BrepDataCompress`) | `prc-brep.js` tessellates NURBS/analytic faces | `PRC EXACT B-REP • …` |
| U3D (ECMA-363) CLOD mesh | `app.js` U3D parser plus `u3d-guard.js` (bounded reads, unsupported-block warnings) | `U3D • …` |
| U3D vendor `RHAdobeMeshResource` mesh | `u3d-rhadobe-mesh.js` (RH39, static/dynamic arithmetic and UIC1 integer encodings; see `docs/rhadobe-mesh-resource.md`) | `U3D/RHAdobeMeshResource` |
| Embedded CAD file (`/EmbeddedFiles` name tree or `/FileAttachment` annotation: STEP, IGES, Parasolid, JT, NX/CATIA/SolidWorks, STL/OBJ/3MF, …) | `pdf-extract.js` | `NO 3D STREAM • EMBEDDED CAD ATTACHMENT: name` |
| Nothing usable | n/a | `NO_3D` load card |

PDF layer (`pdf-extract.js`, `crypto-lite.js`):
- classic xref tables and xref streams, object streams, and incremental updates
- broken-xref recovery
- Flate, LZW, ASCIIHex, ASCII85 and RunLength filters, with predictors
- Standard security handler: RC4 40/128, AES-128 and AES-256 (R2–R6) with local user/owner password entry and automatic empty-user authentication. AES-256 needs WebCrypto (HTTPS, localhost or standalone). Generated tests cover R2/R3/R4/R6; R5 coverage uses existing empty-user r11 only.

Every 3D annotation on every page is listed. Each stream gets its product tree (PRC product occurrences, with names), part transforms, and the `/3DU` unit scale. Wire and polyline geometry is drawn as well. Embedded attachments can be saved from the "Product Tree & Attachments" panel.

Large models: parts are stored as typed arrays with one compact welded B-Rep each, and every exporter streams part by part into a chunked `Blob`, so 1–2M triangle models parse and export without `RangeError: Invalid string length` or out-of-memory. The viewport shows a decimated preview (≤200k tris) and a banner above 1M tris. An optional "Export detail" setting (off = 100% by default) decimates exports.

## Password security and compatibility tests (1.9.0)

The masked dialog appears only after empty-password authentication fails. Submit to
retry, Cancel/Esc to stop; reopen the same file to try again. Opening a new file
cancels old prompts/decode activation. Passwords are not saved in storage, logs,
URLs or exports. Certificates, public-key handlers, DRM and unknown crypt methods
are unsupported. There is no password cracking or server upload.

API: `CAD3DExtractor.loadPDFBuffer(bytes, name, {password, prompt:false})` supplies
an ephemeral password without a dialog. Omit `password` for automatic empty-user
handling; `{requestPassword: async incorrect => stringOrNull}` allows a host-owned
local prompt. Do not store the supplied password in your own integration.
Security outcomes are `PDF_PASSWORD_REQUIRED`, `PDF_PASSWORD_INCORRECT`,
`PDF_PASSWORD_CANCELLED`, `PDF_SECURITY_UNSUPPORTED` and `PDF_DAMAGED`.
Optional damaged PDF text gets `lastLoad.warning`; unverified geometry gets
`lastLoad.damaged`, the visible note and existing partial-export marking.

Focused checks:
```
node test/run.js --exports
node test/compatibility190.js
node test/password-dialog190.js
node test/export-regression190.js
```
The compatibility test creates small temporary encrypted copies of the built-in
U3D+PRC sample using independent libqpdf via pikepdf. Passwords are random,
test-only and passed to Python in memory; generated files are removed afterwards.
Set `PDF3D_QPDF_PYTHON` to a Python with pikepdf installed; absent tooling is an
explicit SKIP, not a pass for encryption. `PDF3D_R5` selects existing r11;
`PDF3D_RH_STREAM` selects the real Ohio U3D stream (both optional external fixtures).
`PDF3D_BASELINE_ROOT` selects an existing v1.8.0 directory for 28-export identity.
See `test/fixtures/README.md` for attribution, hashes and evidence limits.

## Load result (API)

After every load (`CAD3DExtractor.loadPDFBuffer`) and stream switch (`activateStream`), the app sets
`window.PDF3D.lastLoad` (also returned by `CAD3DExtractor.getLastLoad()`). Use `reasonCode` for logic. `message` is a developer/log string (for `error` it includes the decoder's damage text; since 1.6.2 a JavaScript runtime error such as `Offset is outside the bounds of the DataView` is never shown: it is reported as damaged data and logged to the console).

| `status` | `reasonCode` | When | Fields |
|---|---|---|---|
| `'ok'` | `null` | the active stream produced triangles (also when damaged data was skipped: then `damaged` is set) | `format` (`'U3D'`/`'PRC'`), `stream`, `streams`, `decodePath`, `parts`, `tris`, `trisParsed`, [`damaged`] |
| `'unsupported'` | `'UNSUPPORTED_MESH'` | a U3D/PRC stream exists but yields no mesh (vendor block, missing tessellation, unimplemented encoding) | `format`, `stream`, `streams`, `decodePath` (`'none'`), `detail`, `wires`, `message` |
| `'error'` | `'DECODE_ERROR'` | the stream decoder threw, or the stream is damaged: not U3D/PRC data at all (random bytes), a damaged RHAdobeMeshResource mesh, a truncated or damaged classic U3D stream with no decodable mesh, or a PRC whose decode failures left no body | `format`, `stream`, `streams`, `decodePath`, `detail` (error text), `message` |
| `'no3d'` | `'NO_3D'` | no `/3D` or `/RichMedia` stream at all (attachment-only PDFs included) | `format: null`, `streams: 0`, `message` |

Triangle counts on `'ok'` (1.6.2): `tris` is what the viewer draws, the HUD "Tris" shows and mesh exports write: after the
B-Rep weld drops degenerate (zero-area) triangles. `trisParsed` is the count as decoded from the file, before that; the
large-model banner uses it (1.8.0 has no CAD fit limit; the large-model fitting question counts drawn `tris`). They differ only by the degenerate triangles
(r08: `trisParsed` 429,271, `tris` 427,503; g09: 11,516 / 11,514). Show `tris` as "triangles"; compare limits with `trisParsed`.

Damaged streams (1.6.2): the decoder loads what decodes. A U3D block that fails to decode, or a block header that is not a
U3D block (impossible type, metadata or data past the stream end), is skipped and parsing resumes at the next valid pair of
block headers. If triangles remain the load is `'ok'` with `damaged` = the warning text (`"U3D: damaged data skipped (…)"`,
also in the stream's warnings); if nothing decodes it is `DECODE_ERROR`. A PRC stream shorter than its header's
end-of-file offset is truncated: `DECODE_ERROR` (`"PRC stream is damaged (truncated: …)"`) when no body decodes, else `'ok'`
with `damaged`. Damage is never reported as `UNSUPPORTED_MESH`.

Every result (1.6.1) also carries the PDF's embedded files: `attachments` (names, as `NO_3D` had since 1.5.3) and
`attachmentDetails: [{ name, fileName, mime, ext, isCAD, size, description, error }]`. Both are `[]` when the PDF has none.
- `name`: the file spec's `/UF` (else `/F`) as written in the PDF (decrypted in encrypted PDFs). Raw: it may contain
  paths, control or bidi-override characters (`../../evil:name?.sat`); don't display it or use it as a path. `attachments`
  lists these raw names too
- `fileName` (1.6.2): suggested save name: `name`'s last path segment, control / bidi-override / `<>:"|?*` characters
  replaced by `_`, leading and trailing dots and spaces trimmed, Windows device names (`CON`, `NUL`, `COM1`…) prefixed with
  `_`, at most 200 characters (extension kept), `attachment-<n>.bin` if nothing is left (`../../evil:name?.sat` → `evil_name_.sat`).
  Use it as the display name too (the Attachments panel does, since 1.6.2)
- `mime` (1.6.2): the EmbeddedFile stream's `/Subtype` (e.g. `/model#2Fstep` → `model/step`), else by extension
  (`model/step`, `model/iges`, `model/stl`, `model/jt`, `model/vnd.parasolid.transmit.text|binary`, `text/plain`, …), else `null`
- `ext`: lower-case, without the dot; `isCAD` (1.6.2 list): `ext` is one of stp, step, igs, iges, jt, x_t, x_b, sat, sab,
  3dxml, stl, prt, catpart, catproduct, sldprt, sldasm, ipt, iam, vds (any case: `Wing.CATPart` and `GAUGE.STL` count)
- `size`: decoded bytes; `description`: the file spec's `/Desc` or `''`
- `error`: `null`, or why the file can't be read (e.g. `'FlateDecode: inflate failed'`); `PDF3D.saveAttachment(i)` then
  returns `ATTACHMENT_UNREADABLE`

Embedded files are found in the catalog `/Names /EmbeddedFiles` tree, `/FileAttachment` annotations (`/FS`) and PDF 2.0
`/AF` arrays (catalog, pages, annotations); a file listed in several places is reported once. `/EF /UF` is preferred, with
`/EF /F` tried when the `/UF` stream is missing or does not decode. Streams are decoded through their filters and, in
encrypted PDFs (empty user password), decrypted with the embedded-file crypt filter (`/EFF`, else `/StmF`).

`detail` is the vendor New Object Type name(s) for U3D (e.g. `'RHAdobeMeshResource'`), otherwise
`'no supported mesh blocks'`; for PRC it is `'exact geometry without tessellation'` or `'no tessellated representation'`.
`message` for `unsupported` is `This PDF has a 3D model, but it's stored in a format the app can't read yet (<format>, <detail>).`
Example (VEA file with the RHAdobe decoder unavailable):

```json
{"status":"unsupported","reasonCode":"UNSUPPORTED_MESH","format":"U3D","stream":0,"streams":1,"decodePath":"none",
 "detail":"RHAdobeMeshResource","wires":0,
 "message":"This PDF has a 3D model, but it's stored in a format the app can't read yet (U3D, RHAdobeMeshResource)."}
```

The app does not show `message`. It renders its own load card from `reasonCode` (plus `format`/`detail` for
`UNSUPPORTED_MESH`): amber "This 3D model can't be read yet", neutral "No 3D model in this PDF", or amber
"Couldn't read this 3D model". For `DECODE_ERROR` the error text goes only to `console.warn`.

## One UI (1.7.0 alpha)

Since 1.7.0 there is only one UI (formerly "Simple mode"). The Advanced workbench, the Simple / Advanced switch,
`?ui=advanced` / `?ui=simple` and the remembered mode (`pdf3d-extractor.uiMode`, cleared at start) are removed, along
with the STEP text preview, the `.x_t` text preview / entity table (`?xt=1`), Copy Preview and the raw 3D stream block
list. Units, body type and reduce detail are set in the Export dialog.

## Viewer (1.7.0 alpha)

The viewport: the bottom-left holds only the XYZ axis triad. The file / geometry readout (stream, 3D stream size
compressed / uncompressed, solid bodies / faces / tris, bounds, units, renderer) is in **Info → File & geometry**,
followed by the stream list, bounding box & topology, detected features and the product tree. The controls list is in
**More → Help**.
The upper-right status reads `File loaded: name.pdf | Bodies Detected: N` (long names end in "…"; hover shows the full name).
The tab bar is **Solid Bodies** | Display, View, Fit, Reset, More | **Info**.

- **Display:** Shaded + edges, Shaded, Wireframe, Transparent; **Background** Default, Black, White or Black to white
  gradient (black at the top); **Floor grid** (on by default).
- **View:** view presets and **Perspective** (default) or **Orthographic**. Fit and zoom frame the model the same way in both.

Background, floor grid and projection are remembered in `localStorage` (`pdf3d-extractor.viewPrefs`). They change only
the view, never an export. Script access:

```js
PDF3DView.get();                         // { background: 'default', grid: true, projection: 'perspective' }
PDF3DView.set('background', 'gradient'); // 'default' | 'black' | 'white' | 'gradient'; also 'grid' (true/false), 'projection' ('perspective' | 'orthographic')
document.addEventListener('pdf3d:viewprefs', (e) => console.log(e.detail));
```

## Export (1.6.0 alpha; the only export UI since 1.7.0)

The app has one **Export** button (`export-flow.js` / `export-flow.css`, by Designer): pick a format, set its
options, then **Save**.

- **Formats:** STEP, STL (binary or ASCII), OBJ, IGES, raw stream, and Parasolid (only while `PDF3D.capabilities.parasolid`; always one merged body).
- **STEP body:** *Fitted solid* (surfaces fitted by the CAD kernel, served pages only), *Mesh*, or *Both*.
  With *Fitted solid*, each part that closes into a solid is written as a fitted solid. Every other part (open shell,
  no clean fit, no face data) is either written as a mesh body named `<part>_mesh` in the same file
  (**Save mesh STEP instead**, the default) or left out (**Leave unfitted parts out**).
- **Saving:** Chrome and Edge open the system Save dialog first; cancelling it does nothing. Safari and Firefox show a
  file-name field and save to the Downloads folder.
- **Parasolid:** listed as "Faceted body, flat faces"; one merged faceted body, no body or mode choice.
- **Result card:** every export ends with a card: saved, partly fitted (one line per part), fell back to mesh, nothing saved, cancelled or failed.
  A Parasolid sheet body or open model gets an amber "Parasolid sheet body exported (open model)" card; a model with no
  faces gets "Nothing to export" and no file is saved.
- A selected body (Solid Bodies list) limits the export to that body.
- The fitted kernel needs the multi-file app served over http(s); in `file://` pages and the single-file build the card says it is unavailable.

All formats go through `PDF3D.exportFormat(format, opts)` in `app.js`, which calls the same writers as the
1.6.2 export bar did; STEP mesh, STL, OBJ, IGES, raw and Parasolid files are byte-identical to 1.6.2's files:

```js
const r = await PDF3D.exportFormat('step', { body: 'fitted', onNoFit: 'mesh', partIds: null, signal, onProgress });
// r = { blob, filename, status, reasonCode, reason, summary: { parts: [{ index, name, status, faces, reasonCode, written: 'solid'|'mesh'|'omitted' }] } }
// body: 'both' also gives each part fittedBody ('<name>_fitted' for a solid or open shell, else null) and meshBody ('<name>_mesh'),
// the bodies actually in the file (`written` keeps the Fitted-mode meaning: 'solid' only for closed solids)
// STEP 'fitted' / 'both' summary (1.6.1) adds a model-wide reason no part was fitted, so the card can show one line:
//   fitSkippedReason: null (fitting ran) | 'no_face_data' | 'browser_unsupported'
//   (1.8.0: no fit limit, so 'too_many_tris' is gone; canExportCadSurfaces().estimate.warnLarge is true above
//   PDF3D.cadSurfaceLimits.warnFitTris (200,000) and the export popover asks Continue / Export mesh STEP instead first)
// PDF3D.faceTypes(partIdx) (1.8.0) -> { status: 'ready', counts: { plane, cylinder, cone, sphere, torus, freeform } }
//   | { status: 'pending' | 'none' | 'unavailable' | 'error', reason }; 'pdf3d:facetypes' { idx } fires when one arrives
// exportFormat('xt') summary adds: { faces, bodies, bodyType: 'solid'|'sheet', sewn, openEdges, estimatedBytes }
// too large for the Parasolid writer: { blob: null, status: 'error', reasonCode: 'XT_TOO_LARGE', summary: { estimatedBytes } }
// PDF3D.capabilities.cadSurfaces: false with cadSurfacesReason 'single_file' | 'file_url' | 'browser_unsupported' | 'kernel_download'
// PDF3D.retryCadKernel() -> Promise<boolean>: after 'kernel_download', clears the failed state and makes a real, fresh attempt
//   (a new worker downloads or reads the cached kernel and starts it), then updates capabilities. true = fitting usable again
//   (cadSurfaces true, reason null); false = still failing (reason stays 'kernel_download'). Never rejects. For 'single_file',
//   'file_url' and 'browser_unsupported' it resolves false without trying. The Export menu's "Try again" calls it.

// Delivery. exportFormat never downloads or opens a dialog itself:
//   no opts.writable -> r.blob, r.delivery = 'download', r.size (the caller saves the Blob)
//   opts.writable    -> a FileSystemWritableFileStream (showSaveFilePicker() then handle.createWritable()): the file is streamed
//                       into it as it is made (~1 MB Uint8Array writes, no Blob at all) -> r.blob = null, r.delivery = 'picker', r.size.
//                       A failed write -> r.status = 'error', r.reasonCode = 'WRITE_FAILED', r.errorName (the error's name),
//                       r.quota (true for QuotaExceededError). exportFormat never calls close()
//                       or abort(): call close() when r.delivery === 'picker' && r.status is not 'error'/'skipped'/'cancelled',
//                       otherwise abort() (and remove the empty file if you can).
const h = await showSaveFilePicker({ suggestedName: 'model.x_t' }); const w = await h.createWritable();
const x = await PDF3D.exportFormat('xt', { writable: w });

const bytes = await PDF3D.estimateBytes('xt', { partIds: null, detail });   // same opts as exportFormat
// bytes = estimated file size (number), or null (no estimate for this format / nothing to export)
// xt: the writer's counting pre-pass (XT nodes x 92 bytes, 1.0-1.2x the real size); nothing is written, but it walks the
// whole model (seconds on large ones), so open the save dialog first or estimate ahead of the click.
```

#### Partial loads at export time (1.6.2)

While `PDF3D.lastLoad.damaged` is set (an `'ok'` load that skipped damaged data), exports say so:

```js
const r = await PDF3D.exportFormat('xt', { writable: w });
// r.damaged          = PDF3D.lastLoad.damaged (the same warning string), on every result that made a file
//                      (status 'ok' / 'solid' / 'partial' / 'mesh_only', delivery 'picker' or 'download', every format;
//                      also a WRITE_FAILED one). Skipped / cancelled results and undamaged loads have no damaged key.
// r.summary.damaged  = the same string
// r.filename         = '<stem>_partial.<ext>' (part.x_t -> part_partial.x_t, part-ascii.stl -> part-ascii_partial.stl)
// r.suggestedName    = r.filename (on every result with a filename, damaged or not)
PDF3D.suggestedFileName('xt')                        // -> 'part_partial.x_t' while damaged, else 'part.x_t' (before exporting,
PDF3D.suggestedFileName('stl', { encoding: 'ascii' }) //    e.g. for showSaveFilePicker's suggestedName); step = mesh name '<stem>.stp'
                                                     //    (fitted / both results may be named <stem>-surfaces[-only].stp)
PDF3D.partialNote()  // -> 'PARTIAL: some 3D data in the source PDF could not be read; check against the drawing' while damaged, else null
```

The file itself carries that note in STEP (mesh, fitted and both) as a second `FILE_DESCRIPTION` string,
`FILE_DESCRIPTION(('3D PDF Extracted B-Rep Assembly - STEP AP214','PARTIAL: some 3D data in the source PDF could not be read; check against the drawing'),'2;1');`
(printable ASCII, no apostrophe), and in IGES as extra Start-section lines (72 columns each; the Terminate line counts
them). Parasolid `.x_t` gets it as two free-text lines in the header's `**PART3;` section, right above
`**END_OF_HEADER` (split at the note's `;` so no header line is longer than the 80 characters NX writes; no `=`, so they
are not header keys):

```
**PART3;
PARTIAL: some 3D data in the source PDF could not be read;
check against the drawing;
**END_OF_HEADER*****************************************************************
```

(each line ends in CR LF like the rest of the header; the size estimate counts the extra 88 bytes). STL, OBJ and the raw
stream are unchanged. Undamaged loads export byte-identical files, names and result fields (apart from the new
`suggestedName`).

#### STEP strings (1.6.2)

Every STEP writer (mesh, fitted, Both, the step-merge of fitted + mesh) writes header strings that come from the PDF name
or its metadata (`FILE_NAME`, `FILE_DESCRIPTION`) and the mesh writer's part names with ISO 10303-21 string encoding:
`'` → `''`, `\` → `\\`, other characters outside printable ASCII → `\X2\HHHH…\X0\` (UTF-16 code units, consecutive
characters share one run) or `\X4\HHHHHHHH…\X0\` beyond the BMP. `O'Brien bracket – ø20 ü.pdf` →
`FILE_NAME('O''Brien bracket \X2\2013\X0\ \X2\00F8\X0\20 \X2\00FC\X0\.stp',…)`. Names in plain printable ASCII
without `'` or `\` are written unchanged. IGES does not embed the file name (the Global section is fixed text) and the
`.x_t` `KEY=` is already reduced to `[A-Za-z0-9_.-]`. `saveAttachment` results are not affected: embedded files are saved
exactly as embedded and do not depend on whether the 3D stream decoded.

### Saving an embedded file (1.6.2)

`PDF3D.saveAttachment(index, opts)` saves `lastLoad.attachmentDetails[index]` exactly as embedded (decoded and decrypted
bytes), for example from the `NO_3D` card's "Save {name}" button. Delivery works like `exportFormat`:

```js
const d = PDF3D.lastLoad.attachmentDetails[i];
const h = await showSaveFilePicker({ suggestedName: d.fileName });
let w = null;   // createWritable() once more if the first attempt rejects (as export-flow does)
for (let k = 0; k < 2 && !w; k++) { try { w = await h.createWritable(); } catch (e) { /* retry once */ } }
// both attempts failed: remove the empty picked file (h.remove(), Chrome 110+) and save without a writable (download)
const r = await PDF3D.saveAttachment(i, w ? { writable: w, signal, onProgress } : { signal, onProgress });
// opts.writable    -> written in ~1 MiB Uint8Array pieces, no Blob:
//                     { status: 'ok', reasonCode: null, reason: null, blob: null, delivery: 'picker', size, name, filename, mime }
// no opts.writable -> { status: 'ok', reasonCode: null, reason: null, blob, delivery: 'download', size, name, filename, mime }
//                     (blob.type = mime || 'application/octet-stream')
// failure          -> { status: 'error', reasonCode: 'WRITE_FAILED' | 'ATTACHMENT_UNREADABLE', reason, errorName, quota,
//                       blob: null, delivery, size: null, name, filename, mime }
//   ATTACHMENT_UNREADABLE: the entry has no readable bytes (attachmentDetails[i].error is set; errorName = the decode
//                          error's name), or there is no attachment i (errorName 'RangeError'); nothing is written
//   WRITE_FAILED:          writable.write() threw (errorName = its name, quota = errorName === 'QuotaExceededError');
//                          the file is partly written
// opts.signal aborted -> the exportFormat cancelled shape { status: 'cancelled', reasonCode: 'cancelled', blob: null, ... }
// opts.onProgress({ stage: 'write', pct, label, bytes, totalBytes }) after each piece.
// name = filename = attachmentDetails[i].fileName (no damaged key or _partial suffix: a damaged 3D stream does not affect
// embedded files). saveAttachment never calls close() or abort(): close() on status 'ok',
// abort() otherwise (as with exportFormat).
```

## Known limitations

- **U3D `RHAdobeMeshResource`**: encodings 8/9 (U3D arithmetic coder) are not implemented; files using them are reported with a warning.
- **Exact B-Rep** is tessellated for display and export. Analytic hole/boss features are only derived from meshes, and trimmed NURBS faces that fail tessellation are skipped with a warning.
- **Very large models**: STEP text output is large (r13, 2M tris: STEP 1.9 GB); the exporter working set stays near 1.1–1.3 GB, but the browser must hold or spill the resulting Blob. STL/OBJ are far smaller.
- **Encryption:** only files that open without a user password are supported (Standard handler: RC4 40–128-bit, AESV2,
  AES-256 R5/R6; strings, streams and embedded files, including `/EFF`-only files).

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
