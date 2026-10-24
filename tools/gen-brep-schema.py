#!/usr/bin/env python3
"""Generate the PRC exact-geometry entity field table embedded in prc-brep.js (between the SCHEMA markers).
Usage: python3 tools/gen-brep-schema.py /path/to/prc-rs [outdir]
Input: prc-rs (https://github.com/ralovich/prc-rs, MIT, see THIRD_PARTY.md) src/prc.json + src/constants.rs.
Output: <outdir>/schema.js (table literal) and <outdir>/schema.json."""
import os
import json,re,sys
PRCRS=sys.argv[1] if len(sys.argv)>1 else 'prc-rs'
OUT=sys.argv[2] if len(sys.argv)>2 else '.'
d=json.load(open(os.path.join(PRCRS,'src','prc.json'))); s=d['structures'][0]
src=open(os.path.join(PRCRS,'src','constants.rs')).read()
ids={m.group(1):int(m.group(2)) for m in re.finditer(r'(PRC_TYPE_\w+)\s*=\s*(\d+)',src)}
SKIP={'PRC_TYPE_TOPO_BrepDataCompress','PRC_TYPE_TOPO_SingleWireBodyCompress'}
BUILTIN={'Boolean':'b','Double':'d','UnsignedInteger':'u','Integer':'i','Character':'c','UnsignedCharacter':'C','UnsignedShort':'S','String':'s','UserData':'D'}
seen=[]
def visit(n):
  if n in SKIP or n in seen or n not in s: return
  seen.append(n)
  for f in s[n]['fields']:
    visit(f.get('data_type'))
    for e in f.get('eligible_type_ids') or []: visit(e[0])
visit('PRC_TYPE_TOPO_Context')
def tr(e):
  o=e
  e=re.sub(r'\bas [ui]8\b','',e)
  e=re.sub(r'PRC_TRANSFORMATION_(\w+)',lambda m:str({'Translate':1,'Rotate':2,'Mirror':4,'Scale':8,'NonUniformScale':16,'NonOrtho':32,'Homogeneous':64}[m.group(1)]),e)
  e=re.sub(r'have_bbox\(([^)]*)\)',r'((\1)&3)',e)
  e=e.replace('_ctx.ContentCurve_is_3d_flag','c.is3d').replace('_ctx.PRC_TYPE_CRV_NURBS_is_rational','c.rat')
  e=e.replace('self.','')
  e=re.sub(r'\.value\b','',e)
  e=re.sub(r'(?<![\w.])([a-z_][a-z0-9_]*)(?=(\.[a-z_]\w*)*)',lambda m: m.group(1) if m.group(1) in('c','true','false') else 'o.'+m.group(1),e)
  if '_ctx' in e or 'if ' in e: raise Exception('untranslatable '+o)
  return e
out={}; bad=[]
for n in seen:
  fl=[]
  for f in s[n]['fields']:
    dt=f['data_type']; t=BUILTIN.get(dt,dt)
    if t not in BUILTIN.values() and t not in s: bad.append((n,f['name'],dt))
    ent=[f['name'],t]
    x={}
    try:
      if 'condition_rust' in f: x['if']=tr(f['condition_rust'])
      if f.get('is_vec'): x['n']=tr(str(f['size']))
    except Exception as ex: bad.append((n,str(ex))); continue
    if f.get('multiplicity'): x['m']=f['multiplicity']
    if f.get('eligible_type_ids'): x['alt']={str(ids[e[0]]):e[0] for e in f['eligible_type_ids']}
    if f.get('expected_value'): x['id']=ids[f['expected_value'][1]]
    if x: ent.append(x)
    fl.append(ent)
  out[n]=fl
print('// bad:',bad,file=sys.stderr)
print('// structures:',len(out),file=sys.stderr)
js=json.dumps(out,separators=(',',':'))
open(os.path.join(OUT,'schema.json'),'w').write(js)
print(len(js),file=sys.stderr)
# ---- emit JS
lines=[]
for n,fl in out.items():
  ents=[]
  for e in fl:
    name,t=e[0],e[1]; x=e[2] if len(e)>2 else {}
    cond=('(o,c)=>'+x['if']) if 'if' in x else '0'
    size=('(o,c)=>'+x['n']) if 'n' in x else '0'
    alt=json.dumps({int(k):v for k,v in x['alt'].items()}) if 'alt' in x else '0'
    ents.append('[%s,%s,%s,%s,%d,%s,%d]'%(json.dumps(name),json.dumps(t),cond,size,x.get('m',0),alt,x.get('id',0)))
  lines.append('  %s:[%s]'%(n,','.join(ents)))
open(os.path.join(OUT,'schema.js'),'w').write('{\n'+',\n'.join(lines)+'\n}')
