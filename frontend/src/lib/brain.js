// src/lib/brain.js
// The brain providers, shared by the first-run welcome screen and the ⚙ panel's Brain card.
// Cloud entries are OpenAI-compatible; the model is each provider's "good and cheap" one.
export const CLOUD = [
    { id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1/', model: 'claude-haiku-4-5-20251001', keys: 'https://console.anthropic.com' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keys: 'https://platform.openai.com/api-keys' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', keys: 'https://console.groq.com/keys' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct', keys: 'https://openrouter.ai/keys' },
];
export const LOCAL = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' };
export const isLocalUrl = (u) => /localhost|127\.0\.0\.1|:11434/.test(u || '');
export const cloudOf = (u) => CLOUD.find((c) => (u || '').startsWith(c.baseUrl.replace(/\/$/, '')));
