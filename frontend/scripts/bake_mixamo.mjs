// Bake Mixamo FBX gestures -> VRM NORMALIZED-bone local-quaternion clips (JSON).
//
// Runs HEADLESS in Node: loads a VRM (via @pixiv/three-vrm), retargets each Mixamo clip
// onto the VRM humanoid with pixiv's rig map + rest-pose rebake, plays it, and records the
// NORMALIZED humanoid nodes (standard names, identity rest) per frame, in the VRM 1.0 local
// frame. That makes the clips portable: the frontend applies them to any VRM's normalized
// rig, mirroring X/Z for VRM 0.x models (whose local frames carry the 180° facing).
//
//   node scripts/bake_mixamo.mjs
globalThis.self = globalThis; globalThis.window = globalThis;
globalThis.document = { createElementNS: () => ({}), createElement: () => ({ getContext: () => null, style: {} }) };

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import fs from 'fs';
import path from 'path';

const ANIM_DIR = 'public/animations';
const OUT_DIR = 'public/animations/baked';
const FPS = 30;
const CLIPS = ['wave', 'point', 'nod', 'shake_no', 'happy', 'dismiss', 'acknowledge'];

// Mixamo rig bone -> VRM humanoid bone name
const MIXAMO_VRM = {
  mixamorigHips: 'hips', mixamorigSpine: 'spine', mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest', mixamorigNeck: 'neck', mixamorigHead: 'head',
  mixamorigLeftShoulder: 'leftShoulder', mixamorigLeftArm: 'leftUpperArm',
  mixamorigLeftForeArm: 'leftLowerArm', mixamorigLeftHand: 'leftHand',
  mixamorigRightShoulder: 'rightShoulder', mixamorigRightArm: 'rightUpperArm',
  mixamorigRightForeArm: 'rightLowerArm', mixamorigRightHand: 'rightHand',
  mixamorigLeftUpLeg: 'leftUpperLeg', mixamorigLeftLeg: 'leftLowerLeg',
  mixamorigLeftFoot: 'leftFoot', mixamorigLeftToeBase: 'leftToes',
  mixamorigRightUpLeg: 'rightUpperLeg', mixamorigRightLeg: 'rightLowerLeg',
  mixamorigRightFoot: 'rightFoot', mixamorigRightToeBase: 'rightToes',
};

function loadArrayBuffer(p) {
  const b = fs.readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// pixiv's canonical Mixamo->VRM retarget (rest-pose rebake + VRM0 mirror)
function retargetToVrm(asset, vrm) {
  const clip = THREE.AnimationClip.findByName(asset.animations, 'mixamo.com') || asset.animations[0];
  const tracks = [];
  const restRotInv = new THREE.Quaternion();
  const parentRestWorld = new THREE.Quaternion();
  const q = new THREE.Quaternion();

  for (const track of clip.tracks) {
    const [rigName, prop] = track.name.split('.');
    const vrmBone = MIXAMO_VRM[rigName];
    if (!vrmBone) continue;
    const node = vrm.humanoid.getNormalizedBoneNode(vrmBone);
    if (!node) continue;
    const mixamoNode = asset.getObjectByName(rigName);
    mixamoNode.getWorldQuaternion(restRotInv).invert();
    mixamoNode.parent.getWorldQuaternion(parentRestWorld);

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      const v = track.values.slice();
      for (let i = 0; i < v.length; i += 4) {
        q.fromArray(v, i).premultiply(parentRestWorld).multiply(restRotInv);
        // Stored in the VRM 1.0 local frame on purpose (no VRM 0 mirror here): the frontend
        // mirrors at play time when the loaded avatar is a VRM 0.x.
        q.toArray(v, i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${node.name}.${prop}`, track.times.slice(), v));
    }
  }
  return new THREE.AnimationClip('gesture', clip.duration, tracks);
}

async function loadVrm() {
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const warn = console.warn; console.warn = () => {};
  const gltf = await new Promise((res, rej) =>
    loader.parse(loadArrayBuffer('public/avatar.glb'), '', res, rej));
  console.warn = warn;
  return gltf.userData.vrm;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const vrm = await loadVrm();
  // Normalized bones we sample, keyed by humanoid name (frontend skips hips/legs anyway).
  const rawBones = {};
  for (const vb of Object.values(MIXAMO_VRM)) {
    const n = vrm.humanoid.getNormalizedBoneNode(vb);
    if (n) rawBones[vb] = n;
  }

  for (const name of CLIPS) {
    const fbxPath = path.join(ANIM_DIR, `${name}.fbx`);
    if (!fs.existsSync(fbxPath)) { console.log(`skip ${name} (no fbx)`); continue; }
    const asset = new FBXLoader().parse(loadArrayBuffer(fbxPath), '');
    const clip = retargetToVrm(asset, vrm);

    const mixer = new THREE.AnimationMixer(vrm.scene);
    const action = mixer.clipAction(clip);
    action.play();

    const nFrames = Math.max(1, Math.round(clip.duration * FPS));
    const dt = clip.duration / nFrames;
    const bones = {}; for (const vb in rawBones) bones[vb] = [];
    let prev = 0;
    for (let f = 0; f < nFrames; f++) {
      const t = f * dt;
      mixer.update(t - prev); prev = t;
      for (const [vb, node] of Object.entries(rawBones)) {
        const { x, y, z, w } = node.quaternion;
        bones[vb].push([+x.toFixed(5), +y.toFixed(5), +z.toFixed(5), +w.toFixed(5)]);
      }
    }
    mixer.stopAllAction();
    fs.writeFileSync(path.join(OUT_DIR, `${name}.json`),
      JSON.stringify({ name, fps: FPS, frames: nFrames, duration: +clip.duration.toFixed(3), bones }));
    // sanity: how far the right hand travels vs frame 0
    const rh = bones.rightHand;
    const dev = rh ? Math.max(...rh.map((qf) => {
      const d = Math.acos(Math.min(1, Math.abs(qf[0] * rh[0][0] + qf[1] * rh[0][1] + qf[2] * rh[0][2] + qf[3] * rh[0][3])));
      return d;
    })) : 0;
    console.log(`baked ${name}: ${nFrames}f ${clip.duration.toFixed(2)}s  rightHand Δrot=${(dev * 180 / Math.PI).toFixed(0)}°`);
  }
  console.log('done ->', OUT_DIR);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
