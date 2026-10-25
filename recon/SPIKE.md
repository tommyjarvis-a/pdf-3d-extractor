# Feasibility spike results (2026-10-25)

Headless Chrome (Playwright, /usr/bin/google-chrome) running a module Web Worker. Served from localhost with gzip.
The inputs are already fitted by the Python pipeline, so this measures the OCC stage only.

| | head_test (421 regions, 37,196 tris) | screw (34 regions, 45,638 tris) |
|---|---|---|
| WASM fetch + compile + init | 3.0 s | 2.9 s |
| edges + trim faces + sew + ShapeFix | 9.1 s | 2.8 s |
| validity check (BRepCheck, volume, free edges) | 2.5 s | 0.45 s |
| mesh body (one face per triangle) | 0.66 s | 0.88 s |
| STEP write, fitted + mesh | 26.3 s (99.0 MB) | 31.5 s (116.5 MB) |
| STEP write, fitted only (Node) | 1.4 s (8.3 MB) | — |
| end to end in the worker | 41.6 s | 38.6 s |
| WASM heap at end | 642 MB | 743 MB |
| closed / valid | yes / yes, 421 faces, 4 fall back to untrimmed (same 4 as Python) | yes / yes, 34 faces |

Scored with score.py (Python in brackets):
- head_test:
  - volume +0.098% (+0.102%)
  - type match 237/329 (237/329)
  - mesh→fit max 0.106 mm (0.119 mm)
  - coverage 45.74% (45.82%)
  - watertight and valid
- screw:
  - volume −0.013% (−0.013%)
  - type match 27/34 (27/34)
  - fit→ref max 0.0123 mm (0.0127 mm)
  - coverage 100%
  - watertight and valid
