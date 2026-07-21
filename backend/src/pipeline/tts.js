// src/pipeline/tts.js
import axios from 'axios';
import { config } from '../config.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

/**
 * Sintetiza texto a audio usando ElevenLabs (Cloud) o Kokoro (Sidecar Local)
 */
export const synthesizeSpeechStream = async (text) => {
    const timer = startTimer();
    const provider = config.tts.provider.toLowerCase();

    if (provider === 'kokoro') {
        return runKokoroLocalStream(text);
    }

    // --- FALLBACK ELEVENLABS ANTERIOR (Por si decides volver) ---
    const voiceId = config.tts.voiceId;
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    try {
        const response = await axios({
            method: 'POST',
            url: url,
            data: { text, model_id: 'eleven_multilingual_v2' },
            headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
            responseType: 'stream',
        });
        return { audioStream: response.data, format: 'mp3', sample_rate: 44100, tts_latency_ms: timer.stop() };
    } catch (error) {
        return { error: 'tts_failed', message: error.message };
    }
};

/**
 * Conexión directa con el Sidecar de Python ejecutando Kokoro
 */
const runKokoroLocalStream = async (text) => {
    const timer = startTimer();
    const sidecarUrl = config.tts.sidecarUrl;
    const voice = config.tts.voiceId || 'af_bella';

    try {
        const response = await axios({
            method: 'POST',
            url: `${sidecarUrl}/v1/audio/speech`,
            data: {
                text: text,
                voice: voice,
                speed: 1.0
            },
            responseType: 'stream',
        });

        return {
            audioStream: response.data,
            format: 'wav', // Kokoro nativamente genera audio WAV de alta fidelidad
            sample_rate: 24000, // Frecuencia de muestreo estándar de Kokoro
            tts_latency_ms: timer.stop(),
        };
    } catch (error) {
        logger.error('Error de comunicación con el Sidecar de Kokoro', { message: error.message });
        return { error: 'tts_failed', message: 'Sidecar offline o error en modelo Kokoro' };
    }
};