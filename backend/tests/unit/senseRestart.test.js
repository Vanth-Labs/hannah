// tests/unit/senseRestart.test.js
// UN PROCESO SE MUERE Y VUELVE, Y LOS DOS LADOS TIENEN QUE SEGUIR DICIENDO LA VERDAD. Son dos
// reinicios distintos y este archivo cubre los dos, porque comparten cable: el del SIDECAR (la
// persona tiene que enterarse de que ya nadie mira) y el del BACKEND (lo que ya se dijo no puede
// volver a decirse).
//
// La falla que este archivo existe para atrapar es la peor que tiene la feature entera, y es
// silenciosa: `systemctl restart hannah-sense` tarda un segundo, o sea muchísimo menos que
// SENSE_BLIND_MS (120 s), así que el reloj de ceguera del backend ni se despierta. El backend
// reconecta, el stream vuelve a `up`, la reconciliación escribe `suspended` y NADIE dice nada.
// La vigilancia de verdad no está muestreando (asunción A4: lo persistido vuelve suspendido,
// nunca armado) y la persona que la armó sigue creyendo que la miran.
//
// El `watch.disarmed {reason:"shutdown"}` que el sidecar publica en su apagado NO llega: en el
// proceso real sse_starlette parchea la salida de uvicorn y mata todo EventSourceResponse apenas
// entra el SIGTERM, ANTES del lifespan que publica; y con `kill -9` no se publica nada. Por eso
// el sidecar de mentira de este archivo NO EMITE NADA AL MORIRSE: si emitiera el evento de
// apagado (que es lo que dice el código del sidecar, leído sin correrlo) el test pasaría contra
// un backend roto, que es exactamente la clase de espía que no sirve.
//
// Nada está mockeado del lado del backend: se usa el senseClient DE VERDAD contra un sidecar de
// mentira que habla SSE por un socket TCP de verdad, y el reinicio es un reinicio (se cierra el
// servidor, se destruyen las conexiones, se vuelve a escuchar en el mismo puerto con OTRO
// `boot`). Lo que se afirma es de comportamiento: después del reinicio, ALGO SE DICE. No que se
// haya llamado tal función.
import { jest } from '@jest/globals';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key';
process.env.SENSE_ENABLED = 'true';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hannah-sense-restart-'));
process.env.HANNAH_WATCH_INBOX_FILE = path.join(tmp, 'watch-inbox.json');

const { config } = await import('../../src/config.js');
const { conversationManager } = await import('../../src/state/conversationManager.js');
const agentBridge = await import('../../src/pipeline/agentBridge.js');
const bridge = await import('../../src/pipeline/senseBridge.js');

// ── El sidecar de mentira ──────────────────────────────────────────────────────────────
/**
 * Habla el mismo cable que backend/sidecar/sense/main.py: comentario de bienvenida con
 * `boot=` (el de `sense.v1 connected` o el de `sense.resume`), eventos con `id:` de cursor
 * global y `seq` por watch, y GET /v1/watches con las filas del contrato.
 *
 * Las tres cosas que copia del sidecar de verdad y que hacen que el test pueda fallar como
 * falla la máquina:
 *   1. al morir no emite NADA (ver el encabezado);
 *   2. al arrancar de nuevo el `boot` es otro y el anillo vuelve a cero, así que el `seq` de
 *      cada watch vuelve a empezar en 1 (KNOWN-GAPS #23);
 *   3. lo persistido vuelve `suspended`, jamás armado (asunción A4).
 */
class FakeSense {
    constructor() {
        // Identidad ÚNICA por arranque, como el sidecar de verdad (events.py la saca de
        // `secrets.token_hex(8)`). Con un `boot` fijo, el cursor que un caso dejó escrito en el
        // buzón ubicaba eventos de OTRO sidecar falso y el puente los tomaba por ya atendidos.
        this.boot = randomBytes(8).toString('hex');
        this.reboots = 0;
        this.cursor = 0;
        this.seq = new Map();
        this.ring = [];
        this.rows = [];
        this.streams = new Set();
        this.sockets = new Set();
        this.connects = 0;
        this.port = 0;
    }

    async start(port = 0) {
        this.server = http.createServer((req, res) => this._handle(req, res));
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        await new Promise((resolve) => this.server.listen(port, '127.0.0.1', resolve));
        this.port = this.server.address().port;
        return this.port;
    }

    _handle(req, res) {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/v1/events') {
            this.connects++;
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
            const from = Number(req.headers['last-event-id'] || 0) || 0;
            // EL REPLAY DEL ANILLO, que es lo que este falso NO hacía y por eso no podía fallar
            // como falla la máquina. Portado de `EventBus.since()` (sidecar/sense/events.py) y
            // verificado contra el sidecar corriendo: SIN Last-Event-ID devuelve EL ANILLO
            // ENTERO —no distingue "soy nuevo" de "replayame desde el principio"—, con un cursor
            // de este arranque devuelve lo posterior, y con uno imposible (de otro arranque
            // suyo) vuelve a devolverlo entero. Sin esto, el archivo probaba un cable que el
            // sidecar de verdad no habla.
            const ahead = from > this.cursor;
            const replay = ahead ? this.ring.slice() : this.ring.filter((e) => e.cursor > from);
            const truncated = ahead || (from > 0 && this.ring.length > 0 && from < this.ring[0].cursor - 1);
            // Mismo texto que main.py, incluido el `boot=` de 1a231ff.
            res.write(from > 0
                ? `: sense.resume from=${from} replayed=${replay.length} truncated=${truncated ? 'true' : 'false'} boot=${this.boot}\n\n`
                : `: sense.v1 connected cursor=${this.cursor} boot=${this.boot}\n\n`);
            for (const stored of replay) res.write(`id: ${stored.cursor}\ndata: ${JSON.stringify(stored.envelope)}\n\n`);
            this.streams.add(res);
            req.on('close', () => this.streams.delete(res));
            return;
        }
        if (url.pathname === '/v1/watches') return this._json(res, { watches: this.rows });
        const one = url.pathname.match(/^\/v1\/watches\/(.+)$/);
        if (one) {
            const row = this.rows.find((r) => r.watchId === decodeURIComponent(one[1]));
            return row ? this._json(res, row) : this._json(res, { error: 'watch not found' }, 404);
        }
        return this._json(res, { error: 'not found' }, 404);
    }

    _json(res, body, status = 200) {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(text);
    }

    /**
     * La fila que el sidecar YA TIENE, sin anunciar nada. Así la ve un backend que arranca
     * después: armada por REST, o sobreviviente de un reinicio del backend. Nunca pasó un
     * `watch.armed` por el stream, y esa es toda la diferencia con arm().
     */
    persist(watchId, sessionId, label = 'the training') {
        this.rows.push({ watchId, label, state: 'armed', rung: 'R2', sensorKind: 'file',
            lastSampleAt: null, samplesOk: 0, samplesFailed: 0, fires: 0,
            expiresAt: Date.now() + 3600000, sessionId });
    }

    /** Arma una vigilancia como el sidecar: aparece la fila Y sale `watch.armed`. */
    arm(watchId, sessionId, label = 'the training') {
        this.persist(watchId, sessionId, label);
        this.emit(watchId, 'watch.armed', { label, rung: 'R2', sensorKind: 'file',
            periodMs: 15000, expiresAt: Date.now() + 3600000, tier: 'observe' });
    }

    emit(watchId, type, data) {
        const seq = (this.seq.get(watchId) || 0) + 1;
        this.seq.set(watchId, seq);
        this.cursor += 1;
        const envelope = { v: 'sense.v1', watchId, seq, ts: Date.now(), type, data };
        // Al anillo Y a los conectados: el anillo es lo que ve el que se suscribe DESPUÉS.
        this.ring.push({ cursor: this.cursor, envelope });
        for (const res of this.streams) res.write(`id: ${this.cursor}\ndata: ${JSON.stringify(envelope)}\n\n`);
    }

    /** Un corte de red: se cae la conexión, el proceso sigue vivo y con el mismo `boot`. */
    dropStreams() {
        for (const res of this.streams) res.destroy();
        this.streams.clear();
    }

    async stop() {
        this.dropStreams();
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();
        await new Promise((resolve) => this.server.close(resolve));
    }

    /**
     * Vuelve a arrancar en el mismo puerto: otro `boot`, cursor y `seq` desde cero, y lo que
     * había vuelve `suspended`, jamás armado (asunción A4).
     *
     * `keep` es lo que el sidecar de verdad PERSISTIÓ. Lo que no esté en esa lista no vuelve en
     * ninguna respuesta, porque no existe más: es el caso de la fila que el backend recuerda y
     * que allá ya no está en ningún lado.
     */
    async revive({ keep = null } = {}) {
        this.boot = randomBytes(8).toString('hex');
        this.reboots++;
        this.cursor = 0;
        this.seq = new Map();
        this.ring = [];                               // el anillo vive en RAM: se muere con el proceso
        if (keep) this.rows = this.rows.filter((r) => keep.includes(r.watchId));
        for (const row of this.rows) { row.state = 'suspended'; row.lastSampleAt = null; }
        await this.start(this.port);
    }

    /** SIGTERM y vuelta sin pausa: el `systemctl restart` de un segundo. */
    async restart(opts) { await this.stop(); await this.revive(opts); }
}

// ── Andamio ────────────────────────────────────────────────────────────────────────────
let sense;
let narrated;       // [{ sessionId, prompt }]
let sent;           // sessionId -> [payload] — lo que le llegó al HUD por el socket
const opened = [];

const open = () => { const { sessionId } = conversationManager.createSession(); opened.push(sessionId); return sessionId; };
const attach = (sessionId) => {
    sent[sessionId] = sent[sessionId] || [];
    const send = (m) => sent[sessionId].push(m);
    agentBridge.attachSession(sessionId, send);
    bridge.attachSession(sessionId, send);
};
/** Se cierra la pestaña. La conversación sigue viva y puede volver con el MISMO sessionId. */
const detach = (sessionId) => { agentBridge.detachSession(sessionId); bridge.detachSession(sessionId); };
const hud = (sessionId) => sent[sessionId] || [];
/** El buzón EN DISCO, que es lo único que sobrevive a un reinicio del backend. */
const diskTrips = () => { try { return JSON.parse(fs.readFileSync(process.env.HANNAH_WATCH_INBOX_FILE, 'utf8')).trips; } catch { return []; } };

/**
 * NO HAY FILTRO SOBRE `narrated`, y es a propósito. Acá había uno que se quedaba solo con las
 * frases de "dejé de mirar" para no ver la que decía después "ya la veo de nuevo": esa segunda
 * frase era el blocker de esta ronda —la última que oye la persona, sobre una vigilancia que no
 * se muestrea— y filtrarla dejaba este archivo verde justo sobre la falla que su título dice
 * cubrir. Lo que se afirma es TODO lo que se dijo, y cuánto.
 */
const dicho = (re) => narrated.filter((n) => re.test(n.prompt));

/**
 * Una vigilancia que este proceso ADOPTA en vez de verla armarse: la fila ya está en el sidecar
 * cuando el backend arranca (armada por REST, o sobreviviente de un reinicio del backend). Es el
 * caso que ningún test cubría y que el mapa interno del cliente no podía ver, porque por el
 * stream nunca pasó un `watch.armed` suyo.
 */
const adoptar = async (watchId, sessionId, label = 'the training') => {
    await bridge.shutdown(); bridge._reset();
    sense.persist(watchId, sessionId, label);
    await bridge.init();
    await until('la vigilancia adoptada se conoce', () => bridge.snapshot().some((w) => w.watchId === watchId));
    // Y el stream TIENE que estar conectado antes de matar al sidecar: el `boot` del arranque
    // viejo se aprende en el comentario de bienvenida, y sin haberlo visto no hay con qué
    // comparar el del arranque nuevo.
    await until('el stream se conecta', () => bridge.isHealthy());
};

/**
 * EL BACKEND se muere y vuelve, con el sidecar intacto del otro lado. Es la mitad simétrica de
 * `sense.restart()`: acá el proceso que pierde la memoria es este, y lo único que sobrevive es lo
 * que quedó escrito en el buzón. Se vuelve a attachear porque `_reset()` se lleva el mapa de
 * sesiones, igual que un arranque de verdad.
 */
const rebootBackend = async (sessionId) => {
    const conexiones = sense.connects;
    await bridge.shutdown();
    bridge._reset();
    await bridge.init();
    if (sessionId) attach(sessionId);
    await until('el backend nuevo se suscribe', () => sense.connects > conexiones);
    await ringDone();
};

/**
 * Barrera: espera a que TODO el replay del anillo haya pasado por el puente. Un evento vivo
 * emitido después del replay viaja por el mismo socket, así que cuando se ve su efecto lo
 * anterior ya se procesó. `watch.armed` es el evento inerte: no narra ni toca el buzón.
 */
let probes = 0;
const ringDone = async () => {
    const id = `w_probe_${++probes}`;
    sense.emit(id, 'watch.armed', { label: 'probe', rung: 'R2', sensorKind: 'file', tier: 'observe' });
    await until('el anillo terminó de pasar', () => bridge.snapshot().some((w) => w.watchId === id));
    await bridge._settle();
};

/** Espera a que algo pase, o falla diciendo qué esperaba. Nada de sleeps a ojo. */
async function until(what, check, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`nunca pasó: ${what}`);
}

const originalUrl = config.sense.url;
const originalEnabled = config.sense.enabled;

beforeEach(async () => {
    narrated = []; sent = {};
    // El buzón es de UN backend y cada caso arranca uno nuevo: sin esto, los disparos y el cursor
    // que dejó escritos el caso anterior siguen en disco (mismo idioma que senseBridge.test.js).
    try { fs.unlinkSync(process.env.HANNAH_WATCH_INBOX_FILE); } catch { /* no existía */ }
    sense = new FakeSense();
    await sense.start();
    config.sense.enabled = true;
    config.sense.url = `http://127.0.0.1:${sense.port}`;
    agentBridge._reset(); bridge._reset();
    // El espía de la voz: imita a processTextTurn en las dos cosas que importan acá. Con la
    // sesión muerta no habla (ver senseBridge.test.js, que encontró ese agujero) Y DEVUELVE EL
    // ACUSE `{spoken}` cuando sí habló. Lo segundo faltaba, y sin eso el espía no podía tener
    // éxito como tiene éxito el original: el puente leía `spoken` ausente como "no se dijo",
    // llamaba a onLost y desmarcaba la ceguera, así que la misma frase se repetía en cada attach
    // — un falso verde al revés, que escondía lo repetido en vez de lo perdido.
    await agentBridge.init({ narrate: async (sessionId, prompt) => {
        if (!conversationManager.getSession(sessionId)) return { spoken: false, error: 'La sesión no existe o ha expirado' };
        narrated.push({ sessionId, prompt });
        return { spoken: true, error: null };
    } });
    await bridge.init();
});

afterEach(async () => {
    await bridge.shutdown(); bridge._reset(); agentBridge._reset();
    await sense.stop();
    for (const sessionId of opened.splice(0)) conversationManager.deleteSession(sessionId);
    config.sense.url = originalUrl;
    config.sense.enabled = originalEnabled;
});

afterAll(() => { conversationManager.dispose(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ── Lo que se prueba ───────────────────────────────────────────────────────────────────
describe('el sidecar reinicia por debajo de una suscripción viva', () => {
    jest.setTimeout(30000);

    test('un restart de un segundo NO deja a la persona creyendo que la miran', async () => {
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        expect(narrated).toHaveLength(0);            // cuatro horas tranquilas son NADA (plan §10)

        // El reinicio de verdad: no se emite ningún evento, se cae la conexión y el proceso
        // vuelve con otro `boot` y con la vigilancia `suspended`.
        await sense.restart();

        await until('se dice que dejó de mirar', () => narrated.length > 0);
        expect(narrated[0].sessionId).toBe(s);       // a la que armó, no a la última conectada
        expect(narrated[0].prompt).toMatch(/LOST SIGHT/);
        expect(narrated[0].prompt).toContain('the training');

        // Y NADA MÁS, que es la otra mitad de la frase del título. Acá vivía el blocker: la
        // reconciliación decía a continuación "ya la veo de nuevo y la estoy mirando como antes"
        // sobre una fila `suspended` —con el HUD mostrando la pastilla de suspendida y /health
        // en armed:0— y esa frase, por ser la última, es la que le queda a la persona. Se espera
        // a que el puente termine de ver el arranque nuevo para que la ausencia signifique algo.
        await until('el puente ve la fila del arranque nuevo',
            () => bridge.snapshot().find((w) => w.watchId === 'w_1')?.state === 'suspended');
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);
        expect(dicho(/can see/)).toHaveLength(0);
        expect(hud(s).filter((m) => m.type === 'watch_state').at(-1))
            .toMatchObject({ watchId: 'w_1', state: 'suspended' });
    });

    test('lo dice UNA vez: el mismo arranque no se vuelve a anunciar en cada reconexión', async () => {
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s);
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        await sense.restart();
        await until('se dice que dejó de mirar', () => narrated.length > 0);

        const conexiones = sense.connects;
        sense.dropStreams();
        await until('reconecta', () => sense.connects > conexiones);
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);
    });

    test('un corte de red NO es un reinicio: con el mismo arranque no se dice nada', async () => {
        // La otra mitad del contrato. Si esto hablara, cada hipo de la red sería una ceguera
        // falsa a las 3am — y la vigilancia sigue mirando del otro lado, así que sería mentira.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s);
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        const conexiones = sense.connects;
        sense.dropStreams();                          // el proceso sigue vivo: mismo boot
        await until('reconecta', () => sense.connects > conexiones);
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(0);
        expect(bridge.snapshot().find((w) => w.watchId === 'w_1').state).toBe('armed');
    });

    test('una vigilancia que el usuario desarmó antes del reinicio no se anuncia', async () => {
        // El disparo ya se contó (`watch.disarmed` con reason `user`) y la vigilancia no existe
        // más: anunciarla de nuevo sería hablar de algo que la persona ya cerró.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s);
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        sense.emit('w_1', 'watch.disarmed', { label: 'the training', reason: 'user' });
        sense.rows = [];
        await until('el puente la ve desarmada',
            () => bridge.snapshot().find((w) => w.watchId === 'w_1')?.state === 'disarmed');

        await sense.restart();
        const conexiones = sense.connects;
        await until('reconecta', () => sense.connects > conexiones);
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(0);
    });
});

describe('el reinicio con el HUD cerrado, que es el caso de las 3am', () => {
    jest.setTimeout(30000);

    test('nadie conectado en el momento del reinicio: se le cuenta cuando vuelve', async () => {
        // EL CASO TITULAR DEL PLAN §10 ("Trip at 3am"), y el que ningún test cubría: los cuatro
        // de arriba tienen una sesión attacheada cuando el sidecar se muere. Cerrar la pestaña NO
        // es irse: la conversación sigue viva media hora y vuelve con el MISMO sessionId, así que
        // la persona que armó tiene que enterarse al volver. Sin esto, lo único que veía era una
        // pastilla de suspendida y ni una palabra.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        detach(s);
        await sense.restart();
        await until('el puente ve la fila del arranque nuevo',
            () => bridge.snapshot().find((w) => w.watchId === 'w_1')?.state === 'suspended');
        expect(narrated).toHaveLength(0);            // no había a quién decírselo: no se pierde, espera

        attach(s);                                   // vuelve la MISMA conversación
        await until('se lo cuenta al volver', () => narrated.length > 0);
        expect(narrated[0].sessionId).toBe(s);
        expect(narrated[0].prompt).toMatch(/LOST SIGHT/);
        expect(narrated[0].prompt).toContain('the training');
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);            // una vez, no una por cada attach
    });

    test('y no se lo repite en cada attach siguiente', async () => {
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        detach(s);
        await sense.restart();
        attach(s);
        await until('se lo cuenta al volver', () => narrated.length > 0);
        detach(s);
        attach(s);                                   // un F5 del HUD no es un hecho nuevo
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);
    });
});

describe('después del reinicio, el sidecar y la fila del backend tienen que seguir hablándose', () => {
    jest.setTimeout(30000);

    test('lo que pase DESPUÉS del reinicio le llega al HUD: el `seq` del arranque nuevo no se descarta', async () => {
        // Reproducido en vivo: armar, matar el sidecar, levantarlo, y DELETE de la vigilancia en
        // el sidecar, que contesta {"disarmed":true}. Ningún `watch_disarmed` llegaba al HUD. El
        // `_seq` de allá vuelve a 1 en cada arranque (KNOWN-GAPS #23) y acá se descarta todo
        // evento con `seq <= w.seq`, así que el primer evento del arranque nuevo se tiraba en
        // silencio: la fila se quedaba suspendida para siempre, sin estado terminal, FORGET_MS no
        // corría nunca y la fila con su etiqueta vivía lo que viviera el proceso.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        await sense.restart();
        await until('se dice que dejó de mirar', () => narrated.length > 0);
        await until('el puente ve la fila del arranque nuevo',
            () => bridge.snapshot().find((w) => w.watchId === 'w_1')?.state === 'suspended');

        // El DELETE: el sidecar la termina y lo anuncia con el `seq` 1 de ESTE arranque. Se mira
        // solo lo que llega DESPUÉS de este punto: lo de antes es del reinicio y no prueba nada.
        const desde = hud(s).length;
        sense.rows = [];
        sense.emit('w_1', 'watch.disarmed', { label: 'the training', reason: 'user' });

        await until('el HUD se entera de que terminó',
            () => hud(s).slice(desde).some((m) => m.type === 'watch_disarmed' && m.watchId === 'w_1'));
        expect(bridge.snapshot().find((w) => w.watchId === 'w_1').state).toBe('disarmed');
    });

    test('una vigilancia ADOPTADA también deja de mirarse cuando el sidecar reinicia', async () => {
        // La que nunca pasó por el stream: el backend la encontró ya armada al arrancar. El
        // reinicio del sidecar la mata igual que a cualquier otra (asunción A4), pero la cuenta
        // la llevaba el cliente SSE, que solo conoce lo que vio armarse, así que de estas no se
        // decía absolutamente nada y la persona seguía creyendo que la miraban.
        const s = open();
        await adoptar('w_1', s, 'the training');
        attach(s);
        expect(narrated).toHaveLength(0);

        await sense.restart();

        await until('se dice que dejó de mirar', () => narrated.length > 0);
        expect(narrated[0].sessionId).toBe(s);
        expect(narrated[0].prompt).toMatch(/LOST SIGHT/);
        expect(narrated[0].prompt).toContain('the training');
        await until('el puente ve la fila del arranque nuevo',
            () => bridge.snapshot().find((w) => w.watchId === 'w_1')?.state === 'suspended');
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);
        expect(dicho(/can see/)).toHaveLength(0);
    });

    test('la fila que el sidecar ya no tiene se termina: no queda de zombi hablando para siempre', async () => {
        // El efecto de segundo orden, visto en vivo: filas de una caída anterior que ya no
        // existían en ningún lado narraban "dejé de mirar" cada vez que alguien abría el HUD,
        // mientras la que sí existía callaba. Una fila sin estado terminal no la borra nadie:
        // FORGET_MS solo corre sobre las que terminan.
        const s = open();
        await adoptar('w_1', s, 'the training');
        attach(s);

        await sense.restart({ keep: [] });            // el sidecar vuelve sin ella: no la persistió

        await until('se dice que dejó de mirar', () => narrated.length > 0);
        await until('el HUD se entera de que terminó',
            () => hud(s).some((m) => m.type === 'watch_disarmed' && m.watchId === 'w_1'));
        expect(bridge.snapshot().find((w) => w.watchId === 'w_1').state).toBe('disarmed');

        // Se dijo UNA vez que dejó de mirarla, y el HUD que vuelve ya no la ve: es lo que
        // distingue una fila terminada de una zombi.
        expect(dicho(/LOST SIGHT/)).toHaveLength(1);
        detach(s);
        const desde = hud(s).length;
        attach(s);
        await new Promise((r) => setTimeout(r, 200));
        expect(narrated).toHaveLength(1);
        expect(hud(s).slice(desde).some((m) => m.watchId === 'w_1')).toBe(false);
    });
});
describe('el BACKEND reinicia por debajo de un sidecar vivo', () => {
    jest.setTimeout(30000);

    // LA OTRA MITAD DEL MISMO CABLE, y la que no estaba probada. `GET /v1/events` SIN
    // Last-Event-ID replaya el anillo entero como si fuera lo que está pasando ahora
    // (main.py -> `EventBus.since(0)`), y `senseClient.subscribe()` arranca con `lastId` en null
    // en CADA arranque del backend. El dedupe por (watchId, seq) no lo tapa: `adopt()` y
    // `getOrAdopt()` nacen con `seq` 0, así que el `seq` 1 de un evento viejo pasa igual — el
    // docstring de `EventBus.since()` afirma justo lo contrario y es falso cruzando un reinicio
    // del backend. Reproducido en vivo: el buzón fue de 3 a 7 en un reinicio y de 7 a 10 en el
    // siguiente, gritando "buzón lleno" por fantasmas y dejando /api/v1/health en pending:10 con
    // una sola vigilancia armada y cero disparos sin contar.

    test('un disparo YA DICHO no vuelve a contarse cuando el backend arranca de nuevo', async () => {
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        sense.emit('w_1', 'watch.tripped', { label: 'the training', at: Date.now(), fires: 1 });
        await until('se lo dice', () => dicho(/STOPPED/).length === 1);
        await until('y sale del buzón', () => bridge.pendingTrips() === 0);

        await rebootBackend(s);

        // El anillo del sidecar sigue teniendo ese disparo, pero para ESTE backend ya está dicho.
        expect(dicho(/STOPPED/)).toHaveLength(1);
        expect(bridge.pendingTrips()).toBe(0);
        expect(diskTrips()).toHaveLength(0);
    });

    test('dos reinicios del backend no llenan el buzón de fantasmas: lo pendiente sigue siendo lo pendiente', async () => {
        // El envenenamiento de LA alarma que importa. INBOX_MAX son 10 y el anillo 2000: con el
        // anillo re-archivándose en cada arranque, "buzón lleno: se DESCARTA el disparo más viejo
        // sin haberlo dicho nunca" —la única señal de que se perdió un disparo de verdad— se
        // dispara sola, y el contador de /api/v1/health deja de querer decir nada.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));

        detach(s);                                    // se cerró la pestaña: los disparos esperan
        for (let i = 1; i <= 3; i++) sense.emit('w_1', 'watch.tripped', { label: 'the training', at: Date.now(), fires: i });
        await until('los tres quedan guardados', () => bridge.pendingTrips() === 3);

        await rebootBackend();
        expect(bridge.pendingTrips()).toBe(3);
        await rebootBackend();
        expect(bridge.pendingTrips()).toBe(3);
        expect(diskTrips().every((t) => t.watchId === 'w_1')).toBe(true);

        // Y son los de verdad: vuelve la persona y oye TRES, no nueve.
        attach(s);
        await until('se los cuenta al volver', () => bridge.pendingTrips() === 0);
        expect(dicho(/STOPPED/)).toHaveLength(3);
    });

    test('lo que disparó MIENTRAS el backend no estaba sí se cuenta: el anillo no se tira entero', async () => {
        // La otra mitad, y la que impide arreglar lo de arriba a lo bruto (que el sidecar no
        // replaye nada al que llega sin cursor, o que el backend descarte todo replay). Un disparo
        // ocurrido con el backend caído SOLO existe en el anillo, y es exactamente el caso de las
        // 3am que esta feature existe para cubrir.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        sense.emit('w_1', 'watch.tripped', { label: 'the training', at: Date.now(), fires: 1 });
        await until('se lo dice', () => dicho(/STOPPED/).length === 1);
        await until('y sale del buzón', () => bridge.pendingTrips() === 0);

        await bridge.shutdown();
        bridge._reset();
        sense.emit('w_1', 'watch.tripped', { label: 'the training', at: Date.now(), fires: 2 });
        const conexiones = sense.connects;
        await bridge.init();
        attach(s);
        await until('el backend nuevo se suscribe', () => sense.connects > conexiones);

        // `>=` y no `===`: las narraciones van en serie y con el bug se encadenan tres, así que
        // un igual estricto podía no ver nunca el número exacto y fallar por la razón equivocada.
        await until('se cuenta el que se perdió', () => dicho(/STOPPED/).length >= 2);
        await ringDone();
        expect(dicho(/STOPPED/)).toHaveLength(2);     // el segundo, y NO otra vez el primero
        expect(bridge.pendingTrips()).toBe(0);
    });

    test('el cursor guardado vale solo dentro del arranque del sidecar que lo emitió', async () => {
        // Los dos números se guardan juntos por esto: el cursor del sidecar vuelve a 0 en cada
        // arranque suyo (events.py, `_boot`), así que un cursor 2 del arranque viejo y un cursor 2
        // del nuevo no son el mismo evento. Comparar solo el número dejaría mudo el arranque
        // entero del sidecar nuevo, que es peor que el bug que se está arreglando.
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s, 'the training');
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        sense.emit('w_1', 'watch.tripped', { label: 'the training', at: Date.now(), fires: 1 });
        await until('se lo dice', () => dicho(/STOPPED/).length === 1);

        await bridge.shutdown();
        bridge._reset();
        await sense.restart({ keep: [] });            // otro arranque: anillo vacío y cursor en 0
        sense.arm('w_2', s, 'the render');            // armada por REST con el backend caído
        sense.emit('w_2', 'watch.tripped', { label: 'the render', at: Date.now(), fires: 1 });

        const conexiones = sense.connects;
        await bridge.init();
        attach(s);
        await until('el backend nuevo se suscribe', () => sense.connects > conexiones);

        await until('el disparo del arranque nuevo se cuenta', () => dicho(/the render/).length === 1);
        expect(dicho(/STOPPED/)).toHaveLength(2);
        expect(bridge.pendingTrips()).toBe(0);
    });
});
