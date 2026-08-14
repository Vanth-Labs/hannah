// src/components/HUD.jsx
import { useRef, useState } from 'react';
import { useHannahStore } from '../store/hannahStore.js';
import { SettingsPanel } from './SettingsPanel.jsx';
import { TerminalPanel } from './TerminalPanel.jsx';

// Modo overlay (compañera flotante): Tauri o el navegador en modo-app (?overlay=1).
// En overlay: sin barra inferior ni subtítulos, cámara arriba, manos-libres siempre ON.
export const isOverlay = typeof window !== 'undefined'
    && (!!window.__TAURI_INTERNALS__ || !!window.__TAURI__
        || new URLSearchParams(window.location.search).has('overlay'));

const EMOTION_COLOR = {
    neutral:  '#7c8fa6',
    happy:    '#f5c842',
    curious:  '#6ee7b7',
    alert:    '#f87171',
    thinking: '#a78bfa',
    sad:      '#93c5fd',
};

export function HUD({ onSendText, onToggleVision, onToggleRecord, isRecording, sendCommand }) {
    const [input, setInput] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [showTerminal, setShowTerminal] = useState(false);
    const { emotion, isSpeaking, visionActive, transcript, userTranscript, connected, logs,
        avatarMode, setAvatarMode, handsFree, setHandsFree, pendingConfirm, setPendingConfirm } = useHannahStore();

    const toggleTerminal = () => {
        setShowTerminal((v) => {
            if (!v) sendCommand?.({ command: 'TERMINAL_START' });
            return !v;
        });
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
            {/* ── Status bar arriba ─────────────────────────────────────── */}
            <div style={{
                position: 'fixed', top: 0, left: 0, right: 0,
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '14px 24px',
                fontFamily: "'DM Mono', monospace",
                fontSize: '11px',
                color: 'rgba(255,255,255,0.4)',
                zIndex: 10,
                background: 'linear-gradient(to bottom, rgba(0,0,0,0.6) 0%, transparent 100%)',
            }}>
                <span style={{ color: connected ? '#4ade80' : '#f87171' }}>
                    {connected ? '● online' : '○ offline'}
                </span>
                <span style={{ color: emotionColor, letterSpacing: '0.08em' }}>
                    {emotion}
                </span>
                {isSpeaking && (
                    <span style={{ color: '#fff', animation: 'pulse 1s infinite' }}>
                        speaking
                    </span>
                )}
                {visionActive && (
                    <span style={{ color: '#6ee7b7' }}>● yolo</span>
                )}
                <div style={{ flex: 1 }} />
                {/* Mic on/off (manos-libres): apaga la escucha */}
                <button
                    onClick={() => setHandsFree(!handsFree)}
                    title={handsFree ? 'Micrófono activo (click para silenciar)' : 'Micrófono silenciado'}
                    style={{
                        pointerEvents: 'auto',
                        width: '30px', height: '30px', borderRadius: '50%',
                        background: handsFree ? 'rgba(110,231,183,0.12)' : 'rgba(248,113,113,0.12)',
                        border: `1px solid ${handsFree ? 'rgba(110,231,183,0.4)' : 'rgba(248,113,113,0.4)'}`,
                        color: handsFree ? '#6ee7b7' : '#f87171',
                        fontSize: '14px', cursor: 'pointer',
                    }}
                >
                    {handsFree ? '🎙' : '🔇'}
                </button>
                {/* Cámara/visión (arriba en overlay) */}
                <button
                    onClick={onToggleVision}
                    title="Que Hannah te vea por la cámara"
                    style={{
                        pointerEvents: 'auto',
                        width: '30px', height: '30px', borderRadius: '50%',
                        background: visionActive ? 'rgba(110,231,183,0.12)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${visionActive ? 'rgba(110,231,183,0.4)' : 'rgba(255,255,255,0.15)'}`,
                        color: visionActive ? '#6ee7b7' : 'rgba(255,255,255,0.5)',
                        fontSize: '14px', cursor: 'pointer',
                    }}
                >
                    👁
                </button>
                {/* Manos-libres (VAD): en overlay va siempre ON (sin botón). */}
                {!isOverlay && (
                    <button
                        onClick={() => setHandsFree(!handsFree)}
                        title="Manos libres: habla sin botón y puedes interrumpirla"
                        style={{
                            pointerEvents: 'auto',
                            background: handsFree ? 'rgba(110,231,183,0.12)' : 'rgba(255,255,255,0.06)',
                            border: `1px solid ${handsFree ? 'rgba(110,231,183,0.4)' : 'rgba(255,255,255,0.15)'}`,
                            borderRadius: '12px',
                            padding: '4px 10px',
                            color: handsFree ? '#6ee7b7' : 'rgba(255,255,255,0.5)',
                            fontFamily: "'DM Mono', monospace",
                            fontSize: '11px',
                            cursor: 'pointer',
                            letterSpacing: '0.06em',
                        }}
                    >
                        {handsFree ? '🎧 manos-libres' : '🎧 off'}
                    </button>
                )}
                {/* Terminal: panel de shell real que Hannah y tú comparten */}
                <button
                    onClick={toggleTerminal}
                    title="Terminal (Hannah puede correr comandos)"
                    style={{
                        pointerEvents: 'auto',
                        width: '30px', height: '30px', borderRadius: '50%',
                        background: showTerminal ? 'rgba(122,184,232,0.15)' : 'rgba(255,255,255,0.06)',
                        border: `1px solid ${showTerminal ? 'rgba(122,184,232,0.5)' : 'rgba(255,255,255,0.15)'}`,
                        color: showTerminal ? '#7ab8e8' : 'rgba(255,255,255,0.6)',
                        fontSize: '13px', cursor: 'pointer',
                    }}
                >
                    ⌨
                </button>
                {/* Ajustes: trae tu propio modelo/API */}
                <button
                    onClick={() => setShowSettings(true)}
                    title="Ajustes (modelo/API, voz, avatar)"
                    style={{
                        pointerEvents: 'auto',
                        background: 'rgba(255,255,255,0.06)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: '12px',
                        padding: '4px 10px',
                        color: 'rgba(255,255,255,0.6)',
                        fontSize: '13px',
                        cursor: 'pointer',
                    }}
                >
                    ⚙
                </button>
                <span style={{ fontFamily: "'Syne', sans-serif", letterSpacing: '0.2em', fontSize: '12px', color: 'rgba(255,255,255,0.15)' }}>
                    HANNAH
                </span>
            </div>

            {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

            {showTerminal && (
                <TerminalPanel
                    onInput={(d) => sendCommand?.({ command: 'TERMINAL_IN', data: d })}
                    onResize={(cols, rows) => sendCommand?.({ command: 'TERMINAL_RESIZE', cols, rows })}
                    onClose={() => setShowTerminal(false)}
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
