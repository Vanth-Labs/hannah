// src/store/hannahStore.js
import { create } from 'zustand';

// ── Vigilancia (watches, sense.v1) ──────────────────────────────────────────
// Estados terminales: la vigilancia ya no mira nada. Se marcan con `doneAt` para que la píldora
// los retire pasados unos segundos, igual que la tarea del agente.
export const WATCH_TERMINAL = ['expired', 'disarmed', 'faulted'];

// Fila por defecto. La UI no inventa datos: lo que el servidor no manda se queda en el neutro,
// nunca en un valor que parezca una medición.
// `mine` (¿la armó esta sesión?) por defecto en false y no en true: el backend solo manda la
// etiqueta —texto libre que dictó una persona— a la sesión dueña, así que una fila de la que no
// sabemos nada NO es nuestra, y pintarla como propia sería adivinar hacia el lado que filtra.
const WATCH_DEFAULTS = {
    label: '', state: 'armed', rung: '', sensorKind: '', tier: '', mine: false,
    fires: 0, samplesOk: 0, lastSampleAt: null, trippedAt: null, expiresAt: null, doneAt: null,
};

// Quita las claves ausentes del parche. Sin esto un `watch_state` (que no trae `label` ni
// `rung`) los pisaría con undefined al mezclar y la píldora se quedaría sin etiqueta.
const definedOnly = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// `doneAt` es un reloj LOCAL ("desde cuándo esta fila dejó de mirar", para retirar la píldora a
// los WATCH_LINGER_MS), no un dato del servidor: ningún mensaje ni ninguna instantánea lo trae.
// Se sella UNA vez, la primera que la fila entra en un estado terminal — si se re-sellara con
// cada mensaje posterior la píldora no se retiraría nunca. Y se borra si la fila vuelve a un
// estado vivo (re-armada), porque entonces no hay desenlace que leer y la cuenta atrás pendiente
// la haría desaparecer estando armada.
const stampDone = (w) => {
    if (!WATCH_TERMINAL.includes(w.state)) return w.doneAt ? { ...w, doneAt: null } : w;
    return w.doneAt ? w : { ...w, doneAt: Date.now() };
};

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
    watches: [],               // [{ watchId, label, state, rung, sensorKind, fires, lastSampleAt, ... }]
                               // Lista plana: la referencia solo cambia cuando cambia algo de verdad,
                               // así `s.watches` es un selector atómico como los demás y leerla no
                               // re-renderiza con cada visema.
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

    // El servidor es la verdad: la UI no crea watches ni adelanta estados (mismo contrato que
    // agentTask). MEZCLA por watchId — un `watch_armed` repetido, que es lo que llega al
    // reconectar o al re-sincronizar, tiene que actualizar la fila, no duplicarla.
    upsertWatch: (patch) => set((state) => {
        if (!patch?.watchId) return {};
        const i = state.watches.findIndex((w) => w.watchId === patch.watchId);
        const merged = stampDone(i === -1
            ? { ...WATCH_DEFAULTS, ...definedOnly(patch) }
            : { ...state.watches[i], ...definedOnly(patch) });
        if (i === -1) return { watches: [...state.watches, merged] };
        const watches = state.watches.slice();
        watches[i] = merged;
        return { watches };
    }),

    // Un disparo. El `watch_tripped` del contrato backend->HUD no lleva `fires` (el evento
    // sense.v1 sí), y un contador que solo avanzara con la siguiente muestra dejaría a la píldora
    // mintiendo justo sobre lo único que existe para mostrar: que esta vigilancia gritó "lobo".
    // Por eso se cuenta aquí cuando el mensaje no trae el número, y se usa el del servidor cuando
    // sí lo trae.
    tripWatch: (patch) => {
        if (!patch?.watchId) return;
        const prev = get().watches.find((w) => w.watchId === patch.watchId);
        const fires = typeof patch.fires === 'number' ? patch.fires : (prev?.fires || 0) + 1;
        get().upsertWatch({ ...patch, fires });
    },

    // Instantánea completa: sustituye la lista entera, porque es la verdad completa — una fila que
    // ya no está allí tampoco está aquí. Conserva el `doneAt` de la fila que ya teníamos: es un
    // sello local y la instantánea no lo trae, así que reconstruir la fila desde WATCH_DEFAULTS
    // le regalaba a cada terminal otros WATCH_LINGER_MS en pantalla con cada instantánea que
    // llegara, y la píldora no se iba nunca.
    setWatches: (rows) => set((state) => {
        const before = new Map(state.watches.map((w) => [w.watchId, w.doneAt]));
        return {
            watches: (rows || [])
                .filter((r) => r?.watchId)
                .map((r) => stampDone({ ...WATCH_DEFAULTS, doneAt: before.get(r.watchId) ?? null, ...definedOnly(r) })),
        };
    }),

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
