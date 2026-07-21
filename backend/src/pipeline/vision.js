// src/pipeline/vision.js
import axios from 'axios';
import { config } from '../config.js';

const VISION_URL = config.vision.sidecarUrl;

export const visionPipeline = {
    analyzeScene: async (imageBase64) => {
        try {
            const response = await axios.post(`${VISION_URL}/analyze-scene`, {
                image_base64: imageBase64
            });
            return response.data;
        } catch (error) {
            console.error('❌ Error en src/pipeline/vision.js:', error.message);
            throw error;
        }
    }
};

export async function analyzeFrame(imageBase64) {
    return visionPipeline.analyzeScene(imageBase64);
}
