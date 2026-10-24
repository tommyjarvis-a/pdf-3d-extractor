# Changelog

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
- Overflow on large compressed tessellations (index and normal counts past 16-bit or 2^24).
- Streams that decoded with 0 triangles because the tessellation was compressed or the geometry was exact B-Rep only.

### Changed
- Status badge now reports the decode path: PRC tess, exact B-Rep, U3D, embedded CAD attachment, or none.
- `pdf-3d-extractor-standalone.html` regenerated with all scripts inlined.
