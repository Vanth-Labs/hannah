// src/components/Select.jsx
// A dropdown drawn INSIDE the page. A native <select> opens its list as a separate OS popup
// window, and under an always-on-top overlay on Linux (X11/XWayland) that popup lands BEHIND
// Hannah's window: the user sees a shadow and no options. Same look as the inputs of the panel.
import { useEffect, useRef, useState } from 'react';

const LIST = {
    position: 'fixed', zIndex: 10000, maxHeight: '220px', overflowY: 'auto',
    background: '#161a24', border: '1px solid rgba(255,255,255,0.14)', borderRadius: '8px',
    boxShadow: '0 12px 32px rgba(0,0,0,0.55)', padding: '4px', boxSizing: 'border-box',
    fontFamily: "'DM Mono', monospace", fontSize: '12px',
};
const ITEM = { padding: '7px 10px', borderRadius: '6px', cursor: 'pointer', color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/**
 * @param {{ value: string, onChange: (v: string) => void, options: {value: string, label: string}[], style?: object, disabled?: boolean }} props
 */
export function Select({ value, onChange, options, style, disabled }) {
    const [open, setOpen] = useState(false);
    const [rect, setRect] = useState(null);
    const [hover, setHover] = useState(-1);
    const btn = useRef(null);
    const list = useRef(null);
    const current = options.find((o) => o.value === value);

    const place = () => {
        const r = btn.current?.getBoundingClientRect();
        if (!r) return;
        // below the field; above it when there is no room underneath
        const below = window.innerHeight - r.bottom;
        const h = Math.min(220, options.length * 30 + 8);
        setRect({ left: r.left, width: r.width, top: below >= h + 8 ? r.bottom + 4 : Math.max(4, r.top - h - 4) });
    };
    const toggle = () => { if (disabled) return; if (!open) { place(); setHover(Math.max(0, options.findIndex((o) => o.value === value))); } setOpen(!open); };
    const pick = (v) => { setOpen(false); if (v !== value) onChange(v); btn.current?.focus(); };

    useEffect(() => {
        if (!open) return undefined;
        const close = (e) => { if (!btn.current?.contains(e.target) && !list.current?.contains(e.target)) setOpen(false); };
        const onScroll = (e) => { if (!list.current?.contains(e.target)) setOpen(false); };
        document.addEventListener('mousedown', close, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', onScroll);
        return () => {
            document.removeEventListener('mousedown', close, true);
            document.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onScroll);
        };
    }, [open]);

    useEffect(() => {
        if (!open || hover < 0) return;
        list.current?.children[hover]?.scrollIntoView?.({ block: 'nearest' });
    }, [open, hover]);

    const onKey = (e) => {
        if (disabled) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!open) { toggle(); return; }
            const d = e.key === 'ArrowDown' ? 1 : -1;
            setHover((h) => Math.min(options.length - 1, Math.max(0, h + d)));
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!open) toggle(); else if (options[hover]) pick(options[hover].value);
        } else if (e.key === 'Escape' && open) { e.preventDefault(); setOpen(false); }
    };

    return (
        <>
            <button
                ref={btn} type="button" onClick={toggle} onKeyDown={onKey} disabled={disabled}
                aria-haspopup="listbox" aria-expanded={open}
                style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', cursor: disabled ? 'default' : 'pointer', textAlign: 'left', opacity: disabled ? 0.5 : 1 }}
            >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{current?.label ?? value ?? ''}</span>
                <span aria-hidden="true" style={{ fontSize: '9px', opacity: 0.6, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}>▼</span>
            </button>
            {open && rect && (
                <div ref={list} role="listbox" style={{ ...LIST, left: rect.left, top: rect.top, width: rect.width }}>
                    {options.map((o, i) => (
                        <div
                            key={o.value} role="option" aria-selected={o.value === value}
                            onMouseEnter={() => setHover(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.value)}
                            style={{ ...ITEM, background: i === hover ? 'rgba(122,184,232,0.18)' : 'transparent', color: o.value === value ? '#7ab8e8' : ITEM.color }}
                        >
                            {o.label}
                        </div>
                    ))}
                </div>
            )}
        </>
    );
}
