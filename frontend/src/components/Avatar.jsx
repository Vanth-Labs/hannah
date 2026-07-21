// src/components/Avatar.jsx
import { useRef, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import * as THREE from 'three';
import { useHannahStore } from '../store/hannahStore.js';
import { VISEME_MAP } from '../hooks/useWebSocket.js';

// Mapeo de emociones a morph targets de expresión facial
const EMOTION_MORPHS = {
    neutral:  {},
    happy:    { mouthSmile: 0.6, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
    curious:  { browInnerUp: 0.5, eyeWideLeft: 0.3, eyeWideRight: 0.3 },
    alert:    { eyeWideLeft: 0.7, eyeWideRight: 0.7, browOuterUpLeft: 0.4, browOuterUpRight: 0.4 },
    thinking: { browInnerUp: 0.3, eyeLookUpLeft: 0.2, eyeLookUpRight: 0.2 },
    sad:      { mouthFrownLeft: 0.4, mouthFrownRight: 0.4, browInnerUp: 0.6 },
};

// Lerp suave para morph targets
function lerpMorph(mesh, name, target, alpha) {
    if (!mesh?.morphTargetDictionary || !(name in mesh.morphTargetDictionary)) return;
    const idx = mesh.morphTargetDictionary[name];
    if (mesh.morphTargetInfluences) {
        mesh.morphTargetInfluences[idx] = THREE.MathUtils.lerp(
            mesh.morphTargetInfluences[idx],
            target,
            alpha
        );
    }
}

export function Avatar({ url = '/avatar.glb' }) {
    const group = useRef();
    const { scene, animations } = useGLTF(url);
    const { actions } = useAnimations(animations, group);

    const headMesh = useRef(null);   // mesh con morph targets de cara
    const teethMesh = useRef(null);  // mesh de dientes si existe

    // Encontrar los meshes con morph targets al montar
    useEffect(() => {
        scene.traverse((child) => {
            if (child.isMesh && child.morphTargetDictionary) {
                const keys = Object.keys(child.morphTargetDictionary);
                // El mesh de la cara suele tener los visemas
                if (keys.some(k => k.startsWith('viseme_') || k.includes('mouth'))) {
                    if (!headMesh.current) headMesh.current = child;
                }
                if (child.name.toLowerCase().includes('teeth')) {
                    teethMesh.current = child;
                }
            }
        });

        // Activar idle animation si existe
        const idle = actions['Idle'] || actions['idle'] || actions[Object.keys(actions)[0]];
        if (idle) {
            idle.reset().fadeIn(0.5).play();
        }
        useHannahStore.getState().setAvatarLoaded(true);
    }, [scene, actions]);

    useFrame((state, delta) => {
        const { currentVisemes, emotion, isSpeaking } = useHannahStore.getState();
        const mesh = headMesh.current;
        if (!mesh) return;

        // ── Leer visema actual ─────────────────────────────────────────────
        const activeViseme = currentVisemes[0];

        // Todas las keys de visemas a 0 (decay)
        Object.values(VISEME_MAP).forEach((morphName) => {
            lerpMorph(mesh, morphName, 0, 8 * delta);
            if (teethMesh.current) lerpMorph(teethMesh.current, morphName, 0, 8 * delta);
        });

        // Activar el visema actual
        if (activeViseme && activeViseme.viseme !== 'sil') {
            const morphName = VISEME_MAP[activeViseme.viseme] || activeViseme.viseme;
            const weight = activeViseme.weight ?? 1.0;
            lerpMorph(mesh, morphName, weight, 12 * delta);
            if (teethMesh.current) lerpMorph(teethMesh.current, morphName, weight * 0.6, 12 * delta);
        }

        // ── Blendshapes de emoción ─────────────────────────────────────────
        const emotionMorphs = EMOTION_MORPHS[emotion] || {};
        const allEmotionKeys = new Set(
            Object.values(EMOTION_MORPHS).flatMap(m => Object.keys(m))
        );
        allEmotionKeys.forEach((key) => {
            const target = emotionMorphs[key] ?? 0;
            lerpMorph(mesh, key, target, 2 * delta);
        });

        // ── Parpadeo procedural ────────────────────────────────────────────
        const t = state.clock.getElapsedTime();
        const blinkCycle = Math.sin(t * 0.4) > 0.95 ? 1 : 0;
        lerpMorph(mesh, 'eyeBlinkLeft',  blinkCycle, 15 * delta);
        lerpMorph(mesh, 'eyeBlinkRight', blinkCycle, 15 * delta);

        // ── Breathing: sutil movimiento en Y del torso ─────────────────────
        if (group.current) {
            group.current.position.y = Math.sin(t * 0.8) * 0.005;
        }
    });

    return (
        <group ref={group} position={[0, -1.6, 0]} scale={1}>
            <primitive object={scene} />
        </group>
    );
}
