# 3D PDF → CAD Geometry Extractor & B-Rep Workbench

Browser-based engineering tool that extracts embedded 3D streams (`ECMA-363 U3D` and `ISO 14739-1 PRC`) from 3D PDFs and reconstructs watertight B-Rep CAD solids and meshes for manipulation in **Siemens NX**, **SolidWorks**, **Creo**, **FreeCAD**, and **Onshape**.

## Supported CAD Exports
- **Parasolid XT (`.x_t`)**: ASCII Parasolid Transmit format (`SCH_1200000_12006`), native meter scaling (`1 mm = 1e-3 m`, `UIO=1000`, `res_linear=1e-8`), full `BODY` / `REGION` / `SHELL` / `FACE` / `LOOP` / `FIN` / `EDGE` / `VERTEX` / `PLANE` / `CYLINDER` / `LINE` / `POINT` topology, and inner hole loops.
- **STEP AP214 (`.stp`)**: ISO 10303-21 `MANIFOLD_SOLID_BREP` / `CLOSED_SHELL` / `ADVANCED_FACE` solid assembly with `FACE_OUTER_BOUND` and `FACE_BOUND` hole loops.
- **Binary & ASCII STL (`.stl`)**: Watertight 2-manifold triangle meshes.
- **Wavefront OBJ (`.obj`)**: Multi-body grouped mesh with vertex normals.
- **IGES 5.3 Wireframe (`.igs`)**: Sharp CAD feature-edge wireframe lines (Entity `110`).
- **Raw Stream (`.u3d` / `.prc`)**: Direct binary extraction of the decompressed PDF `/3D` stream.
