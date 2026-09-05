// src/retarget/pose.js
// From the per-bone offsets (offsets.js) to the per-frame local rotations, on the VRM's
// normalized humanoid. Pure: the avatar component and the headless tests share it.
//
//   absolute bone:  local[j] = align[p]⁻¹ · R[j] · A[j]        → adopts the SMPL-X pose exactly
//   delta bone:     local[j] = align[p]⁻¹ · R[j] · align[p]    → keeps the avatar's rest shape
//
// `align[j]` is what the bone's frame is aligned to after its own local rotation: A[j] for an
// absolute bone, the parent's alignment for a delta one. R[j] folds in the rotations of SMPL-X
// joints this VRM has no bone for (a model without upperChest still bends there).
import * as THREE from 'three';
import { yawOnly } from './offsets.js';

const _r = new THREE.Quaternion();
const _axis = new THREE.Vector3();

/** SMPL-X axis-angle (3 floats) -> quaternion. */
export function quatFromAxisAngle(x, y, z, out = new THREE.Quaternion()) {
    const ang = Math.sqrt(x * x + y * y + z * z);
    if (ang < 1e-7 || Number.isNaN(ang)) return out.identity();
    _axis.set(x / ang, y / ang, z / ang);
    return out.setFromAxisAngle(_axis, ang);
}

/**
 * Precompute, per SMPL-X joint present on this VRM: the inverse of the parent's alignment,
 * the right-hand factor (A[j] or the inherited alignment) and the joint's own alignment.
 * Joints are visited in index order, which is parent-before-child in SMPL-X.
 */
export function buildPoseRig(offsets, tuning) {
    const align = {};
    const rig = {};
    const keys = Object.keys(offsets).map(Number).sort((a, b) => a - b);
    for (const idx of keys) {
        const o = offsets[String(idx)];
        const isDelta = tuning.deltaBones?.has(o.name) && o.parent !== -1;
        let parentAlign;
        if (o.parent === -1) parentAlign = new THREE.Quaternion();
        else if (o.parent === 0 && tuning.pelvisYawOnly) parentAlign = yawOnly(align[0]);
        else parentAlign = align[o.parent];
        const own = isDelta ? parentAlign.clone() : o.A.clone();
        align[idx] = own;
        rig[String(idx)] = {
            parentInv: parentAlign.clone().invert(),
            right: own,
            skipped: o.skipped || [],
            node: o.node,
            name: o.name,
        };
    }
    return rig;
}

/**
 * Local rotation of joint `idx` for one motion frame.
 * @param poses  Float32Array of the whole motion (frames × 165)
 * @param frame  frame index
 */
export function localRotation(rig, idx, poses, frame, out = new THREE.Quaternion()) {
    const r = rig[idx];
    const base = frame * 165;
    out.copy(r.parentInv);
    for (const s of r.skipped) {
        quatFromAxisAngle(poses[base + s * 3], poses[base + s * 3 + 1], poses[base + s * 3 + 2], _r);
        out.multiply(_r);
    }
    const i = Number(idx) * 3;
    quatFromAxisAngle(poses[base + i], poses[base + i + 1], poses[base + i + 2], _r);
    return out.multiply(_r).multiply(r.right);
}

/**
 * Idle pose for the arms, from the model's own geometry: rotate the upper arm from its rest
 * direction to "hanging, a little outward", bend the forearm a bit further about the same axis.
 * Returns { upper, lower, axis } quaternions/axis in the model frame (= the normalized nodes'
 * local frame at rest), or null when the arm is missing.
 */
export function restArm(upperDir, side, tuning) {
    if (!upperDir) return null;
    // Outward = the side the arm already points to in the model frame; fall back to the
    // convention (left = +X) only if the arm is exactly vertical at rest.
    const outward = Math.sign(upperDir.x) || (side === 'left' ? 1 : -1);
    const target = new THREE.Vector3(outward * Math.sin(tuning.restArmFromVertical), -Math.cos(tuning.restArmFromVertical), 0).normalize();
    const d = upperDir.clone().normalize();
    const upper = new THREE.Quaternion().setFromUnitVectors(d, target);
    const axis = new THREE.Vector3().crossVectors(d, target);
    if (axis.lengthSq() < 1e-8) axis.set(0, 0, outward);   // arm already vertical: any axis in the plane
    axis.normalize();
    const lower = new THREE.Quaternion().setFromAxisAngle(axis, tuning.restForearmBend);
    return { upper, lower, axis };
}
