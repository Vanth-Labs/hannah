// tests/unit/conversationManager.test.js
import { conversationManager } from '../../src/state/conversationManager.js';
import { config } from '../../src/config.js';

afterAll(() => {
    conversationManager.dispose();
});

describe('ConversationManager', () => {
    test('createSession returns a sessionId and TTL in seconds', () => {
        const info = conversationManager.createSession();
        expect(typeof info.sessionId).toBe('string');
        expect(info.expiresIn).toBe(config.session.ttl * 60);
        conversationManager.deleteSession(info.sessionId);
    });

    test('getSession returns null for unknown ids', () => {
        expect(conversationManager.getSession('no-existe')).toBeNull();
    });

    test('addTurn stores turns and trims to the CONTEXT_TURNS window', () => {
        const { sessionId } = conversationManager.createSession();
        const limit = config.llm.contextTurns;

        for (let i = 0; i < limit + 5; i++) {
            expect(conversationManager.addTurn(sessionId, i % 2 === 0 ? 'user' : 'assistant', `turno ${i}`)).toBe(true);
        }

        const session = conversationManager.getSession(sessionId);
        expect(session.turns.length).toBe(limit);
        // Se conservan los turnos más recientes
        expect(session.turns[session.turns.length - 1].content).toBe(`turno ${limit + 4}`);
        conversationManager.deleteSession(sessionId);
    });

    test('expired sessions are purged on access', () => {
        const { sessionId } = conversationManager.createSession();
        const session = conversationManager.getSession(sessionId);

        // Forzar expiración retrocediendo la última actividad más allá del TTL
        session.lastActivityAt = new Date(Date.now() - (config.session.ttl + 1) * 60 * 1000);

        expect(conversationManager.getSession(sessionId)).toBeNull();
        // Ya fue purgada: borrar de nuevo devuelve false
        expect(conversationManager.deleteSession(sessionId)).toBe(false);
    });

    test('updateSessionMetadata updates emotion', () => {
        const { sessionId } = conversationManager.createSession();
        expect(conversationManager.updateSessionMetadata(sessionId, { emotion: 'happy' })).toBe(true);
        expect(conversationManager.getSession(sessionId).emotion).toBe('happy');
        conversationManager.deleteSession(sessionId);
    });

    test('cleanupExpiredSessions fires the onDelete hooks', () => {
        const purged = [];
        const unsubscribe = conversationManager.onDelete((id) => purged.push(id));
        const { sessionId } = conversationManager.createSession();
        const session = conversationManager.getSession(sessionId);

        // Forzar expiración retrocediendo la última actividad más allá del TTL
        session.lastActivityAt = new Date(Date.now() - (config.session.ttl + 1) * 60 * 1000);

        // El barrido real, no deleteSession: si el GC borrara del Map por su cuenta los hooks
        // no correrían y el test no probaría nada.
        conversationManager.cleanupExpiredSessions();

        expect(purged).toContain(sessionId);
        // Ya fue purgada: borrar de nuevo devuelve false
        expect(conversationManager.deleteSession(sessionId)).toBe(false);
        unsubscribe();
    });

    test('deleteSession removes an active session', () => {
        const { sessionId } = conversationManager.createSession();
        expect(conversationManager.deleteSession(sessionId)).toBe(true);
        expect(conversationManager.getSession(sessionId)).toBeNull();
    });
});
