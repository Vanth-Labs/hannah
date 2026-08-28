// The first-run brain choice: what counts as "usable", what the machine can carry, and how
// vision/recall follow the mode. Pure helpers only — no Ollama, no network.
import { config } from '../../src/config.js';
import { hasModel, recommend, computeConfigured, syncBrain } from '../../src/pipeline/brain.js';

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
