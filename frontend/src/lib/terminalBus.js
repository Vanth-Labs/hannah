// src/lib/terminalBus.js
// Pequeño pub/sub para la salida del pty: el WS la recibe (terminal_out) y el
// TerminalPanel (xterm) se suscribe para escribirla, sin pasar por el store (imperativo).
const subs = new Set();
export const onTerminalOut = (cb) => { subs.add(cb); return () => subs.delete(cb); };
export const emitTerminalOut = (data) => { for (const cb of subs) { try { cb(data); } catch { /* noop */ } } };

// Eco de las MANOS (el agente): cada comando que corre y un vistazo a su salida, escrito en
// el mismo panel que el pty, para que "qué corrió en mi máquina" tenga una sola vista. El
// agente corre en su proceso, no en este shell: esto es solo lectura. Se guarda un backlog
// para que abrir la terminal después muestre lo que ya pasó.
const HANDS_BACKLOG_MAX = 80;
const handsBacklog = [];
export const emitHands = (text) => {
    handsBacklog.push(text);
    if (handsBacklog.length > HANDS_BACKLOG_MAX) handsBacklog.shift();
    emitTerminalOut(text);
};
export const getHandsBacklog = () => handsBacklog.join('');

// Un evento `task.tool` del agente -> texto para xterm (ANSI, líneas con \r\n).
const TAG = '\x1b[38;5;110m[hands]\x1b[0m';
export const formatHandsTool = (msg) => {
    const d = msg?.data || {};
    if (d.status === 'started') {
        const what = d.command || d.target || d.summary || d.tool || '';
        return `\r\n${TAG} $ ${String(what).replace(/\r?\n/g, ' ')}\r\n`;
    }
    if (d.status === 'done') {
        const lines = String(d.preview || '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
        return lines.length ? lines.map((l) => `\x1b[2m${l}\x1b[0m\r\n`).join('') : '';
    }
    if (d.status === 'failed') return `\x1b[31m${TAG} ${d.summary || 'failed'}\x1b[0m\r\n`;
    return '';
};
