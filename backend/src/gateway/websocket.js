// src/gateway/websocket.js
import { WebSocketServer } from 'ws';
import { processVoiceTurn } from '../pipeline/orchestrator.js';
import { conversationManager } from '../state/conversationManager.js';
import { logger } from '../utils/logger.js';

// Pre-importar en lugar de dynamic import por cada mensaje
import { startVisionLoop, pushFrame, stopVisionLoop, getLastFrame } from '../pipeline/visionLoop.js';
import { processTextTurn, processUserTextTurn } from '../pipeline/orchestrator.js';
import { analyzeFrame } from '../pipeline/vision.js';

export const initWebSocketGateway = (httpServer) => {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const sessionId = url.searchParams.get('sessionId');

        if (!sessionId || !conversationManager.getSession(sessionId)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request, sessionId);
        });
    });

    wss.on('connection', (ws, request, sessionId) => {
        logger.info('Cliente conectado a través de WebSocket Gateway', { sessionId });

        let audioChunks = [];

        const safeSend = (payload) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(payload));
            }
        };

        ws.on('message', async (message, isBinary) => {
            // ── Mensajes binarios: chunks de audio ──────────────────────────
            if (isBinary) {
                const currentBufferSize = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
                if (currentBufferSize + message.length > 5 * 1024 * 1024) {
                    logger.warn('Buffer de audio excedido (5MB). Ignorando chunk.', { sessionId });
                    return;
                }
                audioChunks.push(message);
                return;
            }

            // ── Mensajes de texto: comandos JSON ────────────────────────────
            let data;
            try {
                data = JSON.parse(message.toString());
            } catch (parseErr) {
                // Log del contenido crudo para diagnosticar (primeros 300 chars)
                const raw = message.toString().slice(0, 300);
                logger.error('JSON inválido recibido', {
                    sessionId,
                    preview: raw,
                    byteLength: message.length,
                });
                return; // no mandar error al cliente, solo ignorar
            }

            const action = data.command || data.type;
            logger.debug('Comando WebSocket recibido', { action, sessionId });

            try {
                switch (action) {
                    case 'SPEECH_START':
                        logger.info('Usuario empezó a hablar, limpiando buffers...', { sessionId });
                        audioChunks = [];
                        break;

                    case 'SPEECH_END': {
                        logger.info('Usuario terminó de hablar. Procesando turno...', { sessionId });
                        if (audioChunks.length === 0) {
                            safeSend({ type: 'error', message: 'No se recibió audio' });
                            break;
                        }
                        const completeAudioBuffer = Buffer.concat(audioChunks);
                        audioChunks = [];
                        await processVoiceTurn(sessionId, completeAudioBuffer, safeSend);
                        break;
                    }

                    case 'TEXT_INPUT': {
                        const text = (data.text || '').trim();
                        if (!text) {
                            safeSend({ type: 'error', message: 'Texto vacío' });
                            break;
                        }
                        await processUserTextTurn(sessionId, text, safeSend);
                        break;
                    }

                    case 'VISION_START':
                        startVisionLoop(sessionId, safeSend);
                        safeSend({ type: 'vision_started' });
                        logger.info('Loop de visión iniciado por cliente', { sessionId });
                        break;

                    case 'VISION_FRAME':
                        pushFrame(sessionId, data.frame);
                        break;

                    case 'VISION_STOP':
                        stopVisionLoop(sessionId);
                        logger.info('Loop de visión detenido por cliente', { sessionId });
                        break;

                    case 'TRIGGER_YOLO': {
                        logger.info('Solicitud YOLO manual recibida', { sessionId });

                        // El análisis necesita un frame real: usar el último recibido del loop de visión
                        const lastFrame = getLastFrame(sessionId);
                        if (!lastFrame) {
                            safeSend({ type: 'error', message: 'No hay frames de cámara disponibles. Activa la visión primero (VISION_START).' });
                            break;
                        }

                        const visionReport = await analyzeFrame(lastFrame);
                        const yoloPrompt = `[SISTEMA - ALERTA DE CÁMARA YOLO]: Escaneo completado. Detección: "${visionReport.summary}". Reacciona de inmediato de forma hablada adoptando tu personalidad de Hannah AI. Sé directa, concisa y alerta al usuario.`;
                        await processTextTurn(sessionId, yoloPrompt, safeSend);
                        break;
                    }

                    default:
                        logger.warn('Comando desconocido recibido', { action, sessionId });
                }
            } catch (err) {
                logger.error('Error ejecutando comando WebSocket', {
                    action,
                    sessionId,
                    message: err.message,
                    stack: err.stack?.split('\n')[1], // primera línea del stack
                });
                safeSend({ type: 'error', message: 'Error interno de procesamiento' });
            }
        });

        ws.on('close', () => {
            logger.info('Conexión WebSocket cerrada por el cliente', { sessionId });
            audioChunks = [];
            stopVisionLoop(sessionId);
        });
    });

    return wss;
};
