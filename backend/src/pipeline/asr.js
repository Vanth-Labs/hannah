// src/pipeline/asr.js
import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

/**
 * Transcribe audio buffer using faster-whisper sidecar (local) or OpenAI Whisper (cloud)
 */
export const transcribeAudio = async (audioBuffer, mimeType = 'audio/wav') => {
    const timer = startTimer();

    if (!audioBuffer || audioBuffer.length === 0) {
        return { error: 'asr_failed', message: 'Empty audio buffer' };
    }

    if (config.asr.provider === 'local') {
        return transcribeLocal(audioBuffer, mimeType, timer);
    }

    return transcribeCloud(audioBuffer, mimeType, timer);
};

/**
 * Local path: faster-whisper via Python sidecar (port 8001)
 */
const transcribeLocal = async (audioBuffer, mimeType, timer) => {
    try {
        const form = new FormData();
        form.append('file', audioBuffer, {
            filename: 'utterance.wav',
            contentType: mimeType,
        });
        form.append('model', config.asr.model || 'small');
        if (config.asr.language) form.append('language', config.asr.language);

        const response = await axios.post(
            `${config.asr.sidecarUrl}/asr`,
            form,
            // 10 s era poco: Whisper en CPU tarda 5 a 9 s por frase en un portatil, y un timeout
            // convierte una espera en un turno perdido. El tiempo de respuesta no manda; la respuesta si.
            { headers: form.getHeaders(), timeout: config.asr.timeoutMs }
        );

        const durationMs = timer.stop();
        if (durationMs > 300) logger.warn('ASR local exceeded latency budget', { durationMs });

        return {
            transcript: response.data.transcript || '',
            language: response.data.language || 'es',
            confidence: response.data.confidence || 1.0,
            duration_ms: durationMs,
        };
    } catch (error) {
        logger.error('ASR local sidecar failed', { message: error.message });
        return { error: 'asr_failed', message: error.message };
    }
};

/**
 * Cloud path: OpenAI Whisper API (fallback, requires OPENAI_API_KEY)
 */
const transcribeCloud = async (audioBuffer, mimeType, timer) => {
    try {
        const { OpenAI, toFile } = await import('openai');
        const openai = new OpenAI({ apiKey: config.asr.apiKey });
        const file = await toFile(audioBuffer, 'utterance.wav', { type: mimeType });

        const response = await openai.audio.transcriptions.create({
            file,
            model: config.asr.model || 'whisper-1',
            ...(config.asr.language ? { language: config.asr.language } : {}),
            temperature: 0.0,
        });

        const durationMs = timer.stop();
        return { transcript: response.text || '', language: config.asr.language || 'auto', confidence: 1.0, duration_ms: durationMs };
    } catch (error) {
        logger.error('ASR cloud failed', { message: error.message });
        return { error: 'asr_failed', message: error.message };
    }
};
