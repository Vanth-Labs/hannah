globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null, style: {} }) };
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import fs from 'fs';
const file = process.argv[2];
const buf = fs.readFileSync(file);
const loader = new GLTFLoader(); loader.register((p) => new VRMLoaderPlugin(p));
loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (gltf) => {
  const vrm = gltf.userData.vrm;
  if (!vrm) { console.log('NOT A VRM'); return; }
  console.log('meta version:', vrm.meta?.metaVersion, '| name:', vrm.meta?.name ?? vrm.meta?.title);
  VRMUtils.rotateVRM0(vrm);
  vrm.scene.updateMatrixWorld(true);
  vrm.humanoid.update();
  const names = Object.values(VRMHumanBoneName);
  const present = names.filter((n) => vrm.humanoid.getNormalizedBoneNode(n));
  console.log('humanoid bones present:', present.length, '/', names.length, '| missing:', names.filter((n) => !present.includes(n)).join(','));
  const p = (n) => { const b = vrm.humanoid.getNormalizedBoneNode(n); if (!b) return null; const v = new THREE.Vector3(); b.getWorldPosition(v); return [v.x, v.y, v.z].map((x) => +x.toFixed(3)); };
  const q = (n) => { const b = vrm.humanoid.getNormalizedBoneNode(n); if (!b) return null; const qq = new THREE.Quaternion(); b.getWorldQuaternion(qq); return [qq.x, qq.y, qq.z, qq.w].map((x) => +x.toFixed(3)); };
  for (const n of ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftUpperLeg', 'leftFoot', 'leftToes', 'leftEye'])
    console.log(n.padEnd(14), 'pos', JSON.stringify(p(n)), 'worldQ', JSON.stringify(q(n)));
  const raw = (n) => vrm.humanoid.getRawBoneNode(n)?.name;
  console.log('raw names: hips=', raw('hips'), 'leftUpperArm=', raw('leftUpperArm'), 'leftEye=', raw('leftEye'));
  console.log('expressions preset:', Object.keys(vrm.expressionManager?.presetExpressionMap ?? {}).join(','));
  console.log('expressions custom:', Object.keys(vrm.expressionManager?.customExpressionMap ?? {}).join(',') || '(none)');
  console.log('springBoneManager:', !!vrm.springBoneManager, 'joints:', vrm.springBoneManager?.joints?.size ?? 0, '| lookAt:', !!vrm.lookAt, vrm.lookAt?.applier?.constructor?.name);
  let mats = new Set(); vrm.scene.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => mats.add(m.type || m.constructor.name)); });
  console.log('materials:', [...mats].join(','));
}, (e) => console.error('parse error', e));
