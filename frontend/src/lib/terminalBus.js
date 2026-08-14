// src/lib/terminalBus.js
// Pequeño pub/sub para la salida del pty: el WS la recibe (terminal_out) y el
// TerminalPanel (xterm) se suscribe para escribirla, sin pasar por el store (imperativo).
const subs = new Set();
export const onTerminalOut = (cb) => { subs.add(cb); return () => subs.delete(cb); };
export const emitTerminalOut = (data) => { for (const cb of subs) { try { cb(data); } catch { /* noop */ } } };
