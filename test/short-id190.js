#!/usr/bin/env node
'use strict';
// Focused genuine-encryption /ID compatibility checks; no corpus or browser run.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const assert = require('assert/strict'), crypto = require('crypto');
const {loadApp} = require('./run');
const ROOT = path.resolve(__dirname, '..');
const python = process.env.PDF3D_QPDF_PYTHON || '/workspace/pdf-encoding-survey-2026-11-07/venv/bin/python';
const external = process.env.PDF3D_SHORT_ID_REPRO || '/workspace/pdf-3d-extractor-qa/v190/repro/cb75-compat';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  if (!fs.existsSync(python)) { console.log('SKIP short-ID libqpdf oracle: survey venv absent'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf3d-short-id-'));
  try {
    const generated = cp.spawnSync(python, [path.join(__dirname,'short-id190.py'), tmp, ROOT, external], {encoding:'utf8'});
    assert.equal(generated.status, 0, generated.stderr);
    const {qpdf, pikepdf, records} = JSON.parse(generated.stdout);
    if (records.length === 10) console.log('SKIP external genuine-ID repros: absent (10 generated controls still run)');
    let files = 0, streams = 0;
    for (const page of ['index.html','pdf-3d-extractor-standalone.html']) {
      const {api, window, ctx} = loadApp({}, ROOT, page), X = window.PDF3DExtract;
      let legacyWarnings = 0;
      ctx.console = {...console, warn: (...a) => { if (String(a[0]).includes('falling back to legacy')) legacyWarnings++; }};
      for (const record of records) {
        const data = new Uint8Array(fs.readFileSync(record.file));
        const decoded = await X.extract3DStreamsFromPDF(data);
        const expected = record.streams.map(s => s.subtype + ':' + s.sha).sort();
        assert.deepEqual(Array.from(decoded, s => s.subtype + ':' + sha(s.rawBytes)).sort(), expected, record.label);
        let prompts = 0;
        await api.loadPDFBuffer(data, record.label + '.pdf', {requestPassword: async () => { prompts++; return null; }});
        assert.equal(window.PDF3D.lastLoad.status, 'ok', record.label);
        assert.equal(prompts, 0); assert.equal(legacyWarnings, 0);
        for (let i = 0; i < decoded.length; i++) {
          await api.activateStream(i);
          const raw = await window.PDF3D.exportFormat('raw');
          assert.equal(raw.status, 'ok'); assert.ok(raw.blob);
          assert.equal(sha(Buffer.from(await raw.blob.arrayBuffer())), sha(decoded[i].rawBytes), record.label);
          streams++;
        }
        files++;
      }
      console.log(`${page}: ${records.length}/${records.length} genuine short-ID/control PDFs decrypt; stream bytes + raw exports match libqpdf; no prompts/legacy warnings`);
    }
    console.log(`OK ${files} file loads / ${streams} decrypted stream + raw-export identities (libqpdf ${qpdf}, pikepdf ${pikepdf})`);
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
})().catch(e => {console.error(e);process.exitCode=1;});
