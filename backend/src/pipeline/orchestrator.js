// src/pipeline/orchestrator.js
import { transcribeAudio } from './asr.js';
import { generateDialogueStream, stripActionTags, HANDS_LABEL_RE } from './llm.js';
import { isReady as brainReady } from './brain.js';
import { synthesizeSpeechStream } from './tts.js';
import { generateVisemesFromText } from './lipsync.js';
import { generateMotion, generateMotionFromText, wavDurationS, MOTION_TAIL_S } from './motion.js';
import { moveWindow, parseMoveIntent } from './windowControl.js';
import * as agentBridge from './agentBridge.js';
import { handleOpenIntent, handleCloseIntent, resolveDataAction, armWatch } from './tools.js';
import { resolveSkillPhrase } from '../state/skills.js';
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
// Sesiones que ya gastaron su gesto deliberado en el turno en curso (se limpia al empezar uno).
const gestureUsed = new Set();
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
// Si el usuario dio un comando de movimiento DETERMINISTA en el turno, ignoramos el [MOVE:]
// que el modelo pueda emitir después (revertía "pantalla completa" a una esquina compacta,
// porque "fullscreen" no está en el vocabulario de [MOVE:]).
const recentUserMove = new Map();   // sessionId -> timestamp
// Últimas palabras del usuario por sesión: son el `title` de la tarea (lo que ve el HUD y el
// historial), en vez de la descripción imperativa que escribe el modelo.
const lastUserWords = new Map();
const lastUserText = new Map();     // sessionId -> la frase entera (para delegarla literal a las manos)
// Estado por sesión de este módulo: se limpia cuando la sesión muere (si no, crece para siempre).
conversationManager.onDelete((sessionId) => {
    gestureUsed.delete(sessionId); recentUserMove.delete(sessionId); lastUserWords.delete(sessionId); lastUserText.delete(sessionId);
});
export const taskMisuse = { count: 0 };
const markUserMove = (sessionId) => recentUserMove.set(sessionId || 'default', Date.now());
const userMovedRecently = (sessionId) => Date.now() - (recentUserMove.get(sessionId || 'default') || 0) < 15000;

// `noActions`: el turno solo NARRA (visión, eventos de las manos). Su entrada es texto que
// escribió otro (una escena de la cámara, un evento del agente), así que un [MOVE:]/[TASK:]
// en la respuesta no es una orden del usuario: es una inyección o un error del modelo. Se
// gatea la EJECUCIÓN, nunca el stripping: la etiqueta tiene que desaparecer del texto igual,
// porque si no el TTS lee "[TASK: ...]" en voz alta.
//
// DEVUELVE EL ACUSE: `true` solo si esta oración SALIÓ de verdad por el socket con su audio.
// Es el único hecho comprobable de "se dijo" que existe en esta capa, y quien narra un disparo
// de vigilancia no puede consumirlo sin él (ver processTextTurn -> narrateTo -> senseBridge):
// un barge-in, un TTS caído o un fragmento que se quedó sin texto son silencio, no entrega.
const processAndSendSegment = async (rawText, sendCallback, sessionId = '', signal, noActions = false) => {
    if (signal?.aborted) return false;
    // Un drop silencioso esconde por igual un intento de inyección y una torpeza del modelo.
    const refuseAction = (tag, arg) => logger.warn('acción ignorada en turno de narración', {
        sessionId, tag, arg: String(arg || '').slice(0, 120),
    });
    // Director de gestos: MOTION:acción marca un gesto DELIBERADO. Esa oración
    // se genera en modo acción (el cuerpo hace SOLO la acción, sin co-speech), y las
    // siguientes oraciones reanudan el co-speech — los dos modos nunca se mezclan.
    // El LLM usa [ ], * * o ( ) como delimitador. Exigimos apertura+cierre y
    // capturamos el caption completo entre ellos.
    // [MOTION:] NO se gatea con noActions a propósito: un gesto es cómo se ve la persona
    // mientras habla, no una acción sobre la máquina. Peor: narrar la cámara SIN poder
    // saludar la dejaría tiesa justo cuando reacciona a alguien. Lo que un texto ajeno
    // podría lograr acá es que mueva un brazo, no que corra un comando ni mueva la ventana.
    const motionMatch = rawText.match(/[[(*]\s*MOTION:\s*([^\])*\n]+?)\s*[\])*]/i);
    const action = motionMatch ? (motionMatch[1] || '').trim() : '';

    // Director de ventana: [MOVE:posición] mueve el overlay. PERO si el usuario ya movió por
    // comando determinista este turno, lo ignoramos (si no, revierte "pantalla completa").
    const moveMatch = rawText.match(/[[(*]\s*MOVE:\s*([^\])*\n]+?)\s*[\])*]/i);
    if (moveMatch && noActions) {
        refuseAction('MOVE', moveMatch[1]);
    } else if (moveMatch && !userMovedRecently(sessionId)) {
        const spec = (moveMatch[1] || '').trim();
        // Mismo criterio que la capa determinista: mover acá, y delegar en el cliente SOLO si
        // el adaptador no pudo. Sin el fallback, en Windows/macOS el [MOVE:] no hacía nada.
        moveWindow(spec)
            .then((moved) => { if (!moved) sendCallback({ type: 'window_move', spec }); })
            .catch((e) => logger.error('moveWindow falló', { message: e.message }));
    }

    // Director de manos: [TASK:descripción] manda un trabajo de varios pasos al agente. Se
    // despacha acá (no en el bucle de acciones de llm.js) porque una tarea dura minutos y sus
    // resultados vuelven como eventos que la persona NARRA — no como una respuesta síncrona.
    // Si el agente no está, el tag no estaba en el prompt; si el modelo lo emite igual, se
    // stripea y se degrada a conversación: nunca a error.
    const taskMatch = rawText.match(/[[(*]\s*TASK:\s*([^\])*\n]+?)\s*[\])*]/i);
    // "[YOUR HANDS]" sin [TASK:]: el modelo quiso delegar y copió la etiqueta (ver keepOnlyTask).
    // La tarea son las palabras literales del usuario — más fieles que cualquier paráfrasis del 7B.
    const handsEcho = !taskMatch && HANDS_LABEL_RE.test(rawText) && lastUserText.get(sessionId);
    // El eco también se gatea: la narración de las manos LLEVA "[YOUR HANDS]" en su prompt, así
    // que un modelo que lo copie relanzaría la última frase del usuario como tarea nueva.
    if ((taskMatch || handsEcho) && noActions) {
        refuseAction(taskMatch ? 'TASK' : 'YOUR HANDS', taskMatch ? taskMatch[1] : lastUserText.get(sessionId));
    } else if (taskMatch || handsEcho) {
        const description = taskMatch
            ? (taskMatch[1] || '').trim()
            : `The user asked, in their own words: "${lastUserText.get(sessionId)}". Do exactly that and report what you did.`;
        agentBridge.dispatch(sessionId, description, { title: lastUserWords.get(sessionId) || description })
            .then((r) => {
                if (r.error) {
                    logger.warn('agent task not dispatched', { reason: r.error });
                    // La persona ya dijo "voy": si no pudo, tiene que corregirse. Nunca fingir.
                    agentBridge.reportDispatchFailure(sessionId, lastUserWords.get(sessionId) || description, r.error);
                } else logger.info('agent task dispatched from [TASK:]', { taskId: r.taskId });
                // Uso indebido del tag (riesgo listado por el agente): el modelo emitió [TASK:] para
                // algo que la capa determinista habría resuelto. Se cuenta para poder medirlo.
                if (r.error === 'agent_disabled' || r.error === 'agent_unavailable') taskMisuse.count++;
            })
            .catch((e) => logger.error('agent dispatch threw', { message: e.message }));
    }

    // Director de la vigilancia: [WATCH: tipo | argumento] arma una vigilancia de pie en el
    // sidecar hannah-sense. Misma forma que [TASK:] y por la misma razón: armar es un ida y
    // vuelta HTTP cuyo resultado no puede frenar la voz, así que se despacha y se sigue.
    // La ETIQUETA de la vigilancia son las palabras del USUARIO (lastUserWords), nunca la
    // paráfrasis del modelo: es lo único de la vigilancia que vuelve al system prompt en cada
    // turno mientras esté armada (plan §9 T9).
    // Se gatea igual que [TASK:]: en un turno de narración el texto de entrada lo escribió otro,
    // y una vigilancia armada desde ahí es un proceso que mira archivos por orden de una línea
    // de log.
    const watchMatch = rawText.match(/[[(*]\s*WATCH:\s*([^\])*\n]+?)\s*[\])*]/i);
    if (watchMatch && noActions) {
        refuseAction('WATCH', watchMatch[1]);
    } else if (watchMatch) {
        armWatch(sessionId, (watchMatch[1] || '').trim(), lastUserWords.get(sessionId))
            .then((r) => {
                if (!r.error) { logger.info('watch armed from [WATCH:]', { watchId: r.watchId }); return; }
                logger.warn('watch not armed', { reason: r.error, detail: String(r.reason || '').slice(0, 160) });
                // Ya dijo "listo, lo miro": si no se armó, tiene que corregirse en voz alta. Un
                // fallo silencioso acá deja al usuario creyendo que hay alguien mirando, que es
                // la peor falla que tiene esta feature. Mismo criterio que reportDispatchFailure.
                processTextTurn(sessionId, '[SYSTEM] The watch you just announced could NOT be armed'
                    + `${r.reason ? ` (${r.reason})` : ''}. Tell the user in ONE short sentence that you are`
                    + ' not watching it after all, and why. Do not promise to retry.',
                // SIN `signal` a propósito: si el usuario interrumpió el turno, la corrección
                // es justo lo que no se puede perder — quedaría creyendo que hay algo mirando.
                sendCallback, { noActions: true });
            })
            .catch((e) => logger.error('watch arm threw', { message: e.message }));
    }

    // Quitar etiquetas MOTION:/EMOTION:/MOVE:/TASK: con cualquier delimitador: no deben verse
    // en el subtítulo, oírse en el TTS ni condicionar el co-speech. Incluye variantes
    // sin cerrar (streaming parcial) para que nunca se filtre un corchete suelto.
    // Acciones: SIEMPRE con corchete (son palabras comunes; jamás estripar "look"/"time"
    // sueltos). El vocabulario viene de llm.js -> una sola fuente con el parser.
    const text = stripActionTags(rawText)
        // Gestos/emoción/mover: con o sin corchete (el 8B a veces los omite).
        .replace(/[[(*]?\s*(MOTION|EMOTION|MOVE)\s*:[^\])*\n]*[\])*]?/gi, '')
        // TASK solo CON delimitador: "the task: finish it" es una frase normal y no debe borrarse.
        .replace(/[[(*]\s*TASK\s*:[^\])*\n]*[\])*]?/gi, '')
        // WATCH, igual: "watch the movie" es una frase normal. Cierre OPCIONAL, como TASK, para
        // que un tag truncado por max_tokens ("[WATCH: proc |") no se oiga; stripActionTags ya
        // trae la misma guardia, esto es el hermano local del vocabulario del orquestador.
        .replace(/[[(*]\s*WATCH\s*:[^\])*\n]*[\])*]?/gi, '')
        // Tags inventados por el modelo, tipo [FULLSCREEN] / [DONE] (corchete + MAYÚSCULAS, sin :).
        .replace(/[[(*]\s*[A-Z][A-Z_ -]{2,}\s*[\])*]/g, '')
        .replace(/[[(*]\s*$/g, '')                                       // delimitador abierto al final
        // Quitar emojis y pictogramas (no se hablan bien y el usuario no los quiere).
        // Incluye los joiners (ZWJ/VS16) a propósito: si no, quedan restos de los compuestos.
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    // Si tras limpiar no queda texto real, ignorar el fragmento
    if (text.length < 2) return false;

    try {
        const ttsResult = await synthesizeSpeechStream(text, signal);
        if (ttsResult.error) return false;

        const lipsyncResult = generateVisemesFromText(text);
        const audioBuffer = await collectStream(ttsResult.audioStream);
        if (signal?.aborted) return false;   // no enviar audio de un turno ya interrumpido

        const message = {
            type: 'audio_chunk',
            text: text, // Texto de la oración actual
            visemes: lipsyncResult.visemes,
            audioBase64: audioBuffer.toString('base64'),
            format: ttsResult.format,
            sample_rate: ttsResult.sample_rate,
        };

        // Director de gestos: si el caption de [MOTION:] mapea a un gesto Mixamo, el frontend
        // reproduce ese clip POR ENCIMA del co-speech de la oración (lo mezcla con peso y, al
        // terminar el clip, el cuerpo sigue con el text-to-motion mientras quede habla). Antes
        // el clip reemplazaba al co-speech de la oración entera y, acabado el clip, ella se
        // quedaba quieta el resto de la frase. Como el 7B tiende a meter gestos de más, se
        // admite como mucho UNO por turno; los demás captions se ignoran y va co-speech.
        const gesture = action ? matchGesture(action) : null;
        if (gesture && !gestureUsed.has(sessionId)) { message.action = gesture; gestureUsed.add(sessionId); }

        // Co-speech (cuerpo hablando) SIEMPRE que haya motion: el gesto va encima, no en lugar.
        if (config.motion.enabled) {
            let motionResult;
            if (config.motion.provider === 'lab') {
                // Duración real del WAV (cabecera parseada; antes se asumía 24 kHz mono 16-bit) más
                // una cola corta: el clip debe SOBREVIVIR al audio y asentarse, no acabar a la vez
                // que la última sílaba y caer a idle a medio gesto (se veía "cortado").
                const durationS = Math.max(0.5, wavDurationS(audioBuffer, ttsResult.sample_rate || 24000)) + MOTION_TAIL_S;
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

        if (signal?.aborted) return false;
        sendCallback(message);
        return true;
    } catch (err) {
        logger.error('Error procesando segmento del orquestador', { message: err.message });
        return false;
    }
};

/**
 * Capa DETERMINISTA del turno (misma para voz y texto): mover / abrir / cerrar ventana, y
 * luego skills con `phrases` o intents genéricos (ejecutá/creá/listá/busca/lee X). Es lo que
 * hace que un modelo débil no "finja" que corrió algo. Si nada matchea, el modelo actuará por
 * tags ([RUN:]/[SKILL:]).
 * Devuelve { turnText, dataResult }: turnText lleva el resultado real inyectado si lo hubo.
 */
async function runDeterministicLayer(text, sessionId, onStreamSegment) {
    lastUserWords.set(sessionId, String(text || '').slice(0, 80));
    lastUserText.set(sessionId, String(text || '').slice(0, 400));
    const ctx = { sessionId, send: onStreamSegment };
    const moveSpec = parseMoveIntent(text);
    if (moveSpec) {
        markUserMove(sessionId);
        // UN solo dueño del movimiento. Antes se movía acá Y se le pedía al cliente que se
        // moviera: con la app de escritorio la ventana se movía DOS veces, y como los specs son
        // relativos ("la otra pantalla"), se saltaba un monitor. Solo se delega en el cliente
        // si el adaptador de acá no pudo (Windows/macOS, o Linux sin hyprctl/wmctrl).
        const moved = await moveWindow(moveSpec).catch((e) => {
            logger.error('moveWindow falló', { message: e.message });
            return false;
        });
        if (!moved) onStreamSegment({ type: 'window_move', spec: moveSpec });
    }
    // await + catch: son async; sin esto un throw se volvía unhandledRejection (mata el proceso).
    await handleOpenIntent(text, ctx).catch((e) => logger.error('handleOpenIntent falló', { message: e.message }));
    await handleCloseIntent(text, ctx).catch((e) => logger.error('handleCloseIntent falló', { message: e.message }));

    const dataResult = (await resolveSkillPhrase(text, ctx))
        || (await resolveDataAction(text, ctx));
    const turnText = dataResult
        ? `${text}\n\n${dataResult}\n${NO_INVENTAR}`
        : text;
    return { turnText, dataResult };
}
// Instrucción que acompaña al resultado real inyectado (única fuente).
const NO_INVENTAR = '(Responde al usuario con este resultado real; no lo inventes.)';

/**
 * Orquesta un turno completo de conversación desde audio entrante hasta streaming de respuesta.
 */
export const processVoiceTurn = async (sessionId, audioBuffer, onStreamSegment, signal) => {
    try {
        // 1. Validar la sesión
        const session = conversationManager.getSession(sessionId);
        if (!session) throw new Error('La sesión no existe o ha expirado');

        // Sin cerebro elegido/usable no hay turno: el overlay muestra la bienvenida. Mejor un
        // aviso claro que un [error llm] a medias en la primera frase.
        if (!brainReady()) { onStreamSegment({ type: 'brain_required' }); return; }

        // 2. ASR: Transcribir el audio del usuario
        logger.info('Iniciando transcripción ASR...', { sessionId });
        const asrResult = await transcribeAudio(audioBuffer);
        if (signal?.aborted) return;   // el usuario ya interrumpió
        if (asrResult.error || !asrResult.transcript.trim()) {
            throw new Error(asrResult.message || 'No se detectó voz clara en el audio');
        }

        // ¿Es la respuesta a una aprobación/pregunta pendiente de las "manos"? Se decide con el
        // instante en que EMPEZÓ a hablar (SPEECH_START), no con el de la transcripción: hablar
        // por encima de la pregunta no puede concederla. Si se consumió, no es conversación.
        if (await agentBridge.routeUtterance(sessionId, asrResult.transcript, agentBridge.speechStartedAt(sessionId))) {
            onStreamSegment({ type: 'user_transcript', text: asrResult.transcript });
            return;
        }
        const { turnText, dataResult } = await runDeterministicLayer(asrResult.transcript, sessionId, onStreamSegment);

        // Guardar el turno (con el resultado inyectado si hubo acción de datos).
        conversationManager.addTurn(sessionId, 'user', turnText);
        // Avisarle al cliente qué fue lo que entendimos (el texto original).
        onStreamSegment({ type: 'user_transcript', text: asrResult.transcript });

        // 3. LLM: Ejecutar el flujo del modelo pasándole el historial de turnos actual
        const updatedSession = conversationManager.getSession(sessionId);
        await executeLlmPipeline(sessionId, updatedSession.turns, onStreamSegment, signal, { noActions: !!dataResult });

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
 * @returns {Promise<{spoken: boolean, error: ?string}>} EL ACUSE DE RECIBO. Esta función NO
 * propaga sus errores (los atrapa y los manda al socket como {type:'error'}), así que resolver
 * no quiere decir que haya hablado: quien narra algo que no puede volver a pedir —un disparo de
 * vigilancia— tiene que mirar `spoken` y no la promesa. Sin esto, con el modelo caído la frase
 * se perdía en silencio y el disparo se daba por entregado.
 */
export const processTextTurn = async (sessionId, systemPromptAlert, onStreamSegment, opts = {}) => {
    try {
        // 1. Validar la sesión
        const session = conversationManager.getSession(sessionId);
        if (!session) throw new Error('La sesión no existe o ha expirado');
        if (!brainReady()) { onStreamSegment({ type: 'brain_required' }); return; }

        logger.info('⚙️ Procesando inyección visual en el pipeline de texto...', { sessionId });

        // 2. Para no contaminar la memoria limpia de la conversación con comandos de código,
        // creamos una copia temporal del historial agregando la alerta como si fuera un input del sistema
        const temporalTurns = [
            ...session.turns,
            { role: 'user', content: systemPromptAlert }
        ];

        // 3. LLM: Disparar directo la tubería cognitiva evadiendo el hardware del micrófono
        // opts.noActions: la inyección solo RELATA (narración de las manos); opts.signal: abortable.
        // opts.ephemeral: se habla y NO se guarda (narración de una vigilancia; ver addTurn).
        return await executeLlmPipeline(sessionId, temporalTurns, onStreamSegment, opts.signal,
            { noActions: !!opts.noActions, ephemeral: !!opts.ephemeral });

    } catch (error) {
        logger.error('Fallo crítico en el Orquestador (Texto/YOLO)', { message: error.message });
        onStreamSegment({ type: 'error', message: error.message });
        return { spoken: false, error: error.message };
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

        const { turnText, dataResult } = await runDeterministicLayer(text, sessionId, onStreamSegment);
        conversationManager.addTurn(sessionId, 'user', turnText);

        const updatedSession = conversationManager.getSession(sessionId);
        await executeLlmPipeline(sessionId, updatedSession.turns, onStreamSegment, signal, { noActions: !!dataResult });
    } catch (error) {
        logger.error('Fallo crítico en el Orquestador (Texto usuario)', { message: error.message });
        onStreamSegment({ type: 'error', message: error.message });
    }
};

/**
 * Sub-proceso reutilizable para aislar y ejecutar el cerebro del LLM junto con TTS y LipSync.
 * Los segmentos se encadenan en una promesa secuencial: las oraciones llegan al cliente
 * en el orden hablado y turn_complete se emite solo cuando el último audio ya salió.
 *
 * Devuelve `{ spoken, error }`: `spoken` es true solo si al menos una oración salió por el
 * socket con su audio. NO alcanza con que esto resuelva sin tirar — un 401 del proveedor, el
 * modelo apagado o un timeout terminan en `onComplete({error})` y esta función vuelve igual de
 * tranquila. Ese silencio prolijo es lo que hacía desaparecer un disparo de vigilancia entero.
 */
const executeLlmPipeline = async (sessionId, turnsInput, onStreamSegment, signal, opts = {}) => {
    let sentenceBuffer = '';
    let segmentChain = Promise.resolve();
    let spoken = false;
    let error = null;
    gestureUsed.delete(sessionId);   // un gesto deliberado como mucho por turno
    logger.info('Despertando cerebro LLM...', { model: config.llm.model });

    const enqueueSegment = (text) => {
        // Barge-in: si el turno fue abortado, no sintetizar/enviar más oraciones.
        segmentChain = segmentChain.then(async () => {
            if (signal?.aborted) return;
            // opts.noActions viaja hasta acá: el gate del prompt (llm.js) solo deja de OFRECER
            // los tags; si el modelo los emite igual, quien no los ejecuta es el segmento.
            if (await processAndSendSegment(text, onStreamSegment, sessionId, signal, !!opts.noActions)) {
                spoken = true;
                // Una oración salió con su audio: es la prueba de que el modelo y el TTS andan
                // AHORA. La leen los ojos para reabrir un disparo de vigilancia que se rindió
                // contra un proveedor caído; sin marcarla acá, el último disparo del buzón no se
                // dice nunca más aunque la voz vuelva (senseBridge, TRIP_MAX_ATTEMPTS).
                agentBridge.markSpoken();
            }
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
            if (finalLlmResult.error) error = finalLlmResult.error;
            if (signal?.aborted || finalLlmResult.error) return;

            if (sentenceBuffer.trim().length > 0) {
                enqueueSegment(sentenceBuffer.trim());
            }

            // Guardar la respuesta final real en el historial oficial de la sesión. Si la
            // respuesta era solo un [TASK:] (keepOnlyTask), se guarda como frase legible: el
            // historial no debe enseñarle al modelo a repetir tags, y la memoria la resume mejor.
            // Lo MISMO con [WATCH:], y por dos razones, no una: el historial es lo que el modelo
            // lee para decidir qué escribir, y además cada turno guardado va a memory.db y al
            // índice de embeddings — o sea que el tag crudo dejaba la RUTA vigilada escrita para
            // siempre en la base que la política del agente marca como sensible, justo lo que el
            // plan §9 pide evitar cuando declara efímera la narración de las vigilancias.
            // Dos diferencias con el de las manos, las dos a propósito: el tag va al FINAL de una
            // respuesta hablada (no es la respuesta entera, así que no se ancla), y el argumento
            // NO se conserva — el de [TASK:] es la descripción que escribió el modelo, el de
            // [WATCH:] es la ruta. Qué se está mirando ya está dicho con las palabras del usuario
            // en el turno de al lado.
            const spokenOrDelegated = String(finalLlmResult.text || '')
                .replace(/^\s*[[(*]\s*TASK:\s*([^\])*\n]+?)\s*[\])*]\s*$/i, '(I handed this to my hands: $1)')
                // Cierre OPCIONAL, igual que en el stripeo de la voz: un tag truncado por
                // max_tokens ("[WATCH: log |") tampoco puede quedar escrito en la base.
                .replace(/[[(*]\s*WATCH\s*:[^\])*\n]*[\])*]?/gi, '(I am keeping an eye on this for the user.)')
                .trim();
            conversationManager.addTurn(sessionId, 'assistant', spokenOrDelegated, { ephemeral: !!opts.ephemeral });
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
        // ctx para tools: sessionId (look_now) + send (confirm_command). noActions: si una acción
        // determinista ya corrió, el LLM SOLO narra (no re-ejecuta con tags -> evita doble ssh/comando).
        { sessionId, send: onStreamSegment, noActions: opts.noActions }
    );

    // No devolver el control hasta que todos los segmentos pendientes hayan salido
    await segmentChain;
    return { spoken, error: error || (signal?.aborted ? 'aborted' : null) };
};
