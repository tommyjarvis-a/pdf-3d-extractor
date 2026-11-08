"""Genuine short-ID encryption fixtures and independent libqpdf stream hashes.
All output PDFs are test-only, in the caller's temporary directory. No credentials.
"""
import hashlib
import json
import pathlib
import sys
import pikepdf

out, root, external = map(pathlib.Path, sys.argv[1:4])
records = []


def reference(file, label, expected_length):
    with pikepdf.open(file) as p:
        lengths = [len(bytes(v)) for v in p.trailer.ID]
        assert lengths[0] == expected_length, (label, lengths)
        streams = [
            {"subtype": str(x.get('/Subtype'))[1:],
             "sha": hashlib.sha256(x.read_bytes()).hexdigest()}
            for x in p.objects
            if isinstance(x, pikepdf.Stream) and str(x.get('/Subtype', '')) in ['/U3D', '/PRC']
        ]
        assert len(streams) == 2, label
        records.append({"label": label, "file": str(file), "lengths": lengths,
                        "streams": streams})


for label, R, aes in [('r2', 2, False), ('r3', 3, False), ('r4rc4', 4, False),
                       ('r4aes', 4, True), ('r6', 6, True)]:
    for length in [1, 8]:
        file = out / (label + '-id' + str(length) + '.pdf')
        with pikepdf.open(root / 'sample-cad-assembly-3d.pdf') as p:
            identifier = pikepdf.String(bytes(range(length)))
            p.trailer.ID = pikepdf.Array([identifier, identifier])
            p.save(file, encryption=pikepdf.Encryption(user='', owner='', R=R,
                                                     aes=aes, metadata=aes))
        # The original ID was in place during key derivation, not patched later.
        reference(file, label + '-generated-id' + str(length), length)

for label in ['r3', 'r4aes', 'r6']:
    file = external / (label + '-genuine-id8.pdf')
    if file.exists():
        reference(file, label + '-genuine-id8', 8)
file = external / 'r3-genuine-id16.pdf'
if file.exists():
    reference(file, 'r3-genuine-id16-control', 16)
print(json.dumps({"qpdf": pikepdf.__libqpdf_version__, "pikepdf": pikepdf.__version__,
                  "records": records}))
