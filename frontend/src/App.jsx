// src/App.jsx
import { useRef, useState, useCallback, useEffect } from 'react';
import { Scene } from './components/Scene.jsx';
import { HUD, isOverlay } from './components/HUD.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useVision } from './hooks/useVision.js';
import { useVoiceActivity } from './hooks/useVoiceActivity.js';
import { useHannahStore } from './store/hannahStore.js';

// ¿Corriendo dentro de la app de escritorio (Tauri)? -> overlay transparente.
const isTauri = typeof window !== 'undefined'
    && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__);

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
    const { sendCommand, sendAudio, sendText, stopPlayback } = useWebSocket();
    const { videoRef, startVision, stopVision } = useVision(sendCommand);
    const { visionActive, connected, handsFree, setHandsFree } = useHannahStore();

    const [isRecording, setIsRecording] = useState(false);

    // En modo overlay, manos-libres siempre ON (sin botón de mic).
    useEffect(() => {
        if (isOverlay) setHandsFree(true);
    }, [setHandsFree]);

    // En overlay-navegador, pedir al backend la mirada global (sigue el cursor).
    useEffect(() => {
        if (isOverlay && connected && !window.__HANNAH_DESKTOP__) sendCommand({ command: 'GAZE_ON' });
    }, [connected, sendCommand]);

    // En Electron, la mirada global la empuja el proceso main (cursor del OS).
    useEffect(() => {
        if (window.__HANNAH_DESKTOP__) {
            window.__HANNAH_DESKTOP__.onGaze((g) => useHannahStore.getState().setOverlayGaze(g));
        }
    }, []);

    // En overlay, la cámara (visión) arranca sola: que Hannah te vea por defecto.
    const visionStarted = useRef(false);
    useEffect(() => {
        if (isOverlay && connected && !visionStarted.current) {
            visionStarted.current = true;
            startVision();
        }
    }, [connected, startVision]);

    // Barge-in: cortar a Hannah y avisar al backend que aborte el turno en curso.
    const bargeIn = useCallback(() => {
        stopPlayback();
        sendCommand({ command: 'INTERRUPT' });
    }, [stopPlayback, sendCommand]);

    // Manos-libres (VAD local): al detectar voz mientras Hannah habla -> barge-in;
    // al terminar el enunciado -> mandarlo como turno (WAV 16kHz).
    useVoiceActivity({
        enabled: handsFree,
        onInterrupt: bargeIn,
        onUtterance: (wavBuffer) => {
            sendCommand({ command: 'SPEECH_START' });
            sendAudio(wavBuffer);
            sendCommand({ command: 'SPEECH_END' });
        },
    });

    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    // ── Grabación de voz ────────────────────────────────────────────────────
    const handleRecord = useCallback(async (start) => {
        if (start) {
            try {
                stopPlayback();   // barge-in: si Hannah hablaba, callarla al tomar el mic
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
    }, [sendCommand, sendAudio, stopPlayback]);

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
                sendCommand={sendCommand}
            />
        </>
    );
}
