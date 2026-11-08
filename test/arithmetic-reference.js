'use strict';
// Independent TEST encoder from ECMA-363 10.4; does not import the decoder.
// Deliberately simple Map/sorted-list model (production uses a Fenwick decoder).
module.exports = function encode(values, {dynamic=false, domain=256, width=16}={}) {
  let lo=0, hi=65535, pending=0, total=1, rescales=0;
  let histogram=new Map([[0,1]]); const bits=[];
  function update(s) {
    if (s>65535) return;
    if (total===8191) {
      histogram=new Map([...histogram].map(([x,n])=>[x,n>>1]).filter(([,n])=>n));
      histogram.set(0,(histogram.get(0)||0)+1); total=[...histogram.values()].reduce((a,b)=>a+b,0); rescales++;
    }
    histogram.set(s,(histogram.get(s)||0)+1); total++;
  }
  function interval(before, frequency, denominator) {
    const length=hi-lo+1; hi=lo+Math.floor(length*(before+frequency)/denominator)-1; lo+=Math.floor(length*before/denominator);
    while ((hi & 32768)===(lo & 32768)) {
      const bit=hi>>>15;bits.push(bit);while(pending>0){bits.push(1-bit);pending--;}
      lo=(lo*2)&65535;hi=(hi*2+1)&65535;
    }
    while ((lo&16384)!==0 && (hi&16384)===0) {pending++;lo=(lo*2)&32767;hi=((hi*2)&32767)|32769;}
  }
  const reverse=byte=>Number.parseInt(byte.toString(2).padStart(8,'0').split('').reverse().join(''),2);
  function raw(v,w){for(let j=0;j<w/8;j++)interval(reverse(Math.floor(v/2**(j*8))&255),1,256);}
  for(const v of values){
    if (!Number.isInteger(v)||v<0||v>=domain) throw Error('Bad synthetic value');
    if (!dynamic) {if(domain<=16382) interval(v,1,domain);else raw(v,domain<=65536?16:32);continue;}
    const symbol=histogram.has(v+1)?v+1:0;
    let before=0;for(const [s,n]of histogram)if(s<symbol)before+=n;
    interval(before,histogram.get(symbol),total);update(symbol);
    if(!symbol){raw(v,width);update(v+1);}
  }
  raw(0,32);while(bits.length%8)bits.push(0);
  const bytes=new Uint8Array(bits.length/8);bits.forEach((b,i)=>bytes[i>>3]|=b<<(i&7));
  return {bytes,rescales};
};
