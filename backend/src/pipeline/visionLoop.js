// src/pipeline/visionLoop.js
import { analyzeFrame } from './vision.js';
import { describeFrame } from './vlm.js';
import { processTextTurn } from './orchestrator.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { pushFrame as storePushFrame, getLastFrame as storeGetFrame, clearFrame } from '../state/frameStore.js';

// Prompt del VLM: observar en primera persona (a la persona y el entorno), no hacer
// un "caption". Frase corta, centrada en qué hace la persona y lo notable.
const VLM_PROMPT = 'You are looking through your own eyes (a webcam) at the person you '
    + 'are chatting with and their surroundings. In ONE short sentence, note what the '
    + 'person is doing and anything notable or new. Be specific about the person.';

// Describe la escena con el proveedor activo: VLM local (rico) o YOLO (etiquetas).
export async function describeScene(frameBase64) {
    if (config.vision.provider === 'vlm') {
        return describeFrame(frameBase64, VLM_PROMPT);
    }
    const vision = await analyzeFrame(frameBase64);
    return vision?.summary || '';
}

// ── Perillas de frecuencia de la visión (cuánto habla sobre lo que ve) ──────
// REACT_IF_SIMILARITY_BELOW: reacciona solo si la escena cambió lo suficiente
//   (más BAJO = exige más cambio = habla MENOS). MIN_GAP_MS: tiempo mínimo entre
//   comentarios (más ALTO = habla MENOS).
const REACT_IF_SIMILARITY_BELOW = 0.30;   // exige MÁS cambio de escena para hablar
const MIN_GAP_MS = 60000;                  // mínimo 60s entre reacciones por visión

// Solapamiento de palabras entre dos descripciones (0..1). Sirve para NO reaccionar
// cuando la escena no cambió (evita que narre lo mismo una y otra vez).
function similarity(a, b) {
    const norm = (s) => new Set(String(s).toLowerCase().match(/[a-záéíóúñ]{4,}/g) || []);
    const A = norm(a), B = norm(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / Math.min(A.size, B.size);
}

const sessions = new Map();

export function startVisionLoop(sessionId, send) {
    if (sessions.has(sessionId)) return;

    const state = {
        isProcessing: false,   // ← CLAVE: evita llamadas solapadas
        interval: null,
        lastReacted: '',       // última escena que disparó una reacción
        lastReactAt: 0,        // timestamp de la última reacción hablada
    };

    state.interval = setInterval(async () => {
        const frame = storeGetFrame(sessionId);
        if (!frame || state.isProcessing) return;

        state.isProcessing = true;
        try {
            const summary = await describeScene(frame);
            if (!summary) return;

            // La visión es AWARENESS continua, no un caption por frame: solo habla
            // la primera vez (te nota) o cuando la escena cambia lo suficiente y pasó
            // un mínimo de tiempo. Si no, se queda callada (sigue "viéndote").
            const changed = similarity(summary, state.lastReacted) < REACT_IF_SIMILARITY_BELOW;
            const enoughGap = Date.now() - state.lastReactAt > MIN_GAP_MS;
            if (state.lastReacted && !(changed && enoughGap)) return;

            state.lastReacted = summary;
            state.lastReactAt = Date.now();

            const prompt = `[YOUR EYES] Right now, through your camera, you can see: "${summary}". `
                + `The person in front of you is who you are chatting with — you can SEE them. `
                + `If there's something natural and worth saying, say ONE short casual line directly `
                + `TO them (second person, like a friend who just noticed something). Do NOT narrate `
                + `or describe the image like a caption.`;
            // Lo que ve la cámara es texto ajeno: no puede disparar acciones (alguien podría
            // enseñarle un cartel a la cámara). Igual que la narración de las manos.
            await processTextTurn(sessionId, prompt, send, { noActions: true });
        } catch (err) {
            logger.error('Vision loop error', { message: err.message });
        } finally {
            state.isProcessing = false;
        }
    }, 4000);

    sessions.set(sessionId, state);
    logger.info('Vision loop started', { sessionId });
}

export function pushFrame(sessionId, frameBase64) {
    storePushFrame(sessionId, frameBase64);
}

export function getLastFrame(sessionId) {
    return storeGetFrame(sessionId);
}

export function stopVisionLoop(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    clearInterval(state.interval);
    sessions.delete(sessionId);
    clearFrame(sessionId);
    logger.info('Vision loop stopped', { sessionId });
}
