// src/pipeline/orchestrator.js
import { transcribeAudio } from './asr.js';
import { generateDialogueStream } from './llm.js';
import { synthesizeSpeechStream } from './tts.js';
import { generateVisemesFromText } from './lipsync.js';
import { generateMotion, generateMotionFromText } from './motion.js';
import { moveWindow, parseMoveIntent } from './windowControl.js';
import { conversationManager } from '../state/conversationManager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

/**
 * Acumula un stream legible de Node en un único Buffer
 */
// Caption libre de [MOTION:] -> clip de gesto Mixamo horneado en el frontend.
// Debe coincidir con GESTURE_NAMES / los .json en public/animations/baked/.
const GESTURE_MATCH = [
    ['wave', /wav|hello|\bhi\b|greet|goodbye|\bbye\b|salut/i],
    ['point', /point|indicat|show|señal/i],
    ['nod', /\bnod|agree|\byes\b|affirm|asint/i],
    ['shake_no', /shak|\bno\b|disagree|deny|declin|niega|neg/i],
    ['happy', /happy|excit|cheer|celebrat|\byay\b|aleg/i],
    ['dismiss', /dismiss|brush.*off|wave.*off|whatever|descart/i],
    ['acknowledge', /acknowledg|understand|got it|\bi see\b|okay|alright|entend|reconoc/i],
];
const matchGesture = (caption) => {
    for (const [key, rx] of GESTURE_MATCH) if (rx.test(caption)) return key;
    return null;
};

const collectStream = (stream) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });

/**
 * Helper interno: Genera TTS y LipSync para una oración y lo manda al cliente.
 * El audio de la oración se envía como UN solo mensaje con el WAV completo:
 * el frontend decodifica con decodeAudioData, que necesita el archivo entero.
 */
const processAndSendSegment = async (rawText, sendCallback, sessionId = '', signal) => {
    if (signal?.aborted) return;
    // Director de gestos: MOTION:acción marca un gesto DELIBERADO. Esa oración
    // se genera en modo acción (el cuerpo hace SOLO la acción, sin co-speech), y las
    // siguientes oraciones reanudan el co-speech — los dos modos nunca se mezclan.
    // El LLM usa [ ], * * o ( ) como delimitador. Exigimos apertura+cierre y
    // capturamos el caption completo entre ellos.
    const motionMatch = rawText.match(/[[(*]\s*MOTION:\s*([^\])*\n]+?)\s*[\])*]/i);
    const action = motionMatch ? (motionMatch[1] || '').trim() : '';

    // Director de ventana: [MOVE:posición] mueve el overlay por el escritorio/monitores.
    const moveMatch = rawText.match(/[[(*]\s*MOVE:\s*([^\])*\n]+?)\s*[\])*]/i);
    if (moveMatch) moveWindow((moveMatch[1] || '').trim());

    // Quitar etiquetas MOTION:/EMOTION:/MOVE: con cualquier delimitador: no deben verse
    // en el subtítulo, oírse en el TTS ni condicionar el co-speech. Incluye variantes
    // sin cerrar (streaming parcial) para que nunca se filtre un corchete suelto.
    const text = rawText
        // con o sin corchetes (llama3.1:8b a veces los omite), cerrada o no
        .replace(/[[(*]?\s*(MOTION|EMOTION|MOVE)\s*:[^\])*\n]*[\])*]?/gi, '')
        .replace(/[[(*]\s*$/g, '')                                       // delimitador abierto al final
        .replace(/\s+/g, ' ')
        .trim();
    // Si tras limpiar no queda texto real, ignorar el fragmento
    if (text.length < 2) return;

    try {
        const ttsResult = await synthesizeSpeechStream(text, signal);
        if (ttsResult.error) return;

        const lipsyncResult = generateVisemesFromText(text);
        const audioBuffer = await collectStream(ttsResult.audioStream);
        if (signal?.aborted) return;   // no enviar audio de un turno ya interrumpido

        const message = {
            type: 'audio_chunk',
            text: text, // Texto de la oración actual
            visemes: lipsyncResult.visemes,
            audioBase64: audioBuffer.toString('base64'),
            format: ttsResult.format,
            sample_rate: ttsResult.sample_rate,
        };

        // Director de gestos: si el caption de [MOTION:] mapea a un gesto Mixamo,
        // el frontend reproduce ese clip limpio (reemplaza el co-speech en esa oración,
        // los dos modos no se mezclan). Si no mapea, la oración va como co-speech normal.
        const gesture = action ? matchGesture(action) : null;
        if (gesture) message.action = gesture;

        // Co-speech (cuerpo hablando) solo cuando NO hay gesto deliberado.
        if (config.motion.enabled && !gesture) {
            let motionResult;
            if (config.motion.provider === 'lab') {
                // Duración real del WAV de Kokoro: PCM 16-bit mono (header 44 bytes)
                const sampleRate = ttsResult.sample_rate || 24000;
                const durationS = Math.max(0.5, (audioBuffer.length - 44) / (sampleRate * 2));
                const session = conversationManager.getSession(sessionId);
                motionResult = await generateMotionFromText(
                    text, durationS, session?.emotion || 'neutral', sessionId);
            } else {
                motionResult = await generateMotion(audioBuffer);
            }
            if (!motionResult.error) {
                message.motion = {
                    fps: motionResult.fps,
                    num_frames: motionResult.num_frames,
                    poses_b64: motionResult.poses_b64,
                    trans_b64: motionResult.trans_b64,
                };
                logger.info('Motion generado', {
                    frames: motionResult.num_frames,
                    latency_ms: motionResult.motion_latency_ms,
                });
            }
        }

        if (signal?.aborted) return;
        sendCallback(message);
    } catch (err) {
        logger.error('Error procesando segmento del orquestador', { message: err.message });
    }
};

/**
 * Orquesta un turno completo de conversación desde audio entrante hasta streaming de respuesta.
 */
export const processVoiceTurn = async (sessionId, audioBuffer, onStreamSegment, signal) => {
    try {
        // 1. Validar la sesión
        const session = conversationManager.getSession(sessionId);
        if (!session) throw new Error('La sesión no existe o ha expirado');

        // 2. ASR: Transcribir el audio del usuario
        logger.info('Iniciando transcripción ASR...', { sessionId });
        const asrResult = await transcribeAudio(audioBuffer);
        if (signal?.aborted) return;   // el usuario ya interrumpió
        if (asrResult.error || !asrResult.transcript.trim()) {
            throw new Error(asrResult.message || 'No se detectó voz clara en el audio');
        }

        // Guardar lo que dijo el usuario en la memoria in-memory de la sesión
        conversationManager.addTurn(sessionId, 'user', asrResult.transcript);

        // Comando de movimiento de ventana (determinista, no depende del LLM).
        const moveSpec = parseMoveIntent(asrResult.transcript);
        if (moveSpec) moveWindow(moveSpec);

        // Avisarle al cliente qué fue lo que entendimos
        onStreamSegment({ type: 'user_transcript', text: asrResult.transcript });

        // 3. LLM: Ejecutar el flujo del modelo pasándole el historial de turnos actual
        const updatedSession = conversationManager.getSession(sessionId);
        await executeLlmPipeline(sessionId, updatedSession.turns, onStreamSegment, signal);

    } catch (error) {
        logger.error('Fallo crítico en el Orquestador (Voz)', { message: error.message });
        onStreamSegment({ type: 'error', message: error.message });
    }
};

/**
 * Orquesta un turno disparado directamente por texto o alertas de sistemas externos como YOLO.
 * @param {string} sessionId - ID de la sesión activa
 * @param {string} systemPromptAlert - El reporte contextual listo para procesar por el LLM
 * @param {Function} onStreamSegment - Callback de envío al WebSocket
 */
export const processTextTurn = async (sessionId, systemPromptAlert, onStreamSegment) => {
    try {
        // 1. Validar la sesión
        const session = conversationManager.getSession(sessionId);
        if (!session) throw new Error('La sesión no existe o ha expirado');

        logger.info('⚙️ Procesando inyección visual en el pipeline de texto...', { sessionId });

        // 2. Para no contaminar la memoria limpia de la conversación con comandos de código,
        // creamos una copia temporal del historial agregando la alerta como si fuera un input del sistema
        const temporalTurns = [
            ...session.turns,
            { role: 'user', content: systemPromptAlert }
        ];

        // 3. LLM: Disparar directo la tubería cognitiva evadiendo el hardware del micrófono
        await executeLlmPipeline(sessionId, temporalTurns, onStreamSegment);

    } catch (error) {
        logger.error('Fallo crítico en el Orquestador (Texto/YOLO)', { message: error.message });
        onStreamSegment({ type: 'error', message: error.message });
    }
};

/**
 * Orquesta un turno de chat escrito por el usuario (input de texto del HUD).
 * A diferencia de processTextTurn (inyecciones de sistema/visión), el texto
 * SÍ se guarda en el historial de la conversación.
 */
export const processUserTextTurn = async (sessionId, text, onStreamSegment, signal) => {
    try {
        const session = conversationManager.getSession(sessionId);
        if (!session) throw new Error('La sesión no existe o ha expirado');

        conversationManager.addTurn(sessionId, 'user', text);

        // Comando de movimiento de ventana (determinista, no depende del LLM).
        const moveSpec = parseMoveIntent(text);
        if (moveSpec) moveWindow(moveSpec);

        const updatedSession = conversationManager.getSession(sessionId);
        await executeLlmPipeline(sessionId, updatedSession.turns, onStreamSegment, signal);
    } catch (error) {
        logger.error('Fallo crítico en el Orquestador (Texto usuario)', { message: error.message });
        onStreamSegment({ type: 'error', message: error.message });
    }
};

/**
 * Sub-proceso reutilizable para aislar y ejecutar el cerebro del LLM junto con TTS y LipSync.
 * Los segmentos se encadenan en una promesa secuencial: las oraciones llegan al cliente
 * en el orden hablado y turn_complete se emite solo cuando el último audio ya salió.
 */
const executeLlmPipeline = async (sessionId, turnsInput, onStreamSegment, signal) => {
    let sentenceBuffer = '';
    let segmentChain = Promise.resolve();
    logger.info('Despertando cerebro LLM...', { model: config.llm.model });

    const enqueueSegment = (text) => {
        // Barge-in: si el turno fue abortado, no sintetizar/enviar más oraciones.
        segmentChain = segmentChain.then(() => {
            if (signal?.aborted) return;
            return processAndSendSegment(text, onStreamSegment, sessionId, signal);
        });
    };

    await generateDialogueStream(
        turnsInput,
        // Callback por cada token generado
        (token) => {
            if (signal?.aborted) return;
            sentenceBuffer += token;

            if (/[.!?]\s*$/.test(sentenceBuffer) && sentenceBuffer.trim().length > 10) {
                enqueueSegment(sentenceBuffer.trim());
                sentenceBuffer = '';
            }
        },
        // Callback al finalizar el flujo por completo
        (finalLlmResult) => {
            // Si el usuario interrumpió, cortar en seco: no guardar respuesta parcial
            // ni emitir turn_complete.
            if (signal?.aborted || finalLlmResult.error) return;

            if (sentenceBuffer.trim().length > 0) {
                enqueueSegment(sentenceBuffer.trim());
            }

            // Guardar la respuesta final real en el historial oficial de la sesión
            conversationManager.addTurn(sessionId, 'assistant', finalLlmResult.text);
            conversationManager.updateSessionMetadata(sessionId, { emotion: finalLlmResult.emotion });

            // Cerrar ciclo de transmisión en el frontend cuando el último segmento ya fue enviado
            segmentChain = segmentChain.then(() => {
                if (signal?.aborted) return;
                onStreamSegment({
                    type: 'turn_complete',
                    emotion: finalLlmResult.emotion,
                    metrics: { llm_ms: finalLlmResult.duration_ms }
                });
            });
        },
        signal,
        { sessionId }   // ctx para las tools (p.ej. look_now usa el frame de la sesión)
    );

    // No devolver el control hasta que todos los segmentos pendientes hayan salido
    await segmentChain;
};
