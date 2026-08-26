// src/api/health.js
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { config } from '../config.js';
import { isHealthy as agentHealthy, snapshot as agentTasks } from '../pipeline/agentBridge.js';

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
    // Las "manos". `healthy` sí es real (viene del stream de eventos), a diferencia de los
    // sidecars de arriba, que solo reflejan la config.
    agent: config.agent.enabled
      ? { enabled: true, healthy: agentHealthy(), url: config.agent.url, tasks: agentTasks().length }
      : { enabled: false },
    uptime_s: Math.floor(process.uptime()),
  });
};
