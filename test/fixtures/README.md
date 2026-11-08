# External RH evidence (not a redistributed model)

`rh-ohio-array-inventory.json` contains only framing metadata and independently
read declared domains, not encoded payload or model geometry. The survey inspector
only delimits arrays; it is not a decoder or geometric oracle.

Source: Porter et al. (2016), crocodilian head vessels / thermal exchange, supplied
via Ohio University's WitmerLab gallery: https://people.ohio.edu/witmerl/3D_gator.htm
PDF: https://people.ohio.edu/witmerl/Downloads/2016_Porter_et_al._crocodilian_head_vessels_&_thermal_exchange_with_3D-PDF.pdf
PDF SHA-256: `6cb83654a968f0f5394a3409f4212bc85c1246944342c54add5942d182c4ce8a`
Decoded object 84 0 U3D SHA-256:
`4de75d3c864d7eaf3a366e1c0d8565e1de45197b9047f4058d38267b8ea96bed`
Offsets are in that decoded U3D stream, not the PDF. Domains come from the mesh
count for index arrays or the preceding U32 NumQuants plus one for scalar arrays.
There are two encoding-8 and 108 encoding-9 arrays. No full PDF, stream or binary
excerpt is committed. Downloading for testing is not permission to redistribute
this third-party PDF. The decoder test skips this fixture explicitly if absent.

Spec-derived: arithmetic encoder/state, static intervals, escape handling,
rescaling, U32-zero flush and byte alignment (ECMA-363 fourth edition, section10.4).
Empirically inferred for this RH producer: encoding8 uses the declared domain;
encoding9 uses a fresh dynamic context and U16 escape values, and includes histogram
symbol `0xFFFF` (escaped value **65534**) in frequency counting. This last rule is
**empirical, not spec-derived**, inferred from only **two real arrays** (mandibular
artery and palatine artery `normals.alpha_theta`). It differs from ECMA-363 A.3.3's
strict `< 0xFFFF` listing. The encoder's corresponding boundary rule is empirical
too; it is not an independent spec oracle for that exception. Every array must
satisfy counts, domains and exact flush/end checks; production never tries alternate
widths to salvage a broken payload. The external real sample has no independent
geometric/visual reference, so structural validity is not visual equivalence.

Reproducible synthetic encrypted fixtures use the repository's built-in sample,
which contains both U3D and PRC, plus a tiny test attachment. They are generated
and removed by `test/compatibility190.js` using `password-fixtures.py`. No third-party
model or user password is required for these tests. R5 uses an external existing
r11 fixture, since new R5 encryption is deprecated; it is not newly generated.

`test/security-metadata190.js` supplies small **synthetic metadata-only** malformed
PDFs to the fast harness (not crypto/geometry oracles). Its CLI also uses Tester's
external `v190/repro/{r3,r4rc4,r4aes}-{base,idref}.pdf` controls, explicitly skipped
if absent, plus incremental metadata mutations and valid indirect-ID revisions.
These external PDFs are not committed. No passwords are needed. Run
`node test/security-metadata190.js` for served/standalone source-VM checks; it is
not a browser or corpus gate.

`node test/short-id190.js` uses survey-venv pikepdf/libqpdf to generate genuine
1-byte and 8-byte first-ID encrypted variants for R2, R3, R4 RC4/AESV2 and R6,
then compares decrypted stream hashes and app raw exports in both builds. It also
checks Tester's external `cb75-compat/*-genuine-id8.pdf` and id16 control when
present. Generated PDFs stay in a temporary directory and are removed. Missing
venv/external fixtures are reported as explicit skips. No R5 fixtures are generated.

ISO 32000-1:2008 14.4 recommends a digest such as MD5; it sets no 16-byte minimum.
Table 15 still requires an array of two byte strings when Encrypt is present; empty
identifiers, missing IDs and malformed reference/type controls remain rejected.
R2–R4 use ID[0] in key derivation; R5/R6 do not, but their structural trailer check
is retained. The existing compatibility for resolvable indirect IDs is unchanged.
