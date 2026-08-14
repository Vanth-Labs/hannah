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
        // Con tools ON: loop de acciones por tags (determinista). Sin tools: streaming directo.
        const text = config.tools.enabled
            ? await generateWithActions(messages, onToken, signal, ctx)
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

// Acciones por TAGS (determinista, fiable en modelos locales — no depende del
// function-calling que los 7B/8B hacen a medias): el modelo emite un tag de acción,
// el backend lo ejecuta y le realimenta el resultado. Ver el protocolo en config.js.
const ACTION_TOOL = {
    run: ['run_command', 'command'], search: ['web_search', 'query'], fetch: ['fetch_url', 'url'],
    weather: ['get_weather', 'location'], look: ['look_now', null], time: ['get_datetime', null],
    open: ['open_app', 'name'], recall: ['recall_memory', 'query'],
};
const ACTION_RE = /\[\s*(RUN|SEARCH|FETCH|WEATHER|LOOK|TIME|OPEN|RECALL)\b\s*(?::\s*([^\]\n]*))?\]/gi;

function parseActions(text) {
    const acts = []; let m; ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(text || ''))) acts.push({ key: m[1].toLowerCase(), arg: (m[2] || '').trim() });
    return acts;
}

async function generateWithActions(messages, onToken, signal, ctx) {
    for (let depth = 0; depth < 3; depth++) {
        // Pasada NO-streaming para poder detectar tags de acción antes de hablar.
        const resp = await getLlmClient().chat.completions.create(
            { model: config.llm.model, messages, max_tokens: 400, stream: false }, { signal });
        if (signal?.aborted) return null;
        const text = resp.choices[0]?.message?.content || '';
        const acts = parseActions(text);
        if (!acts.length) { if (onToken && text) onToken(text); return text; }   // sin acción -> es la respuesta

        // Ejecutar las acciones y realimentar los resultados para la respuesta final.
        const results = [];
        for (const a of acts) {
            const [tool, argName] = ACTION_TOOL[a.key] || [];
            if (!tool) continue;
            const r = await runTool(tool, argName ? { [argName]: a.arg } : {}, ctx);
            results.push(`${a.key.toUpperCase()}${a.arg ? ` ${a.arg}` : ''} -> ${r}`);
        }
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: `[resultados de la acción]\n${results.join('\n')}\n\nResponde al usuario AHORA usando estos resultados, breve y natural. NO emitas más tags de acción.` });
    }
    return streamAnswer(messages, onToken, signal);   // profundidad agotada
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
