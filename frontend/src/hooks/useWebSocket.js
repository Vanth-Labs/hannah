// src/hooks/useWebSocket.js
import { useEffect, useRef, useCallback } from 'react';
import { useHannahStore } from '../store/hannahStore.js';
import { emitTerminalOut, emitHands, formatHandsTool } from '../lib/terminalBus.js';
import { isOverlay as IS_OVERLAY } from '../lib/overlay.js';
import { DESKTOP, API_BASE, apiFetch, withToken } from '../lib/api.js';

export function useWebSocket() {
    const ws = useRef(null);
    const audioCtx = useRef(null);
    const audioQueue = useRef([]);
    const isPlaying = useRef(false);
    // La emoción del turno se mantiene mientras habla y un rato después; luego vuelve a
    // neutral sola (antes se quedaba sonriendo o triste hasta el siguiente turno).
    const EMOTION_HOLD_MS = 4000;
    const emotionTimer = useRef(null);
    const scheduleNeutral = useCallback(() => {
        clearTimeout(emotionTimer.current);
        emotionTimer.current = setTimeout(() => {
            if (!isPlaying.current) useHannahStore.getState().setEmotion('neutral');
        }, EMOTION_HOLD_MS);
    }, []);
    const currentSource = useRef(null);   // BufferSource sonando ahora (para barge-in)
    const visemeSchedule = useRef([]);  // visemas pendientes de reproducir

    const {
        setSession, setConnected, setEmotion,
        setTranscript, setUserTranscript, addLog,
    } = useHannahStore.getState();

    // ── Audio: cola de chunks con AudioContext ──────────────────────────────
    const getAudioCtx = () => {
        if (!audioCtx.current || audioCtx.current.state === 'closed') {
            audioCtx.current = new AudioContext();
        }
        if (audioCtx.current.state === 'suspended') {
            audioCtx.current.resume();
        }
        return audioCtx.current;
    };

    // ── Visemas: programar morph targets cuando el chunk EMPIEZA a sonar ───
    // El backend manda time_ms relativo al inicio de la oración.
    const scheduleVisemes = (visemes) => {
        if (!visemes?.length) return;

        visemes.forEach(({ viseme, time_ms, weight }) => {
            const id = setTimeout(() => {
                useHannahStore.getState().setVisemes([{ viseme, weight: weight ?? 1.0 }]);
                // Reset a silencio después de 120ms. El id TAMBIÉN se registra: si no, este
                // timer sobrevivía al barge-in y cerraba la boca a mitad de la frase siguiente.
                const resetId = setTimeout(() => {
                    useHannahStore.getState().setVisemes([{ viseme: 'sil', weight: 0 }]);
                }, 120);
                visemeSchedule.current.push(resetId);
            }, time_ms || 0);
            visemeSchedule.current.push(id);
        });
    };

    // Decodifica los arrays float32 (little-endian) del sidecar de movimiento
    const decodeMotion = (motion) => {
        if (!motion?.poses_b64) return null;
        const toF32 = (b64) => {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Float32Array(bytes.buffer);
        };
        return {
            fps: motion.fps || 30,
            numFrames: motion.num_frames,
            poses: toF32(motion.poses_b64),   // (T*165) axis-angle, 55 joints SMPL-X
            trans: toF32(motion.trans_b64),   // (T*3)
        };
    };

    const drainQueue = useCallback(() => {
        if (audioQueue.current.length === 0) {
            isPlaying.current = false;
            useHannahStore.getState().setIsSpeaking(false);
            visemeSchedule.current = [];   // timers ya disparados: no acumular ids de por vida
            scheduleNeutral();             // terminó de hablar: la emoción se apaga en un rato
            return;
        }
        isPlaying.current = true;
        useHannahStore.getState().setIsSpeaking(true);
        clearTimeout(emotionTimer.current);   // mientras habla, la emoción se queda

        const { buffer, visemes, motion, action } = audioQueue.current.shift();
        const ctx = getAudioCtx();
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = drainQueue;
        currentSource.current = source;
        scheduleVisemes(visemes);
        // El movimiento (co-speech) arranca sincronizado con el inicio del audio.
        if (motion) {
            useHannahStore.getState().setCurrentMotion({ ...motion, startedAt: performance.now() });
        }
        // Gesto deliberado (Mixamo): se dispara junto al audio de su oración.
        if (action) {
            useHannahStore.getState().setGestureTrigger({ name: action, startedAt: performance.now() });
        }
        source.start();
    }, [scheduleNeutral]);

    const playChunk = useCallback(async (base64wav, visemes, motion, action) => {
        const ctx = getAudioCtx();
        const binary = atob(base64wav);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

        try {
            const decoded = await ctx.decodeAudioData(bytes.buffer);
            audioQueue.current.push({
                buffer: decoded,
                visemes: visemes || [],
                motion: decodeMotion(motion),
                action: action || null,
            });
            if (!isPlaying.current) drainQueue();
        } catch (e) {
            console.warn('Chunk de audio inválido, ignorando:', e.message);
        }
    }, [drainQueue]);

    const clearVisemeSchedule = () => {
        visemeSchedule.current.forEach(clearTimeout);
        visemeSchedule.current = [];
        useHannahStore.getState().setVisemes([]);
    };

    // Barge-in: cortar en seco lo que Hannah está diciendo (audio + visemas + motion).
    const stopPlayback = useCallback(() => {
        audioQueue.current = [];
        if (currentSource.current) {
            try { currentSource.current.onended = null; currentSource.current.stop(); } catch { /* ya parado */ }
            currentSource.current = null;
        }
        clearVisemeSchedule();
        isPlaying.current = false;
        const st = useHannahStore.getState();
        st.setIsSpeaking(false);
        st.setCurrentMotion(null);
        st.setGestureTrigger(null);
        scheduleNeutral();
    }, [scheduleNeutral]);

    // ── Handlers de mensajes del servidor ──────────────────────────────────
    const handleMessage = useCallback((msg) => {
        switch (msg.type) {
            case 'user_transcript':
                setUserTranscript(msg.text || '');
                addLog(`[usuario] ${msg.text}`, 'user');
                break;

            case 'audio_chunk':
                if (msg.text) setTranscript(msg.text);
                if (msg.audio) playChunk(msg.audio, msg.visemes, msg.motion, msg.action);
                else if (msg.audioBase64) playChunk(msg.audioBase64, msg.visemes, msg.motion, msg.action);
                break;

            case 'turn_complete':
                if (msg.emotion) { setEmotion(msg.emotion); scheduleNeutral(); }
                addLog(`[turno] emoción: ${msg.emotion} | llm ${msg.metrics?.llm_ms}ms`, 'info');
                break;

            case 'vision_started':
                addLog('[visión] loop activo', 'vision');
                break;

            case 'error':
                addLog(`[error] ${msg.message}`, 'error');
                break;

            case 'gaze':
                // mirada global (cursor Hyprland). Frecuente: sin log.
                useHannahStore.getState().setOverlayGaze({ x: msg.x, y: msg.y });
                break;

            case 'terminal_out':
                emitTerminalOut(msg.data);
                break;

            case 'terminal_clear':
                // Limpia el xterm (borra pantalla + scrollback + cursor a home).
                emitTerminalOut('\x1b[2J\x1b[3J\x1b[H');
                break;

            case 'window_move':
                // En Electron, el proceso main mueve la ventana (cross-platform).
                if (DESKTOP) DESKTOP.moveWindow(msg.spec);
                break;

            case 'confirm_command':
                useHannahStore.getState().setPendingConfirm({ id: msg.id, command: msg.command });
                break;

            case 'command_run':
                // Comando ejecutado por Hannah: mostrar toast con su salida real (así
                // ves qué hizo sin abrir la terminal).
                useHannahStore.getState().setCommandRun({ command: msg.command, output: msg.output, at: Date.now() });
                break;

            // ── Las "manos" (hannah-agent). La VOZ la pone la persona por el camino normal de
            // audio_chunk; esto es solo lo visual: una píldora con el estado, el toast con el
            // último resumen, y el modal de aprobación (reutiliza el de comandos destructivos).
            case 'agent_task_started':
            case 'agent_task_progress': {
                const st = useHannahStore.getState();
                st.setAgentTask({ taskId: msg.taskId, title: msg.title, state: msg.state, lastSummary: msg.data?.summary || msg.data?.text || st.agentTask?.lastSummary });
                if (msg.kind === 'progress' || msg.kind === 'plan' || msg.kind === 'output') {
                    st.setCommandRun({ command: `hands · ${msg.title}`, output: msg.data?.summary || msg.data?.text || '', at: Date.now() });
                }
                // Cada comando de las manos (y un vistazo a su salida) se ve en la terminal.
                if (msg.kind === 'tool') { const line = formatHandsTool(msg); if (line) emitHands(line); }
                // Al resolverse la aprobación (por voz, HUD o timeout) se cierra el modal.
                if (msg.kind === 'approval.resolved' || msg.kind === 'answered') {
                    if (st.pendingConfirm?.kind === 'agent' && st.pendingConfirm.taskId === msg.taskId) st.setPendingConfirm(null);
                }
                break;
            }
            case 'agent_approval_request':
            case 'agent_question': {
                const isQuestion = msg.type === 'agent_question';
                useHannahStore.getState().setPendingConfirm({
                    kind: 'agent', isQuestion, taskId: msg.taskId, title: msg.title,
                    approvalId: msg.data?.approvalId, questionId: msg.data?.questionId,
                    summary: msg.data?.summary || msg.data?.text || '', command: msg.data?.command,
                    risk: msg.data?.risk || 'low', options: msg.data?.options, expiresAt: msg.expiresAt,
                });
                break;
            }
            case 'agent_task_done': {
                const st = useHannahStore.getState();
                st.setAgentTask({ taskId: msg.taskId, title: msg.title, state: msg.state, lastSummary: msg.data?.summary || msg.data?.error, doneAt: Date.now() });
                if (st.pendingConfirm?.kind === 'agent' && st.pendingConfirm.taskId === msg.taskId) st.setPendingConfirm(null);
                st.setCommandRun({ command: `hands · ${msg.title} · ${msg.state}`, output: msg.data?.summary || msg.data?.error || '', at: Date.now() });
                break;
            }
            case 'agent_command_failed':
                useHannahStore.getState().setCommandRun({ command: `hands · ${msg.command} failed`, output: msg.reason === 'hud_confirmation_required' ? 'This action is high risk: confirm it with the button.' : String(msg.reason || ''), at: Date.now() });
                break;

            case 'open_terminal': {
                // Skill de acción `terminal` (ssh/interactivo): abrir el panel split y escribir
                // el comando. Delay para que xterm monte y quede attacheado antes del output.
                useHannahStore.getState().setTerminalOpen(true);
                const w = ws.current;
                if (w?.readyState === WebSocket.OPEN) {
                    w.send(JSON.stringify({ command: 'TERMINAL_START' }));
                    if (msg.command) {
                        // run !== false -> se ejecuta solo (Enter). Con argumento dictado
                        // (run === false) solo lo escribe: el usuario revisa y da Enter.
                        const data = msg.run === false ? msg.command : `${msg.command}\n`;
                        setTimeout(() => {
                            if (ws.current?.readyState === WebSocket.OPEN) {
                                ws.current.send(JSON.stringify({ command: 'TERMINAL_IN', data }));
                            }
                        }, 350);
                    }
                }
                break;
            }

            default:
                addLog(JSON.stringify(msg), 'debug');
        }
    }, [playChunk, setTranscript, setEmotion, setUserTranscript, addLog, scheduleNeutral]);

    // ── Iniciar sesión y WS ─────────────────────────────────────────────────
    const reconnectRef = useRef(null);
    const unmountedRef = useRef(false);
    const connectRef = useRef(null);
    const connect = useCallback(async () => {
        try {
            const res = await apiFetch(`/api/v1/session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            const { sessionId } = await res.json();
            // El fetch es async: si el componente se desmontó mientras estaba en vuelo (pasa
            // siempre con StrictMode), abortar — si no, quedaba un WebSocket huérfano abierto
            // para siempre, con sus handlers y su propia reconexión.
            if (unmountedRef.current) return;
            setSession(sessionId);
            addLog(`sesión: ${sessionId}`, 'info');

	    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	    const wsUrl = withToken(DESKTOP
	        ? `${DESKTOP.backendBase.replace(/^http/, 'ws')}/ws?sessionId=${sessionId}`
	        : `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`);
            // Cerrar un socket anterior antes de pisar la ref (evita dejarlo colgado). CLAVE:
            // desarmar sus handlers ANTES de cerrarlo — si no, su onclose agenda otra
            // reconexión y se entra en un bucle (sesión nueva cada 1.5s, ningún turno llega
            // a completarse). Mismo patrón que stopPlayback con source.onended.
            const prev = ws.current;
            if (prev) {
                prev.onclose = null;
                prev.onerror = null;
                prev.onmessage = null;
                try { prev.close(); } catch { /* ya cerrado */ }
            }
            clearTimeout(reconnectRef.current);   // matar cualquier reconexión ya agendada
            ws.current = new WebSocket(wsUrl);

            ws.current.onopen = () => {
                setConnected(true);
                addLog('WebSocket conectado', 'info');
                // En overlay-navegador: activar la mirada global del backend (Hyprland/X11).
                // En Electron la mirada la provee el proceso main (IPC), no el backend.
                if (IS_OVERLAY && !DESKTOP) ws.current.send(JSON.stringify({ command: 'GAZE_ON' }));
            };

            const socket = ws.current;   // capturado: este handler es de ESTE socket
            socket.onclose = () => {
                // Si ya no es el socket vigente, no tocar nada (evita que un socket viejo
                // dispare reconexiones y se entre en bucle).
                if (ws.current !== socket) return;
                setConnected(false);
                addLog('WebSocket desconectado, reintentando...', 'error');
                // Auto-reconexión (compañera siempre-encendida: sobrevive reinicios del backend).
                if (!unmountedRef.current) {
                    clearTimeout(reconnectRef.current);
                    reconnectRef.current = setTimeout(() => connectRef.current?.(), 1500);
                }
            };

            ws.current.onerror = () => addLog('WebSocket error', 'error');

            ws.current.onmessage = (event) => {
                try {
                    handleMessage(JSON.parse(event.data));
                } catch (e) {
                    console.error('WS parse error:', e);
                }
            };
        } catch (e) {
            addLog(`Error conectando: ${e.message}`, 'error');
            // Si falla el connect (backend aún caído), reintentar -> reconexión robusta.
            if (!unmountedRef.current) {
                clearTimeout(reconnectRef.current);
                reconnectRef.current = setTimeout(() => connectRef.current?.(), 1500);
            }
        }
    }, [handleMessage, setSession, setConnected, addLog]);

    // ── API pública ─────────────────────────────────────────────────────────
    const sendCommand = useCallback((payload) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify(payload));
        }
    }, []);

    const sendAudio = useCallback((buffer) => {
        if (ws.current?.readyState === WebSocket.OPEN) {
            ws.current.send(buffer);
        }
    }, []);

    // El texto del HUD viaja por el WebSocket: pasa por el orquestador completo
    // (streaming por oración + visemas + gestos EMAGE), igual que la voz.
    const sendText = useCallback((text) => {
        addLog(`[texto] ${text}`, 'out');
        sendCommand({ command: 'TEXT_INPUT', text });
    }, [addLog, sendCommand]);

    useEffect(() => {
        connectRef.current = connect;
        unmountedRef.current = false;
        connect();
        return () => {
            unmountedRef.current = true;
            clearTimeout(reconnectRef.current);
            clearVisemeSchedule();
            ws.current?.close();
            audioCtx.current?.close();
        };
        // Deps vacías A PROPÓSITO: la conexión debe montarse UNA vez. `connect` se accede
        // siempre por connectRef (que se actualiza arriba), justo para no recrear el socket
        // en cada render. Ponerlo en deps reconectaría en loop.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return { sendCommand, sendAudio, sendText, stopPlayback, ws };
}
