// src/components/SmplxAvatar.jsx
// Avatar SMPL-X nativo animado por EMAGE (PantoMatrix).
// El GLB (generado por sidecar/motion/build_avatar.py) tiene los 55 huesos con
// los nombres canónicos SMPL-X y rotación de reposo IDENTIDAD, así que el
// axis-angle de EMAGE se aplica directo al quaternion de cada hueso — sin
// retargeting ni correcciones de rest pose.
import { useRef, useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { useHannahStore } from '../store/hannahStore.js';

export const SMPLX_JOINT_NAMES = [
    'pelvis', 'left_hip', 'right_hip', 'spine1', 'left_knee', 'right_knee',
    'spine2', 'left_ankle', 'right_ankle', 'spine3', 'left_foot', 'right_foot',
    'neck', 'left_collar', 'right_collar', 'head', 'left_shoulder',
    'right_shoulder', 'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist',
    'jaw', 'left_eye_smplhf', 'right_eye_smplhf',
    'left_index1', 'left_index2', 'left_index3', 'left_middle1', 'left_middle2',
    'left_middle3', 'left_pinky1', 'left_pinky2', 'left_pinky3', 'left_ring1',
    'left_ring2', 'left_ring3', 'left_thumb1', 'left_thumb2', 'left_thumb3',
    'right_index1', 'right_index2', 'right_index3', 'right_middle1',
    'right_middle2', 'right_middle3', 'right_pinky1', 'right_pinky2',
    'right_pinky3', 'right_ring1', 'right_ring2', 'right_ring3',
    'right_thumb1', 'right_thumb2', 'right_thumb3',
];

const FLOOR_Y = -1.6; // mismo plano que ContactShadows en Scene.jsx

const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _identity = new THREE.Quaternion();

export function SmplxAvatar({ url = '/smplx_avatar.glb' }) {
    const group = useRef();
    const { scene } = useGLTF(url);

    // Mapa índice de joint SMPL-X -> hueso del GLB + offset de reposo de la pelvis
    const { bones, pelvisRest, baseY } = useMemo(() => {
        const byName = {};
        scene.traverse((child) => {
            byName[child.name] = child;
            if (child.isSkinnedMesh) child.frustumCulled = false;
        });
        const bones = SMPLX_JOINT_NAMES.map((name) => byName[name] || null);

        const bbox = new THREE.Box3().setFromObject(scene);
        return {
            bones,
            pelvisRest: bones[0] ? bones[0].position.clone() : new THREE.Vector3(),
            baseY: FLOOR_Y - bbox.min.y, // apoyar los pies en el suelo de la escena
        };
    }, [scene]);

    useEffect(() => {
        if (group.current) group.current.position.y = baseY;
        useHannahStore.getState().setAvatarLoaded(true);
    }, [baseY]);

    useFrame((state, delta) => {
        const { currentMotion } = useHannahStore.getState();
        const alpha = Math.min(1, 20 * delta); // suavizado entre frames de 30fps

        let frame = -1;
        if (currentMotion?.poses) {
            const elapsed = (performance.now() - currentMotion.startedAt) / 1000;
            const f = Math.floor(elapsed * currentMotion.fps);
            if (f >= 0 && f < currentMotion.numFrames) frame = f;
        }

        if (frame >= 0) {
            const { poses, trans } = currentMotion;
            const base = frame * 165;
            for (let j = 0; j < 55; j++) {
                const bone = bones[j];
                if (!bone) continue;
                const x = poses[base + j * 3];
                const y = poses[base + j * 3 + 1];
                const z = poses[base + j * 3 + 2];
                const angle = Math.sqrt(x * x + y * y + z * z);
                if (angle < 1e-7 || Number.isNaN(angle)) {
                    _quat.identity();
                } else {
                    _axis.set(x / angle, y / angle, z / angle);
                    _quat.setFromAxisAngle(_axis, angle);
                }
                bone.quaternion.slerp(_quat, alpha);
            }
            // Traslación global anclada al primer frame para que no se desplace
            const t = frame * 3;
            if (trans && bones[0]) {
                bones[0].position.set(
                    pelvisRest.x + (trans[t] - trans[0]),
                    pelvisRest.y + (trans[t + 1] - trans[1]),
                    pelvisRest.z + (trans[t + 2] - trans[2]),
                );
            }
        } else {
            // Sin movimiento activo: volver suavemente a la pose de reposo
            const restAlpha = Math.min(1, 3 * delta);
            for (let j = 0; j < 55; j++) {
                const bone = bones[j];
                if (!bone) continue;
                bone.quaternion.slerp(_identity, restAlpha);
            }
            if (bones[0]) bones[0].position.lerp(pelvisRest, restAlpha);
        }

        // Respiración sutil, igual que el avatar RPM
        if (group.current) {
            const t = state.clock.getElapsedTime();
            group.current.position.y = baseY + Math.sin(t * 0.8) * 0.005;
        }
    });

    return (
        <group ref={group} position={[0, baseY, 0]}>
            <primitive object={scene} />
        </group>
    );
}

useGLTF.preload('/smplx_avatar.glb');
