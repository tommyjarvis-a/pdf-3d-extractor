"""Independent libqpdf fixtures. Called by compatibility190.js with in-memory test credentials.
No passwords are written to disk/stdout. All output is test-only in the caller's temporary directory.
"""
import sys,json,pathlib
import pikepdf
out=pathlib.Path(sys.argv[1]);root=pathlib.Path(__file__).resolve().parents[1]
config=json.load(sys.stdin);result=[]
for c in config:
    with pikepdf.open(root/'sample-cad-assembly-3d.pdf') as p:
        p.attachments['proof.step']=b'ISO-10303-21;\nTEST-ONLY attachment bytes\nEND-ISO-10303-21;\n'
        dest=out/(c['id']+'.pdf')
        p.save(dest,encryption=pikepdf.Encryption(user=c['user'],owner=c['owner'],R=c['R'],aes=c['aes'],metadata=c['metadata']))
    with pikepdf.open(dest,password=c['user']) as p:
        streams=[]
        for obj in p.objects:
            if isinstance(obj,pikepdf.Stream) and str(obj.get('/Subtype','')) in ['/U3D','/PRC']:
                st=str(obj['/Subtype'])[1:];f=out/(c['id']+'-'+str(obj.objgen[0])+'.'+st.lower());f.write_bytes(obj.read_bytes());streams.append({'subtype':st,'file':str(f)})
    result.append({'id':c['id'],'file':str(dest),'streams':streams})
print(json.dumps({'fixtures':result,'pikepdf':pikepdf.__version__,'qpdf':pikepdf.__libqpdf_version__}))
