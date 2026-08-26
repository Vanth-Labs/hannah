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
