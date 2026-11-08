'use strict';
// Focused 1.9 gate prep, not the full corpus gate. No user passwords or third-party
// PDFs are committed. qpdf fixtures are generated with ephemeral random test inputs.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..'),RH=require('../u3d-rhadobe-mesh'),X=require('../pdf-extract'),C=require('../crypto-lite');
const encode=require('./arithmetic-reference'),{loadApp}=require('./run');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const U=b=>new Uint8Array(b);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pdf3d-190-'));
let checks=0; const ok=(v,m)=>{checks++;assert(v,m);};
function throws(fn,re){checks++;assert.throws(fn,re);}
async function rejected(fn,code){checks++;await assert.rejects(fn,e=>e.code===code);}
async function main(){
  let vectors=0;
  for(const dynamic of [false,true])for(const [domain,values]of [[1,[0,0,0]],[54,[3,45,20,0,53,53,1]],[256,[0,127,128,255,0,255]],[65536,[0,255,256,32767,65534,65535,65535]]]){
    const {bytes}=encode(values,{dynamic,domain});assert.deepEqual(Array.from(RH._arithmetic(bytes,values.length,dynamic?9:8,domain)),values);vectors++;
    for(let n=0;n<bytes.length;n++)throws(()=>RH._arithmetic(bytes.subarray(0,n),values.length,dynamic?9:8,domain),/truncated|flush|size|alignment/);
    const corrupt=bytes.slice();corrupt[corrupt.length-1]^=128;throws(()=>RH._arithmetic(corrupt,values.length,dynamic?9:8,domain),/flush|alignment|interval|range|domain/);
  }
  const values=Array.from({length:18000},(_,i)=>(i*37+(i%17))%257),enc=encode(values,{dynamic:true,domain:257});
  ok(enc.rescales>=3,'rescale coverage');assert.deepEqual(Array.from(RH._arithmetic(enc.bytes,values.length,9,257)),values);vectors++;
  // Mixed per-array encodings and size widths. Hand-derived raw/RH39/UIC1 values.
  const blocks=[[[0],3,[0,0,0]],[[1,5,0,0,0],2,[5,5]],[[4,4,0x34,0x12,0xcd,0xab],2,[4660,43981]],[[7,5,0x70,10,0x12,0x21,3],3,[11,12,13]],[[10,3,0x0f,0x1f,0x2f],3,[0,1,2]]];
  for(const encoding of [8,9]){const vals=[0,2,1],e=encode(vals,{dynamic:encoding===9,domain:3}).bytes;blocks.push([[encoding,e.length,...e],3,vals,3]);}
  let all=[];for(const [bytes]of blocks)all.push(...bytes);const rr=RH.Reader(U(all),0,all.length);
  for(const [,n,want,domain]of blocks)assert.deepEqual(Array.from(RH._uintBlock(rr,n,false,[],domain)),want);
  throws(()=>RH._uintBlock(RH.Reader(U([7,1,0,120,86,52,18]),0,7),1,false,[]),/past block end/);
  throws(()=>RH._uintBlock(RH.Reader(U([7,5,0x74,1,2,3,4]),0,7),1,false,[]),/offset width/);
  throws(()=>RH.Reader(U([1]),0,2),/bounds/);throws(()=>RH.Reader(U([1]),-1,1),/bounds/);
  throws(()=>RH._uintBlock(RH.Reader(U([0]),0,1),1e9,false,[]),/budget/);
  throws(()=>RH._uintBlock(RH.Reader(U([0]),0,1),1,false,[],0),/domain/);
  throws(()=>RH._uintBlock(RH.Reader(U([3,1,4]),0,3),1,false,[],4),/range/);
  for(const width of [1,2,3,4]){const bytes=U([4|((width-1)<<6),...Array.from({length:width},(_,i)=>i?0:2),7,0]);assert.deepEqual(Array.from(RH._uintBlock(RH.Reader(bytes,0,bytes.length),1,false,[])),[7]);}
  console.log('Arithmetic:',vectors,'independent synthetic vectors; mixed 0/1/4/7/8/9/10, widths 1–4, malformed bounds/flush passed');
  const string=s=>{const b=Buffer.from(s);const h=Buffer.alloc(2);h.writeUInt16LE(b.length);return Buffer.concat([h,b]);};
  const block=(t,data)=>{const h=Buffer.alloc(12);h.writeUInt32LE(t);h.writeUInt32LE(data.length,4);return Buffer.concat([h,data,Buffer.alloc((4-data.length%4)%4)]);};
  const numbers=Buffer.alloc(36);[0,1,0,0,0,1,0,0,0].forEach((x,i)=>numbers.writeFloatLE(x,i*4));
  const mesh=Buffer.concat([string('synthetic triangle'),Buffer.from([0,0,1,0,3,1,3,0]),numbers,Buffer.from([3,3,0,1,2])]);
  const tail=Buffer.concat([mesh,Buffer.from([0])]);ok(RH.decodeBlock(U(tail),0,tail.length).warnings.length===1,'unexplained zero preserved with warning');
  const badMesh=Buffer.from(mesh);badMesh[badMesh.length-1]=3;throws(()=>RH.decodeBlock(U(badMesh),0,badMesh.length),/range/);
  throws(()=>RH.decodeBlock(U(mesh),0,mesh.length,{left:1}),/budget/);
  const skeleton=Buffer.from(mesh);skeleton[string('synthetic triangle').length]=32;throws(()=>RH.decodeBlock(U(skeleton),0,skeleton.length),/skeleton/);
  const decl=Buffer.concat([string('RHAdobeMeshResource'),Buffer.alloc(4),Buffer.from('a604a896b93fc543b2df2a31b5569340','hex'),Buffer.from([0,1,0,0]),Buffer.alloc(4),string('Synthetic tests'),Buffer.alloc(4),string('version 1.0')]);
  const header=Buffer.alloc(32);header.writeUInt32LE(12,4);header.writeUInt32LE(106,20);header.writeDoubleLE(.001,24);
  const direct=U(Buffer.concat([block(0x00443355,header),block(0xffffff16,decl),block(0x100,tail),block(0x100,badMesh)]));
  const partial=loadApp();await partial.api.loadPDFBuffer(direct,'synthetic.u3d');ok(partial.window.PDF3D.lastLoad.status==='ok'&&partial.window.PDF3D.lastLoad.parts===1,'valid body retained when another fails');ok(/unexplained trailing byte/.test(partial.window.PDF3D.lastLoad.damaged)&&/1 mesh blocks unreadable/.test(partial.window.PDF3D.lastLoad.damaged),'partial/tail warning reaches load card contract');ok(partial.window.PDF3D.suggestedFileName('stl').includes('partial'),'partial export marking');
  const noFallback=loadApp();noFallback.window.PDF3DExtract.extract3DStreamsFromPDF=async()=>Object.assign([],{securityHandled:true,attachments:[]});await noFallback.api.loadPDFBuffer(U(fs.readFileSync(path.join(ROOT,'sample-cad-assembly-3d.pdf'))),'encrypted-no3d.pdf');ok(noFallback.window.PDF3D.lastLoad.status==='no3d','authenticated empty result never falls back to ciphertext scanning');
  // Strict crypto primitives: NIST CBC round trip plus length/padding rejection.
  const key=U(crypto.randomBytes(16)),iv=U(crypto.randomBytes(16)),plain=U(crypto.randomBytes(32));
  const cipher=crypto.createCipheriv('aes-128-cbc',key,iv);const ciphertext=U(Buffer.concat([cipher.update(plain),cipher.final()]));
  assert.deepEqual(C.aesCbcDecrypt(key,ciphertext,iv),plain);
  throws(()=>C.aesCbcDecrypt(key,ciphertext.subarray(1),iv),/length/);
  const invalid=U(plain);invalid[31]=0;const bad=crypto.createCipheriv('aes-128-cbc',key,iv);bad.setAutoPadding(false);throws(()=>C.aesCbcDecrypt(key,U(Buffer.concat([bad.update(invalid),bad.final()])),iv),/padding/);
  const prep=require('../saslprep');ok(prep('I\u00ADX')==='IX'&&prep('\u00AA')==='a'&&prep('\u2168')==='IX','RFC4013 examples');throws(()=>prep('a\u0007'),/Prohibited/);throws(()=>prep('\u0627a\u0627'),/directionality/);
  const py=process.env.PDF3D_QPDF_PYTHON||'/workspace/pdf-encoding-survey-2026-11-07/venv/bin/python';
  if(!fs.existsSync(py))console.log('SKIP qpdf generation: set PDF3D_QPDF_PYTHON to Python with pikepdf');else{
    const owner=crypto.randomBytes(20).toString('hex'),ascii=crypto.randomBytes(12).toString('hex'),unicode=ascii+'éΩ水';
    let configs=[];for(const [name,R,aes,metadata]of [['r2',2,false,false],['r3',3,false,false],['r4rc4',4,false,false],['r4aes',4,true,true],['r6',6,true,true]])for(const empty of [false,true])configs.push({id:name+(empty?'-empty':''),R,aes,metadata,user:empty?'':ascii,owner});
    configs.push({id:'r6-unicode',R:6,aes:true,metadata:false,user:unicode,owner});
    const result=cp.spawnSync(py,[path.join(__dirname,'password-fixtures.py'),temp],{input:JSON.stringify(configs),encoding:'utf8'});assert.equal(result.status,0,result.stderr);const made=JSON.parse(result.stdout);
    const original=U(fs.readFileSync(path.join(ROOT,'sample-cad-assembly-3d.pdf'))),baseStreams=await X.extract3DStreamsFromPDF(original);
    const {api,window}=loadApp(),standalone=loadApp({},undefined,'pdf-3d-extractor-standalone.html');
    async function exportHashes(data,password){await api.loadPDFBuffer(data,'comparison.pdf',{...(password===undefined?{}:{password}),prompt:false});ok(window.PDF3D.lastLoad.status==='ok','load geometry');let out=[];
      for(let i=0;i<2;i++){await api.activateStream(i);for(const fmt of ['xt','step','stl','obj','iges','raw']){const e=await window.PDF3D.exportFormat(fmt);ok(e.status==='ok'&&e.blob,'export '+fmt);out.push(sha(Buffer.from(await e.blob.arrayBuffer())));}}
      return out;
    }
    const expected=await exportHashes(original);
    for(const f of made.fixtures){const cfg=configs.find(c=>c.id===f.id),data=U(fs.readFileSync(f.file));
      const s=await X.extract3DStreamsFromPDF(data,'test',{password:cfg.user});
      if(cfg.id==='r6-unicode'){const normalized=await X.extract3DStreamsFromPDF(data,'test',{password:cfg.user.normalize('NFD')});ok(sha(normalized[0].rawBytes)===sha(baseStreams[0].rawBytes),'R6 SASLprep normalized Unicode');}
      for(const reference of f.streams){const stream=s.find(a=>a.subtype===reference.subtype),base=baseStreams.find(a=>a.subtype===reference.subtype);ok(sha(stream.rawBytes)===sha(fs.readFileSync(reference.file))&&sha(stream.rawBytes)===sha(base.rawBytes),'qpdf/original stream equivalence');}
      assert.deepEqual(await exportHashes(data,cfg.user),expected);
      await standalone.api.loadPDFBuffer(data,'standalone.pdf',{password:cfg.user,prompt:false});ok(standalone.window.PDF3D.lastLoad.status==='ok','standalone password decrypt');for(let i=0;i<2;i++){await standalone.api.activateStream(i);const raw=await standalone.window.PDF3D.exportFormat('raw');ok(sha(Buffer.from(await raw.blob.arrayBuffer()))===sha(baseStreams[i].rawBytes),'standalone raw decrypted stream');}
      const attachment=await window.PDF3D.saveAttachment(0);ok(attachment.status==='ok','encrypted attachment readable');ok(Buffer.from(await attachment.blob.arrayBuffer()).equals(Buffer.from('ISO-10303-21;\nTEST-ONLY attachment bytes\nEND-ISO-10303-21;\n')),'encrypted attachment byte identity');
      if(cfg.user){await rejected(()=>X.extract3DStreamsFromPDF(data),'PDF_PASSWORD_REQUIRED');await rejected(()=>X.extract3DStreamsFromPDF(data,'test',{password:''}),'PDF_PASSWORD_INCORRECT');await rejected(()=>X.extract3DStreamsFromPDF(data,'test',{password:ascii+'wrong'}),'PDF_PASSWORD_INCORRECT');
        // Owner authentication must decrypt to the same independent bytes.
        const o=await X.extract3DStreamsFromPDF(data,'test',{password:cfg.owner});ok(sha(o[0].rawBytes)===sha(baseStreams[0].rawBytes),'owner password');
      }else {const automatic=await X.extract3DStreamsFromPDF(data);ok(sha(automatic[0].rawBytes)===sha(baseStreams[0].rawBytes),'empty-password opens automatically');}
      console.log('Encryption:',f.id,'U3D+PRC qpdf streams and 12 exports byte-identical');
    }
    // Retry/cancel/stale loading require only ephemeral callback-held passwords.
    const protectedData=U(fs.readFileSync(made.fixtures[0].file));let tries=0;
    await api.loadPDFBuffer(protectedData,'retry.pdf',{requestPassword:async incorrect=>{tries++;ok(incorrect===(tries>1),'wrong-password retry state');return tries===1?ascii+'bad':ascii;}});ok(tries===2&&window.PDF3D.lastLoad.status==='ok','retry succeeds');
    await api.loadPDFBuffer(protectedData,'cancel.pdf',{requestPassword:async()=>null});ok(window.PDF3D.lastLoad.reasonCode==='PDF_PASSWORD_CANCELLED','cancel');await api.loadPDFBuffer(original,'fresh.pdf');ok(window.PDF3D.lastLoad.status==='ok','usable after cancel');
    let resolveOld;const old=api.loadPDFBuffer(protectedData,'old.pdf',{requestPassword:()=>new Promise(r=>resolveOld=r)});while(!resolveOld)await new Promise(r=>setImmediate(r));await api.loadPDFBuffer(original,'new.pdf');resolveOld(ascii);await old;ok(api.getState().fileName==='new.pdf'&&window.PDF3D.lastLoad.status==='ok','stale prompt cannot replace another file');
    await api.loadPDFBuffer(protectedData,'cleared.pdf',{prompt:false});ok(window.PDF3D.lastLoad.reasonCode==='PDF_PASSWORD_REQUIRED','previous password cleared');
    await api.loadPDFBuffer(original,'ready.pdf');
    console.log('qpdf oracle:',made.qpdf,'pikepdf',made.pikepdf,'retry/cancel/stale-load passed');
    // No new R5 fixtures (deprecated): independently decrypt the existing r11 fixture.
    const r5=process.env.PDF3D_R5||'/workspace/pdf-3d-extractor-corpus/r11_pdf3d_car_suspension_prc_pmi_aes256r5.pdf';
    if(fs.existsSync(r5)){
      const script="import pikepdf,sys,pathlib,json\np=pikepdf.open(sys.argv[1]);p.save(str(pathlib.Path(sys.argv[2])/'r5-reference.pdf'),encryption=False);o=[]\nfor x in p.objects:\n if isinstance(x,pikepdf.Stream) and str(x.get('/Subtype','')) in ['/U3D','/PRC']:\n  f=pathlib.Path(sys.argv[2])/('r5-'+str(x.objgen[0])+'.bin');f.write_bytes(x.read_bytes());o.append(str(f))\nprint(json.dumps(o))";
      const ref=cp.spawnSync(py,['-c',script,r5,temp],{encoding:'utf8'});assert.equal(ref.status,0,ref.stderr);const s=await X.extract3DStreamsFromPDF(U(fs.readFileSync(r5)));const refs=JSON.parse(ref.stdout).map(f=>sha(fs.readFileSync(f)));ok(s.every(st=>refs.includes(sha(st.rawBytes))),'R5 existing r11 qpdf byte-equivalence');const r5hashes=[];for(const f of [r5,path.join(temp,'r5-reference.pdf')]){await api.loadPDFBuffer(U(fs.readFileSync(f)),'r5-comparison.pdf',{prompt:false});ok(window.PDF3D.lastLoad.status==='ok','existing R5 geometry');const e=await window.PDF3D.exportFormat('stl');ok(e.status==='ok','R5 STL');r5hashes.push(sha(Buffer.from(await e.blob.arrayBuffer())));}assert.equal(r5hashes[0],r5hashes[1]);console.log('R5 existing r11: qpdf stream bytes and geometry/STL match (empty user only; no generated nonempty R5 claim)');
    }else console.log('SKIP existing R5: set PDF3D_R5');
  }
  // Unknown revisions, handlers and CFM reject before prompting or legacy fallback.
  for(const [oldValue,newValue]of [['/R 2','/R 9'],['/Standard','/PubSec  ']]){const f=path.join(temp,'r2.pdf');if(fs.existsSync(f)){const data=fs.readFileSync(f),text=data.toString('latin1');ok(text.includes(oldValue),'fixture mutation anchor');const mutated=U(Buffer.from(text.replace(oldValue,newValue),'latin1'));await rejected(()=>X.extract3DStreamsFromPDF(mutated),'PDF_SECURITY_UNSUPPORTED');const {api,window}=loadApp();await api.loadPDFBuffer(mutated,'unsupported.pdf',{prompt:false});ok(window.PDF3D.lastLoad.reasonCode==='PDF_SECURITY_UNSUPPORTED','unsupported security does not fallback');}}
  for(const [file,from,to]of [['r4aes.pdf','/AESV2','/Bogus'],['r6.pdf','/R 6','/R 7']]){const f=path.join(temp,file);if(fs.existsSync(f)){const text=fs.readFileSync(f).toString('latin1');ok(text.includes(from),'security mutation anchor');await rejected(()=>X.extract3DStreamsFromPDF(U(Buffer.from(text.replace(from,to),'latin1'))),'PDF_SECURITY_UNSUPPORTED');}}
  // Named /Crypt filters: independent Node AES, explicit Identity and ordering.
  const parse=text=>new X._Parser(U(Buffer.from(text))).parse();
  const doc=new X._Doc(U([]),{});doc.crypt={key,method:'AES'};doc.efMethod='AES';doc.cryptFilters={Identity:'None',StdCF:'AES'};doc.encryptMetadata=true;
  const payload=Buffer.from('independent named Crypt reference'),objNum=17;
  const objectKey=crypto.createHash('md5').update(Buffer.concat([Buffer.from(key),Buffer.from([17,0,0,0,0,0x73,0x41,0x6c,0x54])])).digest().subarray(0,16);
  const aes=crypto.createCipheriv('aes-128-cbc',objectKey,iv),encrypted=U(Buffer.concat([Buffer.from(iv),aes.update(payload),aes.final()]));
  doc.rawStream=()=>encrypted;
  let obj={num:objNum,gen:0,value:parse('<< /Filter /Crypt /DecodeParms << /Name /StdCF >> >>')};
  ok(Buffer.from((await doc.streamData(obj)).data).equals(payload),'named Crypt decrypt');
  doc.rawStream=()=>U(payload);obj.value=parse('<< /Filter /Crypt /DecodeParms << /Name /Identity >> >>');ok(Buffer.from((await doc.streamData(obj)).data).equals(payload),'explicit Identity prevents default decryption');
  obj.value=parse('<< /Filter /Crypt /DecodeParms << /Name /Unknown >> >>');await rejected(()=>doc.streamData(obj),'PDF_SECURITY_UNSUPPORTED');
  obj.value=parse('<< /Filter [/FlateDecode /Crypt] >>');await rejected(()=>doc.streamData(obj),'PDF_SECURITY_UNSUPPORTED');
  doc.rawStream=()=>encrypted.subarray(0,encrypted.length-1);obj.value=parse('<< >>');await rejected(()=>doc.streamData(obj),'PDF_DAMAGED');
  console.log('Crypt filters: named AES, Identity, unknown methods/order, damaged AES stream passed');
  const real=process.env.PDF3D_RH_STREAM||'/workspace/pdf-encoding-survey-2026-11-07/streams/6cb83654a968f0f5394a3409f4212bc85c1246944342c54add5942d182c4ce8a/84-0.u3d';
  if(fs.existsSync(real)){const result=RH.scan(U(fs.readFileSync(real)));ok(result.meshes.length===90&&result.meshErrors.length===0,'all 90 RH meshes recovered');ok(result.meshes.filter(m=>!m.exactEnd).length===4&&result.warnings.filter(w=>/unexplained trailing byte/.test(w)).length===4,'four unexplained tails explicit');const carotid=result.meshes.find(m=>m.name==='internal carotid artery');assert.deepEqual(carotid.counts,{faces:104,positions:54,normals:56,diffuse:0,specular:0,texCoords:57});const arithmetic=result.meshes.flatMap(m=>m.arrays).filter(a=>a.enc===8||a.enc===9);ok(arithmetic.length===110&&arithmetic.every(a=>a.consumed===a.size),'all 110 arithmetic arrays exact payload');
    const quality=[];let totalFaces=0,totalDegenerate=0;
    for(const m of result.meshes){const p=m.positions,ix=m.indices,n=p.length/3,parent=new Int32Array(n);for(let i=0;i<n;i++)parent[i]=i;
      const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
      const join=(i,j)=>{i=root(i);j=root(j);if(i!==j)parent[j]=i;};
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(let i=0;i<p.length;i++){const c=i%3;lo[c]=Math.min(lo[c],p[i]);hi[c]=Math.max(hi[c],p[i]);}
      let degenerate=0,positive=0,negative=0;
      for(let t=0;t<ix.length;t+=3){const ia=ix[t],ib=ix[t+1],ic=ix[t+2],a=ia*3,b=ib*3,c=ic*3;join(ia,ib);join(ib,ic);
        const ux=p[b]-p[a],uy=p[b+1]-p[a+1],uz=p[b+2]-p[a+2],vx=p[c]-p[a],vy=p[c+1]-p[a+1],vz=p[c+2]-p[a+2];
        const normal=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx];if(normal.every(x=>x===0)){degenerate++;continue;}
        if(m.normals&&m.normalIdx){let dot=0;for(let k=0;k<3;k++)dot+=normal[k]*(m.normals[k][m.normalIdx[t]]+m.normals[k][m.normalIdx[t+1]]+m.normals[k][m.normalIdx[t+2]]);if(dot>0)positive++;else if(dot<0)negative++;}
      }
      let components=0;for(let i=0;i<n;i++)if(root(i)===i)components++;
      ok(lo.every(Number.isFinite)&&hi.every(Number.isFinite)&&hi.some((v,i)=>v>lo[i]),'finite noncollapsed bbox');
      ok(degenerate/m.counts.faces<0.01,'sane non-degenerate face rate');totalFaces+=m.counts.faces;totalDegenerate+=degenerate;
      quality.push({name:m.name,counts:m.counts,bbox:[lo,hi],components,degenerate,positiveNormals:positive,negativeNormals:negative,exactEnd:m.exactEnd,warnings:m.warnings});
    }
    // Domain comes from containing mesh count or preceding quantization field,
    // not from the decoder's output. Test every candidate against every array.
    const source=U(fs.readFileSync(real)), candidates={8:0,16:0,32:0,staticForDynamic:0,dynamicForStatic:0};
    const metadataPath=process.env.PDF3D_RH_ARRAYS||path.join(__dirname,'fixtures/rh-ohio-array-inventory.json');
    if(fs.existsSync(metadataPath)){
      const arrays=JSON.parse(fs.readFileSync(metadataPath));ok(arrays.length===110,'independent inspector array inventory');
      for(const ar of arrays){for(const width of [8,16,32])try{RH._arithmetic(source.subarray(ar.payload_offset,ar.end_offset),ar.count,ar.encoding,ar.domain,width);candidates[width]++;}catch(_){}
        try{RH._arithmetic(source.subarray(ar.payload_offset,ar.end_offset),ar.count,ar.encoding===9?8:9,ar.domain,16);candidates[ar.encoding===9?'staticForDynamic':'dynamicForStatic']++;}catch(_){}
      }
      ok(candidates[16]===110&&candidates[8]===2&&candidates[32]===2&&candidates.staticForDynamic===0&&candidates.dynamicForStatic===0,'unique context and dynamic U16 rule across all 110 arrays');
      console.log('110-array candidate matrix:',JSON.stringify(candidates),'(static arrays have no escapes, so escape width is immaterial there)');
    }else console.log('SKIP alternative-width matrix: set PDF3D_RH_ARRAYS to independent survey array inventory');
    if(process.env.PDF3D_EVIDENCE_OUT)fs.writeFileSync(process.env.PDF3D_EVIDENCE_OUT,JSON.stringify({meshes:quality,totalFaces,totalDegenerate,candidates},null,2));
    console.log('Real RH: 90/90 meshes recovered; 86 exact, four warned trailing-zero meshes; 110 arithmetic arrays exact; carotid 104/54/56/57; faces',totalFaces,'zero-area',totalDegenerate);

  }else console.log('SKIP real RH sample: set PDF3D_RH_STREAM');
  console.log('OK focused 1.9 checks:',checks);
}
main().then(()=>fs.rmSync(temp,{recursive:true,force:true})).catch(e=>{fs.rmSync(temp,{recursive:true,force:true});console.error(e.stack);process.exitCode=1;});
