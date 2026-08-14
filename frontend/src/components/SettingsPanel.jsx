// src/components/SettingsPanel.jsx
// Panel "trae tu propio modelo/API" (estilo airi). Lee la config redactada del
// backend (GET /api/v1/settings), deja editar proveedor/modelo/key/baseUrl por
// sección y la guarda (POST). La app se envía con el stack local del dueño ya
// puesto; el usuario es libre de cambiarlo. Dejar el apiKey en blanco = conservar.
import { useEffect, useState } from 'react';
import { useHannahStore } from '../store/hannahStore.js';

// Presets de LLM: rellenan baseUrl/model de un click (el usuario ajusta luego).
const LLM_PRESETS = [
    { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b' },
    { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' },
    { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct' },
];

// Definición de campos por sección (mismo whitelist que el backend).
const SECTIONS = [
    {
        key: 'llm', title: 'Modelo de lenguaje (cerebro)',
        fields: [
            { name: 'baseUrl', label: 'Base URL', type: 'text', ph: 'https://…/v1  (vacío = OpenAI)' },
            { name: 'model', label: 'Modelo', type: 'text', ph: 'gpt-4o-mini' },
            { name: 'apiKey', label: 'API key', type: 'password' },
            { name: 'persona', label: 'Personalidad', type: 'textarea', ph: 'Quién es, cómo habla… (en blanco = conservar)' },
        ],
    },
    {
        key: 'tts', title: 'Voz (TTS)',
        fields: [
            { name: 'provider', label: 'Proveedor', type: 'select', options: ['kokoro', 'elevenlabs'] },
            { name: 'voiceId', label: 'Voz', type: 'text', ph: 'af_bella' },
            { name: 'model', label: 'Modelo', type: 'text', ph: 'eleven_multilingual_v2' },
            { name: 'apiKey', label: 'API key', type: 'password' },
            { name: 'sidecarUrl', label: 'Sidecar URL', type: 'text' },
        ],
    },
    {
        key: 'asr', title: 'Reconocimiento de voz (ASR)',
        fields: [
            { name: 'provider', label: 'Proveedor', type: 'select', options: ['local', 'cloud'] },
            { name: 'model', label: 'Modelo', type: 'text', ph: 'small / whisper-1' },
            { name: 'language', label: 'Idioma', type: 'text', ph: 'auto' },
            { name: 'apiKey', label: 'API key', type: 'password' },
            { name: 'sidecarUrl', label: 'Sidecar URL', type: 'text' },
        ],
    },
];

const S = {
    overlay: {
        position: 'fixed', inset: 0, zIndex: 30, pointerEvents: 'auto',
        background: 'rgba(0,0,0,0.55)', display: 'flex',
        justifyContent: 'flex-end', backdropFilter: 'blur(2px)',
    },
    panel: {
        width: '380px', maxWidth: '92vw', height: '100%', overflowY: 'auto',
        background: 'rgba(16,18,24,0.97)', borderLeft: '1px solid rgba(255,255,255,0.1)',
        padding: '22px 22px 60px', fontFamily: "'DM Mono', monospace", color: 'rgba(255,255,255,0.8)',
    },
    h: { fontFamily: "'Syne', sans-serif", letterSpacing: '0.14em', fontSize: '13px', color: 'rgba(255,255,255,0.5)' },
    sec: { marginTop: '22px' },
    secTitle: { fontSize: '12px', color: '#7ab8e8', letterSpacing: '0.05em', marginBottom: '8px' },
    label: { fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', margin: '8px 0 3px' },
    input: {
        width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)',
        border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '7px 10px',
        color: 'rgba(255,255,255,0.9)', fontFamily: "'DM Mono', monospace", fontSize: '12px', outline: 'none',
    },
    preset: {
        background: 'rgba(122,184,232,0.12)', border: '1px solid rgba(122,184,232,0.3)',
        borderRadius: '10px', padding: '3px 9px', color: '#7ab8e8', fontSize: '10px',
        cursor: 'pointer', marginRight: '6px', marginTop: '6px',
    },
    row: { display: 'flex', gap: '8px', marginTop: '24px' },
    save: {
        flex: 1, background: '#7ab8e8', border: 'none', borderRadius: '10px', padding: '10px',
        color: '#0a0d14', fontFamily: "'DM Mono', monospace", fontSize: '12px', fontWeight: 700, cursor: 'pointer',
    },
    close: {
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)',
        borderRadius: '10px', padding: '10px 16px', color: 'rgba(255,255,255,0.6)', cursor: 'pointer', fontSize: '12px',
    },
};

// ── Atajos de voz (abrir apps/páginas). Estado propio: carga GET /shortcuts, edita
// filas clave→valor y guarda POST /shortcuts. Sin tocar la config de proveedores.
function ShortcutsSection() {
    const [sites, setSites] = useState([]);   // [[clave, dominio], ...]
    const [apps, setApps] = useState([]);      // [[clave, appKey], ...]
    const [status, setStatus] = useState('cargando…');

    useEffect(() => {
        fetch('/api/v1/shortcuts')
            .then((r) => r.json())
            .then((d) => {
                setSites(Object.entries(d.sites || {}));
                setApps(Object.entries(d.apps || {}));
                setStatus('');
            })
            .catch(() => setStatus('backend no disponible'));
    }, []);

    const edit = (list, setList, i, col, v) =>
        setList(list.map((row, j) => (j === i ? (col === 0 ? [v, row[1]] : [row[0], v]) : row)));
    const add = (list, setList) => setList([...list, ['', '']]);
    const del = (list, setList, i) => setList(list.filter((_, j) => j !== i));

    const save = async () => {
        setStatus('guardando…');
        const toObj = (rows) => Object.fromEntries(
            rows.map(([k, v]) => [k.trim().toLowerCase(), v.trim()]).filter(([k, v]) => k && v));
        try {
            const r = await fetch('/api/v1/shortcuts', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sites: toObj(sites), apps: toObj(apps) }),
            });
            const d = await r.json();
            setSites(Object.entries(d.sites || {}));
            setApps(Object.entries(d.apps || {}));
            setStatus('guardado ✓');
        } catch { setStatus('error al guardar'); }
    };

    const rowStyle = { display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' };
    const delBtn = { flexShrink: 0, width: '26px', height: '26px', borderRadius: '7px', cursor: 'pointer',
        background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: '13px' };
    const addBtn = { ...S.preset, marginTop: '8px', display: 'inline-block' };

    const group = (title, hint, list, setList) => (
        <div style={{ marginTop: '10px' }}>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.5)', marginBottom: '2px' }}>{title}</div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', marginBottom: '4px' }}>{hint}</div>
            {list.map((row, i) => (
                <div key={i} style={rowStyle}>
                    <input style={{ ...S.input, flex: '0 0 40%' }} value={row[0]}
                        placeholder="dices…" onChange={(e) => edit(list, setList, i, 0, e.target.value)} />
                    <input style={{ ...S.input, flex: 1 }} value={row[1]}
                        placeholder={title === 'Páginas' ? 'dominio.com' : 'browser/terminal/code'}
                        onChange={(e) => edit(list, setList, i, 1, e.target.value)} />
                    <button style={delBtn} onClick={() => del(list, setList, i)} title="Quitar">✕</button>
                </div>
            ))}
            <button style={addBtn} onClick={() => add(list, setList)}>+ añadir</button>
        </div>
    );

    return (
        <div style={S.sec}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={S.secTitle}>Atajos de voz (abrir por comando)</div>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)' }}>{status}</span>
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', marginBottom: '4px' }}>
                Di «abre <em>clave</em>» y Hannah lo abre. Las apps deben existir en el allowlist del backend.
            </div>
            {group('Páginas', 'ej.  youtube → youtube.com', sites, setSites)}
            {group('Apps', 'ej.  navegador → browser', apps, setApps)}
            <button style={{ ...S.save, marginTop: '12px' }} onClick={save}>Guardar atajos</button>
        </div>
    );
}

export function SettingsPanel({ onClose }) {
    const { autoLookat, setAutoLookat } = useHannahStore();
    const [form, setForm] = useState({ llm: {}, tts: {}, asr: {} });
    const [saved, setSaved] = useState({});   // { llm:{hasApiKey}, ... } desde el backend
    const [status, setStatus] = useState('cargando…');

    useEffect(() => {
        fetch('/api/v1/settings')
            .then((r) => r.json())
            .then((d) => {
                // apiKey se deja vacío en el form; hasApiKey guía el placeholder
                const f = { llm: {}, tts: {}, asr: {} };
                for (const s of SECTIONS) for (const key in (d[s.key] || {})) {
                    if (key === 'hasApiKey') continue;
                    f[s.key][key] = d[s.key][key] ?? '';
                }
                setForm(f);
                setSaved(d);
                setStatus('');
            })
            .catch(() => setStatus('backend no disponible'));
    }, []);

    const setField = (sec, name, value) =>
        setForm((prev) => ({ ...prev, [sec]: { ...prev[sec], [name]: value } }));

    const applyPreset = (p) =>
        setForm((prev) => ({ ...prev, llm: { ...prev.llm, baseUrl: p.baseUrl, model: p.model } }));

    const save = async () => {
        setStatus('guardando…');
        // No mandar apiKey vacío (backend lo interpreta como "conservar")
        const payload = {};
        for (const s of SECTIONS) {
            payload[s.key] = {};
            for (const fld of s.fields) {
                const v = form[s.key]?.[fld.name] ?? '';
                if (fld.name === 'apiKey' && v.trim() === '') continue;
                payload[s.key][fld.name] = v;
            }
        }
        try {
            const r = await fetch('/api/v1/settings', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });
            const d = await r.json();
            setSaved(d);
            // limpiar los campos de key (ya guardados; el placeholder mostrará "guardada")
            setForm((prev) => {
                const n = { ...prev };
                for (const s of SECTIONS) n[s.key] = { ...n[s.key], apiKey: '' };
                return n;
            });
            setStatus('guardado ✓ (aplica sin reiniciar)');
        } catch {
            setStatus('error al guardar');
        }
    };

    return (
        <div style={S.overlay} onClick={onClose}>
            <div style={S.panel} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={S.h}>AJUSTES</span>
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)' }}>{status}</span>
                </div>

                {SECTIONS.map((s) => (
                    <div key={s.key} style={S.sec}>
                        <div style={S.secTitle}>{s.title}</div>
                        {s.key === 'llm' && (
                            <div>
                                {LLM_PRESETS.map((p) => (
                                    <button key={p.label} style={S.preset} onClick={() => applyPreset(p)}>{p.label}</button>
                                ))}
                            </div>
                        )}
                        {s.fields.map((fld) => {
                            const val = form[s.key]?.[fld.name] ?? '';
                            const hasKey = saved[s.key]?.hasApiKey;
                            return (
                                <div key={fld.name}>
                                    <label style={S.label}>{fld.label}</label>
                                    {fld.type === 'select' ? (
                                        <select style={S.input} value={val} onChange={(e) => setField(s.key, fld.name, e.target.value)}>
                                            {fld.options.map((o) => <option key={o} value={o}>{o}</option>)}
                                        </select>
                                    ) : fld.type === 'textarea' ? (
                                        <textarea
                                            style={{ ...S.input, minHeight: '80px', resize: 'vertical', lineHeight: 1.4 }}
                                            value={val}
                                            placeholder={fld.ph || ''}
                                            onChange={(e) => setField(s.key, fld.name, e.target.value)}
                                        />
                                    ) : (
                                        <input
                                            style={S.input}
                                            type={fld.type}
                                            value={val}
                                            placeholder={fld.name === 'apiKey' ? (hasKey ? '•••••• (guardada)' : 'sin key') : (fld.ph || '')}
                                            onChange={(e) => setField(s.key, fld.name, e.target.value)}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ))}

                {/* Atajos de voz para abrir apps/páginas (editable, con defaults) */}
                <ShortcutsSection />

                {/* Toggle de comportamiento (solo frontend) */}
                <div style={S.sec}>
                    <div style={S.secTitle}>Avatar</div>
                    <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                        <input type="checkbox" checked={autoLookat} onChange={(e) => setAutoLookat(e.target.checked)} />
                        Seguir a la cámara con la mirada (auto-lookat)
                    </label>
                </div>

                <div style={S.row}>
                    <button style={S.save} onClick={save}>Guardar</button>
                    <button style={S.close} onClick={onClose}>Cerrar</button>
                </div>
            </div>
        </div>
    );
}
