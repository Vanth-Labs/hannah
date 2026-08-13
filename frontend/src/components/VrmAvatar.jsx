// src/components/VrmAvatar.jsx
// Avatar anime VRoid/VRM: cara viva (emoción, lipsync, parpadeo, mirada,
// respiración) + retargeting del cuerpo desde el movimiento SMPL-X del modelo.
import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useHannahStore } from '../store/hannahStore.js';
import {
    EMOTION_TO_FCL, ALL_EMOTION_FCL, VISEME_TO_FCL, ALL_VISEME_FCL, BLINK_FCL,
} from '../retarget/retargetFace.js';
import { SMPLX_TO_VROID } from '../retarget/boneMap.js';
import OFFSETS from '../retarget/retargetOffsets.json';

const FLOOR_Y = -1.6;

const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _rot = new THREE.Quaternion();
// Temporales para auto-lookat (cabeza/ojos siguen el cursor).
const _look = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

// Auto-lookat: límites y pesos (radianes). Ajustables si mira raro.
// yawSign/pitchSign corrigen el eje "adelante" del hueso de cabeza si sale invertido.
const LOOK = {
    headYaw: 0.44, headPitch: 0.26,   // clamp cabeza (~25° / ~15°)
    headWeight: 0.5,                  // mezcla sobre el co-speech (no lo mata)
    eyeYaw: 0.22, eyePitch: 0.13,     // clamp ojos
    yawSign: 1, pitchSign: 1,
};

// ── Idle procedural: micro-movimientos cuando NO habla (vida en reposo) ──
// Respiración (pecho/columna) + balanceo lateral (peso de un pie a otro) +
// deriva sutil de brazos, desfasados para que se vea orgánico. Radianes chicos.
const TAU = Math.PI * 2;
const IDLE = {
    breath: 0.045, breathHz: 0.22,   // respiración (~1 cada 4.5 s)
    sway: 0.03, swayHz: 0.12,        // balanceo (~1 cada 8 s)
    armSway: 0.025,
};
const _idleE = new THREE.Euler();
const _idleQ = new THREE.Quaternion();
// Offset de idle por hueso (o null). Se multiplica sobre el reposo.
function idleOffset(idx, t) {
    const b = Math.sin(t * IDLE.breathHz * TAU);   // respiración
    const s = Math.sin(t * IDLE.swayHz * TAU);     // balanceo
    let x = 0, z = 0;
    switch (idx) {
        case '0':  z = s * IDLE.sway * 0.5; break;                         // pelvis: balanceo lateral
        case '3':  x = b * IDLE.breath * 0.4; z = s * IDLE.sway; break;    // columna baja
        case '6':  x = b * IDLE.breath * 0.7; z = s * IDLE.sway * 0.6; break; // pecho (respira más)
        case '9':  x = b * IDLE.breath; break;                             // pecho alto
        case '12': x = -b * IDLE.breath * 0.3; break;                      // cuello contrarresta
        case '16': z = s * IDLE.armSway; break;                            // brazo L sigue el torso
        case '17': z = s * IDLE.armSway; break;                            // brazo R
        default: return null;
    }
    _idleE.set(x, 0, z);
    return _idleQ.setFromEuler(_idleE);
}

// La pelvis se mantiene VERTICAL: nos quedamos solo con el giro alrededor del
// eje Y (encaramiento a cámara) y descartamos la inclinación adelante/atrás.
// El offset de pelvis traía un pitch de ~28° que ladeaba todo el cuerpo.
function keepYawOnly(q) {
    q.set(0, q.y, 0, q.w);
    const n = Math.hypot(q.y, q.w);
    if (n < 1e-6) q.set(0, 0, 0, 1); else { q.y /= n; q.w /= n; }
    return q;
}

// Offsets de retargeting precalculados (frame SMPL-X -> frame VRoid).
// vroid_local[j] = A_parent^-1 · quat(aa[j]) · A_self
const A_SELF = {};       // idx -> Quaternion
const A_PARENT_INV = {}; // idx -> Quaternion (inverso del offset del padre mapeado)
for (const [idx, o] of Object.entries(OFFSETS)) {
    A_SELF[idx] = new THREE.Quaternion(o.A[0], o.A[1], o.A[2], o.A[3]);
}
for (const [idx, o] of Object.entries(OFFSETS)) {
    const p = o.parent;
    A_PARENT_INV[idx] = (p != null && A_SELF[p])
        ? A_SELF[p].clone().invert()
        : new THREE.Quaternion();
}

// La pelvis se renderiza SOLO con yaw (vertical). Para que los hijos directos
// (columna, caderas) no compensen el pitch que ya no está y se inclinen hacia
// adelante, sus A_PARENT_INV deben usar el mismo yaw-only de la pelvis.
function _yawOnly(q) {
    const r = new THREE.Quaternion(0, q.y, 0, q.w);
    const n = Math.hypot(q.y, q.w);
    return n < 1e-6 ? new THREE.Quaternion() : r.set(0, q.y / n, 0, q.w / n);
}
const A0_YAW_INV = _yawOnly(A_SELF['0']).invert();
for (const [idx, o] of Object.entries(OFFSETS)) {
    if (o.parent === 0) A_PARENT_INV[idx] = A0_YAW_INV.clone();
}

// Columna (spine1/2/3): el movimiento generado la encorva hacia adelante
// (parece jorobada). Se amortigua hacia el reposo — piernas y brazos siguen
// libres, así que no queda tiesa, solo menos encorvada.
const SPINE = new Set(['3', '6', '9']);
const SPINE_KEEP = 0.5;   // fracción del movimiento de columna que se conserva

// Pies (tobillos + puntas): el movimiento gira las suelas hacia afuera. Una
// avatar de pie los tiene plantados; se fijan al reposo (piernas siguen libres).
const FEET = new Set(['7', '8', '10', '11']);

// Dedos (SMPL-X 25-54): el modelo generativo es débil en los dedos (alta
// dimensión, poca varianza) y salen crispados/feos. Se fijan a la pose de reposo
// natural del VRoid — manos quietas y relajadas en vez de dedos temblorosos.
const FINGERS = new Set(Array.from({ length: 30 }, (_, i) => String(25 + i)));

// El torso VRoid es más ancho que el SMPL-X: los brazos se meten en el cuerpo.
// Empuje de abducción en los hombros (upperarm) para separarlos un poco.
// Ejes locales de VRoid: brazo apunta ±X; girar sobre Z separa del torso.
const ABDUCT = 0.22; // radianes; súbelo si aún clipa, bájalo si se abre de más
const ABDUCT_L = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -ABDUCT);
const ABDUCT_R = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ABDUCT);

// Gestos deliberados (Mixamo horneado a huesos VRoid). Se reproducen sobre el
// tren superior por encima del co-speech; NO tocan cadera ni piernas para no
// alterar el encaramiento ni la postura (eso evitó el "giro" de los clips SMPL-X).
const GESTURE_NAMES = ['wave', 'point', 'nod', 'shake_no', 'happy', 'dismiss', 'acknowledge'];
const gestureBoneAllowed = (name) =>
    !/Hips|UpperLeg|LowerLeg|_Leg|Foot|Toe/.test(name);

function collectMorphs(scene) {
    const map = {};
    scene.traverse((child) => {
        if (child.isMesh && child.morphTargetDictionary) {
            child.frustumCulled = false;
            for (const [name, idx] of Object.entries(child.morphTargetDictionary)) {
                (map[name] ||= []).push({ mesh: child, idx });
            }
        }
    });
    return map;
}


export function VrmAvatar({ url = '/avatar.glb' }) {
    const group = useRef();
    const { scene } = useGLTF(url);

    const rig = useMemo(() => {
        const morphs = collectMorphs(scene);
        const byName = {};
        scene.traverse((c) => { byName[c.name] = c; });

        // Idle: pelvis vertical y de cara (solo yaw del offset, sin su pitch/ladeo).
        if (byName['J_Bip_C_Hips']) keepYawOnly(byName['J_Bip_C_Hips'].quaternion.copy(A_SELF['0']));
        // Pose de reposo natural (brazos abajo): base cuando NO hay movimiento.
        // Durante el habla el retarget la sobreescribe; al terminar vuelve aquí.
        const arm = (n, z) => { if (byName[n]) byName[n].rotation.z = z; };
        arm('J_Bip_L_UpperArm', 1.2); arm('J_Bip_R_UpperArm', -1.2);
        arm('J_Bip_L_LowerArm', 0.25); arm('J_Bip_R_LowerArm', -0.25);

        // Huesos del cuerpo mapeados + su quaternion de reposo (para volver a él).
        const bodyBones = {};
        const restQuat = {};
        for (const [idx, boneName] of Object.entries(SMPLX_TO_VROID)) {
            const bone = byName[boneName];
            if (bone) {
                bodyBones[idx] = bone;
                restQuat[idx] = bone.quaternion.clone();
            }
        }

        const bbox = new THREE.Box3().setFromObject(scene);
        return {
            morphs, bodyBones, restQuat, byName,
            leftEye: byName['J_Adj_L_FaceEye'] || null,
            rightEye: byName['J_Adj_R_FaceEye'] || null,
            head: byName['J_Bip_C_Head'] || null,
            chest: byName['J_Bip_C_UpperChest'] || byName['J_Bip_C_Chest'] || null,
            baseY: FLOOR_Y - bbox.min.y,
            eyeRestL: byName['J_Adj_L_FaceEye']?.quaternion.clone(),
            eyeRestR: byName['J_Adj_R_FaceEye']?.quaternion.clone(),
        };
    }, [scene]);

    const face = useRef({
        current: {}, blinkNext: 2 + Math.random() * 3, blinkT: -1,
        saccadeNext: 1 + Math.random() * 2,
        gaze: new THREE.Vector2(0, 0), gazeTarget: new THREE.Vector2(0, 0),
        saccade: new THREE.Vector2(0, 0), gazeAnchor: new THREE.Vector2(0, 0),
    }).current;

    // Clips de gesto (Mixamo horneado). Se cargan una vez.
    const clips = useRef({});
    const gesture = useRef(null);   // { clip, startedAt }
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
        if (group.current) group.current.position.y = rig.baseY;
        useHannahStore.getState().setAvatarLoaded(true);
    }, [rig]);

    const setMorph = (name, value) => {
        const targets = rig.morphs[name];
        if (!targets) return;
        for (const { mesh, idx } of targets) {
            if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[idx] = value;
        }
    };
    const lerpMorph = (name, target, a) => {
        const cur = face.current[name] ?? 0;
        const next = cur + (target - cur) * a;
        face.current[name] = next;
        setMorph(name, next);
    };

    useFrame((state, delta) => {
        const { emotion, currentVisemes, isSpeaking, currentMotion, gestureTrigger, autoLookat } = useHannahStore.getState();
        const t = state.clock.getElapsedTime();
        const aFast = Math.min(1, 14 * delta);
        const aSlow = Math.min(1, 3 * delta);
        const aBody = Math.min(1, 16 * delta);

        // ── CUERPO: retargeting SMPL-X -> VRoid ─────────────────────────
        let frame = -1;
        if (currentMotion?.poses) {
            const elapsed = (performance.now() - currentMotion.startedAt) / 1000;
            const f = Math.floor(elapsed * currentMotion.fps);
            if (f >= 0 && f < currentMotion.numFrames) frame = f;
        }
        for (const [idx, bone] of Object.entries(rig.bodyBones)) {
            // Pies plantados: fijar tobillos/puntas al reposo (no giran las suelas).
            if (FEET.has(idx)) {
                bone.quaternion.slerp(rig.restQuat[idx], Math.min(1, 8 * delta));
                continue;
            }
            // Dedos quietos: manos relajadas en reposo (la generación de dedos es fea).
            if (FINGERS.has(idx)) {
                bone.quaternion.slerp(rig.restQuat[idx], Math.min(1, 10 * delta));
                continue;
            }
            if (frame >= 0) {
                const base = frame * 165 + idx * 3;
                const x = currentMotion.poses[base];
                const y = currentMotion.poses[base + 1];
                const z = currentMotion.poses[base + 2];
                const ang = Math.sqrt(x * x + y * y + z * z);
                if (ang < 1e-7 || Number.isNaN(ang)) _rot.identity();
                else { _axis.set(x / ang, y / ang, z / ang); _rot.setFromAxisAngle(_axis, ang); }
                // vroid_local = A_parent^-1 · quat(aa) · A_self (encaramiento horneado).
                _quat.copy(A_PARENT_INV[idx]).multiply(_rot).multiply(A_SELF[idx]);
                // Pelvis vertical: solo yaw (sin el pitch que ladeaba el cuerpo).
                if (idx === '0') keepYawOnly(_quat);
                // Columna: amortiguar hacia el reposo para no parecer jorobada.
                else if (SPINE.has(idx)) _quat.copy(rig.restQuat[idx]).slerp(_quat, SPINE_KEEP);
                // Hombros: separar el brazo del torso (más ancho en VRoid).
                else if (idx === '16') _quat.multiply(ABDUCT_L);
                else if (idx === '17') _quat.multiply(ABDUCT_R);
                bone.quaternion.slerp(_quat, aBody);
            } else {
                // Idle: reposo + micro-movimiento procedural (respiración/balanceo).
                const off = idleOffset(idx, t);
                const tq = off ? _quat.copy(rig.restQuat[idx]).multiply(off) : rig.restQuat[idx];
                bone.quaternion.slerp(tq, Math.min(1, 4 * delta));
            }
        }

        // ── GESTO deliberado (Mixamo) por encima del co-speech ──────────
        if (gestureTrigger && gestureTrigger.startedAt !== gesture.current?.startedAt) {
            const clip = clips.current[gestureTrigger.name];
            if (clip) gesture.current = { clip, startedAt: gestureTrigger.startedAt };
        }
        if (gesture.current) {
            const { clip, startedAt } = gesture.current;
            const elapsed = (performance.now() - startedAt) / 1000;
            const foutEnd = clip.duration + 0.3;   // cola para fundir de vuelta al co-speech
            if (elapsed >= foutEnd) {
                gesture.current = null;
            } else {
                const frame = Math.min(clip.frames - 1, Math.max(0, Math.floor(elapsed * clip.fps)));
                // peso: entra en 0.15s, sale sobre el final hacia la cola
                const w = Math.max(0, Math.min(1, Math.min(
                    elapsed / 0.15,
                    (foutEnd - elapsed) / 0.4,
                )));
                for (const boneName in clip.bones) {
                    if (!gestureBoneAllowed(boneName)) continue;
                    const bone = rig.byName[boneName];
                    if (!bone) continue;
                    const q = clip.bones[boneName][frame];
                    _rot.set(q[0], q[1], q[2], q[3]);
                    bone.quaternion.slerp(_rot, w);   // mezcla sobre lo que puso el co-speech
                }
            }
        }

        // ── AUTO-LOOKAT: cabeza + ojos siguen el CURSOR ─────────────────
        // Se aplica DESPUÉS de cuerpo/gesto (mezcla parcial, no los mata).
        // state.pointer es la posición del mouse en NDC: x,y ∈ [-1,1]
        // (x: izq→der, y: abajo→arriba). yawSign/pitchSign corrigen el sentido.
        if (autoLookat && rig.head && rig.restQuat['15']) {
            const yaw = state.pointer.x * LOOK.headYaw * LOOK.yawSign;
            const pitch = state.pointer.y * LOOK.headPitch * LOOK.pitchSign;
            _euler.set(pitch, yaw, 0);
            _look.setFromEuler(_euler);
            _rot.copy(rig.restQuat['15']).multiply(_look);   // rest · look
            // Bajar el peso si un gesto mueve la cabeza (nod/shake) para no pelear.
            const gName = gesture.current?.clip?.name;
            const w = (gName === 'nod' || gName === 'shake_no') ? LOOK.headWeight * 0.3 : LOOK.headWeight;
            rig.head.quaternion.slerp(_rot, w);
            // Ancla de ojos: fracción del mismo yaw/pitch (los ojos afinan).
            face.gazeAnchor.set(
                THREE.MathUtils.clamp(state.pointer.x * LOOK.eyeYaw * LOOK.yawSign, -LOOK.eyeYaw, LOOK.eyeYaw),
                THREE.MathUtils.clamp(state.pointer.y * LOOK.eyePitch * LOOK.pitchSign, -LOOK.eyePitch, LOOK.eyePitch),
            );
        } else {
            face.gazeAnchor.set(0, 0);
        }

        // ── CARA: emoción ───────────────────────────────────────────────
        const target = EMOTION_TO_FCL[emotion] || {};
        for (const key of ALL_EMOTION_FCL) lerpMorph(key, target[key] ?? 0, aSlow);

        // ── CARA: lipsync ───────────────────────────────────────────────
        const active = currentVisemes?.[0];
        const activeFcl = active && active.viseme !== 'sil' ? VISEME_TO_FCL[active.viseme] : null;
        for (const key of ALL_VISEME_FCL) {
            const want = key === activeFcl ? Math.min(1, (active.weight ?? 1) * 0.9) : 0;
            lerpMorph(key, want, aFast);
        }

        // ── Parpadeo ────────────────────────────────────────────────────
        face.blinkNext -= delta;
        if (face.blinkT < 0 && face.blinkNext <= 0) { face.blinkT = 0.12; face.blinkNext = 2.5 + Math.random() * 3.5; }
        if (face.blinkT >= 0) { face.blinkT -= delta; setMorph(BLINK_FCL, Math.max(0, 1 - Math.abs(face.blinkT / 0.12 - 0.5) * 2)); }
        else setMorph(BLINK_FCL, 0);

        // ── Mirada ──────────────────────────────────────────────────────
        // gazeTarget = ancla (cámara, si autoLookat) + micro-saccade aleatorio.
        face.saccadeNext -= delta;
        if (face.saccadeNext <= 0) {
            face.saccade.set((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04);
            face.saccadeNext = 1.2 + Math.random() * 2.5;
        }
        face.gazeTarget.set(face.gazeAnchor.x + face.saccade.x, face.gazeAnchor.y + face.saccade.y);
        face.gaze.lerp(face.gazeTarget, aSlow);
        if (rig.leftEye && rig.eyeRestL) {
            _quat.setFromEuler(new THREE.Euler(face.gaze.y, face.gaze.x, 0));
            rig.leftEye.quaternion.copy(rig.eyeRestL).multiply(_quat);
            if (rig.rightEye && rig.eyeRestR) rig.rightEye.quaternion.copy(rig.eyeRestR).multiply(_quat);
        }

        // ── Vida en reposo ──────────────────────────────────────────────
        if (rig.chest) rig.chest.position.y = (rig.chest.userData._baseY ??= rig.chest.position.y) + Math.sin(t * 1.6) * 0.008;
        if (group.current) group.current.position.y = rig.baseY + Math.sin(t * 0.8) * 0.004;
    });

    // El encaramiento a cámara se hace en la raíz (pelvis), no aquí — así el
    // movimiento no se voltea 180° (los gestos iban hacia atrás con un PI de grupo).
    return (
        <group ref={group} position={[0, rig.baseY, 0]}>
            <primitive object={scene} />
        </group>
    );
}

useGLTF.preload('/avatar.glb');
