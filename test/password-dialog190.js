'use strict';
// DOM contract test, not a real-browser smoke test. Verifies production dialog handlers.
const {loadApp}=require('./run'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
(async()=>{
 const {api,window,ctx}=loadApp({},undefined,process.env.PDF3D_TEST_PAGE||'index.html'),dialogs=[];
 ctx.document.createElement=tag=>{
   assert.equal(tag,'dialog');const listeners={};const nodes=Object.fromEntries(['input','p','form','[data-cancel]'].map(k=>[k,{value:'',textContent:'',focus(){},addEventListener(t,f){this[t]=f;}}]));
   const dialog={innerHTML:'',className:'',querySelector:s=>nodes[s],showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;},addEventListener(t,f){listeners[t]=f;},nodes,listeners};dialogs.push(dialog);return dialog;
 };
 const bytes=new Uint8Array(fs.readFileSync(path.join(__dirname,'../sample-cad-assembly-3d.pdf')));
 const original=window.PDF3DExtract.extract3DStreamsFromPDF;let calls=[];
 window.PDF3DExtract.extract3DStreamsFromPDF=async(u8,file,opts)=>{calls.push(opts.password);if(opts.password!=='ephemeral-test-input'){const e=Error('Password needed');e.code=Object.hasOwn(opts,'password')?'PDF_PASSWORD_INCORRECT':'PDF_PASSWORD_REQUIRED';throw e;}return original(u8,file,{});};
 const wait=async count=>{for(let i=0;i<50&&dialogs.length<count;i++)await new Promise(r=>setImmediate(r));assert.equal(dialogs.length,count);return dialogs[count-1];};
 const load=api.loadPDFBuffer(bytes,'protected.pdf');let d=await wait(1);assert(d.innerHTML.includes('type="password"'));assert(!d.innerHTML.includes('ephemeral-test-input'));d.nodes.input.value='wrong';d.nodes.form.submit({preventDefault(){}});
 d=await wait(2);assert(d.nodes.p.textContent.includes('Incorrect password'));assert.equal(dialogs[0].nodes.input.value,'');d.nodes.input.value='ephemeral-test-input';d.nodes.form.submit({preventDefault(){}});await load;assert.equal(window.PDF3D.lastLoad.status,'ok');assert.equal(d.nodes.input.value,'');assert(d.removed&&!d.open);
 const cancelLoad=api.loadPDFBuffer(bytes,'cancel.pdf');d=await wait(3);d.nodes.input.value='discard-me';d.nodes['[data-cancel]'].click();await cancelLoad;assert.equal(window.PDF3D.lastLoad.reasonCode,'PDF_PASSWORD_CANCELLED');assert.equal(d.nodes.input.value,'');assert.equal(api.getState().parts.length,0);
 const escLoad=api.loadPDFBuffer(bytes,'escape.pdf');d=await wait(4);d.listeners.cancel({preventDefault(){}});await escLoad;assert.equal(window.PDF3D.lastLoad.reasonCode,'PDF_PASSWORD_CANCELLED');
 const staleLoad=api.loadPDFBuffer(bytes,'old.pdf');d=await wait(5);window.PDF3DExtract.extract3DStreamsFromPDF=original;await api.loadPDFBuffer(bytes,'fresh.pdf');await staleLoad;assert.equal(api.getState().fileName,'fresh.pdf');assert.equal(window.PDF3D.lastLoad.status,'ok');assert(d.removed&&!d.open);
 assert(!calls.includes('discard-me'));console.log('OK password dialog DOM contract: masked, wrong/retry, cancel, Esc, fresh-load cancellation, input cleared on every exit');
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
