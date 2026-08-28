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

// Envelope de respuesta del sidecar de motion (mismo contrato para los dos providers).
const toMotionResult = (data, timer) => ({
    fps: data.fps,
    num_frames: data.num_frames,
    poses_b64: data.poses_b64,
    trans_b64: data.trans_b64,
    motion_latency_ms: timer.stop(),
});

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
            `${config.motion.labUrl}/motion`,
            {
                text,
                action,
                intensity,
                duration_s: durationS,
                emotion: EMOTION_MAP[emotion] || 'neutral',
                session_id: sessionId,
            },
            { timeout: MOTION_TIMEOUT_MS }
        );
        return toMotionResult(response.data, timer);
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
            `${config.motion.emageUrl}/motion`,
            form,
            { headers: form.getHeaders(), timeout: MOTION_TIMEOUT_MS, maxBodyLength: Infinity }
        );

        return toMotionResult(response.data, timer);
    } catch (error) {
        logger.error('Motion sidecar (EMAGE) failed', { message: error.message });
        return { error: 'motion_failed', message: error.message };
    }
};

/** Segundos de movimiento de más respecto al audio: el gesto termina y se asienta después de la voz. */
export const MOTION_TAIL_S = 0.35;
// Gestures are the point of the project: they are never skipped for being slow. On a CPU a long
// sentence can take a few seconds; only a real hang (minutes) gives up on a chunk's motion.
export const MOTION_TIMEOUT_MS = 120000;

/**
 * Duración en segundos de un WAV PCM leyendo su cabecera (fmt: canales, tasa, bits; data: bytes).
 * Cae al cálculo "mono 16-bit, 44 bytes de cabecera" si el archivo no es un RIFF/WAVE reconocible.
 */
export function wavDurationS(buf, fallbackRate = 24000) {
    try {
        if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
            let off = 12, channels = 1, rate = fallbackRate, bits = 16, dataLen = null;
            while (off + 8 <= buf.length) {
                const id = buf.toString('ascii', off, off + 4);
                const size = buf.readUInt32LE(off + 4);
                if (id === 'fmt ' && off + 24 <= buf.length) {
                    channels = buf.readUInt16LE(off + 10) || 1;
                    rate = buf.readUInt32LE(off + 12) || fallbackRate;
                    bits = buf.readUInt16LE(off + 22) || 16;
                } else if (id === 'data') {
                    // soundfile puede escribir size=0/0xFFFFFFFF al hacer streaming: usar lo que hay
                    dataLen = (size === 0 || size === 0xFFFFFFFF || off + 8 + size > buf.length) ? buf.length - off - 8 : size;
                    break;
                }
                off += 8 + size + (size % 2);
            }
            if (dataLen != null) return dataLen / (rate * channels * (bits / 8));
        }
    } catch { /* cabecera rara: abajo */ }
    return (buf.length - 44) / (fallbackRate * 2);
}
