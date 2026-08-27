// src/components/VrmAvatar.jsx
// The avatar: ANY VRM (0.x or 1.0, .vrm or .glb with the VRM extension), through
// @pixiv/three-vrm. Body from the SMPL-X co-speech motion, retargeted onto the VRM's
// NORMALIZED humanoid (standard bone names, identity rest pose) with offsets computed at
// load; face, look-at and spring bones through the VRM standard; deliberate gestures
// (Mixamo, baked in normalized space) layered on top.
import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { useHannahStore } from '../store/hannahStore.js';
import {
    EMOTION_TO_VRM, ALL_EMOTION_VRM, VISEME_TO_VRM, ALL_VISEME_VRM, BLINK_VRM,
    VROID_EXTRAS, ALL_EXTRA_MORPHS, resolveExpression,
} from '../retarget/retargetFace.js';
import { SMPLX_TO_HUMANOID, FEET_IDX, SPINE_IDX, FINGER_IDX, LOWER_BODY } from '../retarget/smplxToHumanoid.js';
import { computeOffsets, yawOnly } from '../retarget/offsets.js';
import { buildPoseRig, localRotation, restArm } from '../retarget/pose.js';
import { TUNING } from '../retarget/tuning.js';
import smplxRest from '../retarget/smplxRest.json';
import { isOverlay as IS_OVERLAY } from '../lib/overlay.js';

// Framing: the HEAD lands at a fixed height, whatever the model's stature. The bundled VRoid
// is 1.47 m to the head and used to sit on a floor at -1.6; a 1.3 m VRM would otherwise drop
// its face into the bottom of the window.
const HEAD_Y = -0.13;

const _quat = new THREE.Quaternion();
const _rot = new THREE.Quaternion();
const _look = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();

// Auto-lookat: límites y pesos (radianes). Ajustables si mira raro.
const LOOK = {
    headYaw: 0.44, headPitch: 0.26,   // clamp cabeza (~25° / ~15°)
    headWeight: 0.5,                  // mezcla sobre el co-speech (no lo mata)
    eyeYaw: 0.22, eyePitch: 0.13,     // amplitud del objetivo de los ojos (en metros, a 1.5 m)
    yawSign: 1,
};

// ── Idle procedural: micro-movimientos cuando NO habla (vida en reposo) ──
const TAU = Math.PI * 2;
const IDLE = {
    breath: 0.045, breathHz: 0.22,   // respiración (~1 cada 4.5 s)
    sway: 0.03, swayHz: 0.12,        // balanceo (~1 cada 8 s)
    armSway: 0.025,
};
const _idleE = new THREE.Euler();
const _idleQ = new THREE.Quaternion();
// Offset de idle por joint SMPL-X (o null). Se multiplica sobre el reposo.
function idleOffset(idx, t) {
    const b = Math.sin(t * IDLE.breathHz * TAU);
    const s = Math.sin(t * IDLE.swayHz * TAU);
    let x = 0, z = 0;
    switch (idx) {
        case '0':  z = s * IDLE.sway * 0.5; break;                            // pelvis
        case '3':  x = b * IDLE.breath * 0.4; z = s * IDLE.sway; break;       // columna baja
        case '6':  x = b * IDLE.breath * 0.7; z = s * IDLE.sway * 0.6; break; // pecho
        case '9':  x = b * IDLE.breath; break;                                // pecho alto
        case '12': x = -b * IDLE.breath * 0.3; break;                         // cuello
        case '16': z = s * IDLE.armSway; break;
        case '17': z = s * IDLE.armSway; break;
        default: return null;
    }
    _idleE.set(x, 0, z);
    return _idleQ.setFromEuler(_idleE);
}

// Gestos deliberados (Mixamo, horneados en espacio normalizado, frame VRM 1.0). Solo tren
// superior: nunca cadera ni piernas, para no alterar encaramiento ni postura.
const GESTURE_NAMES = ['wave', 'point', 'nod', 'shake_no', 'happy', 'dismiss', 'acknowledge'];
// ?nogesture=1: ignora los clips deliberados, para que al hablar TODO el movimiento venga del
// text-to-motion (útil para probar el retarget de un avatar nuevo sin que un clip lo tape).
const NO_GESTURES = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nogesture');
// Al terminar un clip deliberado, el co-speech de esa oración solo retoma si queda habla de
// verdad; con menos de esto se va a reposo en vez de entrar al text-to-motion por un instante.
const RESUME_COSPEECH_MIN_S = 1.0;

// The loader plugin that turns a glTF with the VRM extension into a VRM. Applied through
// drei's `extendLoader` so the model is cached by URL like any other asset.
const extendLoader = (loader) => loader.register((parser) => new VRMLoaderPlugin(parser));

function collectMorphs(scene) {
    const map = {};
    scene.traverse((child) => {
        if (child.isMesh) {
            child.frustumCulled = false;   // skinned meshes get culled by their rest bbox otherwise
            if (child.morphTargetDictionary) {
                for (const [name, idx] of Object.entries(child.morphTargetDictionary)) {
                    (map[name] ||= []).push({ mesh: child, idx });
                }
            }
        }
    });
    return map;
}

// Resolve every expression name once per model: emotion -> { vrmExpressionName: weight }.
function resolveFaceMaps(vrm) {
    const emotion = {};
    for (const [emo, set] of Object.entries(EMOTION_TO_VRM)) {
        emotion[emo] = {};
        for (const [name, w] of Object.entries(set)) {
            const r = resolveExpression(vrm, name);
            if (r) emotion[emo][r] = w;
        }
    }
    const allEmotion = Array.from(new Set(ALL_EMOTION_VRM.map((n) => resolveExpression(vrm, n)).filter(Boolean)));
    const viseme = {};
    for (const [code, name] of Object.entries(VISEME_TO_VRM)) viseme[code] = name ? resolveExpression(vrm, name) : null;
    const allViseme = ALL_VISEME_VRM.map((n) => resolveExpression(vrm, n)).filter(Boolean);
    return { emotion, allEmotion, viseme, allViseme, blink: resolveExpression(vrm, BLINK_VRM) };
}

export function VrmAvatar({ url = '/avatar.glb' }) {
    const group = useRef();
    const gltf = useGLTF(url, undefined, undefined, extendLoader);
    const vrm = gltf.userData?.vrm || null;
    const setAvatarError = useHannahStore((s) => s.setAvatarError);

    useEffect(() => { setAvatarError(vrm ? null : 'not_a_vrm'); }, [vrm, setAvatarError]);

    const rig = useMemo(() => {
        if (!vrm) return null;
        VRMUtils.removeUnnecessaryVertices(vrm.scene);
        const morphs = collectMorphs(vrm.scene);
        const node = (name) => vrm.humanoid.getNormalizedBoneNode(name);
        const isVrm0 = String(vrm.meta?.metaVersion ?? '0') === '0';

        // Offsets SMPL-X -> this VRM, from both rest poses (retarget/offsets.js), and the
        // per-joint factors of the pose formula (retarget/pose.js).
        const offsets = computeOffsets(vrm, smplxRest);
        const poseRig = buildPoseRig(offsets, TUNING);
        const hipsYaw = yawOnly(offsets['0'].A);

        // Rest pose on the normalized rig: facing from the hips offset (only its yaw), arms
        // hanging — computed from where THIS model's arms point at rest, so a T-pose, an
        // A-pose or an asymmetric rig all end up arms down.
        node('hips').quaternion.copy(TUNING.pelvisYawOnly ? hipsYaw : offsets['0'].A);
        const abduct = {};
        for (const [upperIdx, lowerIdx, side] of [['16', '18', 'left'], ['17', '19', 'right']]) {
            const arm = restArm(offsets[upperIdx]?.dir, side, TUNING);
            if (!arm) continue;
            offsets[upperIdx].node.quaternion.copy(arm.upper);
            if (offsets[lowerIdx]) offsets[lowerIdx].node.quaternion.copy(arm.lower);
            // Shoulder abduction: raise the upper arm away from the torso about the same axis.
            abduct[upperIdx] = new THREE.Quaternion().setFromAxisAngle(arm.axis, -TUNING.shoulderAbduct);
        }

        const bodyBones = {}, restQuat = {};
        for (const [idx, o] of Object.entries(offsets)) {
            bodyBones[idx] = o.node;
            restQuat[idx] = o.node.quaternion.clone();
        }

        vrm.scene.updateMatrixWorld(true);
        const headV = new THREE.Vector3();
        node('head')?.getWorldPosition(headV); vrm.scene.worldToLocal(headV);
        const headRestY = node('head') ? headV.y : new THREE.Box3().setFromObject(vrm.scene).max.y - 0.2;
        if (import.meta.env.DEV) window.__hannahVrm = { vrm, group };   // inspección en dev (capturas, consola)
        const lookTarget = new THREE.Object3D();
        if (vrm.lookAt) { vrm.lookAt.target = lookTarget; vrm.lookAt.autoUpdate = true; }

        return {
            vrm, offsets, poseRig, abduct, bodyBones, restQuat, morphs, isVrm0,
            // Local-frame sign: VRM 0 carries the 180° facing in the hips, which mirrors X/Z
            // of every descendant's local frame relative to a VRM 1.0 model.
            flip: isVrm0 ? 1 : -1,
            face: resolveFaceMaps(vrm),
            head: node('head'),
            chest: node('upperChest') || node('chest'),
            baseY: HEAD_Y - headRestY,
            lookTarget,
        };
    }, [vrm]);

    const face = useRef({
        current: {}, blinkNext: 2 + Math.random() * 3, blinkT: -1,
        saccadeNext: 1 + Math.random() * 2,
        saccade: new THREE.Vector2(0, 0), gazeAnchor: new THREE.Vector2(0, 0),
        oGaze: new THREE.Vector2(0, 0),   // mirada global suavizada (overlay)
    }).current;

    // Clips de gesto (Mixamo horneado en espacio normalizado). Se cargan una vez.
    const clips = useRef({});
    const gesture = useRef(null);   // { clip, startedAt }
    const suppressed = useRef(null); // startedAt del motion de una oración cuyo resto no se reproduce
    useEffect(() => {
        let alive = true;
        GESTURE_NAMES.forEach((n) => {
            fetch(`/animations/baked/${n}.json`)
                .then((r) => (r.ok ? r.json() : null))
                .then((c) => { if (alive && c) clips.current[n] = c; })
                .catch(() => {});
        });
        return () => { alive = false; };
    }, []);

    useEffect(() => {
        if (!rig) return;
        if (group.current) { group.current.position.y = rig.baseY; group.current.add(rig.lookTarget); }
        useHannahStore.getState().setAvatarLoaded(true);
        return () => { rig.lookTarget.removeFromParent(); };
    }, [rig]);

    const setExpr = (name, value) => { if (name) rig.vrm.expressionManager?.setValue(name, value); };
    const lerpExpr = (name, target, a) => {
        if (!name) return;
        const cur = face.current[name] ?? 0;
        const next = cur + (target - cur) * a;
        face.current[name] = next;
        setExpr(name, next);
    };
    const setMorph = (name, value) => {
        const targets = rig.morphs[name];
        if (!targets) return;
        for (const { mesh, idx } of targets) if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = value;
    };
    const lerpMorph = (name, target, a) => {
        if (!rig.morphs[name]) return;
        const cur = face.current[name] ?? 0;
        const next = cur + (target - cur) * a;
        face.current[name] = next;
        setMorph(name, next);
    };

    useFrame((state, delta) => {
        if (!rig) return;
        if (import.meta.env.DEV && window.__hannahVrm) window.__hannahVrm.camera = state.camera;
        const { emotion, currentVisemes, currentMotion, gestureTrigger, autoLookat, overlayGaze } = useHannahStore.getState();
        const t = state.clock.getElapsedTime();
        const aFast = Math.min(1, 14 * delta);
        const aSlow = Math.min(1, 3 * delta);
        const aBody = Math.min(1, 16 * delta);

        // ── CUERPO: retargeting SMPL-X -> VRM (nodos normalizados) ───────
        let frame = -1;
        if (currentMotion?.poses && currentMotion.startedAt !== suppressed.current) {
            const elapsed = (performance.now() - currentMotion.startedAt) / 1000;
            const f = Math.floor(elapsed * currentMotion.fps);
            if (f >= 0 && f < currentMotion.numFrames) frame = f;
        }
        for (const [idx, bone] of Object.entries(rig.bodyBones)) {
            if (TUNING.pinFeet && FEET_IDX.has(idx)) { bone.quaternion.slerp(rig.restQuat[idx], Math.min(1, 8 * delta)); continue; }
            if (TUNING.pinFingers && FINGER_IDX.has(idx)) { bone.quaternion.slerp(rig.restQuat[idx], Math.min(1, 10 * delta)); continue; }
            if (frame >= 0) {
                // absolute or delta per bone, skipped joints folded in (retarget/pose.js)
                localRotation(rig.poseRig, idx, currentMotion.poses, frame, _quat);
                if (idx === '0') { if (TUNING.pelvisYawOnly) yawOnly(_quat, _quat); }
                else if (SPINE_IDX.has(idx)) _quat.copy(rig.restQuat[idx]).slerp(_quat, TUNING.spineKeep);
                else if (rig.abduct[idx]) _quat.multiply(rig.abduct[idx]);
                bone.quaternion.slerp(_quat, aBody);
            } else {
                const off = idleOffset(idx, t);
                const tq = off ? _quat.copy(rig.restQuat[idx]).multiply(off) : rig.restQuat[idx];
                bone.quaternion.slerp(tq, Math.min(1, 4 * delta));
            }
        }

        // ── GESTO deliberado (Mixamo) por encima del co-speech ──────────
        if (!NO_GESTURES && gestureTrigger && gestureTrigger.startedAt !== gesture.current?.startedAt) {
            const clip = clips.current[gestureTrigger.name];
            if (clip) gesture.current = { clip, startedAt: gestureTrigger.startedAt };
        }
        if (gesture.current) {
            const { clip, startedAt } = gesture.current;
            const elapsed = (performance.now() - startedAt) / 1000;
            const foutEnd = clip.duration + 0.3;
            if (elapsed >= foutEnd) {
                gesture.current = null;
                // El clip acabó: seguir con el text-to-motion solo si queda habla de verdad.
                if (currentMotion?.poses) {
                    const remain = currentMotion.numFrames / currentMotion.fps - (performance.now() - currentMotion.startedAt) / 1000;
                    if (remain < RESUME_COSPEECH_MIN_S) suppressed.current = currentMotion.startedAt;
                }
            } else {
                const f = Math.min(clip.frames - 1, Math.max(0, Math.floor(elapsed * clip.fps)));
                const w = Math.max(0, Math.min(1, Math.min(elapsed / 0.15, (foutEnd - elapsed) / 0.4)));
                for (const boneName in clip.bones) {
                    if (LOWER_BODY.has(boneName)) continue;
                    const bone = rig.vrm.humanoid.getNormalizedBoneNode(boneName);
                    if (!bone) continue;
                    const q = clip.bones[boneName][f];
                    // Clips are stored in the VRM 1.0 local frame; VRM 0 local frames are mirrored in X/Z.
                    _rot.set(rig.isVrm0 ? -q[0] : q[0], q[1], rig.isVrm0 ? -q[2] : q[2], q[3]);
                    bone.quaternion.slerp(_rot, w);
                }
            }
        }

        // ── AUTO-LOOKAT: cabeza + ojos siguen el CURSOR ─────────────────
        let px, py;
        if (IS_OVERLAY) {
            face.oGaze.lerp(overlayGaze, Math.min(1, 8 * delta));
            px = face.oGaze.x; py = face.oGaze.y;
        } else {
            px = state.pointer.x; py = state.pointer.y;
        }
        if (autoLookat && rig.head && rig.restQuat['15']) {
            const yaw = px * LOOK.headYaw * LOOK.yawSign;
            const pitch = py * LOOK.headPitch * rig.flip;
            _euler.set(pitch, yaw, 0);
            _look.setFromEuler(_euler);
            _rot.copy(rig.restQuat['15']).multiply(_look);
            const gName = gesture.current?.clip?.name;
            const w = (gName === 'nod' || gName === 'shake_no') ? LOOK.headWeight * 0.3 : LOOK.headWeight;
            rig.head.quaternion.slerp(_rot, w);
            face.gazeAnchor.set(
                THREE.MathUtils.clamp(px * LOOK.eyeYaw * LOOK.yawSign, -LOOK.eyeYaw, LOOK.eyeYaw),
                THREE.MathUtils.clamp(py * LOOK.eyePitch, -LOOK.eyePitch, LOOK.eyePitch),
            );
        } else {
            face.gazeAnchor.set(0, 0);
        }

        // ── CARA: emoción (expresiones VRM + extras VRoid si existen) ────
        const target = rig.face.emotion[emotion] || {};
        for (const key of rig.face.allEmotion) lerpExpr(key, target[key] ?? 0, aSlow);
        const extras = VROID_EXTRAS[emotion] || {};
        for (const key of ALL_EXTRA_MORPHS) lerpMorph(key, extras[key] ?? 0, aSlow);

        // ── CARA: lipsync ───────────────────────────────────────────────
        const active = currentVisemes?.[0];
        const activeExpr = active && active.viseme !== 'sil' ? rig.face.viseme[active.viseme] : null;
        for (const key of rig.face.allViseme) {
            const want = key === activeExpr ? Math.min(1, (active.weight ?? 1) * 0.9) : 0;
            lerpExpr(key, want, aFast);
        }

        // ── Parpadeo ────────────────────────────────────────────────────
        face.blinkNext -= delta;
        if (face.blinkT < 0 && face.blinkNext <= 0) { face.blinkT = 0.12; face.blinkNext = 2.5 + Math.random() * 3.5; }
        if (face.blinkT >= 0) { face.blinkT -= delta; setExpr(rig.face.blink, Math.max(0, 1 - Math.abs(face.blinkT / 0.12 - 0.5) * 2)); }
        else setExpr(rig.face.blink, 0);

        // ── Mirada: objetivo del look-at VRM = ancla (cursor) + micro-saccade ──
        face.saccadeNext -= delta;
        if (face.saccadeNext <= 0) {
            face.saccade.set((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04);
            face.saccadeNext = 1.2 + Math.random() * 2.5;
        }
        if (rig.head) {
            rig.head.getWorldPosition(_v);
            if (group.current) group.current.worldToLocal(_v);
            // 1.5 m in front of the head (the camera side, +Z), offset by the gaze in metres.
            rig.lookTarget.position.set(
                _v.x + (face.gazeAnchor.x + face.saccade.x) * 3,
                _v.y + (face.gazeAnchor.y + face.saccade.y) * 3,
                _v.z + 1.5,
            );
        }

        // ── Vida en reposo ──────────────────────────────────────────────
        if (rig.chest) rig.chest.position.y = (rig.chest.userData._baseY ??= rig.chest.position.y) + Math.sin(t * 1.6) * 0.008;
        if (group.current) group.current.position.y = rig.baseY + Math.sin(t * 0.8) * 0.004;

        // ── VRM: normalized -> raw bones, expressions, look-at, spring bones ──
        rig.vrm.update(delta);
    });

    if (!rig) return null;
    return (
        <group ref={group} position={[0, rig.baseY, 0]}>
            <primitive object={rig.vrm.scene} />
        </group>
    );
}

useGLTF.preload('/avatar.glb', undefined, undefined, extendLoader);
