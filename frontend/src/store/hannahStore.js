// src/store/hannahStore.js
import { create } from 'zustand';

export const useHannahStore = create((set) => ({
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

    // Avatar y movimiento corporal (EMAGE / SMPL-X)
    avatarLoaded: false,
    avatarUrl: '/avatar.glb',  // el VRM que se renderiza: el de fábrica, o el subido (GET /api/v1/avatar?v=…)
    avatarError: null,         // 'not_a_vrm' cuando el archivo cargado no trae la extensión VRM
    currentMotion: null,       // { fps, numFrames, poses: Float32Array, trans: Float32Array, startedAt }
    gestureTrigger: null,      // { name, startedAt } — gesto deliberado (Mixamo) sobre el co-speech

    // Comportamiento del avatar (toggles de Settings)
    autoLookat: true,          // la cabeza/ojos siguen a la cámara (Fase 3)
    overlayGaze: { x: 0, y: 0 }, // dirección de mirada global (cursor Hyprland) en overlay
    pendingConfirm: null,      // { id, command } — comando destructivo esperando tu OK
                               // o, con kind:'agent', { kind, taskId, approvalId|questionId, summary, risk, expiresAt, isQuestion }
    agentTask: null,           // { taskId, title, state, lastSummary } — la tarea viva de las "manos" (píldora en el dock)
    commandRun: null,          // { command, output, at } — último comando ejecutado (toast, sin abrir terminal)
    terminalOpen: false,       // terminal abierta -> la ventana se divide (avatar arriba, terminal abajo)
    handsFree: false,          // conversación manos-libres por VAD (Fase B) + barge-in
    brain: null,               // GET /api/v1/brain — { mode, configured, ollama, hardware, recommendation, job } (null = aún no consultado)

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
    setAvatarLoaded: (avatarLoaded) => set({ avatarLoaded }),
    setAvatarUrl: (avatarUrl) => set({ avatarUrl, avatarLoaded: false, avatarError: null }),
    setAvatarError: (avatarError) => set({ avatarError }),
    setCurrentMotion: (currentMotion) => set({ currentMotion }),
    setGestureTrigger: (gestureTrigger) => set({ gestureTrigger }),
    setAutoLookat: (autoLookat) => set({ autoLookat }),
    setHandsFree: (handsFree) => set({ handsFree }),
    setBrain: (brain) => set({ brain }),
    // el backend rechazó un turno por falta de cerebro: reabrir la bienvenida
    markBrainRequired: () => set((st) => ({ brain: { ...(st.brain || {}), configured: false } })),
    setOverlayGaze: (overlayGaze) => set({ overlayGaze }),
    setPendingConfirm: (pendingConfirm) => set({ pendingConfirm }),
    setAgentTask: (agentTask) => set({ agentTask }),
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
