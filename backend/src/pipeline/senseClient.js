// src/pipeline/senseClient.js
// Cliente del sidecar hannah-sense (contrato `sense.v1`, 127.0.0.1:8007). SOLO transporte:
// HTTP + el stream SSE de eventos. No sabe de sesiones, de narración ni de qué significa un
// escalón de la escalera — eso es del puente (senseBridge.js) y del prompt (llm.js).
//
// Casi todo acá es transporte y nada más. La excepción está marcada y es una sola: la
// suscripción SSE mira el `boot=` del sidecar y, cuando cambia, dice en el vocabulario del
// contrato que lo que estaba armado ya no mira. Es el único lugar del backend por donde ese
// hecho pasa, porque el proceso que reinició no puede contarlo (ver `restarted()`).
//
// Contrato verificado contra backend/sidecar/sense/main.py:
//   - GET /health abierto; TODA otra ruta exige el bearer. Ojo con la diferencia: con el token
//     vacío el sidecar responde 401 SIEMPRE (falla cerrado), al revés que la fachada del
//     agente, que sin token abre.
//   - Ningún request lleva `Origin`: el sidecar contesta 403 al que lo lleve, y el fetch de Node
//     no lo pone. Si este archivo alguna vez corriera en un navegador dejaría de funcionar, que
//     es exactamente lo que se quiere.
//   - POST /v1/watches -> 201 {watchId} · 400/403 {error,reason} · 409 {error}.
//   - GET /v1/events: SSE con envelope {v:'sense.v1',watchId,seq,ts,type,data}; `id:` es un
//     cursor global y Last-Event-ID (o ?after=) reanuda desde el anillo del sidecar. El
//     comentario de bienvenida trae `boot=`, la identidad de ESE arranque del sidecar: el cursor
//     solo quiere decir algo adentro del arranque que lo emitió.
//
// A diferencia de agentClient.js, acá NINGUNA función lanza: devuelven { error } como motion.js
// y vision.js. Es deliberado y no una copia mal hecha: el 403 de una ruta denegada trae en
// `reason` justo la frase que Hannah tiene que DECIR, así que el fallo es un dato del que se
// habla y no una excepción que alguien tiene que acordarse de atrapar más arriba.
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Llamada HTTP al sidecar. Nunca lanza: devuelve el JSON, o { error, reason?, status? }.
 * `error` es un código estable para el backend; `reason` es la explicación del sidecar,
 * que es la única que sirve para decírsela al usuario.
 */
async function call(method, path, body, { timeoutMs = 5000 } = {}) {
    // Apagado y ausente son el MISMO estado observable para todo lo de arriba: si se
    // distinguieran, el prompt tendría que aprender la diferencia y ofrecería vigilancias
    // en el caso "apagado pero el proceso está".
    if (!config.sense.enabled) return { error: 'sense_disabled' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const headers = { 'content-type': 'application/json' };
        if (config.sense.token) headers.authorization = `Bearer ${config.sense.token}`;
        const res = await fetch(`${config.sense.url}${path}`, {
            method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* cuerpo no JSON */ }
        if (!res.ok) {
            return { error: json?.error || `http_${res.status}`, reason: json?.reason || '', status: res.status };
        }
        return json ?? {};
    } catch (error) {
        logger.warn('sense sidecar no responde', { path, message: error.message });
        return { error: 'sense_unavailable', message: error.message };
    } finally {
        clearTimeout(t);
    }
}

// ── API ───────────────────────────────────────────────────────────────────────────────

/** GET /health -> { healthy, version, watches: { armed, degraded, blind, suspended } } */
export const health = () => call('GET', '/health', undefined, { timeoutMs: 2000 });

/** GET /v1/capabilities -> { rungs: [{id, available, reason?}], sensors: [kind, ...] } */
export const capabilities = () => call('GET', '/v1/capabilities', undefined, { timeoutMs: 2000 });

/** POST /v1/watches -> { watchId } | { error, reason }. El spec del sensor es TIPADO (regla R2). */
export const createWatch = (watch) => call('POST', '/v1/watches', watch);

export const listWatches = () => call('GET', '/v1/watches', undefined, { timeoutMs: 2000 });
export const getWatch = (watchId) => call('GET', `/v1/watches/${encodeURIComponent(watchId)}`);
export const deleteWatch = (watchId) => call('DELETE', `/v1/watches/${encodeURIComponent(watchId)}`);

// ── Sondas cacheadas ──────────────────────────────────────────────────────────────────
// Las dos se consultan en CADA ensamblado de prompt (y la sonda además en cada turno del
// usuario). Sin cache eso son dos requests HTTP por frase hablada contra un proceso cuyo
// trabajo es estar muestreando. Se cachea también el FALLO: si el sidecar está caído, un
// turno paga el timeout y los siguientes diez segundos no.
const PROBE_TTL_MS = 10000;
const ROWS_TTL_MS = 3000;
const cache = { survey: null, rows: null };

const fresh = (entry, ttl) => entry && Date.now() - entry.at < ttl;

/**
 * La escalera que ESTA máquina puede armar hoy, normalizada e indexada por escalón:
 *   { rungs: { R1: { available, reason }, ... }, sensors: ['proc', ...], error? }
 * El contrato manda una lista; acá se indexa porque todo el que pregunta pregunta por un
 * escalón concreto. Nunca lanza; apagada o caída devuelve la escalera VACÍA, que es lo que
 * hace que el prompt no nombre nada (regla del catálogo de macros).
 */
export async function survey() {
    if (fresh(cache.survey, PROBE_TTL_MS)) return cache.survey.value;
    const raw = await capabilities();
    const value = { rungs: {}, sensors: [] };
    if (raw.error) value.error = raw.error;
    for (const rung of Array.isArray(raw.rungs) ? raw.rungs : []) {
        if (rung && typeof rung.id === 'string') {
            value.rungs[rung.id] = { available: rung.available === true, reason: String(rung.reason || '') };
        }
    }
    if (Array.isArray(raw.sensors)) value.sensors = raw.sensors.filter((s) => typeof s === 'string');
    cache.survey = { at: Date.now(), value };
    return value;
}

/**
 * Las filas de los watches, cacheadas. -> { watches: [...], error? }. Las filas NO llevan
 * valor de muestra, ni línea de log, ni ruta, ni host: eso lo garantiza el sidecar, y quien
 * las mete en el prompt (watchStatus) igual solo copia enums y la etiqueta saneada.
 */
export async function watchRows() {
    if (fresh(cache.rows, ROWS_TTL_MS)) return cache.rows.value;
    const raw = await listWatches();
    const value = raw.error
        ? { watches: [], error: raw.error }
        : { watches: Array.isArray(raw.watches) ? raw.watches : [] };
    cache.rows = { at: Date.now(), value };
    return value;
}

/** Olvida las sondas: después de armar o desarmar, la foto anterior ya es mentira. */
export function invalidate() { cache.survey = null; cache.rows = null; }

// ── SSE ───────────────────────────────────────────────────────────────────────────────

// Los tipos con los que un watch SALE del conjunto vivo. `watch.expired` y `watch.faulted`
// siempre vienen seguidos de un `watch.disarmed`, pero se listan igual: si el anillo truncó el
// replay puede llegar uno solo, y de los dos lados la conclusión es la misma (ya no se mira).
const TERMINAL_TYPES = new Set(['watch.disarmed', 'watch.expired', 'watch.faulted']);

/**
 * Se suscribe a GET /v1/events y llama onEvent(envelope) por cada evento. Reconecta solo,
 * con el mismo backoff que agentClient.subscribe, reanudando desde el último `id` visto
 * (Last-Event-ID). onStatus('up'|'down') marca las transiciones para que el puente pueda
 * contar el tiempo sin contacto (contrato de ceguera, M5.1.4).
 * Devuelve { close() }.
 *
 * Y UNA COSA MÁS, que no es transporte y está acá igual: DETECTA QUE EL SIDECAR REINICIÓ y lo
 * dice en el vocabulario del contrato. Ver `restarted()`.
 */
export function subscribe(onEvent, onStatus = () => {}) {
    let closed = false;
    let lastId = null;
    let attempt = 0;
    let ctl = null;
    // El arranque del sidecar del que venimos leyendo, y los watches que ese arranque anunció
    // armados, con el último `seq` que se entregó de cada uno. Las dos cosas son de ESTA
    // suscripción (una por proceso) y mueren con ella.
    let boot = null;
    const watching = new Map();

    /** Lo que se entregó, para saber después qué se creía armado y con qué `seq` iba. */
    const track = (env) => {
        if (env.type === 'watch.armed') { watching.set(env.watchId, env.seq); return; }
        if (!watching.has(env.watchId)) return;
        if (TERMINAL_TYPES.has(env.type)) watching.delete(env.watchId);
        else watching.set(env.watchId, Math.max(watching.get(env.watchId), env.seq));
    };

    /**
     * El sidecar reinició (`boot` distinto en el comentario de conexión) y hay que DECIRLO.
     *
     * Sin esto, un `systemctl restart` de un segundo deja a la persona creyendo que la miran:
     * `scheduler.shutdown()` publica `watch.disarmed {reason:"shutdown"}` durante el lifespan de
     * FastAPI, pero sse_starlette parchea la salida de uvicorn y mata todo EventSourceResponse
     * apenas llega el SIGTERM, o sea ANTES de ese publish; y el anillo se muere con el proceso,
     * así que tampoco se replaya. Reproducido: el evento queda en el log del sidecar en el cursor
     * 2 y el stream del suscriptor terminó en el 1. Un `kill -9` no emite nada, ni siquiera eso.
     * Del lado del backend el silencio no se nota: reconecta, el stream vuelve a `up`, el reloj de
     * ceguera se cancela y la reconciliación escribe `suspended` sin una palabra.
     *
     * NO hace falta preguntar la lista para saber que ya nadie mira: la asunción A4 dice que lo
     * persistido vuelve `suspended` y JAMÁS armado, así que un `boot` distinto ya es la prueba de
     * que ningún watch de antes está muestreando. (Si algún día algo volviera armado solo, esto
     * tendría que consultar GET /v1/watches en vez de confiar en A4.)
     *
     * El `seq` sigue la cuenta NUESTRA (+1 sobre el último entregado) y no la del sidecar: allá
     * `_seq` vuelve a 1 en cada arranque (KNOWN-GAPS #23), y el puente descarta todo evento con
     * `seq <= w.seq`, así que un 1 recién nacido se perdería en silencio igual que el original.
     */
    const restarted = () => {
        for (const [watchId, seq] of watching) {
            // Sin `label`: el texto lo escribió el usuario y este archivo no lo tiene. El puente
            // lo saca de la fila del sidecar (getOrAdopt), que es de donde salió la primera vez.
            onEvent({ v: 'sense.v1', watchId, seq: seq + 1, ts: Date.now(),
                type: 'watch.disarmed', data: { reason: 'shutdown' } });
        }
        watching.clear();
    };

    /**
     * `boot=` viaja en el comentario de bienvenida (`sense.v1 connected` o `sense.resume`) desde
     * 1a231ff. Es lo único del stream que distingue "se cayó la conexión" de "se cayó el proceso",
     * que para la persona son cosas opuestas: en la primera sus vigilancias siguen mirando.
     */
    const noteBoot = (comment) => {
        const found = /(?:^|\s)boot=([0-9a-f]+)/.exec(comment);
        if (!found) return;                                 // keep-alive y cualquier otro comentario
        if (boot === null) { boot = found[1]; return; }     // primera conexión: no hay con qué comparar
        if (found[1] === boot) return;
        logger.warn('el sidecar sense reinició: lo que estaba armado ya no mira', { boot: found[1] });
        boot = found[1];
        // El cursor era de un arranque que ya no existe (el anillo nace vacío y vuelve a 0).
        lastId = null;
        restarted();
    };

    const loop = async () => {
        while (!closed) {
            ctl = new AbortController();
            try {
                const headers = { accept: 'text/event-stream' };
                if (config.sense.token) headers.authorization = `Bearer ${config.sense.token}`;
                if (lastId) headers['last-event-id'] = lastId;
                const res = await fetch(`${config.sense.url}/v1/events`, { headers, signal: ctl.signal });
                if (!res.ok || !res.body) throw new Error(`sense /v1/events -> ${res.status}`);
                attempt = 0;
                onStatus('up');
                const parse = makeSseParser(({ id, data }) => {
                    if (id) lastId = id;
                    let env;
                    try { env = JSON.parse(data); } catch { return; }   // nunca tumbar el stream por un evento raro
                    if (!env || env.v !== 'sense.v1') return;
                    track(env);
                    onEvent(env);
                }, noteBoot);
                const reader = res.body.getReader();
                const dec = new TextDecoder();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    parse(dec.decode(value, { stream: true }));
                }
            } catch (e) {
                if (!closed) logger.warn('sense events stream down', { message: e.message, attempt });
            }
            if (closed) break;
            onStatus('down');
            // backoff 1s, 2s, 4s… tope 15s
            const wait = Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4));
            await new Promise((r) => setTimeout(r, wait));
        }
    };
    loop().catch((e) => logger.error('sense subscribe loop died', { message: e.message }));

    return { close() { closed = true; ctl?.abort(); } };
}

/**
 * Parser SSE mínimo: acumula líneas hasta la línea en blanco y entrega {id, event, data}.
 * Los comentarios (`: keep-alive`, `: sense.resume …`) NO son ruido: son como el sidecar
 * mantiene viva la conexión, como avisa que el replay quedó truncado y como dice de qué
 * arranque suyo viene lo que sigue. Se entregan por `onComment`, sin cuerpo y sin flush,
 * porque no forman parte de ningún evento.
 */
export function makeSseParser(onMessage, onComment = () => {}) {
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
            if (line.startsWith(':')) { onComment(line.slice(1).replace(/^ /, '')); continue; }
            const i = line.indexOf(':');
            const field = i < 0 ? line : line.slice(0, i);
            const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
            if (field === 'id') cur.id = value;
            else if (field === 'event') cur.event = value;
            else if (field === 'data') cur.data.push(value);
        }
    };
}
