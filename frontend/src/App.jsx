// src/App.jsx
import { useRef, useState, useCallback } from 'react';
import { Scene } from './components/Scene.jsx';
import { HUD } from './components/HUD.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useVision } from './hooks/useVision.js';
import { useHannahStore } from './store/hannahStore.js';

// ── Fondo: gradiente oscuro con sutil vignette ──────────────────────────────
const BG = () => (
    <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        background: `
            radial-gradient(ellipse 80% 60% at 50% 40%, #0d1b2a 0%, #060810 60%, #000 100%)
        `,
    }} />
);

// Fallback mientras carga el avatar
const AvatarLoadingHint = () => {
    const connected = useHannahStore(s => s.connected);
    const avatarLoaded = useHannahStore(s => s.avatarLoaded);
    if (avatarLoaded) return null;
    return (
        <div style={{
            position: 'fixed', top: '50%', left: '50%',
            transform: 'translate(-50%, -50%)',
            fontFamily: "'DM Mono', monospace",
            fontSize: '11px',
            color: 'rgba(255,255,255,0.2)',
            letterSpacing: '0.15em',
            pointerEvents: 'none',
            zIndex: 5,
        }}>
            {connected ? 'cargando avatar...' : 'conectando...'}
        </div>
    );
};

export default function App() {
    const { sendCommand, sendAudio, sendText } = useWebSocket();
    const { videoRef, startVision, stopVision } = useVision(sendCommand);
    const { visionActive, connected } = useHannahStore();

    const [isRecording, setIsRecording] = useState(false);

    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    // ── Grabación de voz ────────────────────────────────────────────────────
    const handleRecord = useCallback(async (start) => {
        if (start) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                audioChunksRef.current = [];
                sendCommand({ command: 'SPEECH_START' });
                recorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunksRef.current.push(e.data);
                };
                recorder.start(100);
                mediaRecorderRef.current = recorder;
                setIsRecording(true);
            } catch (e) {
                console.error('Mic error:', e);
            }
        } else {
            const recorder = mediaRecorderRef.current;
            if (!recorder) return;
            recorder.stop();
            recorder.onstop = async () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                const buffer = await blob.arrayBuffer();
                sendAudio(buffer);
                sendCommand({ command: 'SPEECH_END' });
                recorder.stream.getTracks().forEach(t => t.stop());
            };
            setIsRecording(false);
        }
    }, [sendCommand, sendAudio]);

    // ── Toggle visión ───────────────────────────────────────────────────────
    const handleToggleVision = useCallback(() => {
        if (visionActive) stopVision();
        else startVision();
    }, [visionActive, startVision, stopVision]);

    // Avatar URL — pon tu .glb aquí en /public/avatar.glb
    const avatarUrl = '/avatar.glb';

    return (
        <>
            <BG />

            {/* Cámara oculta para YOLO */}
            <video
                ref={videoRef}
                style={{ display: 'none' }}
                autoPlay
                muted
                playsInline
            />

            {/* Canvas 3D */}
            <div style={{ position: 'fixed', inset: 0, zIndex: 1 }}>
                <Scene avatarUrl={avatarUrl} />
            </div>

            <AvatarLoadingHint />

            {/* HUD */}
            <HUD
                onSendText={sendText}
                onToggleVision={handleToggleVision}
                onToggleRecord={handleRecord}
                isRecording={isRecording}
            />
        </>
    );
}
