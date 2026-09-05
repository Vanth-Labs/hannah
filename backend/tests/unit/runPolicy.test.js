import { config } from '../../src/config.js';
import * as bridge from '../../src/pipeline/agentBridge.js';
import { buildSystemPrompt, runAllowed, handleRunTag } from '../../src/pipeline/llm.js';

// Política de comandos libres: quién corre un [RUN:] que no es skill ni intención determinista.
// Con manos (agente encendido y sano) la opción por defecto es que vaya al agente.

const fakeClient = () => {
    const calls = [];
    return {
        calls,
        health: async () => ({ healthy: true, activeTasks: 0 }),
        listTasks: async () => ({ tasks: [] }),
        createTask: async (body) => { calls.push(body); return { taskId: `t_${calls.length}` }; },
        subscribe: () => () => {},
        approve: async () => ({}), answer: async () => ({}), cancel: async () => ({}), getTask: async () => ({}),
    };
};

describe('run policy', () => {
    const original = { policy: config.tools.runPolicy, agent: config.agent.enabled };
    afterEach(() => { config.tools.runPolicy = original.policy; config.agent.enabled = original.agent; bridge._reset(); });

    test('free: always allowed, prompt teaches [RUN:]', async () => {
        config.tools.runPolicy = 'free'; config.agent.enabled = true; bridge._setHealthy(true);
        expect(runAllowed()).toBe(true);
        const p = await buildSystemPrompt([], true, false);
        expect(p).toContain('[RUN: <command>]');
        expect(p).toContain('[TASK:');            // y la frontera RUN/TASK
        expect(p).not.toContain('never write [RUN:]');
    });

    test('agent-first with healthy hands: [RUN:] leaves the prompt, [TASK:] is the only way', async () => {
        config.tools.runPolicy = 'agent-first'; config.agent.enabled = true; bridge._setHealthy(true);
        expect(runAllowed()).toBe(false);
        const p = await buildSystemPrompt([], true, false);
        expect(p).not.toContain('[RUN: <command>]');
        expect(p).not.toContain('COMMAND REFERENCE');   // los cheat-sheets de [RUN:] tampoco
        expect(p).toContain('never write [RUN:]');
        expect(p).toContain('[TASK:');
        expect(p).not.toContain('{{RUN_PROTOCOL}}');    // el placeholder nunca llega al modelo
    });

    test('agent-first with hands down: falls back to running locally', async () => {
        config.tools.runPolicy = 'agent-first'; config.agent.enabled = true; bridge._setHealthy(false);
        expect(runAllowed()).toBe(true);
        const p = await buildSystemPrompt([], true, false);
        expect(p).toContain('[RUN: <command>]');
        expect(p).not.toContain('[TASK:');
    });

    test('skills-only: never, with or without hands', async () => {
        config.tools.runPolicy = 'skills-only'; config.agent.enabled = false; bridge._setHealthy(false);
        expect(runAllowed()).toBe(false);
        const p = await buildSystemPrompt([], true, false);
        expect(p).not.toContain('[RUN: <command>]');
        expect(p).toContain('You can NOT run commands');
        config.agent.enabled = true; bridge._setHealthy(true);
        expect(runAllowed()).toBe(false);
    });

    test('a stray [RUN:] under agent-first becomes a task for the hands, never a pty command', async () => {
        config.tools.runPolicy = 'agent-first'; config.agent.enabled = true;
        const client = fakeClient();
        await bridge.init({ narrate: async () => {}, classify: async () => 'OTHER', client });
        bridge._setHealthy(true);
        const reply = await handleRunTag('du -sh ~/Downloads', { sessionId: 's1' });
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0].prompt).toContain('du -sh ~/Downloads');
        expect(reply).toMatch(/handed to your HANDS/);
        expect(reply).toMatch(/do NOT claim a result/);
    });

    test('a stray [RUN:] under skills-only is refused with an explanation for the model', async () => {
        config.tools.runPolicy = 'skills-only'; config.agent.enabled = false; bridge._setHealthy(false);
        const reply = await handleRunTag('du -sh ~/Downloads', { sessionId: 's1' });
        expect(reply).toMatch(/^refused/);
    });
});

describe('keepOnlyTask — la prosa alrededor de un [TASK:] no se habla', () => {
    test('descarta cifras inventadas y deja solo el tag', async () => {
        const { keepOnlyTask } = await import('../../src/pipeline/llm.js');
        const reply = 'Your Documents folder contains 24 files. The biggest is "report2023.docx" (5MB). [TASK: count the files in Documents and find the three largest]';
        expect(keepOnlyTask(reply)).toBe('[TASK: count the files in Documents and find the three largest]');
    });
    test('se lleva también un [MOVE:] colado en la misma respuesta', async () => {
        const { keepOnlyTask } = await import('../../src/pipeline/llm.js');
        expect(keepOnlyTask('[MOVE:next-screen] On it! [TASK: list the PDFs in Downloads]')).toBe('[TASK: list the PDFs in Downloads]');
    });
    test('sin [TASK:] no toca nada', async () => {
        const { keepOnlyTask } = await import('../../src/pipeline/llm.js');
        expect(keepOnlyTask('Sure, the task: finish it later.')).toBe('Sure, the task: finish it later.');
        expect(keepOnlyTask('')).toBe('');
    });
});
