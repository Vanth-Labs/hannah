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

  test('a raised left arm in SMPL-X raises the left hand on the VRM', () => {
    const node = (i) => off[i].node;
    // rest: everything identity except hips facing
    for (const o of Object.values(off)) o.node.quaternion.identity();
    node('0').quaternion.copy(yawOnly(off['0'].A));
    vrm.scene.updateMatrixWorld(true);
    const before = new THREE.Vector3(); node('20').getWorldPosition(before);
    // SMPL-X: rotate the left upper arm (16) 90° about its parent's Z... in SMPL-X the arm
    // hangs along +X and a rotation about +Z lifts it toward +Y.
    const apply = (idx, aa) => {
      const ang = aa.length();
      const R = ang < 1e-9 ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(aa.clone().normalize(), ang);
      const parentInv = off[idx].parent === -1 ? new THREE.Quaternion() : off[off[idx].parent].A.clone().invert();
      node(idx).quaternion.copy(parentInv).multiply(R).multiply(off[idx].A);
    };
    for (const idx of Object.keys(off)) if (idx !== '0') apply(idx, new THREE.Vector3());
    apply('16', new THREE.Vector3(0, 0, Math.PI / 2));
    vrm.scene.updateMatrixWorld(true);
    const after = new THREE.Vector3(); node('20').getWorldPosition(after);
    expect(after.y - before.y).toBeGreaterThan(0.25);   // the hand went up, clearly
  });
});
