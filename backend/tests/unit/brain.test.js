// The first-run brain choice: what counts as "usable", what the machine can carry, and how
// vision/recall follow the mode. Pure helpers only — no Ollama, no network.
import { config } from '../../src/config.js';
import { hasModel, recommend, computeConfigured, syncBrain, validateCloud } from '../../src/pipeline/brain.js';

describe('brain: model matching', () => {
  test('exact tag, and bare name matches :latest', () => {
    expect(hasModel(['qwen2.5:7b', 'moondream:latest'], 'qwen2.5:7b')).toBe(true);
    expect(hasModel(['moondream:latest'], 'moondream')).toBe(true);
    expect(hasModel(['qwen2.5:latest'], 'qwen2.5:7b')).toBe(false);
    expect(hasModel([], 'qwen2.5:7b')).toBe(false);
  });
});

describe('brain: recommendation', () => {
  test('a real GPU or a roomy Apple Silicon -> local; otherwise cloud', () => {
    expect(recommend({ gpu: { vramGB: 16 } })).toBe('local');
    expect(recommend({ gpu: { vramGB: 6 }, ramGB: 32 })).toBe('cloud');
    expect(recommend({ appleSilicon: true, ramGB: 16 })).toBe('local');
    expect(recommend({ appleSilicon: true, ramGB: 8 })).toBe('cloud');
    expect(recommend({ ramGB: 64 })).toBe('cloud');
    expect(recommend(null)).toBe('cloud');
  });
});

describe('brain: configured', () => {
  test('local needs Ollama up AND the model pulled', () => {
    expect(computeConfigured({ mode: 'local', ollama: { reachable: true, models: ['qwen2.5:7b'] }, model: 'qwen2.5:7b' })).toBe(true);
    expect(computeConfigured({ mode: 'local', ollama: { reachable: true, models: [] }, model: 'qwen2.5:7b' })).toBe(false);
    expect(computeConfigured({ mode: 'local', ollama: { reachable: false, models: ['qwen2.5:7b'] }, model: 'qwen2.5:7b' })).toBe(false);
  });
  test('cloud needs a key and a non-local base URL; unset mode is never configured', () => {
    expect(computeConfigured({ mode: 'cloud', apiKey: 'gsk_x', baseUrl: 'https://api.groq.com/openai/v1' })).toBe(true);
    expect(computeConfigured({ mode: 'cloud', apiKey: '', baseUrl: 'https://api.groq.com/openai/v1' })).toBe(false);
    expect(computeConfigured({ mode: 'cloud', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' })).toBe(false);
    expect(computeConfigured({ mode: '', ollama: { reachable: true, models: ['qwen2.5:7b'] }, model: 'qwen2.5:7b', apiKey: 'k', baseUrl: 'https://x' })).toBe(false);
  });
});

describe('brain: vision and recall follow the mode', () => {
  const saved = { mode: config.brain.mode, vision: config.vision.provider, recall: config.memory.recallEnabled };
  afterAll(() => { config.brain.mode = saved.mode; config.vision.provider = saved.vision; config.memory.recallEnabled = saved.recall; });
  test('cloud and unset -> off; local -> the .env value', () => {
    config.brain.mode = 'cloud'; syncBrain();
    expect(config.vision.provider).toBe('off'); expect(config.memory.recallEnabled).toBe(false);
    config.brain.mode = ''; syncBrain();
    expect(config.vision.provider).toBe('off');
    config.brain.mode = 'local'; syncBrain();
    expect(config.vision.provider).not.toBe('off');
  });
});

describe('brain: the panel implies the mode', () => {
  test('saving a cloud base URL flips to cloud; a local one to local', async () => {
    const { applySettings } = await import('../../src/state/settings.js');
    const saved = { mode: config.brain.mode, baseUrl: config.llm.baseUrl, key: config.llm.apiKey };
    applySettings({ llm: { baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k' } });
    expect(config.brain.mode).toBe('cloud');
    applySettings({ llm: { baseUrl: 'http://localhost:11434/v1' } });
    expect(config.brain.mode).toBe('local');
    config.brain.mode = saved.mode; config.llm.baseUrl = saved.baseUrl; config.llm.apiKey = saved.key; syncBrain();
  });
});

describe('brain: cloud validation at choose time', () => {
  const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });
  test('a retired model is refused with the ids the provider does serve', async () => {
    const r = await validateCloud('https://api.groq.com/openai/v1', 'llama-3.1-8b-instant', 'gsk_x',
      respond(200, { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'openai/gpt-oss-20b' }] }));
    expect(r.ok).toBe(false); expect(r.error).toBe('model_not_found');
    expect(r.available).toEqual(['llama-3.3-70b-versatile', 'openai/gpt-oss-20b']);
  });
  test('a served model passes; Google-style "models/x" ids match too', async () => {
    expect((await validateCloud('https://x/v1', 'gemini-2.5-flash', 'k', respond(200, { data: [{ id: 'models/gemini-2.5-flash' }] }))).ok).toBe(true);
    expect((await validateCloud('https://x/v1', 'gpt-4o-mini', 'k', respond(200, { data: [{ id: 'gpt-4o-mini' }] }))).ok).toBe(true);
  });
  test('a bad key is refused; a provider without /models or a network error is trusted', async () => {
    expect((await validateCloud('https://x/v1', 'm', 'k', respond(401, {}))).error).toBe('bad_key');
    expect((await validateCloud('https://x/v1', 'm', 'k', respond(404, {}))).ok).toBe(true);
    expect((await validateCloud('https://x/v1', 'm', 'k', async () => { throw new Error('ECONNREFUSED'); })).ok).toBe(true);
    expect((await validateCloud('https://x/v1', 'm', '', respond(200, {}))).error).toBe('bad_key');
  });
});
