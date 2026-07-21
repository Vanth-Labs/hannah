// src/pipeline/motion.js
import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

// Hannah emotions ([EMOTION:] tags) -> BEAT2 emotion labels del motion-lab
const EMOTION_MAP = {
    neutral: 'neutral', happy: 'happiness', surprised: 'surprise',
    thinking: 'neutral', sad: 'sadness',
};

/**
 * Genera movimiento SMPL-X con el modelo de hannah-motion-lab (texto→movimiento).
 * Nunca lanza excepciones: en caso de fallo devuelve { error }.
 *
 * @param {string} text - Texto de la oración que Hannah va a decir (co-speech). Vacío en modo acción.
 * @param {number} durationS - Duración del audio TTS de la oración (segundos)
 * @param {string} emotion - Emoción de Hannah (neutral|happy|surprised|thinking|sad)
 * @param {string} sessionId - Para continuidad de prefijo entre oraciones
 * @param {string} action - Caption de acción deliberada ([MOTION:]). Si se envía, el
 *                          sidecar genera SOLO la acción (sin co-speech): los dos modos no se mezclan.
 * @param {number} intensity - Dial de energía del gesto (1.0 = normal)
 */
export const generateMotionFromText = async (
    text, durationS, emotion = 'neutral', sessionId = '', action = '', intensity = 1.0) => {
    const timer = startTimer();
    try {
        const response = await axios.post(
            `${config.motion.sidecarUrl}/motion`,
            {
                text,
                action,
                intensity,
                duration_s: durationS,
                emotion: EMOTION_MAP[emotion] || 'neutral',
                session_id: sessionId,
            },
            { timeout: 15000 }
        );
        return {
            fps: response.data.fps,
            num_frames: response.data.num_frames,
            poses_b64: response.data.poses_b64,
            trans_b64: response.data.trans_b64,
            motion_latency_ms: timer.stop(),
        };
    } catch (error) {
        logger.error('Motion-lab sidecar failed', { message: error.message });
        return { error: 'motion_failed', message: error.message };
    }
};

/**
 * Genera movimiento corporal SMPL-X (EMAGE) a partir del audio WAV de una oración.
 * Nunca lanza excepciones: en caso de fallo devuelve { error } y el pipeline
 * continúa sin gestos (degradación elegante, igual que visión).
 *
 * @param {Buffer} wavBuffer - WAV completo de la oración (salida de Kokoro)
 * @returns {Promise<{fps, num_frames, poses_b64, trans_b64, motion_latency_ms} | {error, message}>}
 */
export const generateMotion = async (wavBuffer) => {
    const timer = startTimer();

    if (!wavBuffer || wavBuffer.length === 0) {
        return { error: 'motion_failed', message: 'Empty audio buffer' };
    }

    try {
        const form = new FormData();
        form.append('file', wavBuffer, {
            filename: 'sentence.wav',
            contentType: 'audio/wav',
        });

        const response = await axios.post(
            `${config.motion.sidecarUrl}/motion`,
            form,
            { headers: form.getHeaders(), timeout: 15000, maxBodyLength: Infinity }
        );

        return {
            fps: response.data.fps,
            num_frames: response.data.num_frames,
            poses_b64: response.data.poses_b64,
            trans_b64: response.data.trans_b64,
            motion_latency_ms: timer.stop(),
        };
    } catch (error) {
        logger.error('Motion sidecar (EMAGE) failed', { message: error.message });
        return { error: 'motion_failed', message: error.message };
    }
};
