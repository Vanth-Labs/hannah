// src/pipeline/agentBridge.js
// El puente entre la persona y sus "manos" (el sidecar hannah-agent), y el lugar donde se
// hace cumplir la regla que gobierna todo esto: UNA SOLA VOZ.
//
// El agente nunca habla. Cada evento real que produce (aceptó, plan, progreso, pide permiso,
// terminó, falló) se le cuenta a la persona por el MISMO camino por el que le llegan "sus
// ojos" (processTextTurn, el de la visión), con la orden de relatarlo en una frase y no
// inventar. La fuente de verdad es el stream de eventos; la voz es la persona. Así lo que
// dice el 7B no puede diferir de lo que hizo el agente: solo puede relatar lo que le llegó.
//
// Implementa hannah-agent/docs/INTEGRATION.md §4.2–§6 sobre el backend actual. Un puente por
// proceso (el stream de eventos del agente es global), N sesiones.
//
// `processTextTurn` (y el cliente HTTP, `deps.client`) se INYECTAN en init() en vez de importarse: el orquestador importa este
// módulo (para routeUtterance), y un ciclo ESM ahí es frágil. De paso, la narración se prueba
// con un espía en vez de con un modelo.
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import * as agentClient from './agentClient.js';

// ── Estado ─────────────────────────────────────────────────────────────────────────────
const tasks = new Map();        // taskId -> Task
const sessions = new Map();     // sessionId -> { send, speechStartedAt }
let agent = agentClient;        // el cliente HTTP; inyectable en init() para probar sin red
let narrate = null;             // (sessionId, prompt, send) => Promise  (processTextTurn inyectado)
let classify = null;            // (question, utterance) => Promise<'ALLOW'|'DENY'|'CANCEL'|'ANSWER'|'OTHER'>
let sub = null;
let healthy = false;
let downSince = null;
let lostTimer = null;

const TIMELINE_MAX = 200;

// ── Traducción evento -> mensaje WS (INTEGRATION §4.2) ────────────────────────────────
// Los nombres son los del diseño original del compañero, para que un frontend escrito
// contra ellos encaje. `kind` le dice al panel qué produjo la entrada sin que aprenda el
// vocabulario del motor.
const WS_TYPE = {
    'task.accepted': 'agent_task_started',
    'task.started': 'agent_task_progress', 'task.plan': 'agent_task_progress',
    'task.progress': 'agent_task_progress', 'task.tool': 'agent_task_progress',
    'task.output': 'agent_task_progress', 'task.approval.resolved': 'agent_task_progress',
    'task.answered': 'agent_task_progress',
    'task.approval.requested': 'agent_approval_request',
    'task.question': 'agent_question',
    'task.completed': 'agent_task_done', 'task.failed': 'agent_task_done', 'task.cancelled': 'agent_task_done',
};

// Qué se narra SIEMPRE (INTEGRATION §3/§6). task.progress va aparte, con presupuesto.
const ALWAYS_NARRATE = new Set(['task.accepted', 'task.approval.requested', 'task.question',
    'task.completed', 'task.failed', 'task.cancelled']);

// ── Utilidades ─────────────────────────────────────────────────────────────────────────
const now = () => Date.now();

function sendTo(sessionId, payload) {
    const s = sessions.get(sessionId) || [...sessions.values()].at(-1);   // sesión dueña, o la más reciente
    if (s) s.send(payload);
}

function terminal(state) { return state === 'completed' || state === 'failed' || state === 'cancelled'; }

// SANEADO. Todo texto que viene del agente (summary, text, answer, title) es salida de OTRO
// modelo que a su vez leyó archivos y comandos del usuario: puede contener cualquier cosa, incluido
// "[RUN: rm -rf ~]". Si eso entrara crudo al prompt de la persona con el bucle de acciones activo,
// se ejecutaría de verdad. Se quitan los delimitadores de tag, se colapsa a una línea y se acota.
export function clean(str, max = 200) {
    return String(str ?? '').replace(/[[\]()*`#_]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Prompt de narración. La persona es informada de un hecho, no consultada sobre él. */
function narrationPrompt(task, event) {
    const raw = event.data || {};
    const d = { ...raw, summary: clean(raw.summary), text: clean(raw.text), error: clean(raw.error),
        answer: clean(raw.answer, 1200), options: Array.isArray(raw.options) ? raw.options.map((o) => clean(o, 60)) : raw.options };
    task = { ...task, title: clean(task.title, 80) };
    const what = {
        'task.accepted': `you just took on the task "${task.title}".`,
        'task.plan': `your plan for "${task.title}": ${d.summary || (d.steps || []).join('; ')}.`,
        'task.progress': `progress on "${task.title}": ${d.summary}.`,
        'task.approval.requested': `for "${task.title}" your hands need permission to: ${d.summary}${d.risk === 'high' ? ' (HIGH risk: the user must press the button in the HUD, saying yes is not enough)' : ''}. Ask the user for a yes or no.`,
        'task.question': `for "${task.title}" your hands need to know: ${d.text}${d.options?.length ? ` (options: ${d.options.join(' / ')})` : ''}. Ask the user.`,
        'task.completed': `"${task.title}" is DONE: ${d.summary}${d.answer ? ` — the answer: ${d.answer}` : ''}.`,
        'task.failed': `"${task.title}" FAILED: ${d.summary || d.error}.`,
        'task.cancelled': `"${task.title}" was cancelled (${d.reason || 'user'}).`,
        'lost_contact': `you LOST CONTACT with your hands while "${task.title}" was running; you do not know whether it finished.`,
        'approval.timeout': `nobody answered in time, so your hands did NOT do this for "${task.title}": ${d.summary}.`,
        'approval.hud_required': `the user said yes by voice to "${d.summary}", but that action is HIGH risk and needs the button in the HUD; tell them to press it.`,
        'dispatch.failed': `you could NOT hand "${task.title}" to your hands (${d.summary}); you said you were on it, so correct yourself honestly and briefly.`,
    }[event.type] || `${event.type} on "${task.title}": ${d.summary || ''}.`;
    // "Do NOT invent" es la cláusula que cierra la voz única: el evento es la única verdad.
    return `[YOUR HANDS] ${what} Tell the user this in ONE short sentence, in your own words, `
        + `staying in character. Do NOT invent details, steps or results: the event above is the `
        + `only truth about this task.`;
}

// UNA voz = UNA narración a la vez, y nunca encima del usuario. Sin esto, dos eventos seguidos
// (accepted -> approval.requested llegan con milisegundos de diferencia) lanzaban dos pipelines
// LLM+TTS en paralelo y sus oraciones se intercalaban en la cola de audio del cliente; y una
// narración arrancaba mientras aún sonaba el propio turno de la persona. La cola espera a que
// termine el turno activo y la narración anterior, y las narrables acumuladas se colapsan a
// la más reciente (INTEGRATION §6) — salvo aprobaciones/preguntas, que nunca se pierden.
const narrationQueue = new Map();   // sessionId -> { chain: Promise, pending: [] }

async function speak(task, event) {
    if (!narrate) return;
    const s = sessions.get(task.sessionId) || [...sessions.values()].at(-1);
    if (!s) return;
    const sessionId = [...sessions.entries()].find(([, v]) => v === s)?.[0] || task.sessionId;
    task.lastNarratedAt = now();
    const q = narrationQueue.get(sessionId) || { chain: Promise.resolve(), pending: [] };
    narrationQueue.set(sessionId, q);
    const mustKeep = event.type === 'task.approval.requested' || event.type === 'task.question';
    // colapsar: si ya hay narrables esperando de esta tarea y esta no es una pregunta, la nueva
    // reemplaza a las viejas (lo último que pasó es lo que importa)
    if (!mustKeep) q.pending = q.pending.filter((p) => p.task.taskId !== task.taskId || p.mustKeep);
    q.pending.push({ task, event, mustKeep });
    q.chain = q.chain.then(async () => {
        const item = q.pending.shift();
        if (!item) return;
        // esperar a que el usuario/persona terminen el turno en curso (hasta 20s)
        for (let i = 0; i < 100 && s.turnActive; i++) await new Promise((r) => setTimeout(r, 200));
        const ctl = new AbortController();
        s.narrating = ctl;   // barge-in (SPEECH_START/INTERRUPT) aborta ESTA narración, no la tarea
        try {
            await narrate(sessionId, narrationPrompt(item.task, item.event), s.send, { noActions: true, signal: ctl.signal });
        } catch (e) {
            logger.error('agent narration failed', { message: e.message });
        } finally {
            if (s.narrating === ctl) s.narrating = null;
        }
    });
    return q.chain;
}

/** Barge-in: aborta la narración en curso de la sesión (la tarea sigue). */
export function abortNarration(sessionId) {
    const s = sessions.get(sessionId);
    if (s?.narrating) { s.narrating.abort(); s.narrating = null; }
}

// ── Eventos del agente ─────────────────────────────────────────────────────────────────
function getOrAdopt(env) {
    let t = tasks.get(env.taskId);
    if (!t) {
        // Tarea que este proceso no vio nacer (backend reiniciado a mitad): se adopta sin narrar
        // el arranque — al usuario ya se lo dijeron. INTEGRATION §5.
        t = { taskId: env.taskId, title: env.data?.title || 'task', state: 'running', timeline: [],
            pending: null, lastNarratedAt: 0, seq: 0, sessionId: null, adopted: true };
        tasks.set(env.taskId, t);
    }
    return t;
}

export async function onEvent(env) {
    const t = getOrAdopt(env);
    if (env.seq <= t.seq) return;                       // dedupe / resume: (taskId, seq) monotónico
    t.seq = env.seq;
    const d = env.data || {};
    const wsType = WS_TYPE[env.type];
    if (!wsType) return;                                // vocabulario desconocido: se ignora, no se rompe

    switch (env.type) {
        case 'task.accepted': t.title = clean(d.title, 80) || t.title; t.state = d.queued ? 'queued' : 'running'; break;
        case 'task.started': t.state = 'running'; break;
        case 'task.approval.requested':
            t.state = 'awaiting_approval';
            t.pending = { kind: 'approval', id: d.approvalId, askedAt: now(), expiresAt: now() + (d.timeoutMs || 120000),
                risk: d.risk || 'medium', summary: d.summary };
            break;
        case 'task.question':
            t.state = 'awaiting_answer';
            t.pending = { kind: 'question', id: d.questionId, askedAt: now(), expiresAt: now() + (d.timeoutMs || 120000),
                risk: 'low', summary: d.text, options: d.options };
            break;
        case 'task.approval.resolved': case 'task.answered':
            if (t.pending) t.pending = null;
            t.state = 'running';
            break;
        case 'task.completed': t.state = 'completed'; break;
        case 'task.failed': t.state = 'failed'; break;
        case 'task.cancelled': t.state = 'cancelled'; break;
        default: break;
    }
    t.lastSummary = d.summary || d.text || t.lastSummary;
    t.timeline.push({ type: env.type, ts: env.ts, data: d });
    if (t.timeline.length > TIMELINE_MAX) t.timeline.shift();

    // HUD: siempre, todo.
    const msg = { type: wsType, taskId: t.taskId, title: t.title, state: t.state, kind: env.type.replace('task.', ''), data: d };
    if (env.type === 'task.approval.requested' || env.type === 'task.question') msg.expiresAt = t.pending.expiresAt;
    if (env.type === 'task.approval.resolved' && d.by === 'timeout') msg.timedOut = true;
    sendTo(t.sessionId, msg);

    // Voz: lo que el contrato marca como narrable, con presupuesto para el progreso.
    // speak() ENCOLA (no se espera acá): el stream de eventos nunca se bloquea detrás del TTS.
    if (ALWAYS_NARRATE.has(env.type)) {
        if (!(env.type === 'task.accepted' && t.adopted)) speak(t, env);
    } else if (env.type === 'task.progress') {
        // #6: un progress con answer:true es media respuesta truncada; se narra la completa después.
        if (d.answer !== true && now() - t.lastNarratedAt >= config.agent.narrateProgressMs) speak(t, env);
    } else if (env.type === 'task.approval.resolved' && d.by === 'timeout') {
        speak(t, { type: 'approval.timeout', data: { summary: d.summary || t.pending?.summary || '' } });
    }

    if (terminal(t.state)) setTimeout(() => tasks.delete(t.taskId), 5 * 60 * 1000);   // 5 min para consultas tardías
}

// ── Despacho: [TASK:] -> POST /tasks ───────────────────────────────────────────────────
/**
 * Manda una tarea al agente. `description` es lo que emitió la persona en [TASK: …] (imperativo,
 * en inglés); `title` son las palabras del usuario. Devuelve {taskId} o {error}.
 * Si el agente no está sano, NO lanza: devuelve {error:'agent_unavailable'} y el que llama
 * degrada a conversación.
 */
export async function dispatch(sessionId, description, { title, language, conversationSummary, cwd } = {}) {
    if (!config.agent.enabled) return { error: 'agent_disabled' };
    if (!healthy) return { error: 'agent_unavailable' };
    try {
        const r = await agent.createTask({
            prompt: description, title: title || description.slice(0, 60), cwd,
            context: { language: language || 'en', conversationSummary },
        });
        tasks.set(r.taskId, { taskId: r.taskId, title: clean(title || description, 60), state: r.queued ? 'queued' : 'accepted',
            timeline: [], pending: null, lastNarratedAt: 0, seq: 0, sessionId, adopted: false });
        logger.info('agent task dispatched', { taskId: r.taskId, queued: !!r.queued });
        return { taskId: r.taskId, queued: !!r.queued, position: r.position };
    } catch (e) {
        const r = e.status === 409 ? { error: 'agent_busy', activeTaskId: e.body?.activeTaskId } : { error: 'agent_error' };
        logger.error('agent dispatch failed', { message: e.message, status: e.status });
        return r;
    }
}

/** El despacho falló después de que la persona dijera "voy": se lo cuenta y avisa al HUD. */
export function reportDispatchFailure(sessionId, title, reason) {
    const why = { agent_busy: 'the queue is full', agent_unavailable: 'your hands are not reachable', agent_disabled: 'your hands are switched off', agent_error: 'your hands rejected the request' }[reason] || reason;
    sendTo(sessionId, { type: 'agent_command_failed', command: 'dispatch', reason });
    speak({ taskId: 'none', title, sessionId }, { type: 'dispatch.failed', data: { summary: why } });
}

// ── Aprobaciones y respuestas (HUD y voz) ──────────────────────────────────────────────
export async function decide(taskId, approvalId, decision, by) {
    const t = tasks.get(taskId);
    try {
        await agent.approve(taskId, approvalId, decision, by);
        return { ok: true };
    } catch (e) {
        // `high` por voz: el agente se niega (T7). Se dice POR QUÉ el "sí" no funcionó.
        // La fachada responde 409 al "sí" por voz sobre un `high` (T7). Se detecta por status +
        // ruta (aprobación), no por un texto de error que puede cambiar.
        if (e.status === 409 && by === 'voice' && t) {
            sendTo(t.sessionId, { type: 'agent_command_failed', command: 'approval', taskId, reason: 'hud_confirmation_required' });
            await speak(t, { type: 'approval.hud_required', data: { summary: t.pending?.summary || '' } });
            return { ok: false, reason: 'hud_confirmation_required' };
        }
        if (t) sendTo(t.sessionId, { type: 'agent_command_failed', command: 'approval', taskId, reason: e.message });
        return { ok: false, reason: e.message };
    }
}

export async function reply(taskId, questionId, text) {
    const t = tasks.get(taskId);
    try { await agent.answer(taskId, questionId, text); return { ok: true }; } catch (e) {
        if (t) sendTo(t.sessionId, { type: 'agent_command_failed', command: 'answer', taskId, reason: e.message });
        return { ok: false, reason: e.message };
    }
}

export async function cancelTask(taskId, reason = 'user') {
    const t = tasks.get(taskId);
    try { await agent.cancel(taskId, reason); return { ok: true }; } catch (e) {
        if (t) sendTo(t.sessionId, { type: 'agent_command_failed', command: 'cancel', taskId, reason: e.message });
        return { ok: false, reason: e.message };
    }
}

// ── Voz: ¿este enunciado responde a una pregunta pendiente? (INTEGRATION §4.3) ─────────
// Tres reglas que el código HACE CUMPLIR en vez de confiar:
//  1. Solo cuenta un enunciado que EMPEZÓ después de la pregunta (startedAt > askedAt).
//     Hablar por encima de la pregunta no puede concederla.
//  2. Atajo léxico para lo inequívoco ("sí"/"no"/"para"): sin latencia de modelo, y un
//     clasificador muerto no deja a Hannah sorda a un "yes".
//  3. La ambigüedad NUNCA concede: cualquier otra salida deja la aprobación pendiente, y una
//     aprobación pendiente expira en deny.
const YES = /^\s*(s[ií]|dale|ok(ay)?|yes|yeah|yep|sure|go ahead|hazlo|do it|adelante)[\s.!]*$/i;
const NO = /^\s*(no|nope|nah|mejor no|don'?t)[\s.!]*$/i;
const STOP = /^\s*(para|par[aá]lo|cancela|cancel(a|ar)?(lo)?|d[eé]jalo|stop|abort|forget it|olv[ií]dalo)[\s.!]*$/i;

function pendingTaskFor(sessionId) {
    for (const t of tasks.values()) {
        if (t.pending && (t.sessionId === sessionId || t.sessionId === null)) return t;
    }
    return null;
}

/**
 * Devuelve true si el enunciado se consumió como respuesta a una aprobación/pregunta (y por
 * tanto NO debe entrar al pipeline conversacional). false = conversación normal.
 */
export async function routeUtterance(sessionId, text, startedAt) {
    const t = pendingTaskFor(sessionId);
    if (!t) return false;
    const p = t.pending;
    if (!startedAt || startedAt <= p.askedAt) return false;            // regla 1
    const u = String(text || '').trim();
    let intent = null;
    if (STOP.test(u)) intent = 'CANCEL';
    else if (p.kind === 'approval' && YES.test(u)) intent = 'ALLOW';
    else if (p.kind === 'approval' && NO.test(u)) intent = 'DENY';
    else if (classify) {
        try { intent = await classify(p.summary, u, p.kind); } catch { intent = 'OTHER'; }
        if (!['ALLOW', 'DENY', 'CANCEL', 'ANSWER'].includes(intent)) intent = 'OTHER';   // regla 3
    }
    switch (intent) {
        case 'ALLOW': await decide(t.taskId, p.id, 'allow', 'voice'); return true;
        case 'DENY': await decide(t.taskId, p.id, 'deny', 'voice'); return true;
        case 'CANCEL': await cancelTask(t.taskId, 'user'); return true;
        case 'ANSWER': if (p.kind === 'question') { await reply(t.taskId, p.id, u); return true; } return false;
        default: return false;                                            // unrelated: sigue pendiente
    }
}

// ── Estado para el prompt: lo que la persona SABE de sus manos ─────────────────────────
/** Línea(s) de estado para inyectar en el system prompt cuando hay tareas vivas. */
export function handsStatus() {
    const live = [...tasks.values()].filter((t) => !terminal(t.state) || now() - (t.timeline.at(-1)?.ts || 0) < 60000);
    if (!live.length) return '';
    return '\n\n[HANDS STATUS] ' + live.slice(0, 5).map((t) =>
        `"${clean(t.title, 80)}": ${t.state}${t.lastSummary ? `, last: ${clean(t.lastSummary, 160)}` : ''}`).join(' | ')
        + '\nIf the user asks how a task is going, answer from this status only.';
}

export const isHealthy = () => healthy;
export const snapshot = () => [...tasks.values()].map(({ taskId, title, state, pending, lastSummary }) => ({ taskId, title, state, pending: !!pending, lastSummary }));

// ── Sesiones (registro para poder empujar eventos a la sesión correcta) ────────────────
export function attachSession(sessionId, send) {
    sessions.set(sessionId, { send, speechStartedAt: 0, turnActive: false, narrating: null });
    // Reproducir la línea de tiempo de las tareas vivas: un cliente que se conecta a mitad de
    // tarea (o recarga el navegador) ve el estado, no una pantalla vacía.
    for (const t of tasks.values()) {
        if (terminal(t.state)) continue;
        if (t.sessionId === null || !sessions.has(t.sessionId)) t.sessionId = sessionId;
        send({ type: 'agent_task_started', taskId: t.taskId, title: t.title, state: t.state, kind: 'replay', data: {} });
        if (t.pending) send({ type: t.pending.kind === 'approval' ? 'agent_approval_request' : 'agent_question',
            taskId: t.taskId, title: t.title, state: t.state, kind: t.pending.kind, expiresAt: t.pending.expiresAt,
            data: { [t.pending.kind === 'approval' ? 'approvalId' : 'questionId']: t.pending.id, summary: t.pending.summary, risk: t.pending.risk, options: t.pending.options } });
    }
}
export function detachSession(sessionId) {
    sessions.delete(sessionId);
    // Las tareas de esta sesión quedan sin dueño: la próxima sesión (recarga, reconexión) las
    // adopta en attachSession y las aprobaciones por voz vuelven a enrutarse.
    for (const t of tasks.values()) if (t.sessionId === sessionId) t.sessionId = null;
}
export function markSpeechStart(sessionId) { const s = sessions.get(sessionId); if (s) s.speechStartedAt = now(); }
export function speechStartedAt(sessionId) { return sessions.get(sessionId)?.speechStartedAt || 0; }
export function setTurnActive(sessionId, active) { const s = sessions.get(sessionId); if (s) s.turnActive = active; }

// ── Ciclo de vida ──────────────────────────────────────────────────────────────────────
async function expireLoop() {
    for (const t of tasks.values()) {
        if (t.pending && now() > t.pending.expiresAt) {
            // Silencio = no. Se le dice al usuario que NO se hizo, para que no crea que sí.
            const p = t.pending; t.pending = null;
            if (p.kind === 'approval') await decide(t.taskId, p.id, 'deny', 'timeout').catch(() => {});
            await speak(t, { type: 'approval.timeout', data: { summary: p.summary } });
        }
    }
}

function onStreamStatus(status) {
    if (status === 'up') {
        healthy = true; downSince = null;
        if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
        // Reconciliar: lo que el agente diga que está vivo manda sobre lo que recordamos.
        agent.listTasks().then((r) => {
            for (const row of (r?.tasks || r || [])) {
                const t = tasks.get(row.id || row.taskId);
                if (t && row.state) t.state = row.state;
            }
        }).catch(() => {});
        return;
    }
    healthy = false; downSince = downSince || now();
    if (lostTimer) return;
    lostTimer = setTimeout(async () => {
        lostTimer = null;
        // Perdida, no terminada: honestidad antes que optimismo (INTEGRATION §5).
        for (const t of tasks.values()) {
            if (terminal(t.state)) continue;
            t.state = 'failed'; t.lostContact = true;
            sendTo(t.sessionId, { type: 'agent_task_done', taskId: t.taskId, title: t.title, state: 'failed', kind: 'lost_contact', data: { error: 'lost_contact' } });
            await speak(t, { type: 'lost_contact', data: {} });
        }
    }, config.agent.lostContactMs);
}

let expireTimer = null;

/**
 * Arranca el puente. `deps.narrate` es processTextTurn (inyectado); `deps.classify` es el
 * clasificador de intención de una palabra (inyectado, opcional). Si el agente está
 * apagado por config, no hace nada y todo lo demás es no-op.
 */
export async function init(deps = {}) {
    narrate = deps.narrate || null;
    classify = deps.classify || null;
    agent = deps.client || agentClient;
    if (!config.agent.enabled) { logger.info('agent: disabled (AGENT_ENABLED=false)'); return; }
    try {
        const h = await agent.health();
        healthy = !!h?.healthy;
        logger.info('agent: sidecar reachable', { version: h?.version, activeTasks: h?.activeTasks });
        // Adoptar lo que ya esté corriendo (backend reiniciado a mitad de tarea).
        const r = await agent.listTasks().catch(() => null);
        for (const row of (r?.tasks || r || [])) {
            const id = row.id || row.taskId;
            if (id && row.state && !terminal(row.state)) tasks.set(id, { taskId: id, title: row.title || 'task', state: row.state,
                timeline: [], pending: null, lastNarratedAt: 0, seq: 0, sessionId: null, adopted: true });
        }
    } catch (e) {
        healthy = false;
        logger.warn('agent: sidecar NOT reachable — [TASK:] stays out of the prompt', { message: e.message });
    }
    sub = agent.subscribe((env) => onEvent(env).catch((e) => logger.error('agent event failed', { message: e.message })), onStreamStatus);
    expireTimer = setInterval(() => expireLoop().catch(() => {}), 1000);
}

/** Apagado limpio: cancela la tarea activa con reason "shutdown" (INTEGRATION §5). */
export async function shutdown() {
    if (expireTimer) clearInterval(expireTimer);
    sub?.close();
    for (const t of tasks.values()) {
        if (!terminal(t.state)) await agent.cancel(t.taskId, 'shutdown').catch(() => {});
    }
}

// Solo para tests: estado limpio entre casos.
export function _reset() {
    tasks.clear(); sessions.clear(); narrationQueue.clear(); narrate = null; classify = null; healthy = false; agent = agentClient;
    if (expireTimer) { clearInterval(expireTimer); expireTimer = null; }
    if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; }
}
export function _setHealthy(v) { healthy = v; }
