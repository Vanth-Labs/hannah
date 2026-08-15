// src/api/health.js
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { config } from '../config.js';

export const getHealth = (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: '0.1.0',
    services: {
      asr: config.asr.provider,
      llm: config.llm.provider,
      tts: config.tts.provider,
    },
    sidecars: {
      asr: config.asr.sidecarUrl,
      tts: config.tts.sidecarUrl,
      vision: config.vision.sidecarUrl,
      motion: config.motion.enabled
        ? (config.motion.provider === 'lab' ? config.motion.labUrl : config.motion.emageUrl)
        : 'disabled',
    },
    uptime_s: Math.floor(process.uptime()),
  });
};
