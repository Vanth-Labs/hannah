// src/pipeline/visionLoop.js
import { analyzeFrame } from './vision.js';
import { processTextTurn } from './orchestrator.js';
import { logger } from '../utils/logger.js';

const sessions = new Map();

export function startVisionLoop(sessionId, send) {
    if (sessions.has(sessionId)) return;

    const state = {
        lastFrame: null,
        isProcessing: false,   // ← CLAVE: evita llamadas solapadas
        interval: null,
    };

    state.interval = setInterval(async () => {
        if (!state.lastFrame || state.isProcessing) return;

        state.isProcessing = true;
        try {
            const vision = await analyzeFrame(state.lastFrame);
            if (!vision?.summary) return;

            const prompt = `[VISIÓN]: ${vision.summary}. Reacciona brevemente (1-2 frases), como si lo estuvieras viendo ahora mismo.`;
            await processTextTurn(sessionId, prompt, send);
        } catch (err) {
            logger.error('Vision loop error', { message: err.message });
        } finally {
            state.isProcessing = false;
        }
    }, 4000); // cada 4s, no 2s

    sessions.set(sessionId, state);
    logger.info('Vision loop started', { sessionId });
}

export function pushFrame(sessionId, frameBase64) {
    const state = sessions.get(sessionId);
    if (state) state.lastFrame = frameBase64;
}

export function getLastFrame(sessionId) {
    return sessions.get(sessionId)?.lastFrame || null;
}

export function stopVisionLoop(sessionId) {
    const state = sessions.get(sessionId);
    if (!state) return;
    clearInterval(state.interval);
    sessions.delete(sessionId);
    logger.info('Vision loop stopped', { sessionId });
}
