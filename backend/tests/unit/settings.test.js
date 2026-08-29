import { config } from '../../src/config.js';
import { applySettings, getSettings } from '../../src/state/settings.js';

describe('applySettings — agent section', () => {
  const original = { ...config.agent };
  afterEach(() => { Object.assign(config.agent, original); });

  test('a blank url/mode from the panel keeps the .env defaults', () => {
    config.agent.url = 'http://127.0.0.1:8006';
    config.agent.mode = 'companion';
    applySettings({ agent: { url: '', mode: '', apiKey: 'sk-ant-test', token: '' } });
    expect(config.agent.url).toBe('http://127.0.0.1:8006');
    expect(config.agent.mode).toBe('companion');
    expect(config.agent.apiKey).toBe('sk-ant-test');
  });

  test('an explicit url/mode still applies', () => {
    applySettings({ agent: { url: 'http://127.0.0.1:9999', mode: 'paranoid' } });
    expect(config.agent.url).toBe('http://127.0.0.1:9999');
    expect(config.agent.mode).toBe('paranoid');
  });

  test('secrets never come back, only their presence', () => {
    applySettings({ agent: { apiKey: 'sk-ant-test', token: 'tok' } });
    const view = getSettings().agent;
    expect(view.apiKey).toBeUndefined();
    expect(view.token).toBeUndefined();
    expect(view.hasApiKey).toBe(true);
    expect(view.hasToken).toBe(true);
  });
});

describe('writeSettings validates a cloud brain before saving', () => {
  const originalLlm = { ...config.llm };
  const originalFetch = global.fetch;
  afterEach(() => { Object.assign(config.llm, originalLlm); global.fetch = originalFetch; });
  const res = () => { const r = { code: 0, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
  const providerWith = (ids) => async () => ({ ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ id })) }) });

  test('a model the provider no longer serves is refused with the list of what it has', async () => {
    const { writeSettings } = await import('../../src/api/settings.js');
    config.llm.baseUrl = 'https://api.groq.com/openai/v1'; config.llm.apiKey = 'gsk_x';
    global.fetch = providerWith(['openai/gpt-oss-20b', 'whisper-large-v3']);
    const r = res();
    await writeSettings({ body: { llm: { model: 'llama-3.3-70b-versatile' } } }, r);
    expect(r.code).toBe(400);
    expect(r.body.error).toBe('model_not_found');
    expect(r.body.available).toEqual(['openai/gpt-oss-20b']);
    expect(config.llm.model).toBe(originalLlm.model);   // nothing was applied
  });

  test('a local brain (Ollama) is never validated against a provider', async () => {
    const { writeSettings } = await import('../../src/api/settings.js');
    global.fetch = async () => { throw new Error('must not be called'); };
    const r = res();
    await writeSettings({ body: { llm: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' } } }, r);
    expect(r.code).toBe(200);
    expect(config.llm.model).toBe('qwen2.5:7b');
  });
});
