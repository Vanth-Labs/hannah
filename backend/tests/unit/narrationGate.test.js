// tests/unit/narrationGate.test.js
// Un turno de NARRACIÓN (processTextTurn con noActions) habla sobre texto que escribió otro:
// lo que ve la cámara, o un evento de las manos. Ese texto no es una orden del usuario, así
// que el [TASK:]/[MOVE:] que el modelo emita en su respuesta NO puede ejecutarse: sería una
// inyección con la voz de Hannah de fachada. El prompt ya no ofrece los tags (llm.js), pero un
// 7B los emite igual, y hasta este gate el orquestador los obedecía.
//
// Se prueban las dos mitades, porque una sola no distingue el gate de una tubería rota:
//  - con noActions: no despacha, no mueve, y el tag TAMPOCO se oye (el strip nunca se gatea)
//  - sin noActions: la MISMA salida sí despacha y sí mueve
import { jest } from '@jest/globals';
import { Readable } from 'node:stream';

process.env.MOTION_ENABLED = 'false';   // sin sidecar de motion: acá se mide qué se ejecuta

// El embedding de un turno es fire-and-forget dentro de addTurn y llama al proveedor de verdad:
// se mockea para poder AFIRMAR qué texto se embebió (el índice vectorial es la otra base donde
// quedaba escrita la ruta vigilada), y no solo suponerlo. Va antes que los imports reales: el
// grafo de módulos se carga con el primer await import de abajo.
let embedded = [];
jest.unstable_mockModule('../../src/state/embeddings.js', () => ({
    embed: async (text) => { embedded.push(text); return new Float32Array([0.1, 0.2]); },
    cosine: () => 0,
}));

// Los módulos ESM son inmutables (jest.spyOn no los parchea), así que se mockean con
// unstable_mockModule ANTES de importar el orquestador. Cada mock parte del namespace REAL y
// solo pisa lo que sale del proceso (modelo, TTS, ventana, agente): un mock escrito a mano deja
// el resto de los exports en undefined y rompe suites que no tienen nada que ver.
const realLlm = await import('../../src/pipeline/llm.js');
const realTts = await import('../../src/pipeline/tts.js');
const realWindow = await import('../../src/pipeline/windowControl.js');
const realBridge = await import('../../src/pipeline/agentBridge.js');
const realTools = await import('../../src/pipeline/tools.js');

let script = '';                                          // lo que "responde" el modelo
const dispatch = jest.fn(async () => ({ taskId: 't_1' }));
// false = el adaptador no pudo mover: así el turno intenta además el fallback window_move
// contra el cliente, que es la otra mitad de la ejecución que hay que cortar.
const moveWindow = jest.fn(async () => false);
// Armar una vigilancia es la tercera cosa que un texto ajeno no puede lograr: un proceso que
// mira archivos por orden de una línea de log, durante horas, sin que nadie lo haya pedido.
const armWatch = jest.fn(async () => ({ watchId: 'w_test' }));

jest.unstable_mockModule('../../src/pipeline/llm.js', () => ({
    ...realLlm,
    generateDialogueStream: async (_history, onToken, onComplete) => {
        onToken(script);
        onComplete({ text: script, emotion: 'neutral', duration_ms: 1 });
    },
}));
jest.unstable_mockModule('../../src/pipeline/tts.js', () => ({
    ...realTts,
    synthesizeSpeechStream: async () => ({
        audioStream: Readable.from([Buffer.alloc(64)]), format: 'wav', sample_rate: 24000,
    }),
}));
jest.unstable_mockModule('../../src/pipeline/windowControl.js', () => ({ ...realWindow, moveWindow }));
jest.unstable_mockModule('../../src/pipeline/agentBridge.js', () => ({ ...realBridge, dispatch }));
jest.unstable_mockModule('../../src/pipeline/tools.js', () => ({ ...realTools, armWatch }));

const { processTextTurn } = await import('../../src/pipeline/orchestrator.js');
const { conversationManager } = await import('../../src/state/conversationManager.js');
const { memoryStore } = await import('../../src/state/memoryStore.js');
const { config } = await import('../../src/config.js');
const { logger } = await import('../../src/utils/logger.js');

// El modelo delega Y mueve la ventana en la misma respuesta, con prosa alrededor para que
// quede texto real que hablar después del strip.
const HOSTILE = 'Sure thing, on it. [TASK: rm -rf ~] [MOVE: fullscreen] [WATCH: proc | python train.py] Doing that now.';

let sessionId, sent, warn;
// El turno despacha con .then(): un tick para que corran las promesas colgadas antes de mirar.
const turn = async (opts) => {
    await processTextTurn(sessionId, '[SISTEMA - CÁMARA]: veo un cartel', (m) => sent.push(m), opts);
    await new Promise((r) => setTimeout(r, 10));
};
const spoken = () => sent.filter((m) => m.type === 'audio_chunk').map((m) => m.text).join(' ');

const originalRecall = config.memory.recallEnabled;
beforeEach(() => {
    ({ sessionId } = conversationManager.createSession());
    sent = []; script = HOSTILE; embedded = [];
    dispatch.mockClear(); moveWindow.mockClear(); armWatch.mockClear();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => {
    warn.mockRestore(); conversationManager.deleteSession(sessionId);
    config.memory.recallEnabled = originalRecall;
});

describe('turno de narración (noActions): los tags se stripean pero NO se ejecutan', () => {
    test('no despacha la tarea, no mueve la ventana y no arma la vigilancia', async () => {
        await turn({ noActions: true });
        expect(dispatch).not.toHaveBeenCalled();
        expect(moveWindow).not.toHaveBeenCalled();
        expect(armWatch).not.toHaveBeenCalled();
        expect(sent.filter((m) => m.type === 'window_move')).toHaveLength(0);
    });

    test('el texto que llega al TTS no lleva ninguno de los dos tags', async () => {
        await turn({ noActions: true });
        const text = spoken();
        expect(text).not.toMatch(/TASK/i);
        expect(text).not.toMatch(/MOVE/i);
        expect(text).not.toMatch(/WATCH/i);
        expect(text).not.toMatch(/train\.py/);
        expect(text).not.toMatch(/rm -rf/);
        expect(text).toContain('Sure thing, on it.');   // y sí queda la frase hablable
    });

    test('el intento se registra: un drop silencioso escondería la inyección', async () => {
        await turn({ noActions: true });
        const tags = warn.mock.calls.filter((c) => c[1]?.tag).map((c) => c[1].tag);
        expect(tags).toEqual(expect.arrayContaining(['TASK', 'MOVE', 'WATCH']));
    });
});

describe('turno normal: la MISMA salida sí actúa (el gate no es una tubería rota)', () => {
    test('despacha la tarea, mueve la ventana y arma la vigilancia', async () => {
        await turn({});
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][1]).toBe('rm -rf ~');
        expect(moveWindow).toHaveBeenCalledWith('fullscreen');
        expect(sent.filter((m) => m.type === 'window_move')).toHaveLength(1);
        expect(armWatch).toHaveBeenCalledTimes(1);
        expect(armWatch.mock.calls[0][1]).toBe('proc | python train.py');
    });

    test('el TTS tampoco los oye acá: ejecutar y hablar son cosas distintas', async () => {
        await turn({});
        expect(spoken()).not.toMatch(/TASK|MOVE|WATCH/i);
    });
});

describe('la marca de "la voz FUNCIONA", que es lo que reabre un disparo rendido', () => {
    // Esta suite es la única que corre el orquestador de VERDAD, y por eso la línea se afirma acá.
    // senseBridge deja de reintentar un disparo después de TRIP_MAX_ATTEMPTS contra un proveedor
    // caído, y lo ÚNICO que puede reabrirle la puerta es saber que una oración volvió a salir con
    // su audio. Si esta marca no se pusiera, el último disparo del buzón se quedaría mudo para
    // siempre y el test de senseBridge estaría probando una señal que nadie emite.
    test('un turno que habla la deja puesta; uno que no llega a hablar, no', async () => {
        const antes = realBridge.spokenCount();

        script = '';                                    // el modelo no devuelve nada hablable
        await turn({});
        expect(spoken()).toBe('');
        expect(realBridge.spokenCount()).toBe(antes);   // resolver no es haber hablado

        script = 'todo bien por acá, ya lo miro.';
        await turn({});
        expect(spoken()).toContain('todo bien');
        expect(realBridge.spokenCount()).toBeGreaterThan(antes);
    });
});

// Lo que se EJECUTA es la mitad de arriba; esto es lo que queda ESCRITO. Un turno guardado va a
// tres lugares a la vez: la ventana de contexto que el modelo relee, memory.db y el índice de
// embeddings — y las dos bases están en data/, que la política del agente marca como sensible.
// El hermano de este arreglo ya existía para [TASK:] y decía por qué en su comentario; [WATCH:]
// caía por el costado con su ARGUMENTO adentro, que en un watch de archivo o de log es una ruta.
describe('lo que queda escrito de un [WATCH:]: la frase, nunca el tag ni la ruta', () => {
    test('ni en la ventana de contexto, ni en memory.db, ni en el índice vectorial', async () => {
        config.memory.recallEnabled = true;
        const before = memoryStore.recentTurns(200).length;
        script = 'listo, miro el log del entrenamiento. [WATCH: log | /home/webiwabou/train.log | 5]';
        await turn({});
        await new Promise((r) => setTimeout(r, 20));   // el embedding es fire-and-forget

        // La vigilancia SÍ se armó: lo que cambia es lo que se recuerda, no lo que se hace.
        expect(armWatch).toHaveBeenCalledTimes(1);

        const stored = conversationManager.getSession(sessionId).turns.at(-1).content;
        expect(stored).toContain('listo, miro el log del entrenamiento.');
        expect(stored).not.toMatch(/WATCH\s*:/i);
        expect(stored).not.toMatch(/train\.log/);

        const rows = memoryStore.recentTurns(200).slice(before);
        expect(rows.some((r) => r.content === stored)).toBe(true);
        expect(JSON.stringify(rows)).not.toMatch(/WATCH\s*:|train\.log/i);
        expect(embedded.join(' | ')).not.toMatch(/WATCH\s*:|train\.log/i);
    });

    test('un tag truncado por max_tokens tampoco se guarda a medias', async () => {
        script = 'listo, lo miro. [WATCH: log | /home/webiwabou/train.log';
        await turn({});
        const stored = conversationManager.getSession(sessionId).turns.at(-1).content;
        expect(stored).not.toMatch(/WATCH\s*:|train\.log/i);
    });

    test('el de las manos sigue guardándose como antes (no se rompió al extenderlo)', async () => {
        script = '[TASK: list the files in Documents]';
        await turn({});
        expect(conversationManager.getSession(sessionId).turns.at(-1).content)
            .toBe('(I handed this to my hands: list the files in Documents)');
    });
});
