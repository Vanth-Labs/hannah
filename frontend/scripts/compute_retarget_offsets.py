#!/usr/bin/env python
"""Compute per-bone retarget offsets SMPL-X -> VRoid, from BOTH rigs' rest poses.

No trial-and-error: each bone's offset is the rotation that aligns the SMPL-X
rest bone frame to the VRoid rest bone frame (direction + a consistent twist
reference). At runtime the frontend applies:
    vroid_local[j] = A[parent]^-1 · quat(smplx_aa[j]) · A[j]
which reproduces the SMPL-X world pose on the VRoid skeleton exactly.

Outputs hannah-frontend/public/retarget_offsets.json:
    { "<smplxIdx>": { "A": [x,y,z,w], "parent": <smplxIdx|-1> } }
"""
import base64
import json
import struct
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parents[1]
SMPLX_NPZ = Path.home() / "PantoMatrix/smplx_models/smplx/SMPLX_NEUTRAL_2020.npz"
AVATAR_GLB = HERE / "public/avatar.glb"
OUT = HERE / "src/retarget/retargetOffsets.json"

SMPLX_TO_VROID = {
    0: 'J_Bip_C_Hips', 1: 'J_Bip_L_UpperLeg', 2: 'J_Bip_R_UpperLeg', 3: 'J_Bip_C_Spine',
    4: 'J_Bip_L_LowerLeg', 5: 'J_Bip_R_LowerLeg', 6: 'J_Bip_C_Chest', 7: 'J_Bip_L_Foot',
    8: 'J_Bip_R_Foot', 9: 'J_Bip_C_UpperChest', 10: 'J_Bip_L_ToeBase', 11: 'J_Bip_R_ToeBase',
    12: 'J_Bip_C_Neck', 13: 'J_Bip_L_Shoulder', 14: 'J_Bip_R_Shoulder', 15: 'J_Bip_C_Head',
    16: 'J_Bip_L_UpperArm', 17: 'J_Bip_R_UpperArm', 18: 'J_Bip_L_LowerArm', 19: 'J_Bip_R_LowerArm',
    20: 'J_Bip_L_Hand', 21: 'J_Bip_R_Hand',
    25: 'J_Bip_L_Index1', 26: 'J_Bip_L_Index2', 27: 'J_Bip_L_Index3',
    28: 'J_Bip_L_Middle1', 29: 'J_Bip_L_Middle2', 30: 'J_Bip_L_Middle3',
    31: 'J_Bip_L_Little1', 32: 'J_Bip_L_Little2', 33: 'J_Bip_L_Little3',
    34: 'J_Bip_L_Ring1', 35: 'J_Bip_L_Ring2', 36: 'J_Bip_L_Ring3',
    37: 'J_Bip_L_Thumb1', 38: 'J_Bip_L_Thumb2', 39: 'J_Bip_L_Thumb3',
    40: 'J_Bip_R_Index1', 41: 'J_Bip_R_Index2', 42: 'J_Bip_R_Index3',
    43: 'J_Bip_R_Middle1', 44: 'J_Bip_R_Middle2', 45: 'J_Bip_R_Middle3',
    46: 'J_Bip_R_Little1', 47: 'J_Bip_R_Little2', 48: 'J_Bip_R_Little3',
    49: 'J_Bip_R_Ring1', 50: 'J_Bip_R_Ring2', 51: 'J_Bip_R_Ring3',
    52: 'J_Bip_R_Thumb1', 53: 'J_Bip_R_Thumb2', 54: 'J_Bip_R_Thumb3',
}

# SMPL-X kinematic parents (index -> parent index), 55-joint order.
SMPLX_PARENT = {
    0: -1, 1: 0, 2: 0, 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, 11: 8,
    12: 9, 13: 9, 14: 9, 15: 12, 16: 13, 17: 14, 18: 16, 19: 17, 20: 18, 21: 19,
    22: 15, 23: 15, 24: 15,
    25: 20, 26: 25, 27: 26, 28: 20, 29: 28, 30: 29, 31: 20, 32: 31, 33: 32,
    34: 20, 35: 34, 36: 35, 37: 20, 38: 37, 39: 38,
    40: 21, 41: 40, 42: 41, 43: 21, 44: 43, 45: 44, 46: 21, 47: 46, 48: 47,
    49: 21, 50: 49, 51: 50, 52: 21, 53: 52, 54: 53,
}
# Primary child used to define each bone's forward direction.
PRIMARY_CHILD = {
    0: 3, 3: 6, 6: 9, 9: 12, 12: 15, 13: 16, 16: 18, 18: 20, 20: 28,
    14: 17, 17: 19, 19: 21, 21: 43, 1: 4, 4: 7, 7: 10, 2: 5, 5: 8, 8: 11,
    25: 26, 26: 27, 28: 29, 29: 30, 31: 32, 32: 33, 34: 35, 35: 36, 37: 38, 38: 39,
    40: 41, 41: 42, 43: 44, 44: 45, 46: 47, 47: 48, 49: 50, 50: 51, 52: 53, 53: 54,
}


def quat_mul(a, b):
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return np.array([
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ])


def mat_to_quat(m):
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = np.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s; y = (m[0, 2] - m[2, 0]) / s; z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s; x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s; z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s; x = (m[0, 1] + m[1, 0]) / s; y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s; x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s; z = 0.25 * s
    return np.array([x, y, z, w])


def frame_from_dir(dir_vec, fwd):
    """Orthonormal rest frame (columns) from a bone direction + the rig's FORWARD
    axis as the twist reference. SMPL-X faces +Z, VRoid faces -Z: passing each
    rig's own forward bakes the facing (incl. the 180° flip) into the offset, so
    gestures come out of the front of the mesh, not the back."""
    d = dir_vec / (np.linalg.norm(dir_vec) + 1e-9)
    ref = fwd if abs(d @ fwd) < 0.9 else np.array([0, 1.0, 0])
    u = ref - d * (ref @ d); u /= np.linalg.norm(u) + 1e-9
    t = np.cross(d, u)
    return np.stack([d, u, t], axis=1)  # 3x3, columns = axes


def load_smplx_positions():
    m = np.load(SMPLX_NPZ, allow_pickle=True)
    J = m['J_regressor'] @ m['v_template']  # (55,3) rest joint positions
    return np.asarray(J)


def load_vroid_positions():
    with open(AVATAR_GLB, 'rb') as f:
        f.read(12)
        jlen, = struct.unpack('<I', f.read(4)); f.read(4)
        g = json.loads(f.read(jlen))
    nodes = g['nodes']
    name_to_idx = {n.get('name'): i for i, n in enumerate(nodes)}
    # world positions by walking from each scene root
    worldpos = [None] * len(nodes)

    def walk(i, parent_pos):
        t = np.array(nodes[i].get('translation', [0, 0, 0]), dtype=float)
        wp = parent_pos + t
        worldpos[i] = wp
        for c in nodes[i].get('children', []):
            walk(c, wp)
    for root in g['scenes'][g.get('scene', 0)]['nodes']:
        walk(root, np.zeros(3))
    return {name: worldpos[name_to_idx[name]] for name in SMPLX_TO_VROID.values() if name in name_to_idx}


def main():
    Js = load_smplx_positions()
    Vp = load_vroid_positions()

    offsets = {}
    for idx, vname in SMPLX_TO_VROID.items():
        child = PRIMARY_CHILD.get(idx)
        if child is None or vname not in Vp:
            # leaf: reuse parent->self direction
            p = SMPLX_PARENT[idx]
            dir_s = Js[idx] - Js[p]
            vp_name = SMPLX_TO_VROID.get(p)
            dir_v = (Vp[vname] - Vp[vp_name]) if vp_name in Vp else dir_s
        else:
            dir_s = Js[child] - Js[idx]
            vc_name = SMPLX_TO_VROID.get(child)
            dir_v = (Vp[vc_name] - Vp[vname]) if vc_name in Vp else dir_s
        Sf = frame_from_dir(dir_s, np.array([0, 0, 1.0]))    # SMPL-X faces +Z
        Vf = frame_from_dir(dir_v, np.array([0, 0, -1.0]))   # VRoid faces -Z
        A = Vf @ Sf.T           # rotation aligning SMPL-X frame -> VRoid frame
        q = mat_to_quat(A)
        q /= np.linalg.norm(q)
        parent = SMPLX_PARENT[idx]
        # nearest MAPPED ancestor (skip unmapped like jaw/eyes)
        while parent != -1 and parent not in SMPLX_TO_VROID:
            parent = SMPLX_PARENT[parent]
        offsets[str(idx)] = {"A": [round(float(v), 6) for v in q], "parent": parent}

    OUT.write_text(json.dumps(offsets))
    print(f"wrote {len(offsets)} offsets -> {OUT}")


if __name__ == "__main__":
    main()
