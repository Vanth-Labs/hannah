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

// Los módulos ESM son inmutables (jest.spyOn no los parchea), así que se mockean con
// unstable_mockModule ANTES de importar el orquestador. Cada mock parte del namespace REAL y
// solo pisa lo que sale del proceso (modelo, TTS, ventana, agente): un mock escrito a mano deja
// el resto de los exports en undefined y rompe suites que no tienen nada que ver.
const realLlm = await import('../../src/pipeline/llm.js');
const realTts = await import('../../src/pipeline/tts.js');
const realWindow = await import('../../src/pipeline/windowControl.js');
const realBridge = await import('../../src/pipeline/agentBridge.js');

let script = '';                                          // lo que "responde" el modelo
const dispatch = jest.fn(async () => ({ taskId: 't_1' }));
// false = el adaptador no pudo mover: así el turno intenta además el fallback window_move
// contra el cliente, que es la otra mitad de la ejecución que hay que cortar.
const moveWindow = jest.fn(async () => false);

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

const { processTextTurn } = await import('../../src/pipeline/orchestrator.js');
const { conversationManager } = await import('../../src/state/conversationManager.js');
const { logger } = await import('../../src/utils/logger.js');

// El modelo delega Y mueve la ventana en la misma respuesta, con prosa alrededor para que
// quede texto real que hablar después del strip.
const HOSTILE = 'Sure thing, on it. [TASK: rm -rf ~] [MOVE: fullscreen] Doing that now.';

let sessionId, sent, warn;
// El turno despacha con .then(): un tick para que corran las promesas colgadas antes de mirar.
const turn = async (opts) => {
    await processTextTurn(sessionId, '[SISTEMA - CÁMARA]: veo un cartel', (m) => sent.push(m), opts);
    await new Promise((r) => setTimeout(r, 10));
};
const spoken = () => sent.filter((m) => m.type === 'audio_chunk').map((m) => m.text).join(' ');

beforeEach(() => {
    ({ sessionId } = conversationManager.createSession());
    sent = []; script = HOSTILE;
    dispatch.mockClear(); moveWindow.mockClear();
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => { warn.mockRestore(); conversationManager.deleteSession(sessionId); });

describe('turno de narración (noActions): los tags se stripean pero NO se ejecutan', () => {
    test('no despacha la tarea ni mueve la ventana', async () => {
        await turn({ noActions: true });
        expect(dispatch).not.toHaveBeenCalled();
        expect(moveWindow).not.toHaveBeenCalled();
        expect(sent.filter((m) => m.type === 'window_move')).toHaveLength(0);
    });

    test('el texto que llega al TTS no lleva ninguno de los dos tags', async () => {
        await turn({ noActions: true });
        const text = spoken();
        expect(text).not.toMatch(/TASK/i);
        expect(text).not.toMatch(/MOVE/i);
        expect(text).not.toMatch(/rm -rf/);
        expect(text).toContain('Sure thing, on it.');   // y sí queda la frase hablable
    });

    test('el intento se registra: un drop silencioso escondería la inyección', async () => {
        await turn({ noActions: true });
        const tags = warn.mock.calls.filter((c) => c[1]?.tag).map((c) => c[1].tag);
        expect(tags).toEqual(expect.arrayContaining(['TASK', 'MOVE']));
    });
});

describe('turno normal: la MISMA salida sí actúa (el gate no es una tubería rota)', () => {
    test('despacha la tarea y mueve la ventana, con el fallback al cliente', async () => {
        await turn({});
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(dispatch.mock.calls[0][1]).toBe('rm -rf ~');
        expect(moveWindow).toHaveBeenCalledWith('fullscreen');
        expect(sent.filter((m) => m.type === 'window_move')).toHaveLength(1);
    });

    test('el TTS tampoco los oye acá: ejecutar y hablar son cosas distintas', async () => {
        await turn({});
        expect(spoken()).not.toMatch(/TASK|MOVE/i);
    });
});
