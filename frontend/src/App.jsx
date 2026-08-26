// src/App.jsx
import { useRef, useState, useCallback, useEffect } from 'react';
import { Scene } from './components/Scene.jsx';
import { HUD, isOverlay } from './components/HUD.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useVision } from './hooks/useVision.js';
import { useVoiceActivity } from './hooks/useVoiceActivity.js';
import { useHannahStore } from './store/hannahStore.js';
import { DESKTOP } from './lib/api.js';

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
    // Selectores atómicos: App es la raíz, así que suscribirse al store entero re-renderizaba
    // TODO el árbol (Scene/Canvas incluido) con cada visema/gaze/log.
    const visionActive = useHannahStore((s) => s.visionActive);
    const connected = useHannahStore((s) => s.connected);
    const handsFree = useHannahStore((s) => s.handsFree);
    const terminalOpen = useHannahStore((s) => s.terminalOpen);
    const setHandsFree = useHannahStore((s) => s.setHandsFree);

    const [isRecording, setIsRecording] = useState(false);

    // En modo overlay, manos-libres siempre ON (sin botón de mic).
    useEffect(() => {
        if (isOverlay) setHandsFree(true);
    }, [setHandsFree]);

    // (El GAZE_ON del overlay-navegador lo manda useWebSocket en su onopen: allí cubre también
    // las reconexiones. Antes se enviaba dos veces, desde acá y desde el hook.)

    // En Electron, la mirada global la empuja el proceso main (cursor del OS).
    useEffect(() => {
        if (!DESKTOP) return undefined;
        const off = DESKTOP.onGaze((g) => useHannahStore.getState().setOverlayGaze(g));
        return typeof off === 'function' ? off : undefined;   // desuscribir si el preload lo permite
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
    // SPEECH_START se manda cuando el VAD detecta que EMPEZASTE a hablar, no al terminar: el
    // backend usa ese instante para decidir si un "sí" responde a una pregunta que las manos
    // hicieron ANTES (hablar por encima de la pregunta no puede concederla). Mandarlo al final
    // del enunciado hacía que toda respuesta pareciera posterior a cualquier pregunta.
    useVoiceActivity({
        enabled: handsFree,
        onSpeechStart: () => sendCommand({ command: 'SPEECH_START' }),
        onInterrupt: bargeIn,
        onUtterance: (wavBuffer) => {
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

            {/* Canvas 3D — al abrir la terminal, se encoge al 60% superior (split:
                Hannah arriba, terminal abajo) en vez de que la terminal la tape. */}
            <div style={{
                position: 'fixed', top: 0, left: 0, right: 0,
                bottom: terminalOpen ? '40%' : 0, zIndex: 1, transition: 'bottom 0.18s',
            }}>
                <Scene />
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
