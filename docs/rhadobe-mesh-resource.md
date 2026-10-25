# U3D RHAdobeMeshResource (corpus r09)

## What it is
Some producers write U3D geometry in a vendor extension rather than in the standard ECMA-363 CLOD mesh blocks. Example: CoreTechnologie 3D_Evolution, corpus file `r09_coretech_compare_u3d_2annots_aes128.pdf`.

The extension is "RHAdobeMeshResource" (Right Hemisphere / Adobe 3D mesh compression, Acrobat 8.1+). It is declared with a New Object Type block (`0xFFFFFF16`):
- GUID `96a804a6-3fb9-43c5-b2df-2a31b5569340`
- vendor "Right Hemisphere Adobe Systems"
- info "version 1.0"

The mesh data then sits in New Object Blocks whose block type is the one assigned by that declaration. Up to 1.2.0 these files produced 0 triangles and the message "Unsupported proprietary U3D mesh".

## Format
The format is documented in the Adobe Acrobat SDK 8.1 "U3D Supported Elements", chapter 2 and appendix A.

**Mesh layout:**
1. Object name.
2. Chunk flags: version, subchunks, skeleton, and how the material count is encoded.
3. The materials.
4. Value flags and counts for faces, positions, normals, diffuse, specular and texcoords.
5. Float arrays, stored planar. Each array is one of:
   - raw F32
   - quantised (min, max, quant count, then a UINT block)
   - alpha/theta normals
6. UINT arrays: face material IDs, then position, normal, colour and texcoord face indices.

**Each UINT block starts with an encoding byte:**

| Code | Encoding |
|---|---|
| 0 | zero |
| 1 | replicate |
| 2 | U4 |
| 3 | U8 |
| 4 | U16 |
| 5 | U24 |
| 6 | U32 |
| 7 | RH39 |
| 8, 9 | U3D arithmetic |
| 10 | UIC1 |

## Decoder
The decoder is `u3d-rhadobe-mesh.js`, written by the QA Tester and integrated as-is (global `RHAdobeMesh`).

When the standard U3D parse yields 0 triangles, `parseU3DStream` calls `RHAdobeMesh.parseU3D(u8)` and uses its parts. The decode path is shown as `U3D/RHAdobeMeshResource`.

## r09 results

| | Value |
|---|---|
| Bodies | 2: PartBody_2 (70,958 tris / 49,549 verts) and PartBody_5 (71,146 tris / 49,662 verts) |
| Total | 142,104 tris as decoded (= `test/expect.json`). The B-Rep/HUD/STL count is 142,042: the weld drops 62 zero-area triangles that have two distinct indices with bit-identical positions |
| Bounding box | [0, -170.46, -97] .. [100, 92.0, 160] |
| Time | about 1.6 s |
| Peak RSS (headless) | about 300 MB |
| Exports | STL, OBJ, STEP and XT all succeed |

**Byte checks:**
- Every encoded array ends exactly at its declared size.
- The second mesh ends exactly at the end of the U3D block.

## Limits
- Encodings 8/9 (U3D arithmetic coder) are not implemented. Files that use them keep the "unsupported" message.
- The decode paths for normals type 3, multi-material face IDs, skeletons and subchunks are unverified, because only one producer (CoreTechnologie) was available.

## Offline fallback (not built in)
For an unknown vendor mesh encoding, one option is to capture the geometry while Acrobat/Reader renders the 3D annotation, by intercepting graphics API calls (for example an OpenGL/Direct3D call capture tool such as RenderDoc). This is manual, platform-specific, and depends on the Acrobat EULA. It is documented only as an offline last resort and is not part of the app.
