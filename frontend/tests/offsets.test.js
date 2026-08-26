// The retarget math, pure and headless. The headless VRM test loads public/avatar.glb through
// three-vrm exactly like the app does (minus WebGL), so a change that breaks the mapping fails
// here before anyone looks at a render.
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null, style: {} }) };
import { describe, expect, test, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { frameFromDir, computeOffsets, yawOnly, vrmForward } from '../src/retarget/offsets.js';
import { buildPoseRig, localRotation, restArm } from '../src/retarget/pose.js';
import { TUNING } from '../src/retarget/tuning.js';
import { SMPLX_TO_HUMANOID, SMPLX_PARENT } from '../src/retarget/smplxToHumanoid.js';
import smplxRest from '../src/retarget/smplxRest.json';

const FWD = new THREE.Vector3(0, 0, 1);

describe('frameFromDir', () => {
  test('is orthonormal with the bone direction as first column', () => {
    const m = frameFromDir(new THREE.Vector3(0.3, 1, 0.1), FWD);
    const e = m.elements; // column-major
    const c = (i) => new THREE.Vector3(e[i * 3], e[i * 3 + 1], e[i * 3 + 2]);
    const d = new THREE.Vector3(0.3, 1, 0.1).normalize();
    expect(c(0).distanceTo(d)).toBeLessThan(1e-6);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(c(i).dot(c(j)) - (i === j ? 1 : 0))).toBeLessThan(1e-6);
    expect(new THREE.Matrix3().copy(m).determinant()).toBeCloseTo(1, 6);
  });
  test('falls back to world up when the bone runs along forward (feet)', () => {
    const m = frameFromDir(new THREE.Vector3(0, 0, 1), FWD);
    expect(Number.isFinite(m.elements[4])).toBe(true);
    expect(new THREE.Matrix3().copy(m).determinant()).toBeCloseTo(1, 6);
  });
});

describe('yawOnly', () => {
  test('keeps the rotation about Y and drops the rest', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.5, 1.0, 0.2, 'YXZ'));
    const y = yawOnly(q);
    const e = new THREE.Euler().setFromQuaternion(y, 'YXZ');
    expect(Math.abs(e.x)).toBeLessThan(1e-6); expect(Math.abs(e.z)).toBeLessThan(1e-6);
    expect(Math.abs(y.length() - 1)).toBeLessThan(1e-6);
  });
});

describe('SMPL-X -> humanoid map', () => {
  test('every mapped joint has a parent chain that reaches the hips', () => {
    for (const idx of Object.keys(SMPLX_TO_HUMANOID).map(Number)) {
      let p = idx, hops = 0;
      while (p !== 0 && p !== -1 && hops < 20) { p = SMPLX_PARENT[p]; hops++; }
      expect(p).toBe(0);
    }
  });
});

async function loadVrm(file) {
  const b = fs.readFileSync(file);
  const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
  const warn = console.warn; console.warn = () => {};
  const gltf = await new Promise((res, rej) => loader.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej));
  console.warn = warn;
  return gltf.userData.vrm;
}

describe('computeOffsets on the bundled VRoid avatar (headless three-vrm)', () => {
  let vrm, off;
  beforeAll(async () => { vrm = await loadVrm('public/avatar.glb'); off = computeOffsets(vrm, smplxRest); });

  test('covers the body and the hands, chained to present ancestors', () => {
    expect(Object.keys(off).length).toBeGreaterThanOrEqual(50);
    for (const [idx, o] of Object.entries(off)) {
      expect(o.node).toBeTruthy();
      expect(Math.abs(o.A.length() - 1)).toBeLessThan(1e-6);
      if (idx !== '0') expect(off[o.parent]).toBeTruthy();
    }
  });

  test('a VRM 0 faces -Z in its own frame, so the hips offset carries the 180° turn', () => {
    expect(vrmForward(vrm).z).toBe(-1);
    const yaw = yawOnly(off['0'].A);
    // 180° about Y: |y| ≈ 1, w ≈ 0
    expect(Math.abs(yaw.y)).toBeGreaterThan(0.99);
  });

  // Apply one SMPL-X frame (Float32Array 165) through pose.js, hips yaw-only like the app.
  function applyFrame(poses) {
    const rig = buildPoseRig(off, TUNING);
    for (const idx of Object.keys(off)) {
      const q = localRotation(rig, idx, poses, 0);
      if (idx === '0' && TUNING.pelvisYawOnly) yawOnly(q, q);
      off[idx].node.quaternion.copy(q);
    }
    vrm.scene.updateMatrixWorld(true);
  }
  const worldDir = (a, b) => { const pa = new THREE.Vector3(), pb = new THREE.Vector3(); off[a].node.getWorldPosition(pa); off[b].node.getWorldPosition(pb); return pb.sub(pa).normalize(); };
  const smplxDir = (a, b) => new THREE.Vector3().fromArray(smplxRest.joints[b]).sub(new THREE.Vector3().fromArray(smplxRest.joints[a])).normalize();

  test('at the SMPL-X rest pose, absolute limbs point where SMPL-X points (mirrored by the facing)', () => {
    applyFrame(new Float32Array(165));
    // VRM 0 faces -Z in its frame; the hips yaw turns it to +Z, so world == SMPL-X axes.
    const arm = worldDir('16', '18'), armS = smplxDir(16, 18);
    expect(arm.angleTo(armS)).toBeLessThan(0.05);
    const thigh = worldDir('1', '4'), thighS = smplxDir(1, 4);
    expect(thigh.angleTo(thighS)).toBeLessThan(0.05);
  });

  test('at the SMPL-X rest pose, delta bones keep the avatar\'s own shape', () => {
    // rest directions in the model frame, mirrored by the facing (VRM 0: 180° about Y)
    const restShoulder = off['13'].dir.clone(); restShoulder.x *= -1; restShoulder.z *= -1;
    applyFrame(new Float32Array(165));
    expect(worldDir('13', '16').angleTo(restShoulder)).toBeLessThan(0.05);
  });

  test('a raised left arm in SMPL-X raises the left hand on the VRM', () => {
    applyFrame(new Float32Array(165));
    const before = new THREE.Vector3(); off['20'].node.getWorldPosition(before);
    const poses = new Float32Array(165); poses[16 * 3 + 2] = Math.PI / 2;   // joint 16 about +Z
    applyFrame(poses);
    const after = new THREE.Vector3(); off['20'].node.getWorldPosition(after);
    expect(after.y - before.y).toBeGreaterThan(0.25);
  });

  test('the idle arms hang down on both sides, from the model\'s own geometry', () => {
    for (const [upper, lower, side] of [['16', '18', 'left'], ['17', '19', 'right']]) {
      for (const o of Object.values(off)) o.node.quaternion.identity();
      off['0'].node.quaternion.copy(yawOnly(off['0'].A));
      const arm = restArm(off[upper].dir, side, TUNING);
      off[upper].node.quaternion.copy(arm.upper); off[lower].node.quaternion.copy(arm.lower);
      vrm.scene.updateMatrixWorld(true);
      const d = worldDir(upper, lower);
      expect(d.y).toBeLessThan(-0.85);                       // hanging
      expect(Math.sign(d.x)).toBe(side === 'left' ? 1 : -1); // a little outward, on its own side (world: left = +X)
    }
  });
});
