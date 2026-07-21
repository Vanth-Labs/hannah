// src/server.js
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { router as apiRouter } from './api/router.js';
import { initWebSocketGateway } from './gateway/websocket.js';

const app = express();

// 1. Security Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Deshabilitar CSP para pruebas locales con scripts externos
}));
app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// 2. Rate Limiting (Protects the infrastructure against flooding)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// 3. Body Parsing Middleware
app.use(express.json());

// Servir cliente de prueba
app.use(express.static('.'));

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
const httpServer = app.listen(config.port, () => {
  logger.info(`Hannah Backend listening on port ${config.port} [ENV: ${config.env}]`);
});

initWebSocketGateway(httpServer);

export default httpServer;
