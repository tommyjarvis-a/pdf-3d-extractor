# PROGRESS — finish/verify "Export as CAD surfaces (STEP)" (1.5.0, feature/cad-surfaces)

Restart guide: read this file top to bottom, then `git log --oneline -10`. Each step below is marked DONE / IN PROGRESS / TODO.
Outputs go to `test-out/` (untracked). Don't push, don't bump version, don't merge into main, don't touch /workspace/pdf-3d-extractor.

## Steps
- [x] 0. DONE Merge main (b2e9f8c, v1.4.1) into feature/cad-surfaces (merge, not rebase)
- [x] 1. DONE Browser e2e (Playwright, Chrome) head_test + sample2, fittedOnly true/false
- [ ] 2. Score fitted outputs vs Parasolid refs
- [ ] 3. Fallbacks: r17/dice mesh_only, r05/r13 too_large, cancel, standalone unavailable
- [ ] 4. 25-file corpus harness (flock /tmp/pdf3d-bigrun.lock, capped heap, --jobs=1) vs v1.4.1
- [ ] 5. Designer suite (/workspace/pdf3d-simple-mode/test)

## Log
- 2026-10-25 09:55 EDT: started; no prior PROGRESS.md existed. HEAD f178afc, tree clean.
- 09:58 EDT: merged b2e9f8c (conflicts CHANGELOG.md, index.html resolved; recon scripts at ?v=1.4.1). Commit: a187470
- 09:57 EDT: added recon/tools/browser-e2e.cjs (Playwright/Chrome driver). Step 1 running via test-out/run-e2e.sh (untracked).
  head_test full: solid, 421 faces, 47.9 s wall, WASM heap 105 MB, vol 3611401.9 (+0.145%).
- 10:04 EDT: steering from parent: (1) pushing feature/cad-surfaces (never main) after milestones is allowed; (2) use Designer's cad-export-ui.js/.css as the only CAD export UI (Simple + Advanced), remove the Advanced #btnExportCAD button/panel.
- 10:15 EDT: step 1 DONE: browser e2e, 4 runs all `solid` (test-out/*.stp). Standalone (merged build in test-out/standalone-merged.html): preflight unavailable, export skipped/unavailable.
  Designer suite (test.js) first run on merged tree, before the UI swap: failures in [chromium +macOS focus] Export menu/Display (to investigate after the swap).
- 10:15 EDT: UI swap done (cad-export-ui.* copied unmodified; index.html wiring; cad-export.js Advanced button code removed).
