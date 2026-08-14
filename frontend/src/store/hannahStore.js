// src/store/hannahStore.js
import { create } from 'zustand';

export const useHannahStore = create((set, get) => ({
    // Conexión
    sessionId: null,
    connected: false,

    // Estado del avatar
    emotion: 'neutral',        // neutral | happy | curious | alert | thinking
    isSpeaking: false,
    currentVisemes: [],        // [{ viseme: 'aa', weight: 0.8, time: 0 }, ...]
    transcript: '',            // último texto que dijo Hannah
    userTranscript: '',        // lo que dijo el usuario

    // Visión
    visionActive: false,
    lastDetection: null,       // resumen del último análisis YOLO

    // Avatar y movimiento corporal (EMAGE / SMPL-X)
    avatarMode: 'vrm',         // 'vrm' (VRoid anime, cara+cuerpo) | 'smplx' (debug SMPL-X) | 'rpm'
    avatarLoaded: false,
    currentMotion: null,       // { fps, numFrames, poses: Float32Array, trans: Float32Array, startedAt }
    gestureTrigger: null,      // { name, startedAt } — gesto deliberado (Mixamo) sobre el co-speech

    // Comportamiento del avatar (toggles de Settings)
    autoLookat: true,          // la cabeza/ojos siguen a la cámara (Fase 3)
    overlayGaze: { x: 0, y: 0 }, // dirección de mirada global (cursor Hyprland) en overlay
    pendingConfirm: null,      // { id, command } — comando destructivo esperando tu OK
    commandRun: null,          // { command, output, at } — último comando ejecutado (toast, sin abrir terminal)
    terminalOpen: false,       // terminal abierta -> la ventana se divide (avatar arriba, terminal abajo)
    handsFree: false,          // conversación manos-libres por VAD (Fase B) + barge-in

    // Log de pipeline
    logs: [],

    // Acciones
    setSession: (sessionId) => set({ sessionId }),
    setConnected: (connected) => set({ connected }),
    setEmotion: (emotion) => set({ emotion }),
    setIsSpeaking: (isSpeaking) => set({ isSpeaking }),
    setVisemes: (visemes) => set({ currentVisemes: visemes || [] }),
    setTranscript: (transcript) => set({ transcript }),
    setUserTranscript: (userTranscript) => set({ userTranscript }),
    setVisionActive: (visionActive) => set({ visionActive }),
    setLastDetection: (lastDetection) => set({ lastDetection }),
    setAvatarMode: (avatarMode) => set({ avatarMode }),
    setAvatarLoaded: (avatarLoaded) => set({ avatarLoaded }),
    setCurrentMotion: (currentMotion) => set({ currentMotion }),
    setGestureTrigger: (gestureTrigger) => set({ gestureTrigger }),
    setAutoLookat: (autoLookat) => set({ autoLookat }),
    setHandsFree: (handsFree) => set({ handsFree }),
    setOverlayGaze: (overlayGaze) => set({ overlayGaze }),
    setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),
    setCommandRun: (commandRun) => set({ commandRun }),
    setTerminalOpen: (terminalOpen) => set({ terminalOpen }),

    addLog: (msg, type = 'info') => set((state) => ({
        logs: [...state.logs.slice(-49), {
            id: Date.now(),
            msg,
            type,
            ts: new Date().toLocaleTimeString(),
        }],
    })),
}));
