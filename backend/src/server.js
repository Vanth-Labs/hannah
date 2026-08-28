// src/server.js
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { router as apiRouter } from './api/router.js';
import { initWebSocketGateway } from './gateway/websocket.js';
import { requireUiAuth, clientIp, isLoopback } from './api/auth.js';
import * as agentBridge from './pipeline/agentBridge.js';
import * as senseBridge from './pipeline/senseBridge.js';
import { processTextTurn } from './pipeline/orchestrator.js';
import { classifyIntent } from './pipeline/llm.js';
import { loadPersisted } from './state/settings.js';
import { loadShortcuts } from './state/shortcuts.js';
import { loadSkills } from './state/skills.js';
import { loadReference } from './state/reference.js';

// Aplica la config de proveedores guardada por el usuario (data/settings.json)
// por encima de los defaults de .env, antes de servir peticiones.
loadPersisted();
loadShortcuts();
loadSkills();
loadReference();

const app = express();

// 1. Security Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Deshabilitar CSP para pruebas locales con scripts externos
}));
// CORS: la lista de CORS_ORIGIN más CUALQUIER origen de loopback (la app Electron sirve el
// dist en un puerto aleatorio de 127.0.0.1; antes apagaba webSecurity para saltarse esto).
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || config.corsOrigin.includes(origin) || LOOPBACK_ORIGIN.test(origin)),
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Rate Limiting (Protects the infrastructure against flooding)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,                // por IP (antes 100: se agotaba en uso normal)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  // LOCALHOST EXENTO: es la propia app (panel ⚙, sesiones, reconexiones). Limitarla solo
  // servía para romperse solo — con el backend en 127.0.0.1 no hay nada de qué protegerse.
  // El límite queda para cuando alguien pone HOST=0.0.0.0 y lo expone a la red.
  // OJO: a través del proxy de Vite TODO llega como 127.0.0.1; la IP real es la que Vite
  // añade en X-Forwarded-For (api/auth.js). Solo se exime al loopback de verdad.
  skip: (req) => isLoopback(clientIp(req)),
});
app.use('/api/', limiter);
// Quién puede usar la API: esta máquina sin más; otro equipo, con el token de la UI.
app.use('/api/v1', requireUiAuth);

// 3. Body Parsing Middleware
app.use(express.json());

// Servir SOLO el cliente de prueba (no todo el root: express.static('.') exponía
// data/settings.json con API keys y data/memory.db con el historial completo).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.get(['/', '/test-client.html'], (req, res) => {
  res.sendFile(path.resolve(__dirname, '../test-client.html'));
});

// 4. API Routes
app.use('/api/v1', apiRouter);

// 5. Global Error Handler (Prevents server crashes and ensures strict rule compliance)
app.use((err, req, res, next) => {
  // Log metadata only - never user inputs or context
  logger.error('Unhandled server exception', {
    message: err.message,
    stack: config.env === 'development' ? err.stack : undefined
  });

  res.status(500).json({
    error: 'internal_server_error',
    message: config.env === 'development' ? err.message : 'An unexpected error occurred.'
  });
});

// 6. Start Server
const httpServer = app.listen(config.port, config.host, () => {
  logger.info(`Hannah Backend listening on ${config.host}:${config.port} [ENV: ${config.env}]`);
});

initWebSocketGateway(httpServer);

// Las "manos": el puente con hannah-agent. processTextTurn se INYECTA (es el mismo camino por
// el que a la persona le llegan sus ojos): así la narración sale con su voz, emoción y gestos.
// Si AGENT_ENABLED=false, init() no hace nada y todo lo demás es no-op.
agentBridge.init({ narrate: processTextTurn, classify: classifyIntent })
  .catch((e) => logger.error('agent bridge init failed', { message: e.message }));

// Los "ojos": el puente con hannah-sense. No recibe `narrate`: narra por la MISMA cola del puente
// del agente (una sola boca), atado a la sesión que armó cada vigilancia. Si SENSE_ENABLED=false,
// init() no hace nada y todo lo demás es no-op.
senseBridge.init()
  .catch((e) => logger.error('sense bridge init failed', { message: e.message }));

// Apagado limpio: la tarea activa se cancela con reason "shutdown" (no se deja huérfana).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // El buzón de vigilancias se persiste en el apagado: un disparo sin entregar no se pierde
    // porque el usuario reinició.
    Promise.allSettled([agentBridge.shutdown(), senseBridge.shutdown()]).finally(() => process.exit(0));
  });
}

export default httpServer;
