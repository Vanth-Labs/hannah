// src/api/health.js
// Los errores los captura el wrapper `handler` del router (api/handler.js).
import { config } from '../config.js';
import { isHealthy as agentHealthy, snapshot as agentTasks } from '../pipeline/agentBridge.js';
import { watchCounters } from '../pipeline/senseBridge.js';

export const getHealth = async (req, res) => {
  // Los "ojos": el contador sale de las FILAS del sidecar, no de la config, y es lo que contesta
  // "¿sigue mirando?" sin abrir el HUD. Vacío y con error se ven igual: nadie está mirando.
  const watches = config.sense.enabled ? await watchCounters() : { armed: 0, degraded: 0, blind: 0, suspended: 0, lastSampleAt: null };
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
    watches,
    uptime_s: Math.floor(process.uptime()),
  });
};
