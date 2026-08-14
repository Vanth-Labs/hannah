// src/pipeline/llm.js
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { memoryStore } from '../state/memoryStore.js';
import { embed, cosine } from '../state/embeddings.js';
import { toolSchemas, runTool } from './tools.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

// Recall vectorial: embebe el último mensaje del usuario, busca por coseno en la
// memoria y devuelve los fragmentos OLD relevantes (los que NO están ya en la ventana).
async function recallContext(history) {
    if (!config.memory.recallEnabled) return '';
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    if (!lastUser?.content) return '';
    const q = await embed(lastUser.content);
    if (!q) return '';
    const inWindow = new Set(history.map((t) => t.content));
    const scored = memoryStore.embeddings(2000)
        .filter((r) => !inWindow.has(r.text))
        .map((r) => ({ text: r.text, s: cosine(q, r.vec) }))
        .filter((r) => r.s > 0.55)
        .sort((a, b) => b.s - a.s)
        .slice(0, config.memory.recallK);
    return scored.length ? scored.map((r) => `- ${r.text}`).join('\n') : '';
}

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

// System prompt = persona + memoria (resumen + recall vectorial) + protocolo.
async function buildSystemPrompt(history) {
    const summary = memoryStore.getSummary();
    const recalled = await recallContext(history);
    let memorySection = '';
    if (summary) memorySection += `\n\n[What you remember about the user and past conversations]\n${summary}`;
    if (recalled) memorySection += `\n\n[Relevant things from earlier conversations]\n${recalled}`;
    return `${config.llm.persona}${memorySection}\n\n${config.llm.protocol}`;
}

/**
 * Streaming wrapper. `ctx` (p.ej. { sessionId }) se pasa a las tools que lo necesitan.
 */
export const generateDialogueStream = async (history, onToken, onComplete, signal, ctx = {}) => {
    const timer = startTimer();
    try {
        const systemPrompt = await buildSystemPrompt(history);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map((turn) => ({
                role: turn.role === 'assistant' ? 'assistant' : 'user',
                content: turn.content,
            })),
        ];
        // Con tools: pasada de decisión NO-streaming (Ollama solo devuelve tool_calls
        // sin streaming), y streaming solo para la respuesta hablada. Sin tools: el
        // streaming original (más snappy).
        const text = toolSchemas().length
            ? await generateWithTools(messages, onToken, signal, ctx)
            : await streamAnswer(messages, onToken, signal);
        if (text === null) return;   // abortado (barge-in)
        finalizeLlmTurn(text, timer.stop(), onComplete);
    } catch (error) {
        if (signal?.aborted || error.name === 'APIUserAbortError' || error.name === 'AbortError') {
            logger.info('LLM stream abortado (barge-in)');
            return;
        }
        logger.error('OpenAI-compatible stream engine runtime error', { message: error.message });
        if (onComplete) onComplete({ error: 'llm_failed', message: error.message });
    }
};

// Streamea una respuesta (sin tools) por la ruta token→onToken. Devuelve el texto
// acumulado, o null si se abortó (barge-in).
async function streamAnswer(messages, onToken, signal) {
    const stream = await getLlmClient().chat.completions.create(
        { model: config.llm.model, messages, max_tokens: 400, stream: true }, { signal });
    let content = '';
    for await (const chunk of stream) {
        if (signal?.aborted) return null;
        const tok = chunk.choices[0]?.delta?.content || '';
        if (tok) { content += tok; if (onToken) onToken(tok); }
    }
    return content;
}

// Loop de tool-calling: pasada NO-streaming con tools; si el modelo pide tools, las
// ejecuta, apenda los resultados y repite; cuando ya no pide tools, la respuesta
// hablada se STREAMEA. Cap de profundidad. Devuelve el texto final o null si se abortó.
async function generateWithTools(messages, onToken, signal, ctx) {
    for (let depth = 0; depth < 3; depth++) {
        const tools = toolSchemas();
        const resp = await getLlmClient().chat.completions.create(
            { model: config.llm.model, messages, max_tokens: 400, stream: false, ...(tools.length ? { tools } : {}) },
            { signal });
        if (signal?.aborted) return null;
        const msg = resp.choices[0]?.message || {};

        if (msg.tool_calls?.length) {
            messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
            for (const tc of msg.tool_calls) {
                let args = {};
                try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* sin args */ }
                const result = await runTool(tc.function?.name, args, ctx);
                messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
            }
            // Tras ejecutar tools, generar la respuesta hablada. El protocolo verboso
            // de gestos ahoga al modelo 8B en el follow-up -> system SLIM (persona +
            // instrucción corta; conserva el tag de emoción, no el menú de gestos). Se
            // hace NO-streaming (más fiable con 8B) y se emite el texto por onToken.
            messages[0] = {
                role: 'system',
                content: `${config.llm.persona}\n\nUse the tool results to answer the user `
                    + `conversationally and briefly (1-2 sentences). End with an emotion tag like `
                    + `[EMOTION:neutral|happy|surprised|thinking|sad|angry|curious|alert].`,
            };
            const done = await getLlmClient().chat.completions.create(
                { model: config.llm.model, messages, max_tokens: 300, stream: false }, { signal });
            if (signal?.aborted) return null;
            const answer = done.choices[0]?.message?.content || '';
            if (onToken && answer) onToken(answer);
            return answer;
        }

        // Sin tool_calls: este mensaje ES la respuesta. Emitirla por onToken.
        const text = msg.content || '';
        if (onToken && text) onToken(text);
        return text;
    }
    // Profundidad agotada: forzar respuesta final hablada.
    return streamAnswer(messages, onToken, signal);
}

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
    // llama3.1:8b a veces omite los corchetes -> aceptar [EMOTION:x], (EMOTION:x),
    // *EMOTION:x* o EMOTION:x pelado.
    const emotionMatch = rawResponse.match(/[[(*]?\s*EMOTION\s*:\s*([a-z]+)\s*[\])*]?/i);
    const raw = emotionMatch ? emotionMatch[1].toLowerCase() : 'neutral';
    const emotion = EMOTIONS.includes(raw) ? raw : 'neutral';   // desconocida -> neutral

    // Quitar la etiqueta (con o sin delimitadores) antes de mandar a texto/audio.
    const text = rawResponse.replace(/[[(*]?\s*EMOTION\s*:[^\])*\n]*[\])*]?/gi, '').trim();

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
