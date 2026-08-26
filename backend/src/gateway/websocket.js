// src/gateway/websocket.js
import { WebSocketServer } from 'ws';
import { processVoiceTurn } from '../pipeline/orchestrator.js';
import { conversationManager } from '../state/conversationManager.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

// Pre-importar en lugar de dynamic import por cada mensaje
import { startVisionLoop, pushFrame, stopVisionLoop, getLastFrame, describeScene } from '../pipeline/visionLoop.js';
import { processTextTurn, processUserTextTurn } from '../pipeline/orchestrator.js';
import { getGaze } from '../pipeline/windowControl.js';
import { attach as terminalAttach, input as terminalInput, resize as terminalResize, dispose as terminalDispose, resolveConfirm } from '../pipeline/terminal.js';
import * as agentBridge from '../pipeline/agentBridge.js';

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
        // Las "manos": registrar la sesión para que los eventos del agente lleguen a ESTE
        // socket (y para reproducirle las tareas vivas si se conectó a mitad de una).
        agentBridge.attachSession(sessionId, (payload) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); });

        // Barge-in: un AbortController por turno en curso. INTERRUPT lo aborta para
        // que Hannah deje de generar/hablar al instante cuando el usuario retoma.
        let currentTurn = null;
        const abortCurrentTurn = () => {
            if (currentTurn) { currentTurn.abort(); currentTurn = null; }
            agentBridge.abortNarration(sessionId);   // la narración de las manos también calla; la tarea sigue
        };

        const safeSend = (payload) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify(payload));
            }
        };

        // Mirada global (solo overlay): sondea el cursor de Hyprland y le manda a Hannah
        // hacia dónde mirar, aunque el cursor esté en otro monitor. Se activa con GAZE_ON.
        let gazeTimer = null;
        const startGaze = () => {
            if (gazeTimer) return;
            gazeTimer = setInterval(async () => {
                const g = await getGaze();
                if (g) safeSend({ type: 'gaze', x: g.x, y: g.y });
            }, 80);
        };
        const stopGaze = () => { if (gazeTimer) { clearInterval(gazeTimer); gazeTimer = null; } };

        // Terminal: suscripción al stream del pty de esta sesión (para el panel xterm).
        let detachTerminal = null;

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
            } catch {
                // Solo metadata (regla: nunca loguear contenido del usuario).
                logger.error('JSON inválido recibido', {
                    sessionId,
                    byteLength: message.length,
                    firstChar: message.toString().slice(0, 1),
                });
                return; // no mandar error al cliente, solo ignorar
            }

            const action = data.command || data.type;
            logger.debug('Comando WebSocket recibido', { action, sessionId });

            try {
                switch (action) {
                    case 'INTERRUPT':
                        // El usuario empezó a hablar sobre Hannah: abortar su turno en curso.
                        logger.info('INTERRUPT: abortando turno en curso', { sessionId });
                        abortCurrentTurn();
                        break;

                    case 'GAZE_ON':
                        startGaze();
                        break;
                    case 'GAZE_OFF':
                        stopGaze();
                        break;

                    // El pty es una shell REAL: mismo gate que run_command (systemControl).
                    // Sin el flag no se crea ni se escribe en la terminal.
                    case 'TERMINAL_START':
                        if (!config.tools.systemControl) {
                            safeSend({ type: 'error', message: 'terminal deshabilitada (activá TOOLS_SYSTEM_CONTROL)' });
                            break;
                        }
                        if (!detachTerminal) detachTerminal = terminalAttach(sessionId, safeSend);
                        break;
                    case 'TERMINAL_IN':
                        if (!config.tools.systemControl) break;
                        terminalInput(sessionId, data.data || '');
                        break;
                    case 'TERMINAL_RESIZE':
                        if (!config.tools.systemControl) break;
                        terminalResize(sessionId, data.cols, data.rows);
                        break;
                    case 'CONFIRM_COMMAND':
                        resolveConfirm(data.id, data.approved);
                        break;

                    // Botones del HUD hacia las "manos". `by: 'hud'` es la atribución que permite
                    // conceder un `high` (por voz el agente lo rechaza: anti-spoofing, T7).
                    case 'AGENT_APPROVAL':
                        await agentBridge.decide(data.taskId, data.approvalId, data.decision === 'allow' ? 'allow' : 'deny', 'hud');
                        break;
                    case 'AGENT_ANSWER':
                        await agentBridge.reply(data.taskId, data.questionId, String(data.answer || ''));
                        break;
                    case 'AGENT_CANCEL':
                        await agentBridge.cancelTask(data.taskId, 'user');
                        break;

                    case 'SPEECH_START':
                        logger.info('Usuario empezó a hablar, limpiando buffers...', { sessionId });
                        // Si Hannah aún hablaba, cortar (barge-in por voz). OJO: esto aborta la
                        // NARRACIÓN, nunca la tarea del agente — la tarea sigue (INTEGRATION §5).
                        abortCurrentTurn();
                        audioChunks = [];
                        // Cuándo EMPEZÓ a hablar: una aprobación pendiente solo la responde un
                        // enunciado que empezó después de la pregunta.
                        agentBridge.markSpeechStart(sessionId);
                        break;

                    case 'SPEECH_END': {
                        logger.info('Usuario terminó de hablar. Procesando turno...', { sessionId });
                        if (audioChunks.length === 0) {
                            safeSend({ type: 'error', message: 'No se recibió audio' });
                            break;
                        }
                        const completeAudioBuffer = Buffer.concat(audioChunks);
                        audioChunks = [];
                        currentTurn = new AbortController();
                        agentBridge.setTurnActive(sessionId, true);
                        try {
                            await processVoiceTurn(sessionId, completeAudioBuffer, safeSend, currentTurn.signal);
                        } finally { agentBridge.setTurnActive(sessionId, false); }
                        break;
                    }

                    case 'TEXT_INPUT': {
                        const text = (data.text || '').trim();
                        if (!text) {
                            safeSend({ type: 'error', message: 'Texto vacío' });
                            break;
                        }
                        abortCurrentTurn();
                        // ¿Es la respuesta a una aprobación/pregunta pendiente del agente? Si sí, se
                        // consume ahí y NO entra a la conversación. Un texto tecleado "empieza" ahora.
                        if (await agentBridge.routeUtterance(sessionId, text, Date.now())) break;
                        currentTurn = new AbortController();
                        agentBridge.setTurnActive(sessionId, true);
                        try {
                            await processUserTextTurn(sessionId, text, safeSend, currentTurn.signal);
                        } finally { agentBridge.setTurnActive(sessionId, false); }
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

                        const sceneSummary = await describeScene(lastFrame);
                        const yoloPrompt = `[SISTEMA - CÁMARA]: Escaneo completado. Veo: "${sceneSummary}". Reacciona de inmediato de forma hablada adoptando tu personalidad de Hannah AI. Sé directa y concisa.`;
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
            abortCurrentTurn();
            agentBridge.detachSession(sessionId);
            stopGaze();
            if (detachTerminal) detachTerminal();
            terminalDispose(sessionId);
            audioChunks = [];
            stopVisionLoop(sessionId);
        });
    });

    return wss;
};
