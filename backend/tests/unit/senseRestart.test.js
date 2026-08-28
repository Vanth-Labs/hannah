// tests/unit/senseRestart.test.js
// EL SIDECAR REINICIA Y LA PERSONA TIENE QUE ENTERARSE.
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
        this.boot = 'b00700000000aaaa';
        this.cursor = 0;
        this.seq = new Map();
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
            const from = Number(req.headers['last-event-id'] || 0);
            // Mismo texto que main.py, incluido el `boot=` de 1a231ff.
            res.write(from > 0
                ? `: sense.resume from=${from} replayed=0 truncated=true boot=${this.boot}\n\n`
                : `: sense.v1 connected cursor=${this.cursor} boot=${this.boot}\n\n`);
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

    /** Arma una vigilancia como el sidecar: aparece la fila Y sale `watch.armed`. */
    arm(watchId, sessionId, label = 'the training') {
        this.rows.push({ watchId, label, state: 'armed', rung: 'R2', sensorKind: 'file',
            lastSampleAt: null, samplesOk: 0, samplesFailed: 0, fires: 0,
            expiresAt: Date.now() + 3600000, sessionId });
        this.emit(watchId, 'watch.armed', { label, rung: 'R2', sensorKind: 'file',
            periodMs: 15000, expiresAt: Date.now() + 3600000, tier: 'observe' });
    }

    emit(watchId, type, data) {
        const seq = (this.seq.get(watchId) || 0) + 1;
        this.seq.set(watchId, seq);
        this.cursor += 1;
        const envelope = { v: 'sense.v1', watchId, seq, ts: Date.now(), type, data };
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

    /** SIGTERM y vuelta: otro `boot`, cursor y seq desde cero, y lo que había, `suspended`. */
    async restart() {
        const port = this.port;
        await this.stop();
        this.boot = 'b00700000000bbbb';
        this.cursor = 0;
        this.seq = new Map();
        for (const row of this.rows) { row.state = 'suspended'; row.lastSampleAt = null; }
        await this.start(port);
    }
}

// ── Andamio ────────────────────────────────────────────────────────────────────────────
let sense;
let narrated;       // [{ sessionId, prompt }]
const opened = [];

const open = () => { const { sessionId } = conversationManager.createSession(); opened.push(sessionId); return sessionId; };
const attach = (sessionId) => {
    const send = () => {};
    agentBridge.attachSession(sessionId, send);
    bridge.attachSession(sessionId, send);
};

/**
 * Las frases de "dejé de mirar" que se dijeron.
 *
 * Se filtra en vez de contar todo lo narrado porque hoy hay un DEFECTO VECINO, en
 * `senseBridge.reconcile()`, que este archivo no puede arreglar (otro agente está en ese
 * archivo): la reconciliación hace `if (w.state !== 'blind') goVisible(w)`, y una fila
 * `suspended` no es 'blind', así que después de haber dicho la ceguera la reconexión siguiente
 * (o el attach de un HUD) dice "ya la veo de nuevo" sobre una vigilancia que NO está
 * muestreando. Es anterior a este arreglo —se llega igual por el reloj de ceguera de 120 s— y
 * se arregla en una línea: solo una fila `armed` es haberla recuperado.
 */
const perdida = () => narrated.filter((n) => /LOST SIGHT/.test(n.prompt));

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
    narrated = [];
    sense = new FakeSense();
    await sense.start();
    config.sense.enabled = true;
    config.sense.url = `http://127.0.0.1:${sense.port}`;
    agentBridge._reset(); bridge._reset();
    // El espía de la voz: imita a processTextTurn en lo único que importa acá — con la sesión
    // muerta no habla (ver senseBridge.test.js, que encontró ese agujero).
    await agentBridge.init({ narrate: async (sessionId, prompt) => {
        if (!conversationManager.getSession(sessionId)) return;
        narrated.push({ sessionId, prompt });
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

        await until('se dice que dejó de mirar', () => perdida().length > 0);
        expect(perdida()[0].sessionId).toBe(s);      // a la que armó, no a la última conectada
        expect(perdida()[0].prompt).toContain('the training');
    });

    test('lo dice UNA vez: el mismo arranque no se vuelve a anunciar en cada reconexión', async () => {
        const s = open();
        attach(s);
        await until('el stream se conecta', () => bridge.isHealthy());
        sense.arm('w_1', s);
        await until('la vigilancia se conoce', () => bridge.snapshot().some((w) => w.watchId === 'w_1'));
        await sense.restart();
        await until('se dice que dejó de mirar', () => perdida().length > 0);

        const conexiones = sense.connects;
        sense.dropStreams();
        await until('reconecta', () => sense.connects > conexiones);
        await new Promise((r) => setTimeout(r, 200));
        expect(perdida()).toHaveLength(1);
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
