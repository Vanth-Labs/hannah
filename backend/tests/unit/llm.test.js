// tests/unit/llm.test.js
// El cliente OpenAI se instancia al importar el módulo: garantizar una API key
// antes del import dinámico para que la suite no dependa de un .env local.
process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'test-key';

const { parseLlmResponse } = await import('../../src/pipeline/llm.js');

describe('parseLlmResponse', () => {
    test('parses and strips a trailing emotion tag', () => {
        const raw = 'Hola, soy Hannah.\n[EMOTION:happy]';
        const { text, emotion } = parseLlmResponse(raw);
        expect(text).toBe('Hola, soy Hannah.');
        expect(emotion).toBe('happy');
    });

    test('is case-insensitive on the tag', () => {
        const { emotion } = parseLlmResponse('Claro.\n[emotion:SURPRISED]');
        expect(emotion).toBe('surprised');
    });

    test('defaults to neutral when no tag is present', () => {
        const { text, emotion } = parseLlmResponse('Respuesta sin etiqueta.');
        expect(text).toBe('Respuesta sin etiqueta.');
        expect(emotion).toBe('neutral');
    });

    test('defaults to neutral on an unknown emotion but still strips the tag', () => {
        const { text, emotion } = parseLlmResponse('Hola.\n[EMOTION:furious]');
        expect(emotion).toBe('neutral');
        expect(text).toBe('Hola.');
    });

    test('strips a tag that appears mid-text', () => {
        const { text, emotion } = parseLlmResponse('Primera parte. [EMOTION:thinking] Segunda parte.');
        expect(emotion).toBe('thinking');
        expect(text).toBe('Primera parte.  Segunda parte.');
    });
});

describe('[YOUR HANDS] echoed by the model', () => {
  test('keepOnlyTask keeps only the label so the prose is never spoken', async () => {
    const { keepOnlyTask, stripActionTags } = await import('../../src/pipeline/llm.js');
    expect(keepOnlyTask('[YOUR HANDS] Creating a file named notes.txt now. [EMOTION:happy]')).toBe('[YOUR HANDS]');
    expect(keepOnlyTask('Sure thing! [EMOTION:happy]')).toBe('Sure thing! [EMOTION:happy]');
    expect(stripActionTags('[YOUR HANDS] hello').trim()).toBe('hello');
  });
});
