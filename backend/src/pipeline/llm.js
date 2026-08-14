// src/pipeline/llm.js
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

// Cliente OpenAI-compatible (Groq, Ollama, OpenRouter, OpenAI…) construido bajo
// demanda y memoizado. Se reconstruye SOLO si cambian apiKey o baseUrl en runtime
// (vía POST /settings), así el usuario puede cambiar de proveedor sin reiniciar.
let _client = null;
let _clientKey = '';
const getLlmClient = () => {
    const key = `${config.llm.apiKey}|${config.llm.baseUrl}`;
    if (!_client || key !== _clientKey) {
        _client = new OpenAI({
            apiKey: config.llm.apiKey || 'not-needed', // Ollama/local ignoran la key
            baseURL: config.llm.baseUrl || undefined,
        });
        _clientKey = key;
    }
    return _client;
};

/**
 * Agnostic Streaming Wrapper for Dialogue Engines
 */
export const generateDialogueStream = async (history, onToken, onComplete, signal) => {
    return runOpenAICompatibleStream(history, onToken, onComplete, signal);
};

/**
 * Path: Generic OpenAI-Compatible Stream Connection (LLaMA, Groq, local Ollama)
 */
const runOpenAICompatibleStream = async (history, onToken, onComplete, signal) => {
    const timer = startTimer();
    let accumulatedResponse = '';

    try {
        // System prompt = persona (editable por el usuario) + protocolo fijo de tags.
        const systemPrompt = `${config.llm.persona}\n\n${config.llm.protocol}`;
        const formattedMessages = [
            { role: 'system', content: systemPrompt },
            ...history.map(turn => ({
                role: turn.role === 'assistant' ? 'assistant' : 'user',
                content: turn.content
            }))
        ];

        const stream = await getLlmClient().chat.completions.create({
            model: config.llm.model, // se lee por llamada: cambia sin reiniciar
            messages: formattedMessages,
            max_tokens: 400,
            stream: true,
        }, { signal });   // barge-in: abortar la generación al instante

        for await (const chunk of stream) {
            if (signal?.aborted) break;
            const token = chunk.choices[0]?.delta?.content || '';
            if (token) {
                accumulatedResponse += token;
                if (onToken) onToken(token);
            }
        }

        finalizeLlmTurn(accumulatedResponse, timer.stop(), onComplete);
    } catch (error) {
        // Abort por barge-in: no es un error real, no notificar al cliente.
        if (signal?.aborted || error.name === 'APIUserAbortError' || error.name === 'AbortError') {
            logger.info('LLM stream abortado (barge-in)');
            return;
        }
        logger.error('OpenAI-compatible stream engine runtime error', { message: error.message });
        if (onComplete) onComplete({ error: 'llm_failed', message: error.message });
    }
};

/**
 * Pure helper: extracts the system-enforced [EMOTION:xx] tag and strips it from the text.
 * Exported for unit testing.
 */
// Emociones que el rig de cara (retargetFace.js EMOTION_TO_FCL) sabe expresar.
const EMOTIONS = ['neutral', 'happy', 'surprised', 'thinking', 'sad', 'angry', 'curious', 'alert'];

export const parseLlmResponse = (rawResponse) => {
    const emotionMatch = rawResponse.match(/\[EMOTION:\s*([a-z]+)\s*\]/i);
    const raw = emotionMatch ? emotionMatch[1].toLowerCase() : 'neutral';
    const emotion = EMOTIONS.includes(raw) ? raw : 'neutral';   // desconocida -> neutral

    // Strip out the emotion text before sending to user/audio modules
    const text = rawResponse.replace(/\[EMOTION:.*?\]/gi, '').trim();

    return { text, emotion };
};

/**
 * Shared Utility: structures the pipeline contract uniformly
 */
const finalizeLlmTurn = (accumulatedResponse, durationMs, onComplete) => {
    const { text, emotion } = parseLlmResponse(accumulatedResponse);

    if (onComplete) {
        onComplete({
            text,
            emotion,
            duration_ms: durationMs,
            tokens_used: Math.round(accumulatedResponse.length / 4),
        });
    }
};
