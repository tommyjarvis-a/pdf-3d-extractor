# recon/ — "Export as CAD surfaces (STEP)" (feature/cad-surfaces, work in progress)

Spike checkpoint (feasibility): the OpenCascade stage runs in a module Web Worker on **pre-fitted** inputs
(fits produced by the Python pipeline in nx-prc-analysis). The JS fitting port (`fit.js`) is not written yet.

- `occ-build.js` — UMD; port of brep.py/topo.py/export_step.py to opencascade.js 2.0-beta: topology (boundary
  loops, edges split at ≥3-face vertices), edge curves (line/arc/cubic interpolation, uv-projected cut edges),
  analytic + B-spline surfaces, trimming (MakeFace + ShapeFix_Face), sewing into shell/solid + ShapeFix_Shape,
  validity check, per-triangle mesh body, XCAF STEP AP214 writer with named bodies.
- `cad-worker.js` — module worker; lazy-loads `vendor/opencascade/*` on first use.
- `spike.html` — test page: `spike.html?mesh=<mesh.json>&inputs=<inputs.json>&name=<part>[&fittedOnly=1]`.
- `vendor/opencascade/` — opencascade.js 2.0.0-beta.b5ff984 full build, LGPL-2.1 (see THIRD_PARTY.md).
  50,305,130 B raw / 13.7 MB gzip.
