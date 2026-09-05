// src/pipeline/agentClient.js
// Cliente del sidecar hannah-agent (fachada `/hannah/v0`). SOLO transporte: HTTP + el stream
// SSE de eventos. No sabe nada de Hannah, de sesiones ni de narración — eso es agentBridge.js.
//
// Contrato verificado contra hannah-agent/packages/agent/src/hannah/facade/routes.ts:
//   - Bearer en cada request si hay token (401 si falta o no coincide).
//   - POST /tasks -> 202 {taskId, queued?, position?}; 409 {activeTaskId} = cola llena.
//   - GET /events: SSE global (una sola conexión por proceso), envelope
//     {v:'hannah.v0', taskId, seq, ts, type, data}; `id:` es un cursor global y Last-Event-ID
//     (o ?after=) reanuda desde el ring buffer del agente; keep-alive cada 15s como comentario.
// Sin dependencias nuevas: fetch nativo de Node 20 y un parser SSE mínimo.
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const PREFIX = '/hannah/v0';

export class AgentHttpError extends Error {
    constructor(status, body, path) {
        super(`agent ${path} -> ${status}${body?.error ? ` (${body.error})` : ''}`);
        this.status = status;
        this.body = body;
    }
}

function headers(extra = {}) {
    const h = { 'content-type': 'application/json', ...extra };
    if (config.agent.token) h.authorization = `Bearer ${config.agent.token}`;
    return h;
}

async function call(method, path, body, { timeoutMs = 10000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(`${config.agent.url}${PREFIX}${path}`, {
            method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* cuerpo no JSON */ }
        if (!res.ok) throw new AgentHttpError(res.status, json, path);
        return json;
    } finally {
        clearTimeout(t);
    }
}

// ── API ───────────────────────────────────────────────────────────────────────────────

/** GET /health -> { healthy, version, engineVersion, activeTasks, workspaces, trash } */
export const health = () => call('GET', '/health', undefined, { timeoutMs: 3000 });

/**
 * POST /tasks. `prompt` es imperativo y en inglés (es lo que el modelo del agente lee);
 * `title` son las palabras del usuario, para el HUD y el historial.
 * -> 202 { taskId, queued?, position? }
 */
export const createTask = ({ prompt, title, cwd, mode, timeboxMs, narration, context }) =>
    call('POST', '/tasks', {
        prompt, title, cwd, mode: mode || config.agent.mode,
        timeboxMs: timeboxMs || config.agent.timeboxMs,
        ...(narration ? { narration } : {}),
        ...(context ? { context } : {}),
    });

export const getTask = (taskId) => call('GET', `/tasks/${encodeURIComponent(taskId)}`);
export const listTasks = () => call('GET', '/tasks');

/** decision: 'allow' | 'deny' — by: 'voice' | 'hud' | 'timeout'. `high` por voz -> 409 hud_confirmation_required. */
export const approve = (taskId, approvalId, decision, by) =>
    call('POST', `/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, { decision, by });

export const answer = (taskId, questionId, text) =>
    call('POST', `/tasks/${encodeURIComponent(taskId)}/answer`, { questionId, answer: text });

export const cancel = (taskId, reason = 'user') =>
    call('POST', `/tasks/${encodeURIComponent(taskId)}/cancel`, { reason });

// ── SSE ───────────────────────────────────────────────────────────────────────────────

/**
 * Parser SSE mínimo: acumula líneas hasta la línea en blanco y entrega {id, event, data}.
 * Ignora comentarios (`: keep-alive`), que es como el agente mantiene viva la conexión.
 */
export function makeSseParser(onMessage) {
    let buf = '';
    let cur = { id: null, event: null, data: [] };
    const flush = () => {
        if (cur.data.length) onMessage({ id: cur.id, event: cur.event, data: cur.data.join('\n') });
        cur = { id: null, event: null, data: [] };
    };
    return (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, '');
            buf = buf.slice(nl + 1);
            if (line === '') { flush(); continue; }
            if (line.startsWith(':')) continue;                 // comentario / keep-alive
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'id') cur.id = value;
            else if (field === 'event') cur.event = value;
            else if (field === 'data') cur.data.push(value);
        }
    };
}

/**
 * Se suscribe a GET /events y llama onEvent(envelope) por cada evento. Reconecta solo, con
 * backoff, reanudando desde el último `id` visto (Last-Event-ID). Llama onStatus('up'|'down')
 * en cada transición para que el puente pueda contar el tiempo sin contacto.
 * Devuelve { close() }.
 */
export function subscribe(onEvent, onStatus = () => {}) {
    let closed = false;
    let lastId = null;
    let attempt = 0;
    let ctl = null;

    const loop = async () => {
        while (!closed) {
            ctl = new AbortController();
            try {
                const res = await fetch(`${config.agent.url}${PREFIX}/events`, {
                    headers: headers({ accept: 'text/event-stream', ...(lastId ? { 'last-event-id': lastId } : {}) }),
                    signal: ctl.signal,
                });
                if (!res.ok || !res.body) throw new AgentHttpError(res.status, null, '/events');
                attempt = 0;
                onStatus('up');
                const parse = makeSseParser(({ id, data }) => {
                    if (id) lastId = id;
                    let env;
                    try { env = JSON.parse(data); } catch { return; }   // nunca tumbar el stream por un evento raro
                    if (env && env.v === 'hannah.v0') onEvent(env);
                });
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    parse(dec.decode(value, { stream: true }));
                }
            } catch (e) {
                if (!closed) logger.warn('agent events stream down', { message: e.message, attempt });
            }
            if (closed) break;
            onStatus('down');
            // backoff 1s, 2s, 4s… tope 15s
            const wait = Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4));
            await new Promise((r) => setTimeout(r, wait));
        }
    };
    loop().catch((e) => logger.error('agent subscribe loop died', { message: e.message }));

    return { close() { closed = true; ctl?.abort(); } };
}
