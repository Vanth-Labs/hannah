// src/pipeline/llm.js
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { memoryStore } from '../state/memoryStore.js';
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
        // System prompt = persona (editable) + memoria de largo plazo + protocolo fijo.
        const summary = memoryStore.getSummary();
        const memorySection = summary
            ? `\n\n[What you remember about the user and past conversations]\n${summary}`
            : '';
        const systemPrompt = `${config.llm.persona}${memorySection}\n\n${config.llm.protocol}`;
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
 * Resume la conversación en una memoria de largo plazo concisa (no-streaming).
 * Toma el resumen previo + los turnos nuevos y devuelve la memoria actualizada.
 */
export const summarizeConversation = async (oldSummary, turns) => {
    const convo = turns
        .map((t) => `${t.role === 'assistant' ? 'Hannah' : 'User'}: ${t.content}`)
        .join('\n');
    const sys = 'You maintain a concise long-term memory for the AI avatar Hannah. '
        + 'Update the memory with DURABLE facts about the user (name, preferences, ongoing '
        + 'topics, plans, promises) and key context. Keep it short (max ~1000 chars), third '
        + 'person, terse, drop stale trivia and small talk. Output ONLY the updated memory text.';
    const user = `Current memory:\n${oldSummary || '(empty)'}\n\nNew conversation to fold in:\n${convo}`;
    try {
        const res = await getLlmClient().chat.completions.create({
            model: config.llm.model,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            max_tokens: 400,
            stream: false,
        });
        return res.choices[0]?.message?.content?.trim() || oldSummary;
    } catch (error) {
        logger.error('Resumen de memoria falló', { message: error.message });
        return oldSummary;
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
