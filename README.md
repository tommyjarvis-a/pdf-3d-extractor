# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Client-side web workbench that extracts embedded 3D streams (`/Subtype /U3D` ECMA-363 & `/Subtype /PRC` ISO 14739-1) from 3D PDF files, reconstructs watertight 2-manifold B-Rep faces and analytic hole/boss features, and exports CAD-ready geometry:

- **STEP AP214 (`.stp`)** — Recommended for Siemens NX. ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` with outer and inner `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)** — Per-solid watertight triangle meshes.
- **Wavefront OBJ (`.obj`)** — Multi-body named groups (`o` / `g`) with vertex normals.
- **IGES 5.3 (`.igs`)** — Sharp feature-edge 3D CAD wireframe (`Entity 110`).
- **Raw `.u3d` / `.prc` stream extraction** — Direct binary payload extraction from `/3D` and `/RichMedia` dictionaries.

> **Parasolid XT (`.x_t`) export is temporarily disabled.** Siemens NX currently reports the generated `.x_t` as corrupt, so the export button and inspector tab are hidden until the NX import issues are fixed. Use **STEP AP214 (`.stp`)** for NX. The exporter code is retained (`buildParasolidXT` in `app.js`, gated by `ENABLE_XT_EXPORT`); append `?xt=1` to the page URL to re-enable it for development testing only.

## Usage

Open `index.html` (multi-file, served or via `file://`) or the single-file offline build `pdf-3d-extractor-standalone.html`, then drop a 3D PDF. Everything runs client-side; no build step.

## What 1.4.1 decodes

| Source in the PDF | Decode path | Status badge |
|---|---|---|
| `/3D` or `/RichMedia` PRC stream with tessellation (`TESS_3D`, `TESS_3D_Compressed`, `TESS_3D_Wire`) | `prc-decoder.js` | `PRC TESS • …` |
| PRC stream with exact B-Rep only (`TOPO_BrepData`, `TOPO_BrepDataCompress`) | `prc-brep.js` tessellates NURBS/analytic faces | `PRC EXACT B-REP • …` |
| U3D (ECMA-363) CLOD mesh | `app.js` U3D parser plus `u3d-guard.js` (bounded reads, unsupported-block warnings) | `U3D • …` |
| U3D vendor `RHAdobeMeshResource` mesh | `u3d-rhadobe-mesh.js` (see `docs/rhadobe-mesh-resource.md`) | `U3D/RHAdobeMeshResource` |
| Embedded CAD file (`/EmbeddedFiles` name tree or `/FileAttachment` annotation: STEP, IGES, Parasolid, JT, NX/CATIA/SolidWorks, STL/OBJ/3MF, …) | `pdf-extract.js` | `NO 3D STREAM • EMBEDDED CAD ATTACHMENT: name` |
| Nothing usable | n/a | alert "No embedded /3D (U3D / PRC) streams or file attachments found" |

PDF layer (`pdf-extract.js`, `crypto-lite.js`):
- classic xref tables and xref streams, object streams, and incremental updates
- broken-xref recovery
- Flate, LZW, ASCIIHex, ASCII85 and RunLength filters, with predictors
- Standard security handler: RC4 40/128, AES-128 and AES-256 (R2–R6) with the empty user password. AES-256 needs WebCrypto.

Every 3D annotation on every page is listed. Each stream gets its product tree (PRC product occurrences, with names), part transforms, and the `/3DU` unit scale. Wire and polyline geometry is drawn as well. Embedded attachments can be saved from the "Product Tree & Attachments" panel.

Large models: parts are stored as typed arrays with one compact welded B-Rep each, and every exporter streams part by part into a chunked `Blob`, so 1–2M triangle models parse and export without `RangeError: Invalid string length` or out-of-memory. The viewport shows a decimated preview (≤200k tris) and a banner above 1M tris. An optional "Export detail" setting (off = 100% by default) decimates exports.

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
