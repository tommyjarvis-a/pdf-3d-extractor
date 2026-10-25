# PROGRESS — finish/verify "Export as CAD surfaces (STEP)" (1.5.0, feature/cad-surfaces)

Restart guide: read this file top to bottom, then `git log --oneline -10`. Each step below is marked DONE / IN PROGRESS / TODO.
Outputs go to `test-out/` (untracked). Push only feature/cad-surfaces (never main), don't bump version, don't merge into main, don't touch /workspace/pdf-3d-extractor.

## Steps
- [x] 0. DONE Merge main (b2e9f8c, v1.4.1) into feature/cad-surfaces (merge, not rebase)
- [x] 1. DONE Browser e2e (Playwright, Chrome) head_test + sample2, fittedOnly true/false
- [x] 2. DONE Score fitted outputs vs Parasolid refs (test-out/score-*.md)
- [x] 3. DONE Fallbacks: r17/dice mesh_only, r05/r13 too_large, cancel, standalone unavailable
- [x] 4. DONE 25-file corpus harness (flock /tmp/pdf3d-bigrun.lock, capped heap, --jobs=1) vs v1.4.1
- [x] 5. DONE Designer suite (/workspace/pdf3d-simple-mode/test)

## Log
- 2026-10-25 09:55 EDT: started; no prior PROGRESS.md existed. HEAD f178afc, tree clean.
- 09:58 EDT: merged b2e9f8c (conflicts CHANGELOG.md, index.html resolved; recon scripts at ?v=1.4.1). Commit: a187470
- 09:57 EDT: added recon/tools/browser-e2e.cjs (Playwright/Chrome driver). Step 1 running via test-out/run-e2e.sh (untracked).
  head_test full: solid, 421 faces, 47.9 s wall, WASM heap 105 MB, vol 3611401.9 (+0.145%).
- 10:04 EDT: steering from parent: (1) pushing feature/cad-surfaces (never main) after milestones is allowed; (2) use Designer's cad-export-ui.js/.css as the only CAD export UI (Simple + Advanced), remove the Advanced #btnExportCAD button/panel.
- 10:15 EDT: step 1 DONE: browser e2e, 4 runs all `solid` (test-out/*.stp). Standalone (merged build in test-out/standalone-merged.html): preflight unavailable, export skipped/unavailable.
  Designer suite (test.js) first run on merged tree, before the UI swap: failures in [chromium +macOS focus] Export menu/Display (to investigate after the swap).
- 10:15 EDT: UI swap done (cad-export-ui.* copied unmodified; index.html wiring; cad-export.js Advanced button code removed).
- 10:18 EDT: step 2 DONE. screw: closed/valid, 34 faces, vol -0.012%, fit->ref max 0.0123 / rms 0.00072 mm (target max 0.012, vol -0.014%).
  head_test: closed/valid, 421 faces, vol +0.145% (Python +0.10%), fit->ref rms 0.0243 / p99 0.115 / max 0.212 mm (target ~0.025). No fit fix needed.
  Step 3 DONE (test-out/policy-*.log, cancel-head_test.log): dice mesh_only 0.2 s; r17 mesh_only (403 k tris > 200 k fit limit) 7.2 s, 343 MB STEP, peak tree RSS 3.1 GB;
  r13 skipped too_large (1.99 M), r05 skipped too_large (1.29 M), no OOM; cancel at fit -> cancelled in 4.5 s.
  Added recon/tools/cad-ui-real.test.cjs: Designer's UI against the real engine, 23/23 PASS (test-out/designer/cad-ui-real.log).
  Designer stub test cad-export.test.js on the merged copy: 99/100; the 1 FAIL is "no add-on: no CAD elements" — that test expects index.html
  without the add-on, but on this branch index.html ships it (expected mismatch, not a defect).
- 10:22 EDT: Python head_test re-scored with the current scorer (test-out/score-head_test-python.md): vol +0.102%, fit->ref rms 0.0241 / max 0.2123,
  coverage 45.8% (JS 45.7%: same scorer artifact, not a JS gap). JS rms is 1.01x Python. CHANGELOG numbers updated to measured values.
- 10:24 EDT: Designer test.js on the merged copy (/tmp/cad-merged-suite = git archive 8aa983d, real engine + add-on in index.html): 304/306.
  FAILs: (a) round-trip pixel check, 5 px (known 1.4.1 anti-aliasing diff, baseline also fails it: 305/306);
  (b) "Export menu lists STL…Raw" sees 2 extra entries (the add-on's separator + CAD item). Designer's README says test.js was not run with the add-on in index.html; expected.
  The earlier [chromium +macOS focus] Export/Display failures are gone (they were from the old #btnExportCAD panel or CPU contention).
  safari-focus.test.js (SAFARI=1): pass (test-out/designer/safari-focus.log).
- 10:25 EDT: step 4 started: 25-file harness, label cad-merged-6c6bc8c (test-out/harness-run.sh, harness.out).
- 10:40 EDT: step 4 DONE: harness cad-merged-6c6bc8c 25/25 PASS, 0 diffs in status/tris/parts/verts vs v141-b2e9f8c. All steps done; next: Tester QA, then 1.5.0 bump + merge to main.
