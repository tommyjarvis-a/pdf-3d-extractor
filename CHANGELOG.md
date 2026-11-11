# Changelog

## 1.9.0 (alpha) — 2026-11-08

Compatibility candidate; not a general converter and not fitted Parasolid.

### Added
- RHAdobeMeshResource integer-array arithmetic encodings **8 (static domain)** and
  **9 (dynamic, U16 escapes)**. The mapping is inferred from all 110 arithmetic arrays
  in one Ohio University producer sample, checked by an independent test encoder,
  declared domains, exact flush bytes and mesh structure. The encoder arithmetic is
  spec-derived, but encoding-9 frequency counting of symbol `0xFFFF` (escaped value
  **65534**) is empirical, inferred from **two real arrays**, not spec-derived. Existing
  RH39/7 and UIC1/10 are retained. This is not an independent visual-equivalence claim.
- Local masked password entry, wrong-password retry and Cancel/Esc. Empty-user PDFs
  still open without prompting. New loads clear entry state and supersede old loads.
- Standard R2/R3 RC4, R4 RC4/AESV2, R5/R6 AES-256 user/owner authentication;
  R6 uses RFC4013 SASLprep with Unicode 3.2 tables. Generated libqpdf fixtures cover
  R2/R3/R4/R6, including Unicode R6; deprecated R5 is checked against existing r11 only.

### Fixed / hardened
- Strict per-array bounds, RH39 offset widths/overflow, counts/allocation budgets,
  integer/float/index domains, UIC1 run lengths and U3D framing limits.
- Partial RH recovery is explicit: unknown trailing data rejects the chunk; one
  unexplained trailing zero byte preserves geometry with a visible warning and
  partial-export marking. The real Ohio sample recovers 90/90 meshes (86 exact);
  **four Ohio chunks** load with the trailing-byte warning and partial-export marking.
  The load card shows unreadable/missing mesh-block counts together with recovered
  trailing-byte-warning counts, wrapping rather than hiding either warning.
  Skeleton/subchunk descriptions remain explicitly unsupported, never silently ignored.
- Unknown security revisions/handlers/crypt methods are rejected before prompting;
  security errors never fall back to scanning ciphertext. Named `/Crypt`, Identity,
  metadata and attachment filters follow the selected security method.
- Encryption dictionaries and trailer IDs are validated before authentication;
  valid indirect IDs resolve and any nonempty ID length is accepted (16 bytes is
  recommended, not mandatory). Malformed metadata gives a typed damaged error.
  Unexpected errors on encrypted inputs fail closed at the PDF and app boundaries;
  the legacy scanner remains available for unencrypted inputs only.
- AES-CBC length/padding validation is strict. Damaged optional encrypted text is
  omitted with a visible metadata warning, not passed off as decrypted text; stream
  failures remain errors. Corrected the R6 Algorithm 2.B round-number termination.
- All 28 built-in sample exports remain byte-identical to 1.8.0. No new backend,
  password persistence, main/tag/release/Pages change or UI redesign.
- Ohio export evidence is full raw/STL/OBJ and subset STEP/XT/IGES only. Full Ohio
  XT exceeded Tester's **4 GB test heap**; full Ohio STEP/XT success is not claimed.
- Served cache keys: `1.9.0` / worker `1.9.0-w1`; standalone rebuilt.


### Known limitations
- **L1 (Low):** libqpdf (and tools that use it, such as pikepdf / `qpdf --encrypt`)
  does not apply SASLprep to R6 passwords. The app follows ISO 32000-2 and does
  apply SASLprep, so an R6 password that SASLprep would change can fail to open
  some libqpdf-made files. This is a known interop gap, not a cryptographic defect.
- **L4 (Low):** cosmetic console / `lastLoad` text (for example a leading
  "0 mesh blocks unreadable" when the only issues are trailing-byte warnings).

## 1.8.0 (alpha) — 2026-11-02

Alpha: the Solid Bodies list redesign, list / viewport selection sync, a face-types panel per body, and no fitted STEP
triangle limit. Exports are byte-identical to 1.7.0 except where a body name is written: bodies now get default names
(below), so STEP and OBJ name strings change (geometry unchanged); binary / ASCII STL, .x_t, IGES and raw are identical.

### Changed (Solid Bodies list)
- Each row is **name | type | watertight | triangles**: type Solid / Sheet / Mesh, watertight Yes / No, triangles as
  `999`, `612k`, `1.2M`. The vertex, triangle and B-rep surface counts per row are gone.
- An **eye** button replaces the visibility checkbox (eye with an X = hidden; tooltip Hide / Show).
- **Default names** `Body_1`, `Sheet_1`, `Mesh_1`…, numbered per type in file order (the name in the file is in the
  row tooltip). **Double-click a name (or F2) to rename** it: Enter saves, Esc cancels. Names are kept per stream and
  used by every export that writes a body name (STEP, OBJ, fitted STEP); a name already taken gets `_2`.

### Added
- **Selection sync**: click a row to highlight the body in the view; click a body in the view to select its row (scrolled
  into view); click empty space or press Esc to clear both. One selection at a time. With a body selected the export
  popover says the export covers that body only (as before), and how to clear it.
- **Face types panel** under the selected row: planes, cylinders, cones, spheres, tori and freeform counts (zero rows
  hidden); click the row again to fold it. Computed in a background worker (segmentation + primitive classification,
  no CAD kernel), the selected body first; a one-line message for meshes, the single-file build / `file://`, or while
  it runs. `PDF3D.faceTypes(idx)` and the `'pdf3d:facetypes'` event expose it.
- `CAD3DExtractor.selectPart / renamePart / setPartVisible / pickPartAt / formatTriCount / bodyKind / defaultBodyNames`.

### Changed (export)
- **No fitted STEP triangle limit** (`cadSurfaceLimits.maxFitTris` and `fitSkippedReason: 'too_many_tris'` removed).
  Above 200k triangles (`warnFitTris`, `estimate.warnLarge`) the popover asks first: "may take a long time and can
  crash the browser tab on very large models", with **Continue** / **Export mesh STEP instead** / Back. Fitting keeps
  its progress bar and Cancel. Models under 200k fit exactly as in 1.7.0.
- Selection highlight is a clearer cyan tint (both renderers).
- Worker cache key is now `1.8.0-w1`.

### Fixed (QA gate a60f9d0)
- Body names, feature labels and stream / file names are HTML-escaped in the Info sheet (features and streams lists);
  a renamed body or a file named like HTML could inject markup before.
- Double-clicking a name renames that row even when the face panel of a row above collapses on the first click.
- OBJ `o` / `g` names are one token: whitespace and `#` become `_` (only names you type can contain them).
- A Mesh-type body that still has some CAD face data shows its face counts instead of the "no CAD face data" line.

## 1.7.0 (alpha) — 2026-11-02

Alpha: carries the 1.6.2 release candidate (below), a Simple-mode viewer refresh, and Simple as the only UI (the
Advanced UI is removed). Exports are byte-identical to 1.6.2.

### Included from 1.6.2
- Everything listed under 1.6.2 below: `PDF3D.saveAttachment`, `attachmentDetails[].fileName` / `.mime`,
  `lastLoad.trisParsed`, `lastLoad.damaged` partial loads, the `NO_3D` attachment card, STEP string escaping, Designer's
  Simple mode / export flow update, one file-name rule for `exportFormat` results and `PDF3D.suggestedFileName`, the
  sanitized attachment `fileName` in Advanced's status badge, and the README `createWritable()` retry.

### Changed (Simple mode)
- The bottom-left file / geometry readout moved into **Info → File & geometry** (stream, bodies / faces / tris, bounds,
  units, renderer; nothing dropped). The controls help moved to **More → Help**. The bottom-left now holds only the axis
  triad (moved there from the lower right, at every window size); the decimation note moved to the lower right.
- **Info** is the last tab, at the far right of the tab bar.
- "Parts" is now **Solid Bodies** (tab, panel, tooltips, row labels).
- Upper-right status: `File loaded: name.pdf | Bodies Detected: N`; long names truncate with "…", full name on hover.
- "X-ray" is now **Transparent** (label only; same render mode).

### Added
- **Background** (Display menu): Default, Black, White, Black to white gradient (black at the top).
- **Floor grid** toggle (Display menu), on by default.
- **Perspective / Orthographic** (View menu), Perspective by default. Both renderers (WebGL and the Canvas 2D fallback)
  use the same framing: the plane through the view centre matches orthographic, so Fit and zoom frame the model the same way.
- `window.PDF3DView` (`get()`, `set(key, value)`, `'pdf3d:viewprefs'` event); the three choices are remembered in
  `localStorage` (`pdf3d-extractor.viewPrefs`).
- Worker cache key is now `1.7.0-w1`.
- **Info → File & geometry** shows the active 3D stream size: `3D stream size: X compressed • Y uncompressed` (moved from
  the Advanced stream drawer).
- Script hooks the UI now uses directly: `PDF3DView.renderModes` / `state()` / `setRenderMode` / `preset` / `fit` /
  `setOrbitMode` / `setExplode` (`'pdf3d:viewchange'` event); `PDF3D.exportSettings` (`get` / `set`, units, body type,
  reduce detail; `'pdf3d:exportsettings'` event); `CAD3DExtractor.getStatus` / `loadSample` / `showAllParts` /
  `invertParts` (`'pdf3d:status'` event). Existing `PDF3D` export hooks are unchanged.

### Removed
- The Advanced UI (workbench, inspector, export bar, stream telemetry drawer, `#statusBadge`): code deleted, not hidden.
- The Simple / Advanced switch, `?ui=advanced` / `?ui=simple` and the remembered mode (`pdf3d-extractor.uiMode` is
  cleared at start). Simple is the only UI.
- The STEP text preview, the `.x_t` text preview / entity table (`?xt=1`), Copy Preview and the raw 3D stream block list.
- Units, body type and reduce detail live only in the Export dialog (same values and defaults as before).

### Fixed (before release)
- View → Top / Front / Right have their full hover titles again: **Top (XY)**, **Front (XZ)**, **Right (YZ)**.
- On-screen wording says **body / bodies** instead of "part(s)" to match Solid Bodies / Bodies Detected (damaged-load
  note, Show all N bodies, export result cards, Leave unfitted bodies out, OBJ "Mesh with body groups", messages and
  progress). Text written into exported files, reason codes and API fields are unchanged.

## 1.6.2 (alpha) — 2026-11-01

Alpha: Simple mode now handles PDFs without a 3D model but with embedded files, and partial (damaged) loads. Its wording may still change.

### Added
- **`PDF3D.saveAttachment(index, opts)`** saves embedded file `lastLoad.attachmentDetails[index]` exactly as embedded
  (decoded and decrypted), so the `NO_3D` card can offer "Save {name}" for attachment-only PDFs. Delivery as
  `exportFormat`: with `opts.writable` the bytes are written in ~1 MiB `Uint8Array` pieces with no Blob →
  `{ status: 'ok', blob: null, delivery: 'picker', size, name, filename, mime }`; without it →
  `{ status: 'ok', blob, delivery: 'download', size, name, filename, mime }`. Failures → `status: 'error'` with
  `reasonCode` `'ATTACHMENT_UNREADABLE'` (unreadable entry or no such index) or `'WRITE_FAILED'`, plus `errorName` and
  `quota`. `opts.signal` gives the cancelled shape; the caller closes or aborts the writable.
- **`attachmentDetails[].fileName`** (sanitized suggested save name) and **`.mime`** (the EmbeddedFile `/Subtype`, else
  by extension, else `null`). An entry without bytes always has `error` set.
- **`lastLoad.trisParsed`** next to `tris` on `'ok'` loads: `tris` is drawn / exported / shown in the HUD (after the
  B-Rep weld drops degenerate triangles), `trisParsed` is as decoded (what the CAD fit limit `fitSkippedTris` and the
  large-model banner count). r08 showed 429,271 in the fit line and 427,503 in `lastLoad.tris`; both are now exposed and labelled.
- **`lastLoad.damaged`** on `'ok'` loads that skipped damaged data (the warning text).
- **Partial loads are visible at export time.** While `lastLoad.damaged` is set, every `PDF3D.exportFormat` result that
  made a file (every format, `'picker'` and `'download'`, also `WRITE_FAILED`) carries **`damaged`** and
  **`summary.damaged`** (= `lastLoad.damaged`), and its **`filename`** gets `_partial` before the extension
  (`part_partial.x_t`). New **`result.suggestedName`** (= `filename`), **`PDF3D.suggestedFileName(format, opts)`** (the
  name the export will use, `_partial` while damaged; see Changed) and **`PDF3D.partialNote()`**. STEP (mesh, fitted, both) gets
  the second `FILE_DESCRIPTION` string `'PARTIAL: some 3D data in the source PDF could not be read; check against the
  drawing'`, IGES the same note as extra Start-section lines, Parasolid `.x_t` two free-text header lines under
  `**PART3;` right above `**END_OF_HEADER` (split at the `;`, each ≤ 80 characters; the size estimate counts them); STL,
  OBJ and raw are unchanged. Undamaged exports are
  byte-identical to before. `saveAttachment` is unaffected (embedded files do not depend on the 3D decode).
  `test/run.js` checks every format both ways on x05 and x10, and that the same export with `damaged` cleared differs
  only by the note.
- **Attachment card on the Simple no-3D screen (simple-mode, Designer).** When a load has no 3D model but embedded files,
  the empty screen lists them by `fileName` (never the raw name) and offers "Save {name}" through
  `PDF3D.saveAttachment` (Save-as picker, `createWritable()` with one retry, else a download), with a green / amber
  result card.
- **Partial-load note in Simple mode (simple-mode / export-flow, Designer).** A damaged `'ok'` load shows a dismissable
  amber note ("Part of this model couldn’t be read, so only N parts loaded."); the Export popover warns before Save, the
  Save dialog uses `PDF3D.suggestedFileName` (`…_partial.…`), and the result card for a written file is amber with
  "This model was only partly read. Check it against the drawing before using it."
- **Attachment fixtures** `x06_attachments_mixed.pdf`, `x07_attachments_aesv2.pdf`, `x08_attachments_rc4.pdf`,
  `x09_attachments_eff_aesv2.pdf` (tools/make-damaged-fixtures.js). Their expect.json entries pin `attachmentDetails`
  and the source sha256 of every attachment. `test/run.js` saves every attachment of every corpus file both ways and
  compares the bytes.
- **Damage fixtures** `x10_u3d_bad_block_header.pdf` (g01's U3D with one block type overwritten → `'ok'`, `damaged`)
  and `x11_prc_truncated.pdf` (g07's PRC with the last 1% cut → `DECODE_ERROR`).

### Changed
- **`attachmentDetails[].isCAD`** is true for exactly these extensions, in any case: stp, step, igs, iges, jt, x_t,
  x_b, sat, sab, 3dxml, stl, prt, catpart, catproduct, sldprt, sldasm, ipt, iam, vds (`3dxml` and `vds` are new;
  obj, glb/gltf, dwg/dxf, 3dm, asm, par, ifc and the other mesh/drawing formats of 1.6.1's list no longer count).
- The Attachments panel shows each file under its sanitized `fileName` (it showed the raw `../../evil:name?.sat`), and
  Save uses that name and the attachment's MIME type. `attachmentDetails[].name` / `attachments` stay the raw PDF names.
- **One file-name rule for `exportFormat` results and `PDF3D.suggestedFileName(format, opts)`** (same opts): STEP
  `{ body: 'fitted' }` → `<stem>-surfaces-only.stp`, `{ body: 'both' }` → `<stem>-surfaces.stp`, mesh → `<stem>.stp`, also
  when the fit falls back to mesh (`browser_unsupported`, fit limit) or merges mesh leftovers into a fitted file
  (`<stem>.stp` before; its `FILE_NAME` matches). STL `{ encoding: 'ascii' }` → `<stem>-ascii.stl`; `_partial` while
  damaged. `test/run.js` checks `result.filename === suggestedFileName(format, opts)` for every format and mode.
- Advanced `#statusBadge` ("NO 3D STREAM • … ATTACHMENT: {name}") shows the sanitized `fileName`, not the raw PDF name
  (Designer's note).
- README `saveAttachment` sample retries `createWritable()` once, as export-flow does.
- Designer's `export-flow.js/.css` and `simple-mode.js/.css` from b1555e2.
- CAD worker cache key `1.6.2-w1`.
- **Damaged U3D loads what decodes** (Tester's 1.6.1 fuzz): a block that fails to decode is skipped instead of failing the
  whole stream, and a block header that is not U3D (impossible type, metadata or data past the end) is skipped with a
  resync to the next valid pair of block headers. g01-zero0.3 / zero0.6 failed completely while a truncated tail loaded
  partly; now both load 20 of 22 parts with "U3D: damaged data skipped (…)". `x05_u3d_damaged_node_count` changes from
  `DECODE_ERROR` to `'ok'` (81 parts, `damaged` set) for the same reason; its expect entry is updated.

### Fixed
- **Parasolid Save as no longer turns into a download in Chrome (export-flow, Designer).** Chrome's
  `showSaveFilePicker` throws a TypeError for `.x_t` in the `types` filter, so every Parasolid Save as silently fell
  back to a browser download. The picker now gets a type filter only for extensions of letters, digits and `+`.
- **STEP strings are encoded per ISO 10303-21** in every STEP writer (mesh, fitted, Both, step-merge): `FILE_NAME`,
  `FILE_DESCRIPTION` and the mesh writer's part names double `'` and `\` and write other non-printable-ASCII characters
  as `\X2\…\X0\` (`\X4\…\X0\` beyond the BMP). A PDF named `O'Brien bracket – ø20 ü.pdf` produced an unterminated
  string in `FILE_NAME`, and PRC part names holding a raw 0x01 or a LaTeX `\frac` (g02, g06, g10) wrote control characters
  or bad escapes into `DATA`. step-merge also no longer expands `$&` / `$'` in a file name (`String.replace` pattern).
  Plain-ASCII names are unchanged (byte-identical files). `test/run.js` loads the sample as `O'Brien bracket – ø20 ü.pdf`
  and as `back\slash 😀 $& $1.pdf`, parses the STEP header strings and decodes them back to the name (mesh, `mergeSTEP`,
  `mergeSTEPChunks`).
- **Encrypted PDFs: strings are decrypted.** Attachment names, descriptions and name-tree keys were ciphertext, so an
  embedded `.step` got a garbage name and `isCAD: false`. Strings now use the string crypt filter (`/StrF`; RC4/AES
  by object), except in object streams, the `/Encrypt` dictionary and XRef streams.
- **`/EFF`-only encryption** (`/StmF /Identity`, `/EFF` AESV2): embedded files were decrypted with RC4 and came out
  as garbage. They now use the `/EFF` crypt filter (falling back to `/StmF` per ISO 32000), with a 128-bit key for AESV2.
- **Damaged streams are no longer `UNSUPPORTED_MESH`:** g01-flip1024s1/s2 and g01-zero0.05 (broken U3D block headers)
  now load partly with a warning; g06-trunc0.999 and g07-trunc0.99 (PRC with the tail cut off, reported as "exact
  geometry without tessellation") are `DECODE_ERROR` "PRC stream is damaged (truncated: …)": a PRC stream shorter than
  its header's end-of-file offset is truncated.
- **No raw JavaScript errors** in `detail`, `message` or warnings: g01-flip1024s3 showed
  `Offset is outside the bounds of the DataView`. Runtime errors (RangeError, TypeError) from a decoder are reported as
  damaged data; the raw error goes to the console.
- **U3D block sizes ≥ 2³¹** made the 4-byte padding negative (`(n + 3) & ~3`), moving the parser backwards.
- **More embedded files are found:** PDF 2.0 `/AF` arrays (catalog, pages, annotations); `/EF /F` when the `/EF /UF`
  stream is missing or does not decode; a file spec whose EF stream is missing is listed with an `error` instead
  of being dropped; a file listed in several places is reported once.

## 1.6.1 (alpha) — 2026-11-01

### Fixed
- **Save as on a retried `createWritable()` no longer builds one huge Blob (export-flow, Designer).** The flow opens the
  writable before the export (one retry) and always passes it as `opts.writable`, so the file is streamed to disk even when
  the first `createWritable()` fails. Also from Designer: a whole-model fitting-limit card ("Saved as mesh STEP" / "Too large
  to fit surfaces in the browser (429k triangles, limit 200k).") with no per-part rows, the free-space line only for a full
  disk, and download wording that never names a folder.
- **Damaged 3D data reports a decode error instead of crashing or "unsupported".** A damaged PRC stream (bad section
  sizes, garbage after inflate) no longer hits the V8 invalid-size crash: oversized allocations are refused and the load
  ends with `DECODE_ERROR`. A PRC whose decode failures leave no body is `DECODE_ERROR`, not `UNSUPPORTED_MESH`
  ("exact geometry without tessellation"). A damaged RHAdobeMeshResource (VEA) mesh is `DECODE_ERROR` with the block
  and offset in `detail` (partly damaged models still load what decodes, with a warning). A `/3D` stream of random
  bytes is `DECODE_ERROR`; `NO_3D` is reserved for PDFs that really have no 3D stream.
- **A damaged classic U3D stream no longer hangs the page.** A corrupted count (e.g. a GroupNode's parent count)
  could make the bit reader read zeros past the end of a block for minutes (also in 1.6.0). Reads past a block's end
  now throw. A U3D stream that is truncated or whose blocks fail to decode and yields no mesh is `DECODE_ERROR` (with the
  block and offset in `detail`), not `UNSUPPORTED_MESH`. When some meshes still decode, they load with a
  "damaged data skipped" warning.
- **Info overlay:** the previous file's stream name no longer stays on screen after loading a PDF with no 3D or one that fails.
- **Fitted STEP is streamed in chunks** from the CAD worker result (4 MiB pieces), instead of being decoded into one
  string, so very large fitted files no longer need a second whole-file copy in memory.
- **Simple mode:** the Parasolid option reads "Faceted body, flat faces".
- **Export summary part count:** worker parts are de-duplicated by index, so the per-part summary can never list more
  parts than the bodies that were extracted (r08: 5415).

### Added
- **`WRITE_FAILED` results carry `errorName`** (the write error's name) and **`quota`** (`true` for `QuotaExceededError`), so
  the card shows the free-space advice only when the disk is actually full.
- **`lastLoad.attachments` / `lastLoad.attachmentDetails` on every load result**, not only `NO_3D` (see README "Load result").
- **`summary.fitSkippedReason`** on STEP Fitted / Both exports: `'too_many_tris'` (with `fitSkippedTris` and
  `fitSkippedLimit`), `'no_face_data'`, `'browser_unsupported'`, or `null` when fitting ran. One model-wide reason the
  export card can show instead of one row per part.
- **Regression corpus:** `tools/make-damaged-fixtures.js` builds `x01_damaged_prc`, `x02_damaged_vea_mesh`,
  `x03_random_bytes_3d`, `x04_attachments_only` and `x05_u3d_damaged_node_count` (the U3D hang above); `test/run.js` checks an entry's `lastLoad` keys (status,
  reasonCode, attachments) when expect.json gives them.

### Changed
- CAD worker cache key `1.6.1-w1`.

## 1.6.0 (alpha) — 2026-10-25

Alpha: the new Simple-mode Export menu is ready for testing, and its wording and options may still change.

### Added
- **One Export button in Simple mode** (Designer's `export-flow.js` / `export-flow.css`). It replaces the Simple Export
  split button and Export ▾ menu: pick a format (STEP, STL, OBJ, IGES, raw stream, Parasolid), its options, then **Save**.
  Advanced mode is unchanged.
  - **STEP body:** *Fitted solid*, *Mesh* or *Both*. With *Fitted solid*, parts that close into a solid are written as
    fitted solids. Every other part is saved as a mesh body named `<part>_mesh` in the same file (default), or left out
    with **Leave unfitted parts out**.
  - **Save dialog:** Chrome and Edge ask where to save before the export runs (cancel = nothing happens). Safari and
    Firefox show a file-name field and save to Downloads.
  - **Parasolid:** listed as *Faceted body, flat faces*, with no body or mode choice (one merged faceted body).
  - **Result card after every export:** saved, partly fitted (one line per part with its reason), fell back to the mesh
    STEP, nothing saved, cancelled, or failed. A Parasolid file that is a sheet body or has open edges gets an amber
    "Parasolid sheet body exported (open model)" card. If there are no faces, the card says "Nothing to export" and no
    file is saved (in Chrome, the empty file the save dialog made is deleted). A Parasolid file too large to write
    gets an amber "Model too large to export" card showing the estimated size (the empty save-dialog file is deleted). Parasolid cards add "Stored in meters,
    opens at true size in NX."
- **`PDF3D.exportFormat(format, opts)`** (`app.js`): one entry point for every export format, returning
  `{blob, filename, status, reasonCode, summary.parts[].written}`. For Parasolid, the summary also has `faces`, `bodies`,
  `bodyType` (`solid`/`sheet`), `sewn` and `openEdges`, taken from the 1.5.2 writer's stats. A model too large for the
  Parasolid writer returns `status: 'error'`, `reasonCode: 'XT_TOO_LARGE'`, no file and `summary.estimatedBytes`. It calls the same writers as the Advanced buttons
  (no hidden button clicks), so STEP mesh, STL, OBJ, IGES, raw and Parasolid files are byte-identical to theirs.
- **`PDF3D.capabilities.cadSurfaces`** (bool) and **`cadSurfacesReason`** (`recon/cad-export.js`): false with
  `single_file` in the single-file build, `file_url` on a `file://` page, `browser_unsupported` when the browser has no
  Web Workers or no WebAssembly, and `kernel_download` after the CAD kernel fails to download or its worker fails to start
  (true again after the next successful run or when the browser comes back online). True otherwise (reason `null`). The Export menu dims
  *Fitted solid* and *Both* and shows the reason when it is false (for `browser_unsupported`: "This browser can’t run
  surface fitting. Try a recent version of Chrome, Edge, Safari or Firefox.").
- **`PDF3D.retryCadKernel()`** (`recon/cad-export.js`): clears a `kernel_download` failure and makes a real, fresh
  attempt to download (or read from the cache) and start the CAD kernel in a new worker, then updates
  `capabilities.cadSurfaces` / `cadSurfacesReason`. Resolves `true` when fitting works again, `false` otherwise (the
  reason stays `kernel_download`); it never rejects. `single_file`, `file_url` and `browser_unsupported` resolve `false`
  without trying. The Export menu shows **Try again** next to the kernel-download reason (Designer's `export-flow.js`,
  db3c08c); *Fitted solid* and *Both* come back without a reload.
- **`PDF3D.estimateBytes(format, opts)`** (`app.js`): a size estimate before exporting, for the save dialog and
  big-file warnings. For Parasolid it runs the writer's counting pre-pass only (XT nodes × 92 bytes, the figure behind
  `XT_TOO_LARGE`) and returns the estimated size in bytes as a number; other formats, or nothing to export, return `null`.
- **`exportFormat(format, {writable})`**: given a `FileSystemWritableFileStream` (from the save dialog), the file is
  streamed into it while it is being made: every writer (Parasolid, STEP, STL, OBJ, IGES; raw and fitted STEP too)
  hands over ~1 MB pieces, each UTF-8 encoded and awaited with `writable.write(Uint8Array)` before the writer goes on.
  No Blob is created or read back on this path, so only a few MB are buffered and very large Parasolid files (r08,
  554 MB, which Chrome could not hold as Blob parts) save through the dialog. The bytes are the same as the download. The result is `{blob: null, delivery: 'picker', size}`. A failed write returns
  `status: 'error'`, `reasonCode: 'WRITE_FAILED'`. `exportFormat` never calls `close()` or `abort()`; the caller does.
  Without `writable` the result is the Blob as before, now with `delivery: 'download'` and `size`. This applies to every
  format, including fitted STEP.
- `recon/cad-worker.js` is loaded with its own cache key (`?v=1.6.0-w2`), so a browser never runs a cached older worker.
- `test/run.js`: a corpus file with no `test/expect.json` entry, or one that decodes to 0 triangles (unless its entry
  has `"allowZeroTris": true`), fails; an empty corpus dir fails; without a corpus the last line says that only the
  built-in checks ran (no `ALL OK`). `--exports` checks that the writable path gives the same bytes as the download for
  every format and creates no Blob; `--identity` repeats that on every corpus file.
- `exportFormat('step', {body: 'fitted' | 'both'})` in a browser without Web Workers or WebAssembly
  (`cadSurfacesReason: 'browser_unsupported'`) returns the mesh STEP with `status: 'mesh_only'`,
  `reasonCode: 'browser_unsupported'` (per part too); with `onNoFit: 'omit'` it is skipped with that code.
- Fitted STEP length units: not added. A STEP file records its own unit, so the mm output is correct;
  `capabilities.fittedUnits` is not set, and the Units setting is hidden for Fitted and Both.
- **Fitted-only CAD export can leave open shells out** (`exportCadSurfaces(..., {fittedOnly: true, solidsOnly: true})`,
  `recon/cad-worker.js`): only closed solids are written as fitted bodies. The default is unchanged.

### Changed
- `cad-export-ui.js` from Designer: when the browser is offline, a failed kernel download or worker now reads
  "You’re offline" with a reconnect hint, and a late progress update can no longer replace the screen-reader
  announcement of the result. Its result wording is shared with the Export card (`PDF3DCadExportUI.describe`).
- Advanced **Export Parasolid (.x_t)** no longer says the file was saved, because the browser download can still fail.
  It says "Parasolid download started: screw.x_t". Above about 300 MB it adds: "This file is about 1.1 GB. Chrome can
  cancel downloads this large without a message; if it isn't in your Downloads, hide some parts or use Reduce detail
  and export again."
- Export card (Designer's `export-flow.js`, 1dbed0a): after a save-dialog file that needed a second try to open, the
  card says "Saved as" (it was "Sent to Downloads as"); only a real fallback to Downloads says "Sent to Downloads as",
  and the empty picked file is then removed. Every downloaded file over about 300 MB gets the size check, including
  amber cards (as their first line); saves through the dialog never do. A part that could not be fitted gives its
  reason as its own sentence, without nested parentheses.
- Sizes under 1 GB in Parasolid messages are shown in MB (was "0.0 GB").
- The page title lists Parasolid .x_t.

### Fixed
- Advanced mode on phones (390 px): the longer B-Rep Mode option text from 1.5.2 no longer makes the page scroll sideways.
- After a CAD kernel download failure, the next export that gets the kernel running reports its real status (it was
  "unknown", with no reasonCode) and turns Fitted and Both back on without a reload.
- Both (fitted + mesh): a part whose fit stopped short (status `mesh_only`) is no longer written as a partial
  `<name>_fitted` body, so the file matches the summary (r03: "No clean surface fit", mesh bodies only). Every mesh body
  in a Both file is now named `<name>_mesh`, including parts that could not be fitted and models with no face data.
  Each part in a Both result also lists `fittedBody` and `meshBody`, the body names actually in the file.
- Parasolid open models (sheet bodies): a loop vertex that lands exactly on the previous one when flattened onto its
  face plane is dropped, so no zero-length line with a (0,0,0) direction is written (one line in r07). Other files are
  byte-identical to 1.5.2.
- `test/run.js` loads the app again (its fake window now has `matchMedia`, which `simple-mode.js` reads at load).

### Known issues
- Fitted surfaces need the multi-file app served over http(s); `file://` pages and the single-file build say they are unavailable.
## 1.5.3 — 2026-11-01

### Fixed
- **SAP Visual Enterprise Author 9.0 U3D** (`RHAdobeMeshResource`, UIC1-encoded arrays) now decodes. Before, the screw
  from VEA showed "No mesh found" (`UIC1: data ended at value 65752`). Four UIC1/normal bugs in `u3d-rhadobe-mesh.js`,
  only reachable by UIC1 producers (r09 uses RH39 and is unchanged):
  - LongReplicate16 (extended cmd 13) produced U16+36 values, not U16+37 (it keeps the current value and queues 36+N more).
  - prevVertical (the value 3 back) was used only for face-index arrays. VEA also uses `DeltaU4*_V` in position arrays.
  - The previous-values ring starts as `GetBackValue(w) == w`, not zeros (VEA face indices begin with BackPtrValue(4), (6), …).
  - Type-3 (alpha/theta) normals are one UINT block of 2n values, not two blocks.
- Simple's status chip no longer shows the raw decoder error as its hover text: for `DECODE_ERROR` it shows the card
  line, and the raw error is only in the console.
- `test/run.js` stubs `window.matchMedia`.
- `docs/rhadobe-mesh-resource.md`: type-3 normals are now listed as verified (SAP VEA screw).

### Added
- `window.PDF3D.lastLoad` / `CAD3DExtractor.getLastLoad()`: `ok` / `unsupported` (`UNSUPPORTED_MESH`) / `error`
  (`DECODE_ERROR`) / `no3d` (`NO_3D`) with `format`, `detail` and a display `message` (see README "Load result").
- Simple mode: load-result cards in the empty viewport (Designer wording). `UNSUPPORTED_MESH` and `DECODE_ERROR` are amber, `NO_3D`
  is neutral. The raw decode error is never shown on the card; it is logged once with `console.warn('[PDF3D] 3D decode error: …')`.
  A PDF with no 3D content and no attachments now clears the viewport and shows the `NO_3D` card in Simple mode instead of an
  `alert()` over the previous model. Advanced is unchanged.

### Known issues
- The *sheet-unsewn* and *faceted* XT modes (API only) are not tested in NX; `xt-check` reports their open sheet edges.
- Open models (any open edges) export by default as a Parasolid **sheet body**; this form has not yet been tested in NX.
- Chrome: very large Parasolid downloads (roughly above 300–600 MB, a browser limit on blob downloads) can be cancelled
  at 0 bytes while the app still shows success. Normal parts (e.g. the 41 MB screw) are unaffected. To be fixed in 1.6.0.
- One zero-length line (zero tangent) is written for a degenerate edge in r07, an open sheet model (1 of 1.6 million lines).

## 1.5.2 — 2026-10-25

### Added
- **Parasolid (.x_t) export is back**, in both modes: a **Parasolid (.x_t)** item in Simple's Export ▾ menu and the
  **Export Parasolid (.x_t)** button plus the **Parasolid .x_t Inspector** tab in Advanced. No `?xt=1` needed.
  - Shown only while the writer is the NX form (`PDF3D.capabilities.parasolid`, a new flag for export UI wiring).
  - Always exports one merged planar B-Rep body, the mode verified in NX. The **Body type** setting still applies to STEP only.
  - Every export shows a result message, e.g. "Parasolid file saved: screw.x_t" with "1 solid body, 44,724 flat faces",
    or says why nothing was saved (no visible geometry, model too large, out of memory, other error).
    - When the count differs from the viewer, the message says why: on screw, "The viewer shows 44,682 faces: 42 of them
      are not exactly flat, so they were saved as 84 flat triangles" (each bends 14 to 90 nm, over the 4 nm flat limit).
    - Open models (not closed, e.g. g06 to g09, r03, r04) still export, as a sheet body. The title is **"Parasolid sheet
      body exported (open model)"**, followed by "This part isn't closed, so it was saved as surfaces, not a solid. This
      form hasn't been tested in NX."
    - With every part hidden, no file is saved and the message reads "Parasolid export: nothing to save".
  - Menu sub-line and button tooltip: **Faceted solid, flat faces**. The Advanced **B-Rep Mode** tooltip and its
    *Multi-Body Assembly* option now say they apply to STEP only: Parasolid always writes one merged body.
  - `buildParasolidXT` reports a summary for the UI (`options.stats`, or `CAD3DExtractor.getLastXTStats()`):
    `faces` (FACE nodes written), `bodies`, `bodyType` (`'solid'` / `'sheet'`), `sewn`, `openEdges`, plus `viewerFaces`,
    `splitFaces`, `splitTris`, `estimatedBytes` and the node `counts`.

### Changed
- **The .x_t file is now in the Siemens NX format and imports into NX** (`buildParasolidXT` in `app.js`): schema
  `SCH_3800173_37102` (key `SCH_3800173_37102_13006`) with inline BODY/REGION schema deltas, NX header keys
  (`APPL=NX`, `KEY=<part>`, `USFLD_SIZE=0`), strict token spacing, Python-style reals, nodes in index order and
  80-column CRLF lines. This is a port of the QA rewriter `xt-rewrite.py --nx-embedded`: the browser output needs no
  post-processing. The old `SCH_1200000_12006` output was rejected by NX.
  - Verified in NX: screw.pdf exports byte-identical to the file Steven imported (41,222,574 bytes, 1 solid body,
    44,724 planar faces); `xt-check` CLEAN on screw, head_test and the bundled sample.
  - The API's *merged-assembly* mode now writes one merged body (the ASSEMBLY/INSTANCE layouts of schema 37102 are not known).
  - The XT inspector reads node counts from the writer (the stream is wrapped at 80 columns).
  - The writer streams: a counting pass plans each part's node indices, then each part is expanded and written in
    index order before the next one, so memory holds one part's topology plus a small text buffer. All 25 corpus files
    export under a 4 GB heap (r13, the largest, writes 3.96 GB). Peak memory is at or below 1.5.1 on most files
    (screw 393 MB, was 459 MB; r09 779 MB, was 1,261 MB; r11 587 MB, was 1,599 MB). It is higher on r07 (2.2 GB vs 1.9 GB)
    and on r13, where the 4 GB file itself is held in Blob memory outside the JS heap until it is saved. The first 1.5.2
    builds held every record of the body at once and ran out of memory on r05, r07, r08, r10, r13 and r17.
  - A size guard runs before anything is written: when the estimated file (92 bytes per node) is over 8 GB, the export stops with
    "Parasolid export: model too large" (error code `XT_TOO_LARGE`) and suggests hiding parts or Reduce detail.

### Known issues
- The *sheet-unsewn* and *faceted* XT modes (API only) are not tested in NX; `xt-check` reports their open sheet edges.
- Open models (any open edges) export by default as a Parasolid **sheet body**; this form has not yet been tested in NX.
- Chrome: very large Parasolid downloads (roughly above 300–600 MB, a browser limit on blob downloads) can be cancelled
  at 0 bytes while the app still shows success. Normal parts (e.g. the 41 MB screw) are unaffected. Fixed in 1.6.0.
- One zero-length line (zero tangent) is written for a degenerate edge in r07, an open sheet model (1 of 1.6 million lines).

## 1.5.1 — 2026-10-25

### Fixed
- CAD surfaces (STEP) export wording, all by Designer (`cad-export-ui.js`):
  - The kernel download size now reads **13.7 MB** (decimal MB, same as the app's own label). 1.5.0 showed 13.1 MB in the menu and toast.
  - The face breakdown names every surface type in the right number, e.g. "34 (24 B-spline surfaces, 8 cylinders, 2 planes)".
    Surfaces of revolution now have a name too, e.g. "48 surfaces of revolution" on head_test. 1.5.0 showed the internal key `revolution`.
  - When **Fitted solid only** finds nothing to fit (U3D models, the bundled legacy sample, selections above the fitting limit,
    or no face could be fitted), the result now tells you to turn off **Fitted solid only** to get the mesh body in a STEP file.
  - A CAD kernel that can't be downloaded (offline, firewall, proxy or browser extension), a surface-fitting worker the browser
    blocks, and running out of memory each get a plain title and a next step, e.g. "CAD kernel didn’t download: mesh body exported".
    With **Fitted solid only** on, the title names the cause and the message says nothing was exported.
  - The UI now reads the engine's `reasonCode` to choose this wording.

## 1.5.0 — 2026-10-25

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
  - The kernel wasm is kept in Cache Storage after the first download, so later exports start without downloading it;
    the "first use downloads 13.7 MB" note checks that cache. Offline or blocked downloads give a plain message and the mesh body.
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
