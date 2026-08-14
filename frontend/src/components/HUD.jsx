// src/components/HUD.jsx
import { useRef, useState } from 'react';
import { useHannahStore } from '../store/hannahStore.js';
import { SettingsPanel } from './SettingsPanel.jsx';

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

// Control de posición del overlay: mover/redimensionar por clic (fiable, sin voz/LLM).
// El selector de pantalla aparece SOLO si hay más de un monitor (universal).
function PositionPanel({ monitors, onMove, onClose }) {
    const cell = { pointerEvents: 'auto', height: '30px', borderRadius: '8px', cursor: 'pointer',
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)',
        color: 'rgba(255,255,255,0.8)', fontSize: '13px' };
    const Btn = ({ label, spec, style }) => (
        <button onClick={() => onMove(spec)} style={{ ...cell, ...style }}>{label}</button>
    );
    const gap = { width: '30px' };
    return (
        <div style={{
            position: 'fixed', top: '54px', right: '16px', zIndex: 20, width: '206px',
            background: 'rgba(10,14,22,0.95)', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: '14px', padding: '14px', fontFamily: "'DM Mono', monospace",
            color: 'rgba(255,255,255,0.7)', backdropFilter: 'blur(8px)', pointerEvents: 'auto',
        }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', fontSize: '11px', letterSpacing: '0.12em' }}>
                <span>POSICIÓN</span>
                <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.6 }}>✕</span>
            </div>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                <Btn label="⛶ Completa" spec="fullscreen" style={{ flex: 2 }} />
                <Btn label="▫ Chica" spec="top-right" style={{ flex: 1 }} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', marginBottom: '10px' }}>
                <Btn label="↖" spec="top-left" /><span style={gap} /><Btn label="↗" spec="top-right" />
                <span style={gap} /><Btn label="●" spec="center" /><span style={gap} />
                <Btn label="↙" spec="bottom-left" /><span style={gap} /><Btn label="↘" spec="bottom-right" />
            </div>
            {monitors?.count > 1 && (
                <div>
                    <div style={{ fontSize: '10px', opacity: 0.5, marginBottom: '5px', letterSpacing: '0.08em' }}>
                        PANTALLA ({monitors.count})
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        {monitors.list.map((m) => (
                            <Btn key={m.index} label={String(m.index)} spec={`screen ${m.index} full`} style={{ flex: 1 }} />
                        ))}
                        <Btn label="⇄" spec="next-screen full" style={{ flex: 1 }} />
                    </div>
                </div>
            )}
        </div>
    );
}

export function HUD({ onSendText, onToggleVision, onToggleRecord, isRecording, onMoveWindow }) {
    const [input, setInput] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [showPos, setShowPos] = useState(false);
    const { emotion, isSpeaking, visionActive, transcript, userTranscript, connected, logs,
        avatarMode, setAvatarMode, handsFree, setHandsFree, monitors } = useHannahStore();

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
                {/* Posición de la ventana (overlay): mover/redimensionar por clic */}
                {isOverlay && (
                    <button
                        onClick={() => setShowPos((v) => !v)}
                        title="Posición de la ventana"
                        style={{
                            pointerEvents: 'auto',
                            width: '30px', height: '30px', borderRadius: '50%',
                            background: showPos ? 'rgba(122,184,232,0.15)' : 'rgba(255,255,255,0.06)',
                            border: `1px solid ${showPos ? 'rgba(122,184,232,0.5)' : 'rgba(255,255,255,0.15)'}`,
                            color: showPos ? '#7ab8e8' : 'rgba(255,255,255,0.6)',
                            fontSize: '14px', cursor: 'pointer',
                        }}
                    >
                        ⤢
                    </button>
                )}
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

            {showPos && isOverlay && (
                <PositionPanel
                    monitors={monitors}
                    onMove={(spec) => onMoveWindow?.(spec)}
                    onClose={() => setShowPos(false)}
                />
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
