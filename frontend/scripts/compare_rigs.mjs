// Compare rest geometry that the retarget depends on: bone directions (unit) and lengths, for
// the shoulders/arms/spine of one or more VRMs. node scripts/compare_rigs.mjs a.vrm b.vrm …
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null, style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import fs from 'fs';
import { humanoidRestPositions } from '../src/retarget/offsets.js';
console.warn = () => {};
const PAIRS = [['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['neck', 'head'],
  ['upperChest', 'leftShoulder'], ['leftShoulder', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['upperChest', 'rightShoulder'], ['rightShoulder', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot']];
for (const file of process.argv.slice(2)) {
  const b = fs.readFileSync(file);
  const gltf = await new Promise((res, rej) => { const l = new GLTFLoader(); l.register((p) => new VRMLoaderPlugin(p)); l.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), '', res, rej); });
  const vrm = gltf.userData.vrm; if (!vrm) { console.log(file, 'NOT A VRM'); continue; }
  const P = humanoidRestPositions(vrm);
  const h = P.head ? P.head.y : 0;
  console.log(`\n=== ${file}  v${vrm.meta?.metaVersion}  height(head)=${h.toFixed(2)}  hips=${P.hips?.y.toFixed(2)}`);
  for (const [a, c] of PAIRS) {
    if (!P[a] || !P[c]) { console.log(`  ${a}->${c}: (missing)`); continue; }
    const d = new THREE.Vector3().subVectors(P[c], P[a]); const len = d.length(); d.normalize();
    console.log(`  ${(a + '->' + c).padEnd(28)} len ${len.toFixed(3).padStart(6)}  dir [${d.x.toFixed(2)}, ${d.y.toFixed(2)}, ${d.z.toFixed(2)}]`);
  }
}
