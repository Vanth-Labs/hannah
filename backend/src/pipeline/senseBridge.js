// src/pipeline/senseBridge.js
// El puente entre la persona y sus "ojos" (el sidecar hannah-sense, :8007). Hermano de
// agentBridge.js y con la misma regla de fondo: UNA SOLA VOZ. El sidecar no habla; cada cosa
// que ve (disparó, se quedó ciego, se le acabó el tiempo, se le rompió el sensor) se le cuenta
// a la persona por el mismo camino por el que le llegan sus manos y sus ojos de cámara
// (processTextTurn), con la orden de relatarlo en una frase y no inventar.
//
// UN puente por proceso, como el del agente y por la misma razón: el stream de :8007 es global,
// N suscriptores se pelearían por el cursor de resume, y vivir en el PROCESO (y no en la
// conexión) es lo que hace que una vigilancia sobreviva a un F5.
//
// Tres cosas son propias de esta feature y no del puente del agente:
//
//  1. LA REGLA DE ENTREGA. `sendTo`/`speak` del agente caen a [...sessions.values()].at(-1), la
//     sesión más reciente, y `speak` se va sin encolar nada si no hay ninguna. Un disparo NO usa
//     ese fallback: se ata a la sesión que armó la vigilancia, y si esa sesión ya no está el
//     disparo se GUARDA en un buzón durable y se cuenta en el próximo attach, una sola vez y con
//     su hora real. Las dos alternativas son inaceptables: leerle un traceback de entrenamiento
//     a quien justo abrió el HUD es una fuga, y perderlo en silencio anula la feature entera.
//  2. LA NARRACIÓN ES EFÍMERA (plan §9): no deja fila en memory.db ni embedding. Ocho horas de
//     vigilancia desalojarían la conversación real de la ventana de 10 turnos y grabarían para
//     siempre lo observado en una base que la propia política del agente marca como sensible.
//  3. EL CONTRATO DE CEGUERA. Si pasan SENSE_BLIND_MS sin muestra, la vigilancia está ciega y
//     hay que DECIRLO. Una vigilancia que cree que está mirando y no está es la peor falla que
//     tiene esta feature, y el caso que ningún evento puede avisar es justo el peor: si el
//     sidecar se muere no manda `watch.blind`, no manda nada. Por eso el reloj de la ceguera
//     también corre acá, sobre el stream caído, y no solo allá sobre las muestras.
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { DATA_DIR } from '../state/dataDir.js';
import * as senseClient from './senseClient.js';
import { clean, hasSession, narrateTo } from './agentBridge.js';

// ── Estado ─────────────────────────────────────────────────────────────────────────────
const watches = new Map();      // watchId -> fila local (NUNCA lleva contenido observado)
const sessions = new Map();     // sessionId -> send (solo para el HUD; la voz la resuelve agentBridge)
let client = senseClient;       // inyectable en init() para probar sin sidecar
let sub = null;
let healthy = false;
let blindTimer = null;
// Los eventos se procesan EN ORDEN: el parser SSE llama sin esperar, y onEvent tiene un await
// adentro (adoptar una vigilancia pide su fila). Sin esta cadena, dos eventos seguidos del mismo
// watch se cruzan y el dedupe por (watchId, seq) deja de valer.
let eventChain = Promise.resolve();
// Las narraciones de vigilancia van de a UNA en todo el proceso. La cola de agentBridge ya
// serializa POR SESIÓN, pero dos vigilancias atadas a sesiones distintas hablarían a la vez por
// los mismos parlantes; y su regla de colapso solo descarta lo viejo del MISMO id, así que dos
// disparos distintos narran los dos (plan §10, "dos vigilancias disparan a la vez").
let narrationChain = Promise.resolve();

// Cuánto se guarda una vigilancia terminada: lo justo para que el HUD muestre por qué se
// desarmó y para contestar una pregunta tardía. Mismo criterio (y mismo número) que el agente.
const FORGET_MS = 5 * 60 * 1000;
// Tope del buzón. Un crash-loop a las 3am no puede convertir el archivo en un log infinito ni
// la vuelta del usuario en veinte frases seguidas. Se tira lo VIEJO: el último disparo es el
// que describe el estado actual.
const INBOX_MAX = 10;

// ── El buzón durable ───────────────────────────────────────────────────────────────────
// Mismo idioma que api/auth.js con el ui-token: ruta override por entorno (los tests no tocan
// data/ del usuario), carpeta 0700 y archivo 0600. Va en data/ y no en el sidecar a propósito:
// lo que hay acá es una entrega pendiente del BACKEND, y el sidecar no sabe de sesiones.
export const INBOX_FILE = process.env.HANNAH_WATCH_INBOX_FILE || path.join(DATA_DIR, 'watch-inbox.json');
let inbox = [];   // [{ watchId, label, at, confidence, fires }]

function loadInbox() {
    try {
        const raw = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
        inbox = Array.isArray(raw?.trips) ? raw.trips : [];
    } catch { inbox = []; }   // no existe, o quedó corrupto: se empieza vacío, nunca se rompe el arranque
}

function saveInbox() {
    try {
        fs.mkdirSync(path.dirname(INBOX_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(INBOX_FILE, JSON.stringify({ v: 'sense.v1', trips: inbox }, null, 2), { mode: 0o600 });
        try { fs.chmodSync(INBOX_FILE, 0o600); } catch { /* fs sin permisos POSIX */ }
    } catch (e) {
        logger.error('No se pudo persistir el buzón de vigilancias', { message: e.message });
    }
}

// ── Utilidades ─────────────────────────────────────────────────────────────────────────
const now = () => Date.now();
const TERMINAL = new Set(['expired', 'disarmed', 'faulted']);
const terminal = (state) => TERMINAL.has(state);

/** Hora del reloj (HH:MM local) del instante REAL del hecho, no del momento en que se cuenta. */
const clockOf = (ms) => new Date(ms).toTimeString().slice(0, 5);

/** "hace 12 min" / "hace 3 h 05 min", en inglés porque es una instrucción para el modelo. */
function agoOf(ms) {
    const mins = Math.max(1, Math.round((now() - ms) / 60000));
    if (mins < 60) return `${mins} min ago`;
    return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, '0')} min ago`;
}

function toSession(sessionId, payload) {
    const send = sessions.get(sessionId);
    if (send) send(payload);
}
// Las vigilancias son del PROCESO, no de la sesión: cualquier HUD conectado muestra las mismas.
// Esto es el estado para la pantalla, no la voz — la voz sí está atada (ver eyes()).
function broadcast(payload) { for (const send of sessions.values()) send(payload); }

function pushState(w) {
    broadcast({ type: 'watch_state', watchId: w.watchId, state: w.state,
        lastSampleAt: w.lastSampleAt || null, samplesOk: w.samplesOk || 0, fires: w.fires || 0 });
}

// ── Lo que dice ────────────────────────────────────────────────────────────────────────
// Una entrada por momento del plan §10. El texto que entra acá es SIEMPRE la etiqueta (las
// palabras del usuario, saneadas) y números: nunca una línea de log, una ruta ni un host. Esa
// es la regla R3 aplicada al único lugar donde el contenido observado podría entrar a la voz.
const EYES = {
    tripped: ({ label, when }) => `"${label}" — the thing you were keeping an eye on for the user — `
        + `STOPPED, and you noticed at ${when}.`,
    tripped_away: ({ label, when, ago }) => `while the user was away, "${label}" — the thing you were `
        + `keeping an eye on — STOPPED at ${when}, ${ago}. Say FIRST that this happened while they `
        + 'were not here, then what it was and at what time.',
    blind: ({ label }) => `you LOST SIGHT of "${label}": right now you are NOT watching it and you do `
        + 'not know whether it is still running. Say exactly that, and do not guess how it is going.',
    recovered: ({ label }) => `you can see "${label}" again and you are watching it like before.`,
    expired: ({ label }) => `the time you agreed to keep an eye on "${label}" is up, so you STOPPED `
        + 'watching it. Say it plainly, so the user does not keep believing someone is looking.',
    faulted: ({ label }) => `the way you were watching "${label}" BROKE, so you are not watching it `
        + 'any more. Say it plainly, and do not promise to try again.',
};

/**
 * El prompt de narración. Cierra con las dos cláusulas que hacen falta acá: la de no inventar
 * (la misma del puente del agente: el evento es la única verdad) y la de que esto solo MIRA —
 * sin ella el 7B ofrece relanzar el entrenamiento, que es exactamente la capacidad que esta
 * fase no tiene (regla R1: el sidecar observa, actuar llega en P5.2).
 */
function eyesPrompt(kind, vars) {
    return `[YOUR EYES] ${EYES[kind](vars)} Tell the user this in ONE short sentence, in your own `
        + 'words, staying in character. Do NOT invent details, numbers or causes: the line above is '
        + 'the only thing you know. You only WATCH: you did not fix or restart anything, and you cannot.';
}

/**
 * Narra por la voz de la persona, ATADA a `sessionId` y en serie con las demás vigilancias.
 * `onLost` corre si la sesión se desconectó entre que esto se encoló y le tocó el turno: la
 * narración NO se le pasa a otra sesión, se la reporta al que llamó (que la guarda en el buzón).
 */
function eyes(sessionId, watchId, kind, vars, onLost) {
    narrationChain = narrationChain.then(async () => {
        // ephemeral: se dice y no se recuerda (plan §9). mustKeep: una vigilancia habla poquísimo;
        // si llegó a la cola es porque pasó algo, y colapsarlo sería perderlo.
        const chain = narrateTo(sessionId, eyesPrompt(kind, vars), { id: watchId, mustKeep: true, ephemeral: true });
        if (!chain) { onLost?.(); return; }
        await chain;
    }).catch((e) => logger.error('narración de vigilancia falló', { message: e.message }));
    return narrationChain;
}

// ── Eventos del sidecar ────────────────────────────────────────────────────────────────
/**
 * La fila local de un watch. `sessionId` NO viaja en el sobre (el contrato no lo lleva) y es lo
 * único que decide a quién se le habla, así que se pide la fila al sidecar. Si no se puede, el
 * watch queda sin dueño y sus disparos van al buzón: es el lado seguro de equivocarse.
 */
async function getOrAdopt(env) {
    const existing = watches.get(env.watchId);
    if (existing) return existing;
    const d = env.data || {};
    const w = {
        watchId: env.watchId, label: clean(d.label, 80) || 'what you are watching',
        state: 'armed', rung: d.rung || null, sensorKind: d.sensorKind || null,
        tier: d.tier || 'observe', expiresAt: d.expiresAt || 0,
        sessionId: null, seq: 0, fires: 0, samplesOk: 0, lastSampleAt: null, blindSpoken: false,
    };
    watches.set(env.watchId, w);
    const row = await client.getWatch(env.watchId);
    if (row && !row.error) {
        w.sessionId = row.sessionId || null;
        w.label = clean(row.label, 80) || w.label;
        w.rung = row.rung || w.rung;
        w.sensorKind = row.sensorKind || w.sensorKind;
        w.expiresAt = row.expiresAt || w.expiresAt;
    }
    return w;
}

export async function onEvent(env) {
    const w = await getOrAdopt(env);
    if (env.seq <= w.seq) return;                     // dedupe / resume: (watchId, seq) monotónico
    w.seq = env.seq;
    const d = env.data || {};

    switch (env.type) {
        case 'watch.armed':
            w.state = 'armed'; w.blindSpoken = false;
            w.rung = d.rung || w.rung; w.sensorKind = d.sensorKind || w.sensorKind;
            w.tier = d.tier || w.tier; w.expiresAt = d.expiresAt || w.expiresAt;
            broadcast({ type: 'watch_armed', watchId: w.watchId, label: w.label, rung: w.rung,
                tier: w.tier, expiresAt: w.expiresAt });
            // Sin narración: la persona YA dijo "listo, miro el log" en el turno que armó.
            break;

        case 'watch.tripped':
            w.fires = d.fires || w.fires + 1;
            w.lastSampleAt = d.at || now();
            deliverTrip(w, { at: d.at || now(), confidence: d.confidence || null, fires: w.fires });
            pushState(w);
            break;

        case 'watch.blind':
            // `reason` del sidecar es vocabulario fijo y va al log, no a la voz: lo que el usuario
            // necesita saber es que nadie está mirando, no por qué falló el stat.
            logger.warn('vigilancia ciega', { watchId: w.watchId, sinceMs: d.sinceMs, reason: d.reason });
            goBlind(w);
            break;

        case 'watch.recovered':
            w.state = 'armed';
            goVisible(w);
            pushState(w);
            break;

        case 'watch.expired':
            w.state = 'expired';
            eyes(w.sessionId, w.watchId, 'expired', { label: w.label });
            break;

        case 'watch.faulted':
            w.state = 'faulted';
            logger.error('sensor de vigilancia roto', { watchId: w.watchId, error: clean(d.error, 120) });
            eyes(w.sessionId, w.watchId, 'faulted', { label: w.label });
            break;

        case 'watch.disarmed':
            w.state = 'disarmed'; w.disarmReason = d.reason || 'user';
            broadcast({ type: 'watch_disarmed', watchId: w.watchId, reason: w.disarmReason });
            // Quién habla y quién no: 'user' lo pidió el usuario y ya lo sabe; 'expired' y
            // 'faulted' ya hablaron en su propio evento; 'shutdown' es que el sidecar se va, o
            // sea CEGUERA, y esa hay que decirla — además marca blindSpoken, así que el reloj de
            // ceguera del stream caído no la va a repetir dentro de dos minutos.
            // `shutdown` NO toca el estado (la fila ya es terminal y el sidecar la va a devolver
            // `suspended` al arrancar): solo dice la frase, que es la misma verdad.
            if (w.disarmReason === 'shutdown') sayBlind(w);
            break;

        default:
            return;                                    // vocabulario desconocido: se ignora, no se rompe
    }

    if (terminal(w.state)) setTimeout(() => watches.delete(w.watchId), FORGET_MS);
}

/** La regla de entrega, en un solo lugar: la sesión que armó, o el buzón. Nunca una tercera. */
function deliverTrip(w, trip) {
    if (!hasSession(w.sessionId)) return toInbox(w.watchId, w.label, trip);
    toSession(w.sessionId, { type: 'watch_tripped', watchId: w.watchId, label: w.label,
        at: trip.at, confidence: trip.confidence });
    eyes(w.sessionId, w.watchId, 'tripped', { label: w.label, when: clockOf(trip.at) },
        () => toInbox(w.watchId, w.label, trip));
}

function toInbox(watchId, label, trip) {
    inbox.push({ watchId, label, at: trip.at, confidence: trip.confidence, fires: trip.fires });
    while (inbox.length > INBOX_MAX) inbox.shift();
    saveInbox();
    logger.info('disparo al buzón: no hay sesión dueña conectada', { watchId, pending: inbox.length });
}

/**
 * Decir que se quedó ciega, UNA vez por episodio. Si no hay a quién decírselo NO se marca como
 * dicha, y la próxima sesión que se conecte se entera (attachSession lo reintenta): una ceguera
 * no es historia, es el estado actual, y sigue siendo verdad cuando el usuario vuelve.
 */
function sayBlind(w) {
    if (w.blindSpoken || !hasSession(w.sessionId)) return;
    w.blindSpoken = true;
    eyes(w.sessionId, w.watchId, 'blind', { label: w.label }, () => { w.blindSpoken = false; });
}

function goBlind(w) {
    if (w.state !== 'blind') { w.state = 'blind'; pushState(w); }
    sayBlind(w);
}

/**
 * Volvió a verla. Solo se anuncia si se anunció la pérdida: si no, estaría avisando de que
 * recuperó algo que nunca dijo haber perdido. Y al revés importa más: haber dicho "no lo estoy
 * mirando" y volver a mirarlo sin decirlo deja al usuario creyendo que no hay nadie.
 */
function goVisible(w) {
    if (!w.blindSpoken) return;
    w.blindSpoken = false;
    eyes(w.sessionId, w.watchId, 'recovered', { label: w.label });
}

// ── Contacto con el sidecar ────────────────────────────────────────────────────────────
/**
 * El reloj de la ceguera del lado del backend. El sidecar tiene el suyo sobre las muestras, pero
 * el caso que importa es el que ese reloj no puede ver: si el proceso muere no manda
 * `watch.blind` ni ninguna otra cosa. Sin esto, matar el sidecar deja a Hannah creyendo que
 * mira, que es la falla que este hito existe para evitar.
 */
function onStreamStatus(status) {
    if (status === 'up') {
        healthy = true;
        if (blindTimer) { clearTimeout(blindTimer); blindTimer = null; }
        reconcile().catch((e) => logger.error('reconciliar vigilancias falló', { message: e.message }));
        return;
    }
    healthy = false;
    if (blindTimer) return;                            // ya hay un reloj corriendo: no se reinicia por cada reintento
    blindTimer = setTimeout(() => {
        blindTimer = null;
        for (const w of watches.values()) if (!terminal(w.state) && w.state !== 'blind') goBlind(w);
    }, config.sense.blindMs);
}

/** Lo que el sidecar diga que está vivo manda sobre lo que recordamos (mismo criterio que el agente). */
async function reconcile() {
    const r = await client.listWatches();
    if (r?.error) return;
    for (const row of r.watches || []) {
        const w = watches.get(row.watchId);
        if (!w) continue;
        w.state = row.state || w.state;
        w.lastSampleAt = row.lastSampleAt ?? w.lastSampleAt;
        w.samplesOk = row.samplesOk ?? w.samplesOk;
        w.fires = row.fires ?? w.fires;
        if (w.state !== 'blind') goVisible(w);
        pushState(w);
    }
}

// ── Sesiones ───────────────────────────────────────────────────────────────────────────
export function attachSession(sessionId, send) {
    sessions.set(sessionId, send);
    for (const w of watches.values()) {
        if (terminal(w.state)) continue;
        // ADOPCIÓN de las huérfanas, que NO es el fallback prohibido y la diferencia es CUÁNDO:
        // aquel elegía oyente en el momento del EVENTO, con la sesión dueña posiblemente viva, y
        // por eso podía leerle a un tercero lo que pasó en el entrenamiento de otro. Acá la dueña
        // ya no existe y lo que pasa es que un humano se está conectando. Es el mismo patrón que
        // agentBridge.attachSession, y sin él un disparo con el HUD abierto (pero recargado)
        // caería al buzón, que se vacía en el próximo attach: podría ser mañana.
        if (!w.sessionId || !sessions.has(w.sessionId)) w.sessionId = sessionId;
        send({ type: 'watch_armed', watchId: w.watchId, label: w.label, rung: w.rung, tier: w.tier, expiresAt: w.expiresAt });
        send({ type: 'watch_state', watchId: w.watchId, state: w.state,
            lastSampleAt: w.lastSampleAt || null, samplesOk: w.samplesOk || 0, fires: w.fires || 0 });
    }
    // "Esto pasó mientras no estabas". Se VACÍA el buzón antes de narrar (y se persiste): si dos
    // pestañas se conectan a la vez, el disparo se cuenta una sola vez. Lo que no se pudo
    // entregar vuelve al buzón, así que "una sola vez" nunca degrada a "ninguna".
    if (inbox.length) {
        const pending = inbox.splice(0, inbox.length);
        saveInbox();
        for (const trip of pending) replay(sessionId, trip);
    }
    // Una ceguera que sigue siendo verdad se dice ahora: no es historia, es el estado actual.
    for (const w of watches.values()) if (w.state === 'blind') sayBlind(w);
}

function replay(sessionId, trip) {
    toSession(sessionId, { type: 'watch_tripped', watchId: trip.watchId, label: trip.label,
        at: trip.at, confidence: trip.confidence });
    eyes(sessionId, trip.watchId, 'tripped_away',
        { label: clean(trip.label, 80), when: clockOf(trip.at), ago: agoOf(trip.at) },
        () => { inbox.push(trip); saveInbox(); });
}

export function detachSession(sessionId) {
    sessions.delete(sessionId);
    // La vigilancia NO se muere con la sesión: vive en el sidecar y sigue mirando (plan §10: el
    // sessionId es una preferencia de entrega, no la vida del watch). Si queda otro HUD abierto,
    // se le pasa a ese; si no queda ninguno, se queda sin dueño y lo que dispare va al buzón.
    // Dejarla huérfana con alguien conectado sería mandar al buzón un disparo que el usuario está
    // ahí para escuchar, y el buzón se vacía recién en el próximo attach: podría ser mañana.
    const heir = [...sessions.keys()].at(-1) || null;
    for (const w of watches.values()) if (w.sessionId === sessionId) w.sessionId = heir;
}

// ── API para el resto del backend ──────────────────────────────────────────────────────
export const isHealthy = () => healthy;
export const snapshot = () => [...watches.values()].map(({ watchId, label, state, rung, sensorKind, fires, sessionId }) =>
    ({ watchId, label, state, rung, sensorKind, fires, sessionId }));
export const pendingTrips = () => inbox.length;

/** Desarma (HUD o DELETE). El sidecar es el dueño; acá solo se le pide y se invalida la foto. */
export async function disarm(watchId) {
    const r = await client.deleteWatch(watchId);
    senseClient.invalidate();
    return r;
}

/**
 * El contador para GET /api/v1/health. Se arma de las FILAS del sidecar (la verdad) y no del
 * estado local. `degraded` es una vigilancia a la que se le bajó el tier de acción: en esta fase,
 * que solo observa, es siempre 0 — el campo se mantiene para que la forma no cambie después.
 */
export async function watchCounters() {
    const { watches: rows, error } = await senseClient.watchRows();
    const counters = { armed: 0, degraded: 0, blind: 0, suspended: 0, lastSampleAt: null };
    if (error) return { ...counters, error };
    for (const row of rows) {
        if (row.state === 'armed') counters.armed++;
        else if (row.state === 'blind') counters.blind++;
        else if (row.state === 'suspended') counters.suspended++;
        if (row.lastSampleAt && row.lastSampleAt > (counters.lastSampleAt || 0)) counters.lastSampleAt = row.lastSampleAt;
    }
    return counters;
}

// ── Ciclo de vida ──────────────────────────────────────────────────────────────────────
/**
 * Arranca el puente. `deps.client` inyecta el cliente HTTP para probar sin sidecar. Si las
 * vigilancias están apagadas por config, no hace nada y todo lo demás es no-op.
 */
export async function init(deps = {}) {
    client = deps.client || senseClient;
    if (!config.sense.enabled) { logger.info('sense: disabled (SENSE_ENABLED=false)'); return; }
    loadInbox();
    if (inbox.length) logger.info('buzón de vigilancias con entregas pendientes', { pending: inbox.length });
    // Adoptar lo que el sidecar ya tenga (backend reiniciado con vigilancias armadas). Vienen sin
    // dueño: la sesión que las armó murió con el proceso anterior, y la próxima que attachee las
    // adopta. Nunca se re-arma nada desde acá (asunción A4: re-armar no es consentimiento).
    const r = await client.listWatches();
    for (const row of (r?.watches || [])) {
        watches.set(row.watchId, { watchId: row.watchId, label: clean(row.label, 80), state: row.state,
            rung: row.rung, sensorKind: row.sensorKind, tier: 'observe', expiresAt: row.expiresAt,
            sessionId: null, seq: 0, fires: row.fires || 0, samplesOk: row.samplesOk || 0,
            lastSampleAt: row.lastSampleAt || null, blindSpoken: false });
    }
    if (r?.error) logger.warn('sense: sidecar NO alcanzable al arrancar', { error: r.error });
    sub = client.subscribe(
        (env) => { eventChain = eventChain.then(() => onEvent(env)).catch((e) => logger.error('evento de vigilancia falló', { message: e.message })); },
        onStreamStatus);
}

/** Apagado limpio: se corta el stream y se PERSISTE el buzón (lo pendiente no se pierde). */
export async function shutdown() {
    if (blindTimer) { clearTimeout(blindTimer); blindTimer = null; }
    sub?.close(); sub = null;
    saveInbox();
}

// Solo para tests: estado limpio entre casos.
export function _reset() {
    watches.clear(); sessions.clear(); inbox = [];
    eventChain = Promise.resolve(); narrationChain = Promise.resolve();
    client = senseClient; healthy = false;
    if (blindTimer) { clearTimeout(blindTimer); blindTimer = null; }
    sub?.close(); sub = null;
}
export const _settle = () => eventChain.then(() => narrationChain).then(() => {});
