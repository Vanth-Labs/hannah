// src/retarget/offsets.js
// Per-bone retarget offsets SMPL-X -> VRM, computed AT LOAD from both rigs' rest poses.
// No trial-and-error and nothing per avatar on disk: each bone's offset is the rotation that
// aligns the SMPL-X rest bone frame to the VRM rest bone frame (bone direction + a consistent
// twist reference). At runtime the avatar applies, on the VRM's NORMALIZED humanoid nodes
// (rest = identity for every VRM, so this works for any of them):
//     local[j] = align[parent]^-1 · quat(smplx_aa[j]) · A[j]         (absolute: limbs)
//     local[j] = align[parent]^-1 · quat(smplx_aa[j]) · align[parent]  (delta: body shape)
// Absolute bones adopt the SMPL-X pose exactly (an arm at -90° is vertical on every avatar);
// delta bones keep the avatar's own rest shape (its shoulder slope, its neck) and take only the
// motion's rotation on top. See pose.js and TUNING.deltaBones.
//
// Ported from the retired scripts/compute_retarget_offsets.py, generalised through
// @pixiv/three-vrm's humanoid — with one correction, see `A` below.
import * as THREE from 'three';
import { SMPLX_TO_HUMANOID, SMPLX_PARENT, PRIMARY_CHILD } from './smplxToHumanoid.js';

const _d = new THREE.Vector3();
const _u = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Orthonormal rest frame from a bone direction + the rig's FORWARD axis as the twist
 * reference. Columns: [direction, up-ish, third]. When the bone runs along the forward axis
 * (feet), world up takes over as the reference so the frame stays defined.
 */
export function frameFromDir(dir, fwd, out = new THREE.Matrix3()) {
    _d.copy(dir).normalize();
    const ref = Math.abs(_d.dot(fwd)) < 0.9 ? fwd : UP;
    _u.copy(ref).addScaledVector(_d, -ref.dot(_d)).normalize();
    _t.crossVectors(_d, _u);
    out.set(
        _d.x, _u.x, _t.x,
        _d.y, _u.y, _t.y,
        _d.z, _u.z, _t.z,
    );
    return out;
}

/** Quaternion from a 3x3 rotation matrix (columns = axes). */
export function quatFromMatrix3(m3, out = new THREE.Quaternion()) {
    _m.setFromMatrix3(m3);
    return out.setFromRotationMatrix(_m).normalize();
}

/**
 * Rest positions of the VRM's humanoid bones, in the VRM scene's own frame (not world: the
 * scene may be rotated, and the motion is applied to nodes under it). Uses the normalized
 * rig, whose rest rotations are identity for every VRM.
 */
export function humanoidRestPositions(vrm) {
    vrm.scene.updateMatrixWorld(true);
    const pos = {};
    const v = new THREE.Vector3();
    for (const name of Object.values(SMPLX_TO_HUMANOID)) {
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (!node) continue;
        node.getWorldPosition(v);
        vrm.scene.worldToLocal(v);
        pos[name] = v.clone();
    }
    return pos;
}

/**
 * The direction the VRM faces in its own scene frame. VRM 1.0 faces +Z; VRM 0.x faces -Z
 * (Unity's convention, before any rotateVRM0). SMPL-X faces +Z. Giving each rig its own
 * forward bakes the facing — including the 180° flip for VRM 0 — into the hips offset, so
 * the gestures come out of the front of the mesh and the avatar faces +Z (the camera).
 */
export function vrmForward(vrm) {
    const v0 = String(vrm.meta?.metaVersion ?? '0') === '0';
    return new THREE.Vector3(0, 0, v0 ? -1 : 1);
}

/**
 * Compute the offsets for this VRM.
 * @param vrm        a three-vrm VRM instance (humanoid required)
 * @param smplxRest  { joints: [[x,y,z] x55] } — SMPL-X rest joint positions
 * @returns { [smplxIdx]: { A: THREE.Quaternion, parent: smplxIdx|-1, node: Object3D, name } }
 *          only for joints whose humanoid bone exists in this VRM; `parent` is the nearest
 *          MAPPED (and present) ancestor, so a VRM without upperChest or chest still chains.
 */
export function computeOffsets(vrm, smplxRest) {
    const J = smplxRest.joints.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const V = humanoidRestPositions(vrm);
    const fwdS = new THREE.Vector3(0, 0, 1);
    const fwdV = vrmForward(vrm);
    const present = (idx) => idx != null && idx !== -1 && V[SMPLX_TO_HUMANOID[idx]] != null;

    const out = {};
    const Sf = new THREE.Matrix3();
    const Vf = new THREE.Matrix3();
    const dirS = new THREE.Vector3();
    const dirV = new THREE.Vector3();
    for (const [idxStr, name] of Object.entries(SMPLX_TO_HUMANOID)) {
        const idx = Number(idxStr);
        if (!V[name]) continue;
        // Direction: bone -> primary child; leaves reuse parent -> self.
        let child = PRIMARY_CHILD[idx];
        if (child != null && !present(child)) child = null;
        if (child == null) {
            let p = SMPLX_PARENT[idx];
            while (p !== -1 && !present(p)) p = SMPLX_PARENT[p];
            if (p === -1) continue; // nothing to orient against (only if the whole spine is missing)
            dirS.subVectors(J[idx], J[p]);
            dirV.subVectors(V[name], V[SMPLX_TO_HUMANOID[p]]);
        } else {
            dirS.subVectors(J[child], J[idx]);
            dirV.subVectors(V[SMPLX_TO_HUMANOID[child]], V[name]);
        }
        frameFromDir(dirS, fwdS, Sf);
        frameFromDir(dirV, fwdV, Vf);
        // A = Sf · Vfᵀ : the rotation that takes the VRM rest frame onto the SMPL-X rest frame.
        // With world[j] = world_smplx[j] · A[j], the VRM bone points where the SMPL-X bone points
        // (at rest: A·d_vrm = d_smplx), so a limb angle in the motion is that angle on the avatar.
        // (The retired Python script had Vf·Sfᵀ — the inverse. On the VRoid it was harmless because
        // the 180° facing folded into A cancels the error; on a VRM 1.0 the direction difference
        // got applied twice, which is what pulled the shoulders down on other avatars.)
        const A = new THREE.Matrix3().copy(Sf).multiply(new THREE.Matrix3().copy(Vf).transpose());
        // nearest mapped AND present ancestor (skips jaw/eyes and bones this VRM lacks); the
        // joints skipped in between still rotate in SMPL-X, so their rotations are folded in.
        let parent = SMPLX_PARENT[idx];
        const skipped = [];
        while (parent !== -1 && !present(parent)) { if (SMPLX_TO_HUMANOID[parent]) skipped.unshift(parent); parent = SMPLX_PARENT[parent]; }
        out[idxStr] = {
            A: quatFromMatrix3(A), parent, skipped, name,
            node: vrm.humanoid.getNormalizedBoneNode(name),
            dir: dirV.clone().normalize(),   // rest direction in the model frame (for the idle pose)
        };
    }
    return out;
}

/** Yaw-only version of a quaternion (rotation about world Y), normalised. */
export function yawOnly(q, out = new THREE.Quaternion()) {
    const n = Math.hypot(q.y, q.w);
    return n < 1e-6 ? out.identity() : out.set(0, q.y / n, 0, q.w / n);
}
