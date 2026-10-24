# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Client-side web workbench that extracts embedded 3D streams (`/Subtype /U3D` ECMA-363 & `/Subtype /PRC` ISO 14739-1) from 3D PDF files, reconstructs watertight 2-manifold B-Rep faces and analytic hole/boss features, and exports CAD-ready geometry:

- **Parasolid XT (`.x_t`)** — Native Siemens Parasolid ASCII transmit format (`SCH_1200000_120060`, meter-scaled `1e-3 m/mm`, `UIO=1000`) with `BODY`, `REGION`, `SHELL`, `FACE`, `LOOP`, `FIN`, `EDGE`, `VERTEX`, `PLANE`, `CYLINDER`, `LINE`, and `POINT` topological chains for direct import into Siemens NX, SolidWorks, Solid Edge, and Onshape.
- **STEP AP214 (`.stp`)** — ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` with outer and inner `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)** — Per-solid watertight triangle meshes.
- **Wavefront OBJ (`.obj`)** — Multi-body named groups (`o` / `g`) with vertex normals.
- **IGES 5.3 (`.igs`)** — Sharp feature-edge 3D CAD wireframe (`Entity 110`).
- **Raw `.u3d` / `.prc` stream extraction** — Direct binary payload extraction from `/3D` and `/RichMedia` dictionaries.

## Usage

Open `index.html` (multi-file, served or via `file://`) or the single-file offline build `pdf-3d-extractor-standalone.html`, then drop a 3D PDF. Everything runs client-side; no build step.

## What 1.2.0 decodes

| Source in the PDF | Decode path | Status badge |
|---|---|---|
| `/3D` or `/RichMedia` PRC stream with tessellation (`TESS_3D`, `TESS_3D_Compressed`, `TESS_3D_Wire`) | `prc-decoder.js` | `PRC TESS • …` |
| PRC stream with exact B-Rep only (`TOPO_BrepData`, `TOPO_BrepDataCompress`) | `prc-brep.js` tessellates NURBS/analytic faces | `PRC EXACT B-REP • …` |
| U3D (ECMA-363) CLOD mesh | `app.js` U3D parser plus `u3d-guard.js` (bounded reads, unsupported-block warnings) | `U3D • …` |
| Embedded CAD file (`/EmbeddedFiles` name tree or `/FileAttachment` annotation: STEP, IGES, Parasolid, JT, NX/CATIA/SolidWorks, STL/OBJ/3MF, …) | `pdf-extract.js` | `NO 3D STREAM • EMBEDDED CAD ATTACHMENT: name` |
| Nothing usable | n/a | alert "No embedded /3D (U3D / PRC) streams or file attachments found" |

PDF layer (`pdf-extract.js`, `crypto-lite.js`):
- classic xref tables and xref streams, object streams, and incremental updates
- broken-xref recovery
- Flate, LZW, ASCIIHex, ASCII85 and RunLength filters, with predictors
- Standard security handler: RC4 40/128, AES-128 and AES-256 (R2–R6) with the empty user password. AES-256 needs WebCrypto.

Every 3D annotation on every page is listed. Each stream gets its product tree (PRC product occurrences, with names), part transforms, and the `/3DU` unit scale. Wire and polyline geometry is drawn as well. Embedded attachments can be saved from the "Product Tree & Attachments" panel.

Large models: an export over ~128 M characters comes back as an array of line-aligned chunks and is written as a `Blob`, which avoids `RangeError: Invalid string length`. The inspector shows only the first lines of large exports.

## Known limitations

- **U3D `RHAdobeMeshResource`** (Adobe's proprietary mesh compression, e.g. Acrobat-converted files) is not documented publicly. Files that use it are detected and reported with a warning, and no geometry is extracted from them.
- **Exact B-Rep** is tessellated for display and export. Analytic hole/boss features are only derived from meshes, and trimmed NURBS faces that fail tessellation are skipped with a warning.
- **Very large models** (hundreds of thousands of triangles) parse fine. Generating every export format at once can still need several GB of memory.
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
