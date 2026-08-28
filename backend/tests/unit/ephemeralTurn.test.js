// tests/unit/ephemeralTurn.test.js
// M5.1.4 — la salida `ephemeral` de addTurn, que es lo que hace que una vigilancia se DIGA y no
// se RECUERDE (plan VIGILANCE §9, "watch narration is ephemeral").
//
// Sin esto, una vigilancia de ocho horas hace dos daños distintos y hay que probar los dos:
// desaloja la conversación real de la ventana de CONTEXT_TURNS (la memoria de trabajo se llena
// de "sigo mirando"), y graba para siempre en memory.db lo que se observó — una base que la
// propia política del agente marca como sensible y le prohíbe leer.
import { jest } from '@jest/globals';

process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key';

// El embedding es fire-and-forget dentro de addTurn: sin espiarlo, "no se embebe" no se puede
// afirmar, solo suponer.
let embedded = [];
jest.unstable_mockModule('../../src/state/embeddings.js', () => ({
    embed: async (text) => { embedded.push(text); return new Float32Array([0.1, 0.2]); },
    cosine: () => 0,
}));

const { conversationManager } = await import('../../src/state/conversationManager.js');
const { memoryStore } = await import('../../src/state/memoryStore.js');
const { config } = await import('../../src/config.js');

const settle = () => new Promise((r) => setTimeout(r, 20));
const original = config.memory.recallEnabled;
beforeEach(() => { embedded = []; config.memory.recallEnabled = true; });
afterAll(() => { config.memory.recallEnabled = original; conversationManager.dispose(); });

describe('addTurn({ ephemeral }) — la narración de una vigilancia no deja rastro', () => {
    test('un turno normal SÍ se guarda y se embebe (el control del test)', async () => {
        const { sessionId } = conversationManager.createSession();
        const before = memoryStore.recentTurns(50).length;

        expect(conversationManager.addTurn(sessionId, 'assistant', 'listo, miro el log del entrenamiento')).toBe(true);
        await settle();

        expect(memoryStore.recentTurns(50).length).toBe(before + 1);
        expect(embedded).toHaveLength(1);
        conversationManager.deleteSession(sessionId);
    });

    test('un turno efímero no deja fila, ni embedding, ni ocupa la ventana de contexto', async () => {
        const { sessionId } = conversationManager.createSession();
        conversationManager.addTurn(sessionId, 'user', 'vigilá el entrenamiento');
        await settle();
        const rows = memoryStore.recentTurns(50).length;
        const window = conversationManager.getSession(sessionId).turns.length;
        embedded = [];

        // Ocho horas de vigilancia son muchas de estas.
        for (let i = 0; i < 20; i++) {
            expect(conversationManager.addTurn(sessionId, 'assistant',
                `perdí de vista el entrenamiento (${i})`, { ephemeral: true })).toBe(false);
        }
        await settle();

        expect(memoryStore.recentTurns(50).length).toBe(rows);                      // ni una fila en memory.db
        expect(embedded).toHaveLength(0);                                            // ni un embedding
        expect(conversationManager.getSession(sessionId).turns.length).toBe(window); // ni un desalojo
        expect(conversationManager.getSession(sessionId).turns.at(-1).content).toBe('vigilá el entrenamiento');
        conversationManager.deleteSession(sessionId);
    });
});
