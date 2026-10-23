# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Client-side web workbench that extracts embedded 3D streams (`/Subtype /U3D` ECMA-363 & `/Subtype /PRC` ISO 14739-1) from 3D PDF files, reconstructs watertight 2-manifold B-Rep faces and analytic hole/boss features, and exports CAD-ready geometry:

- **Parasolid XT (`.x_t`)** — Native Siemens Parasolid ASCII transmit format (`SCH_1200000_120060`, meter-scaled `1e-3 m/mm`, `UIO=1000`) with `BODY`, `REGION`, `SHELL`, `FACE`, `LOOP`, `FIN`, `EDGE`, `VERTEX`, `PLANE`, `CYLINDER`, `LINE`, and `POINT` topological chains for direct import into Siemens NX, SolidWorks, Solid Edge, and Onshape.
- **STEP AP214 (`.stp`)** — ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` with outer and inner `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)** — Per-solid watertight triangle meshes.
- **Wavefront OBJ (`.obj`)** — Multi-body named groups (`o` / `g`) with vertex normals.
- **IGES 5.3 (`.igs`)** — Sharp feature-edge 3D CAD wireframe (`Entity 110`).
- **Raw `.u3d` / `.prc` stream extraction** — Direct binary payload extraction from `/3D` and `/RichMedia` dictionaries.
