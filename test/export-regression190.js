'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),{loadApp}=require('./run');
const baseline=process.env.PDF3D_BASELINE_ROOT||'/workspace/pdf-3d-extractor-qa/v180/src-18d';
if(!fs.existsSync(path.join(baseline,'index.html'))){console.log('SKIP sample export baseline: set PDF3D_BASELINE_ROOT to v1.8.0 files');process.exit(0);}
(async()=>{const bytes=new Uint8Array(fs.readFileSync(path.join(__dirname,'../sample-cad-assembly-3d.pdf')));const old=loadApp({},baseline),now=loadApp();
 for(const app of [old,now])await app.api.loadPDFBuffer(bytes,'comparison.pdf');let checked=0;
 for(const units of ['mm','in'])for(const detail of [1,.5])for(const [format,extra]of [['xt',{}],['step',{}],['stl',{}],['stl',{encoding:'ascii'}],['obj',{}],['iges',{}],['raw',{}]]){
  const options={units,detail,...extra},a=await old.window.PDF3D.exportFormat(format,options),b=await now.window.PDF3D.exportFormat(format,options);
  assert.equal(a.status,b.status);assert(Buffer.from(await a.blob.arrayBuffer()).equals(Buffer.from(await b.blob.arrayBuffer())),`${format}/${units}/${detail} changed`);checked++;
 }
 console.log('OK',checked,'sample exports byte-identical to v1.8.0');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
