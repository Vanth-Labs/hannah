// src/components/HUD.jsx
import { useEffect, useRef, useState } from 'react';
import { useHannahStore } from '../store/hannahStore.js';
import { SettingsPanel } from './SettingsPanel.jsx';
import { TerminalPanel } from './TerminalPanel.jsx';
import { isOverlay } from '../lib/overlay.js';

// Re-export por compatibilidad (App lo importa desde aquí).
export { isOverlay };

const EMOTION_COLOR = {
    neutral:  '#7c8fa6',
    happy:    '#f5c842',
    curious:  '#6ee7b7',
    alert:    '#f87171',
    thinking: '#a78bfa',
    sad:      '#93c5fd',
};

// Botón de icono redondo reutilizable (dedupe de estilos). `active` lo tiñe con activeColor.
function IconBtn({ onClick, onMouseDown, onMouseUp, onTouchStart, onTouchEnd, title, active, activeColor = '#7ab8e8', size = 34, children }) {
    return (
        <button
            onClick={onClick} onMouseDown={onMouseDown} onMouseUp={onMouseUp}
            onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} title={title}
            style={{
                pointerEvents: 'auto', width: size, height: size, borderRadius: '50%',
                display: 'grid', placeItems: 'center', flexShrink: 0,
                background: active ? `${activeColor}22` : 'rgba(255,255,255,0.06)',
                border: `1px solid ${active ? `${activeColor}66` : 'rgba(255,255,255,0.14)'}`,
                color: active ? activeColor : 'rgba(255,255,255,0.55)',
                fontSize: `${Math.round(size * 0.44)}px`, cursor: 'pointer', transition: 'all 0.15s',
            }}
        >
            {children}
        </button>
    );
}

// Toast que muestra el comando ejecutado y su salida real, sin abrir la terminal.
// Se auto-cierra a los 9s (se reinicia si llega uno nuevo).
function CommandToast({ run, onClose }) {
    useEffect(() => {
        const id = setTimeout(onClose, 9000);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [run.at]);
    return (
        <div style={{
            position: 'fixed', top: '46px', left: '50%', transform: 'translateX(-50%)',
            zIndex: 32, width: 'min(520px, 92%)', maxHeight: '40vh', overflow: 'auto',
            background: 'rgba(8,11,18,0.93)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(122,184,232,0.35)', borderRadius: '12px',
            boxShadow: '0 8px 28px rgba(0,0,0,0.45)', pointerEvents: 'auto', fontFamily: "'DM Mono', monospace",
        }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
                <span style={{ color: '#7ab8e8', fontSize: '11px', letterSpacing: '0.05em', wordBreak: 'break-all' }}>
                    ⌨ {run.command}
                </span>
                <span onClick={onClose} style={{ cursor: 'pointer', color: 'rgba(255,255,255,0.5)', fontSize: '12px', flexShrink: 0, marginLeft: '10px' }}>✕</span>
            </div>
            <pre style={{
                margin: 0, padding: '8px 12px', fontSize: '11.5px', color: 'rgba(255,255,255,0.8)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{run.output || '(sin salida)'}</pre>
        </div>
    );
}

export function HUD({ onSendText, onToggleVision, onToggleRecord, isRecording, sendCommand }) {
    const [input, setInput] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    // Selectores ATÓMICOS: sin ellos el HUD se re-renderizaba con CUALQUIER cambio del store
    // (visemas varias veces por segundo, gaze ~12Hz, cada log) aunque no use esos campos.
    const emotion = useHannahStore((s) => s.emotion);
    const isSpeaking = useHannahStore((s) => s.isSpeaking);
    const visionActive = useHannahStore((s) => s.visionActive);
    const transcript = useHannahStore((s) => s.transcript);
    const userTranscript = useHannahStore((s) => s.userTranscript);
    const connected = useHannahStore((s) => s.connected);
    const handsFree = useHannahStore((s) => s.handsFree);
    const pendingConfirm = useHannahStore((s) => s.pendingConfirm);
    const commandRun = useHannahStore((s) => s.commandRun);
    const terminalOpen = useHannahStore((s) => s.terminalOpen);
    // Acciones: referencias estables en zustand -> no provocan re-render.
    const setHandsFree = useHannahStore((s) => s.setHandsFree);
    const setPendingConfirm = useHannahStore((s) => s.setPendingConfirm);
    const setCommandRun = useHannahStore((s) => s.setCommandRun);
    const setTerminalOpen = useHannahStore((s) => s.setTerminalOpen);

    const toggleTerminal = () => {
        const next = !terminalOpen;
        if (next) sendCommand?.({ command: 'TERMINAL_START' });
        setTerminalOpen(next);
    };
    const answerConfirm = (approved) => {
        if (pendingConfirm) sendCommand?.({ command: 'CONFIRM_COMMAND', id: pendingConfirm.id, approved });
        setPendingConfirm(null);
    };

    const handleSend = () => {
        if (!input.trim()) return;
        onSendText(input.trim());
        setInput('');
    };

    const emotionColor = EMOTION_COLOR[emotion] || EMOTION_COLOR.neutral;

    return (
        <>
            {/* ── Status mínimo (arriba-izquierda), sin botones ─────────────── */}
            <div style={{
                position: 'fixed', top: '14px', left: '18px',
                display: 'flex', alignItems: 'center', gap: '10px',
                fontFamily: "'DM Mono', monospace", fontSize: '10px', letterSpacing: '0.06em',
                zIndex: 10, pointerEvents: 'none',
            }}>
                <span style={{ color: connected ? '#4ade80' : '#f87171' }} title={connected ? 'online' : 'offline'}>
                    {connected ? '●' : '○'}
                </span>
                <span style={{ color: emotionColor }}>{emotion}</span>
                {isSpeaking && <span style={{ color: '#fff', animation: 'pulse 1s infinite' }}>speaking</span>}
                {visionActive && <span style={{ color: '#6ee7b7' }}>● cam</span>}
            </div>

            {/* ── Dock flotante de controles (glass, agrupado) ──────────────
                overlay: abajo-centro, discreto sobre el avatar.
                web:     arriba-derecha. */}
            <div style={{
                position: 'fixed', zIndex: 31,
                ...(isOverlay
                    ? { bottom: terminalOpen ? 'calc(40% + 14px)' : '20px', left: '50%', transform: 'translateX(-50%)', transition: 'bottom 0.18s' }
                    : { top: '14px', right: '18px' }),
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '7px 9px', borderRadius: '999px',
                background: 'rgba(12,15,22,0.6)', backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
            }}>
                <IconBtn onClick={() => setHandsFree(!handsFree)} active={handsFree} activeColor="#6ee7b7"
                    title={handsFree ? 'Micrófono activo (click para silenciar)' : 'Micrófono silenciado'}>
                    {handsFree ? '🎙' : '🔇'}
                </IconBtn>
                <IconBtn onClick={onToggleVision} active={visionActive} activeColor="#6ee7b7"
                    title="Que Hannah te vea por la cámara">👁</IconBtn>
                <IconBtn onClick={toggleTerminal} active={terminalOpen} activeColor="#7ab8e8"
                    title="Terminal (Hannah puede correr comandos)">⌨</IconBtn>
                <IconBtn onClick={() => setShowSettings(true)}
                    title="Ajustes (modelo/API, voz, atajos)">⚙</IconBtn>
            </div>

            {commandRun && <CommandToast run={commandRun} onClose={() => setCommandRun(null)} />}

            {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

            {terminalOpen && (
                <TerminalPanel
                    onInput={(d) => sendCommand?.({ command: 'TERMINAL_IN', data: d })}
                    onResize={(cols, rows) => sendCommand?.({ command: 'TERMINAL_RESIZE', cols, rows })}
                    onClose={() => setTerminalOpen(false)}
                />
            )}

            {/* Confirmación de comando destructivo */}
            {pendingConfirm && (
                <div style={{
                    position: 'fixed', inset: 0, zIndex: 40, display: 'flex',
                    alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)',
                }}>
                    <div style={{
                        width: 'min(440px, 90%)', background: 'rgba(14,18,26,0.98)',
                        border: '1px solid rgba(248,113,113,0.4)', borderRadius: '14px', padding: '20px',
                        fontFamily: "'DM Mono', monospace", color: 'rgba(255,255,255,0.85)',
                    }}>
                        <div style={{ color: '#f87171', fontSize: '12px', letterSpacing: '0.1em', marginBottom: '10px' }}>
                            ⚠ COMANDO DESTRUCTIVO — ¿lo autorizas?
                        </div>
                        <pre style={{
                            background: 'rgba(0,0,0,0.4)', padding: '10px 12px', borderRadius: '8px',
                            fontSize: '13px', color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: '0 0 16px',
                        }}>{pendingConfirm.command}</pre>
                        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                            <button onClick={() => answerConfirm(false)} style={{
                                pointerEvents: 'auto', padding: '8px 16px', borderRadius: '10px', cursor: 'pointer',
                                background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.2)', color: 'rgba(255,255,255,0.8)',
                            }}>Rechazar</button>
                            <button onClick={() => answerConfirm(true)} style={{
                                pointerEvents: 'auto', padding: '8px 16px', borderRadius: '10px', cursor: 'pointer',
                                background: 'rgba(248,113,113,0.2)', border: '1px solid rgba(248,113,113,0.6)', color: '#fca5a5',
                            }}>Ejecutar</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Transcript flotante (oculto en modo overlay) ── */}
            {!isOverlay && (transcript || userTranscript) && (
                <div style={{
                    position: 'fixed', bottom: '120px', left: '50%',
                    transform: 'translateX(-50%)',
                    maxWidth: '540px', width: '90%',
                    zIndex: 10,
                    pointerEvents: 'none',
                }}>
                    {userTranscript && (
                        <p style={{
                            fontFamily: "'DM Mono', monospace",
                            fontSize: '12px',
                            color: 'rgba(255,255,255,0.35)',
                            textAlign: 'right',
                            marginBottom: '6px',
                        }}>
                            {userTranscript}
                        </p>
                    )}
                    {transcript && (
                        <p style={{
                            fontFamily: "'Syne', sans-serif",
                            fontSize: '15px',
                            color: 'rgba(255,255,255,0.82)',
                            textAlign: 'center',
                            lineHeight: 1.5,
                            textShadow: '0 2px 20px rgba(0,0,0,0.8)',
                        }}>
                            {transcript}
                        </p>
                    )}
                </div>
            )}

            {/* ── Controles abajo (ocultos en modo overlay) ───────────────── */}
            {!isOverlay && (
            <div style={{
                position: 'fixed', bottom: 0, left: 0, right: 0,
                padding: '20px 24px',
                background: 'linear-gradient(to top, rgba(0,0,0,0.85) 0%, transparent 100%)',
                display: 'flex', gap: '10px', alignItems: 'center',
                zIndex: 10,
            }}>
                {/* Mic */}
                <button
                    onMouseDown={() => onToggleRecord(true)}
                    onMouseUp={() => onToggleRecord(false)}
                    onTouchStart={() => onToggleRecord(true)}
                    onTouchEnd={() => onToggleRecord(false)}
                    style={{
                        width: '44px', height: '44px',
                        borderRadius: '50%',
                        border: isRecording
                            ? '2px solid #f87171'
                            : '2px solid rgba(255,255,255,0.2)',
                        background: isRecording
                            ? 'rgba(248,113,113,0.15)'
                            : 'rgba(255,255,255,0.05)',
                        color: isRecording ? '#f87171' : 'rgba(255,255,255,0.5)',
                        fontSize: '18px',
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'all 0.2s',
                    }}
                >
                    🎙
                </button>

                {/* Input texto */}
                <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSend()}
                    placeholder="Escribe a Hannah..."
                    style={{
                        flex: 1,
                        background: 'rgba(255,255,255,0.07)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: '22px',
                        padding: '10px 18px',
                        color: 'rgba(255,255,255,0.85)',
                        fontFamily: "'DM Mono', monospace",
                        fontSize: '13px',
                        outline: 'none',
                    }}
                />

                {/* Enviar */}
                <button
                    onClick={handleSend}
                    style={{
                        width: '44px', height: '44px',
                        borderRadius: '50%',
                        border: '2px solid rgba(255,255,255,0.2)',
                        background: 'rgba(255,255,255,0.05)',
                        color: 'rgba(255,255,255,0.6)',
                        fontSize: '16px',
                        cursor: 'pointer',
                        flexShrink: 0,
                    }}
                >
                    ↗
                </button>

                {/* Visión */}
                <button
                    onClick={onToggleVision}
                    style={{
                        width: '44px', height: '44px',
                        borderRadius: '50%',
                        border: visionActive
                            ? '2px solid #6ee7b7'
                            : '2px solid rgba(255,255,255,0.2)',
                        background: visionActive
                            ? 'rgba(110,231,183,0.1)'
                            : 'rgba(255,255,255,0.05)',
                        color: visionActive ? '#6ee7b7' : 'rgba(255,255,255,0.5)',
                        fontSize: '18px',
                        cursor: 'pointer',
                        flexShrink: 0,
                        transition: 'all 0.2s',
                    }}
                >
                    👁
                </button>
            </div>
            )}

            <style>{`
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.3; }
                }
            `}</style>
        </>
    );
}
