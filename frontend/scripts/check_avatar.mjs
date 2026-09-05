// Headless sanity check of one or more VRMs through the same code the app runs: bones present,
// rest directions of arms/shoulders, and where the idle arms end up (should hang, on their side).
//   node scripts/check_avatar.mjs a.vrm b.glb …
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null, style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMHumanBoneName } from '@pixiv/three-vrm';
import fs from 'fs';
import { computeOffsets, yawOnly } from '../src/retarget/offsets.js';
import { buildPoseRig, localRotation, restArm } from '../src/retarget/pose.js';
import { TUNING } from '../src/retarget/tuning.js';
import smplxRest from '../src/retarget/smplxRest.json' with { type: 'json' };
console.warn = () => {};
const f3 = (v) => `[${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)}]`;
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const gltf = await new Promise((res, rej) => { const l = new GLTFLoader(); l.register((p) => new VRMLoaderPlugin(p)); l.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej); });
  const vrm = gltf.userData.vrm; if (!vrm) { console.log(file, 'NOT A VRM'); continue; }
  const missing = Object.values(VRMHumanBoneName).filter((n) => !vrm.humanoid.getNormalizedBoneNode(n));
  const off = computeOffsets(vrm, smplxRest);
  console.log(`\n=== ${file}  VRM ${vrm.meta?.metaVersion}  name=${vrm.meta?.name ?? vrm.meta?.title ?? '?'}  missing: ${missing.join(',') || 'none'}`);
  console.log(`  rest dirs (model frame): L upperArm ${f3(off['16'].dir)}  R upperArm ${f3(off['17'].dir)}  L shoulder ${off['13'] ? f3(off['13'].dir) : '-'}  spine ${f3(off['3'].dir)}`);
  // idle pose like the app
  for (const o of Object.values(off)) o.node.quaternion.identity();
  off['0'].node.quaternion.copy(yawOnly(off['0'].A));
  for (const [u, l, side] of [['16', '18', 'left'], ['17', '19', 'right']]) {
    const arm = restArm(off[u].dir, side, TUNING);
    off[u].node.quaternion.copy(arm.upper); if (off[l]) off[l].node.quaternion.copy(arm.lower);
  }
  vrm.scene.updateMatrixWorld(true);
  const wdir = (a, c) => { const pa = new THREE.Vector3(), pc = new THREE.Vector3(); off[a].node.getWorldPosition(pa); off[c].node.getWorldPosition(pc); return pc.sub(pa).normalize(); };
  const L = wdir('16', '18'), R = wdir('17', '19');
  const ok = (d, side) => d.y < -0.85 && Math.sign(d.x) === (side === 'left' ? 1 : -1);
  console.log(`  idle arms (world): L ${f3(L)} ${ok(L, 'left') ? 'OK' : 'WRONG'}   R ${f3(R)} ${ok(R, 'right') ? 'OK' : 'WRONG'}`);
  // SMPL-X rest frame through the pose formula
  const rig = buildPoseRig(off, TUNING); const zero = new Float32Array(165);
  for (const idx of Object.keys(off)) { const q = localRotation(rig, idx, zero, 0); if (idx === '0') yawOnly(q, q); off[idx].node.quaternion.copy(q); }
  vrm.scene.updateMatrixWorld(true);
  const sh = off['13'] ? wdir('13', '16') : null;
  console.log(`  at SMPL-X rest: L arm ${f3(wdir('16', '18'))}  L shoulder ${sh ? f3(sh) : '-'}  head/neck ${off['12'] ? f3(wdir('12', '15')) : '-'}`);
}
