// src/lib/brain.js
// The brain providers, shared by the first-run welcome screen and the ⚙ panel's Brain card.
// Cloud entries are OpenAI-compatible; the model is each provider's "good and cheap" one.
// Prefer models that answer without a long hidden reasoning phase (Gemini 3.x flash, o-series):
// Hannah speaks sentence by sentence and a 10 to 50 s think before the first word feels dead.
// Groq retires model ids often (llama-3.1-8b-instant, llama-3.3-70b-versatile are gone).
export const CLOUD = [
    { id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1/', model: 'claude-haiku-4-5-20251001', keys: 'https://console.anthropic.com' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keys: 'https://platform.openai.com/api-keys' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-20b', keys: 'https://console.groq.com/keys' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct', keys: 'https://openrouter.ai/keys' },
    // Google AI Studio speaks the OpenAI protocol on this path; the key goes as a bearer like the rest.
    { id: 'google', label: 'Google (Gemini, AI Studio)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash', keys: 'https://aistudio.google.com/apikey' },
];
export const LOCAL = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' };
export const isLocalUrl = (u) => /localhost|127\.0\.0\.1|:11434/.test(u || '');
export const cloudOf = (u) => CLOUD.find((c) => (u || '').startsWith(c.baseUrl.replace(/\/$/, '')));
