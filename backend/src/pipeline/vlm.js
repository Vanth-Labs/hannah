// src/pipeline/vlm.js
// Visión con modelo VLM LOCAL (Ollama moondream/llava vía API OpenAI-compat).
// Describe/entiende la escena en vez de solo listar objetos como YOLO.
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let _client = null;
let _key = '';
const getClient = () => {
    const key = config.vision.vlmBaseUrl;
    if (!_client || key !== _key) {
        _client = new OpenAI({ apiKey: 'ollama', baseURL: config.vision.vlmBaseUrl });
        _key = key;
    }
    return _client;
};

/**
 * Describe un frame (JPEG base64) con el VLM local. Devuelve texto ('' si falla).
 * @param {string} base64Jpeg - base64 crudo o data-URI; se normaliza.
 * @param {string} prompt - qué preguntar sobre la imagen.
 */
export const describeFrame = async (base64Jpeg, prompt = 'Describe briefly, in one sentence, what you see in this camera image.') => {
    if (!base64Jpeg) return '';
    const b64 = base64Jpeg.replace(/^data:image\/\w+;base64,/, '');
    try {
        const res = await getClient().chat.completions.create({
            model: config.vision.vlmModel,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
                ],
            }],
            max_tokens: 120,
        });
        return res.choices[0]?.message?.content?.trim() || '';
    } catch (error) {
        logger.error('VLM describeFrame falló', { message: error.message });
        return '';
    }
};
