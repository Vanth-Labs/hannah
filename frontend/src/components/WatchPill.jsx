// src/components/WatchPill.jsx
// La superficie de "vigilancia" (watches) en el HUD. Una fila por watch, del alto de una línea:
// modelada sobre AgentPill y por su misma razón, que en el widget de 400px un panel de 330-520px
// tapa el avatar.
//
// La regla de producto que manda sobre el estilo: la promesa entera es "sigo mirando", así que un
// watch que NO está mirando (blind, suspended, expired, disarmed, faulted) no puede parecerse a
// uno armado. El borde discontinuo lo dice sin depender del color (daltonismo, capturas en gris);
// el color y el icono solo distinguen el motivo.
import { useHannahStore, WATCH_TERMINAL } from '../store/hannahStore.js';

// Una fila terminal se queda unos segundos para que se lea el desenlace y luego desaparece,
// igual que hace el HUD con la píldora del agente.
export const WATCH_LINGER_MS = 15000;

const LOOK = {
    armed:     { icon: '◉', color: '#6ee7b7',              border: 'rgba(110,231,183,0.55)', watching: true },
    blind:     { icon: '◌', color: '#f5c842',              border: 'rgba(245,200,66,0.60)',  watching: false },
    suspended: { icon: '⏸', color: '#93c5fd',              border: 'rgba(147,197,253,0.50)', watching: false },
    expired:   { icon: '⌛', color: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.20)', watching: false },
    disarmed:  { icon: '⊘', color: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.20)', watching: false },
    faulted:   { icon: '⚠', color: '#f87171',              border: 'rgba(248,113,113,0.55)', watching: false },
};
// Un estado que no conocemos (contrato nuevo, backend más moderno que esta HUD) se pinta como
// "no está mirando". Fallar hacia `armed` sería la mentira exacta que este componente evita.
const UNKNOWN = { icon: '?', color: 'rgba(255,255,255,0.5)', border: 'rgba(255,255,255,0.20)', watching: false };

/** Aspecto de un estado de watch. Lo comparte el panel de ajustes para que "ciega" se vea igual en los dos sitios. */
export const watchLook = (state) => LOOK[state] || UNKNOWN;

export function WatchPill({ watch, onDisarm }) {
    const look = watchLook(watch.state);
    const fires = watch.fires || 0;
    // Terminal = ya no hay nada que desarmar. El botón desaparece en vez de mandar una orden
    // que el servidor va a rechazar con un 404.
    const live = !WATCH_TERMINAL.includes(watch.state);
    return (
        <div style={{
            maxWidth: 'min(320px, 70vw)', padding: '4px 9px', borderRadius: '999px',
            background: 'rgba(8,11,18,0.9)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)',
            border: `1px solid ${look.border}`, borderStyle: look.watching ? 'solid' : 'dashed',
            color: 'rgba(255,255,255,0.85)', fontFamily: "'DM Mono', monospace", fontSize: '11px',
            display: 'flex', gap: '7px', alignItems: 'center', pointerEvents: 'auto', whiteSpace: 'nowrap',
        }}>
            <span style={{ color: look.color }}>{look.icon}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{watch.label}</span>
            <span style={{ opacity: 0.55 }}>{watch.state}</span>
            {/* El contador de disparos no es decoración: es cómo se ve que gritó "lobo". */}
            {fires > 0 && (
                <span title={`Saltó ${fires} ${fires === 1 ? 'vez' : 'veces'}`} style={{ color: '#f5c842' }}>
                    ⚡{fires}
                </span>
            )}
            {live && <button onClick={() => onDisarm?.(watch.watchId)} title="Dejar de vigilar" style={{
                pointerEvents: 'auto', background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '12px', padding: '0 2px',
            }}>✕</button>}
        </div>
    );
}

// Columna de píldoras, arriba a la izquierda y bajo la línea de estado: la vigilancia es estado
// ambiente, no un evento modal, así que no compite por el centro con AgentPill ni con el toast.
// Se suscribe ELLA al store (selector atómico `s.watches`) en vez de recibir la lista por prop:
// así una muestra que llega cada 15s no re-renderiza el HUD entero.
export function WatchesRail({ onDisarm }) {
    const watches = useHannahStore((s) => s.watches);
    const visible = watches.filter((w) => !w.doneAt || Date.now() - w.doneAt < WATCH_LINGER_MS);
    if (!visible.length) return null;
    return (
        <div style={{
            position: 'fixed', top: '34px', left: '18px', zIndex: 31,
            display: 'flex', flexDirection: 'column', gap: '5px', alignItems: 'flex-start',
            pointerEvents: 'none',
        }}>
            {visible.map((w) => <WatchPill key={w.watchId} watch={w} onDisarm={onDisarm} />)}
        </div>
    );
}
