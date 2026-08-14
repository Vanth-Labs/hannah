// src/components/TerminalPanel.jsx
// Panel de terminal real (xterm.js) conectado al pty del backend. Muestra la salida en
// vivo (bus terminalOut) y manda lo que escribes (onInput). Hannah y tú comparten el shell.
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { onTerminalOut } from '../lib/terminalBus.js';

export function TerminalPanel({ onInput, onResize, onClose }) {
    const hostRef = useRef(null);

    useEffect(() => {
        const term = new Terminal({
            fontSize: 12,
            fontFamily: "'DM Mono', ui-monospace, monospace",
            cursorBlink: true,
            theme: { background: '#080b12', foreground: '#d5dae2', cursor: '#7ab8e8' },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(hostRef.current);
        const doFit = () => { try { fit.fit(); onResize?.(term.cols, term.rows); } catch { /* noop */ } };
        doFit();
        const off = onTerminalOut((data) => term.write(data));
        if (onInput) term.onData(onInput);
        const ro = new ResizeObserver(doFit);
        ro.observe(hostRef.current);
        term.focus();
        return () => { off(); ro.disconnect(); term.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div style={{
            position: 'fixed', left: 0, right: 0, bottom: 0, height: '40%', zIndex: 30,
            background: '#080b12', borderTop: '1px solid rgba(255,255,255,0.15)',
            display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 24px rgba(0,0,0,0.5)',
        }}>
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '5px 12px', fontFamily: "'DM Mono', monospace", fontSize: '11px',
                color: 'rgba(255,255,255,0.5)', letterSpacing: '0.1em',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}>
                <span>⌨ TERMINAL</span>
                <span onClick={onClose} style={{ cursor: 'pointer', opacity: 0.7 }}>✕</span>
            </div>
            <div ref={hostRef} style={{ flex: 1, minHeight: 0, padding: '4px 8px' }} />
        </div>
    );
}
