#!/usr/bin/env python
"""
One-time builder: textured, rigged SMPL-X avatar GLB for the Hannah frontend.

Design contract (this is what makes EMAGE playback retarget-free):
  - Skeleton = the 55 canonical SMPL-X joints, node names = SMPL-X joint names.
  - Every joint node has IDENTITY rest rotation (translation-only hierarchy).
    EMAGE's per-joint axis-angle can then be applied directly as the node's
    quaternion — exactly SMPL-X forward kinematics, no rest-pose correction.
  - Geometry/weights come from SMPLX_NEUTRAL_2020.npz (authoritative, Y-up).
  - UVs + albedo texture come from the official SMPL-X Blender addon zip
    (extracted with bpy). If bpy is unavailable the GLB is built untextured
    with a skin-tone material.

Run with the bpy venv for the textured path:
  <bpy-venv>/bin/python build_avatar.py --out ../../..../smplx_avatar.glb
"""

import argparse
import json
import os
import struct
import sys
import tempfile
import zipfile

import numpy as np

SMPLX_JOINT_NAMES = [
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee",
    "spine2", "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot",
    "neck", "left_collar", "right_collar", "head", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
    "jaw", "left_eye_smplhf", "right_eye_smplhf",
    "left_index1", "left_index2", "left_index3", "left_middle1", "left_middle2",
    "left_middle3", "left_pinky1", "left_pinky2", "left_pinky3", "left_ring1",
    "left_ring2", "left_ring3", "left_thumb1", "left_thumb2", "left_thumb3",
    "right_index1", "right_index2", "right_index3", "right_middle1",
    "right_middle2", "right_middle3", "right_pinky1", "right_pinky2",
    "right_pinky3", "right_ring1", "right_ring2", "right_ring3",
    "right_thumb1", "right_thumb2", "right_thumb3",
]
NUM_JOINTS = 55


# ── Blender extraction (UVs + triangulation from the addon .blend) ──────────

def extract_uv_with_bpy(blend_path, expected_verts):
    import bpy  # only available in the bpy venv

    bpy.ops.wm.open_mainfile(filepath=blend_path)
    # The addon .blend holds hundreds of UV-less shape meshes; the UV'd model
    # datablocks are SMPLX-shapes-{female,male,neutral}. Prefer neutral.
    candidates = [m for m in bpy.data.meshes
                  if len(m.vertices) == expected_verts and len(m.uv_layers) > 0]
    if not candidates:
        raise RuntimeError(f"No {expected_verts}-vert mesh with UVs in blend")
    candidates.sort(key=lambda m: (0 if "neutral" in m.name.lower() else 1, m.name))
    mesh = candidates[0]
    print(f"[build] using mesh datablock '{mesh.name}' with UV layer '{mesh.uv_layers[0].name}'")

    mesh.calc_loop_triangles()
    uv_layer = mesh.uv_layers[0].data

    n_tris = len(mesh.loop_triangles)
    tris = np.empty((n_tris, 3), dtype=np.int64)
    corner_uv = np.empty((n_tris, 3, 2), dtype=np.float64)
    for i, lt in enumerate(mesh.loop_triangles):
        tris[i] = lt.vertices
        for c, loop_idx in enumerate(lt.loops):
            corner_uv[i, c] = uv_layer[loop_idx].uv

    verts = np.array([v.co[:] for v in mesh.vertices], dtype=np.float64)
    return verts, tris, corner_uv


def verify_vertex_order(blend_verts, v_template):
    """The blend mesh must share SMPL-X vertex order. Blender may store the mesh
    Z-up; try the plausible orientations and accept if one matches closely."""
    candidates = {
        "identity": blend_verts,
        "zup_to_yup": np.stack([blend_verts[:, 0], blend_verts[:, 2], -blend_verts[:, 1]], axis=1),
        "yup_to_zup": np.stack([blend_verts[:, 0], -blend_verts[:, 2], blend_verts[:, 1]], axis=1),
    }
    best_name, best_err = None, np.inf
    for name, v in candidates.items():
        err = float(np.abs(v - v_template).mean())
        if err < best_err:
            best_name, best_err = name, err
    if best_err > 0.01:  # meters — template heights are ~1.7m, so 1cm mean error means mismatch
        raise RuntimeError(f"Blend vertex order does not match npz (best {best_name}, mean err {best_err:.4f}m)")
    print(f"[build] vertex order verified ({best_name}, mean err {best_err:.6f}m)")


# ── Geometry helpers ────────────────────────────────────────────────────────

def split_by_uv_seams(tris, corner_uv, n_verts):
    """glTF wants per-vertex UVs; SMPL-X UVs have seams. Duplicate vertices
    that carry multiple UVs. Returns (orig_index per new vert, per-vert uv, new tris)."""
    key_to_new = {}
    orig_of_new = []
    uv_of_new = []
    new_tris = np.empty_like(tris)
    quant = np.round(corner_uv * 1e5).astype(np.int64)
    for t in range(tris.shape[0]):
        for c in range(3):
            key = (int(tris[t, c]), int(quant[t, c, 0]), int(quant[t, c, 1]))
            idx = key_to_new.get(key)
            if idx is None:
                idx = len(orig_of_new)
                key_to_new[key] = idx
                orig_of_new.append(tris[t, c])
                uv_of_new.append(corner_uv[t, c])
            new_tris[t, c] = idx
    return np.asarray(orig_of_new), np.asarray(uv_of_new, dtype=np.float64), new_tris


def vertex_normals(positions, tris):
    normals = np.zeros_like(positions)
    p0, p1, p2 = positions[tris[:, 0]], positions[tris[:, 1]], positions[tris[:, 2]]
    face_n = np.cross(p1 - p0, p2 - p0)  # area-weighted
    for c in range(3):
        np.add.at(normals, tris[:, c], face_n)
    lens = np.linalg.norm(normals, axis=1, keepdims=True)
    lens[lens == 0] = 1.0
    return normals / lens


def top4_weights(weights):
    """(V,55) dense LBS weights -> (V,4) joint indices + normalized weights."""
    idx = np.argsort(weights, axis=1)[:, -4:][:, ::-1]
    w = np.take_along_axis(weights, idx, axis=1)
    w = w / np.clip(w.sum(axis=1, keepdims=True), 1e-8, None)
    return idx.astype(np.uint16), w.astype(np.float32)


# ── GLB writer (raw glTF 2.0, no external deps) ─────────────────────────────

class GlbBuilder:
    def __init__(self):
        self.buffer = bytearray()
        self.buffer_views = []
        self.accessors = []

    def _align(self, n=4):
        while len(self.buffer) % n:
            self.buffer.append(0)

    def add_buffer_view(self, data: bytes, target=None):
        self._align()
        view = {"buffer": 0, "byteOffset": len(self.buffer), "byteLength": len(data)}
        if target:
            view["target"] = target
        self.buffer.extend(data)
        self.buffer_views.append(view)
        return len(self.buffer_views) - 1

    def add_accessor(self, array, component_type, type_str, target=None, minmax=False):
        view_idx = self.add_buffer_view(array.tobytes(), target)
        acc = {
            "bufferView": view_idx,
            "componentType": component_type,
            "count": array.shape[0],
            "type": type_str,
        }
        if minmax:
            acc["min"] = array.min(axis=0).tolist()
            acc["max"] = array.max(axis=0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1


def build_glb(out_path, positions, normals, uvs, joints4, weights4, tris,
              joint_offsets, parents, inverse_bind, texture_png=None):
    FLOAT, USHORT, UINT = 5126, 5123, 5125
    ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963

    b = GlbBuilder()
    acc_pos = b.add_accessor(positions.astype("<f4"), FLOAT, "VEC3", ARRAY_BUFFER, minmax=True)
    acc_nrm = b.add_accessor(normals.astype("<f4"), FLOAT, "VEC3", ARRAY_BUFFER)
    attributes = {"POSITION": acc_pos, "NORMAL": acc_nrm}
    if uvs is not None:
        attributes["TEXCOORD_0"] = b.add_accessor(uvs.astype("<f4"), FLOAT, "VEC2", ARRAY_BUFFER)
    attributes["JOINTS_0"] = b.add_accessor(joints4.astype("<u2"), USHORT, "VEC4", ARRAY_BUFFER)
    attributes["WEIGHTS_0"] = b.add_accessor(weights4.astype("<f4"), FLOAT, "VEC4", ARRAY_BUFFER)
    acc_idx = b.add_accessor(tris.reshape(-1, 1).astype("<u4"), UINT, "SCALAR", ELEMENT_ARRAY_BUFFER)
    acc_ibm = b.add_accessor(inverse_bind.reshape(NUM_JOINTS, 16).astype("<f4"), FLOAT, "MAT4")

    # Nodes 0..54 = joints (index == SMPL-X joint index), 55 = skinned mesh, 56 = root
    nodes = []
    for j in range(NUM_JOINTS):
        node = {"name": SMPLX_JOINT_NAMES[j], "translation": joint_offsets[j].tolist()}
        children = [int(c) for c in range(NUM_JOINTS) if parents[c] == j]
        if children:
            node["children"] = children
        nodes.append(node)
    mesh_node = NUM_JOINTS
    nodes.append({"name": "smplx_mesh", "mesh": 0, "skin": 0})
    nodes.append({"name": "SMPLX_Avatar", "children": [0, mesh_node]})

    material = {
        "name": "smplx_skin",
        "pbrMetallicRoughness": {"metallicFactor": 0.0, "roughnessFactor": 0.85},
        "doubleSided": False,
    }
    gltf = {
        "asset": {"version": "2.0", "generator": "hannah build_avatar.py"},
        "scene": 0,
        "scenes": [{"nodes": [NUM_JOINTS + 1]}],
        "nodes": nodes,
        "meshes": [{"name": "smplx", "primitives": [
            {"attributes": attributes, "indices": acc_idx, "material": 0, "mode": 4}
        ]}],
        "skins": [{
            "name": "smplx_skin",
            "joints": list(range(NUM_JOINTS)),
            "inverseBindMatrices": acc_ibm,
            "skeleton": 0,
        }],
        "materials": [material],
    }

    if texture_png is not None:
        img_view = b.add_buffer_view(texture_png)
        gltf["images"] = [{"bufferView": img_view, "mimeType": "image/png", "name": "smplx_albedo"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        gltf["textures"] = [{"source": 0, "sampler": 0}]
        material["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
    else:
        material["pbrMetallicRoughness"]["baseColorFactor"] = [0.72, 0.54, 0.44, 1.0]  # warm skin tone

    b._align()
    gltf["bufferViews"] = b.buffer_views
    gltf["accessors"] = b.accessors
    gltf["buffers"] = [{"byteLength": len(b.buffer)}]

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - len(json_bytes) % 4) % 4)
    bin_bytes = bytes(b.buffer)

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    with open(out_path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))
        f.write(json_bytes)
        f.write(struct.pack("<II", len(bin_bytes), 0x004E4942))
        f.write(bin_bytes)
    print(f"[build] wrote {out_path} ({total/1e6:.1f} MB, {positions.shape[0]} verts, {tris.shape[0]} tris)")


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    default_panto = os.path.expanduser(os.environ.get("PANTOMATRIX_DIR", "~/PantoMatrix"))
    parser.add_argument("--pantomatrix", default=default_panto)
    parser.add_argument("--out", required=True)
    parser.add_argument("--texture", default="f", choices=["f", "m", "rainbow", "none"],
                        help="albedo from the addon zip: f(emale)/m(ale)/rainbow, or none")
    args = parser.parse_args()

    npz_path = os.path.join(args.pantomatrix, "smplx_models", "smplx", "SMPLX_NEUTRAL_2020.npz")
    addon_zip = os.path.join(args.pantomatrix, "blender_tools", "smplx_blender_addon_20230921.zip")

    model = np.load(npz_path, allow_pickle=True)
    v_template = model["v_template"].astype(np.float64)          # (10475, 3)
    weights = model["weights"].astype(np.float64)                # (10475, 55)
    j_regressor = model["J_regressor"].astype(np.float64)        # (55, 10475)
    kintree = model["kintree_table"].astype(np.int64)            # (2, 55)
    n_verts = v_template.shape[0]

    parents = kintree[0].copy()
    parents[0] = -1

    joints_rest = j_regressor @ v_template                       # (55, 3) global rest positions
    joint_offsets = joints_rest.copy()
    for j in range(1, NUM_JOINTS):
        joint_offsets[j] = joints_rest[j] - joints_rest[parents[j]]

    inverse_bind = np.tile(np.eye(4, dtype=np.float64), (NUM_JOINTS, 1, 1))
    inverse_bind[:, :3, 3] = -joints_rest
    # glTF matrices are column-major
    inverse_bind = np.ascontiguousarray(np.transpose(inverse_bind, (0, 2, 1)))

    uvs = tris = None
    texture_png = None
    if args.texture != "none":
        try:
            tex_name = {"f": "smplx_texture_f_alb.png", "m": "smplx_texture_m_alb.png",
                        "rainbow": "smplx_texture_rainbow.png"}[args.texture]
            with tempfile.TemporaryDirectory() as tmp:
                with zipfile.ZipFile(addon_zip) as z:
                    blend_path = z.extract("smplx_blender_addon/data/smplx_model_300_20230905.blend", tmp)
                    texture_png = z.read(f"smplx_blender_addon/data/{tex_name}")
                blend_verts, tris, corner_uv = extract_uv_with_bpy(blend_path, n_verts)
            verify_vertex_order(blend_verts, v_template)
            corner_uv[:, :, 1] = 1.0 - corner_uv[:, :, 1]  # blender UV origin bottom-left -> glTF top-left
        except Exception as exc:
            print(f"[build] WARNING: textured path failed ({exc}); falling back to untextured", file=sys.stderr)
            uvs = tris = texture_png = None

    if tris is None:
        tris = model["f"].astype(np.int64)                       # (20908, 3)
        orig_of_new = np.arange(n_verts)
        per_vert_uv = None
        new_tris = tris
    else:
        orig_of_new, per_vert_uv, new_tris = split_by_uv_seams(tris, corner_uv, n_verts)
        print(f"[build] UV seam split: {n_verts} -> {orig_of_new.shape[0]} verts")

    positions = v_template[orig_of_new]
    normals = vertex_normals(positions, new_tris)
    joints4, weights4 = top4_weights(weights[orig_of_new])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    build_glb(args.out, positions, normals, per_vert_uv, joints4, weights4,
              new_tris, joint_offsets, parents, inverse_bind, texture_png)


if __name__ == "__main__":
    main()
