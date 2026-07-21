// src/components/Scene.jsx
import { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { Environment, ContactShadows, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { Avatar } from './Avatar.jsx';
import { SmplxAvatar } from './SmplxAvatar.jsx';
import { VrmAvatar } from './VrmAvatar.jsx';
import { useHannahStore } from '../store/hannahStore.js';

function Lights() {
    return (
        <>
            {/* Luz de relleno fría desde atrás */}
            <directionalLight
                position={[-3, 4, -3]}
                intensity={0.4}
                color="#7ab8e8"
            />
            {/* Key light cálida frontal */}
            <directionalLight
                position={[2, 5, 4]}
                intensity={1.2}
                color="#fff5e6"
                castShadow
                shadow-mapSize={[2048, 2048]}
            />
            {/* Rim light lateral */}
            <pointLight
                position={[-3, 2, 1]}
                intensity={0.6}
                color="#b8d4ff"
            />
            <ambientLight intensity={0.2} color="#1a1a2e" />
        </>
    );
}

function Floor() {
    return (
        <ContactShadows
            position={[0, -1.6, 0]}
            opacity={0.4}
            scale={6}
            blur={2.5}
            far={4}
            color="#000011"
        />
    );
}

export function Scene({ avatarUrl }) {
    const avatarMode = useHannahStore(s => s.avatarMode);
    return (
        <Canvas
            camera={{ position: [0, 0.3, 2.2], fov: 38, near: 0.1, far: 100 }}
            gl={{
                antialias: true,
                toneMapping: THREE.ACESFilmicToneMapping,
                toneMappingExposure: 1.1,
                outputColorSpace: THREE.SRGBColorSpace,
            }}
            shadows
            style={{ background: 'transparent' }}
        >
            <Lights />
            <Floor />

            {/* Ejes de referencia: rejilla del suelo + eje vertical (debug de postura) */}
            <gridHelper args={[6, 24, '#3a4a63', '#1c2637']} position={[0, -1.6, 0]} />
            <axesHelper args={[1.2]} position={[0, -1.6, 0]} />

            <Suspense fallback={null}>
                {avatarMode === 'vrm' && <VrmAvatar url="/avatar.glb" />}
                {avatarMode === 'smplx' && <SmplxAvatar url="/smplx_avatar.glb" />}
                {avatarMode === 'rpm' && avatarUrl && <Avatar url={avatarUrl} />}
                <Environment preset="city" background={false} />
            </Suspense>

            {/* Permitir rotar la cámara para desarrollo — quitar en prod */}
            <OrbitControls
                target={[0, 0.1, 0]}
                minDistance={1}
                maxDistance={5}
                enablePan={false}
                minPolarAngle={Math.PI / 6}
                maxPolarAngle={Math.PI / 1.8}
            />
        </Canvas>
    );
}
