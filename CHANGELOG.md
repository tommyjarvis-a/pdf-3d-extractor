# Changelog

## 1.3.0 — 2026-10-24

Large models (1M+ triangles) no longer exhaust memory, and the vendor U3D mesh in RHAdobeMeshResource files is decoded. Much of this release builds on the QA Tester's root-cause analysis and prototypes (`pdf-3d-extractor-qa/fixes/`, REPORT.md "Problem files").

### Fixed
- Out-of-memory on very large models (corpus r05 1.29M tris, r07 650k, r13 1.99M). The Tester traced it to the legacy per-part B-Rep (about 1.1 KB per triangle, cached for the session and rebuilt for each of r05's 956 instances of 247 tessellations). Now:
  - PRC parts are kept as typed arrays (`Float64Array` positions, `Uint32Array` indices).
  - Each part gets one compact, welded B-Rep (`vx`/`tv`/`fev` typed arrays). The full object form is re-expanded per part only while exporting XT/STEP, and cached only for models of 300k tris or fewer.
  - Every exporter (STL, ASCII STL, OBJ, IGES, STEP AP214, Parasolid X_T) streams part by part into line-aligned chunks that become a chunked `Blob`, so no single huge string or array is ever built. STL and OBJ never build a B-Rep.
  - Measured peak RSS (headless, Node) for parse plus STL/OBJ: r05 0.48 GB, r13 0.61 GB, r07 0.50 GB. Before, r05 hit 1.9 GB after STL and 2.7 GB after OBJ, r13 hit 3.0 GB after STL, and STEP/XT ran out of memory at 9–10 GB.
- U3D `RHAdobeMeshResource` (Right Hemisphere / Adobe mesh compression, corpus r09): geometry is now decoded (142k tris, 2 bodies) instead of "unsupported". Uses the Tester's `u3d-rhadobe-mesh.js`, written from the Acrobat SDK 8.1 "U3D Supported Elements" spec. Encodings 8/9 (U3D arithmetic) are not implemented; a file that uses them still gets the clear "unsupported" message.
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
