// src/components/Welcome.jsx
// First run: "¿Dónde pienso?" — shown until a brain is chosen AND usable (GET /api/v1/brain
// says `configured`). Two choices, the same the ⚙ panel's Brain card offers later:
//   · En mi PC  -> Ollama here. Detects it; can install it PER USER and pull the models, each a
//                  button with progress (nothing runs on its own). Recommended with a real GPU.
//   · En la nube -> a provider key. Recommended everywhere else.
// The installer no longer touches Ollama or models: this screen is where that decision lives.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api.js';
import { CLOUD, cloudOf } from '../lib/brain.js';
import { useHannahStore } from '../store/hannahStore.js';

const ACCENT = '#7ab8e8';
const S = {
    overlay: { position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(6,8,12,0.86)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', pointerEvents: 'auto' },
    box: { width: '100%', maxWidth: '440px', maxHeight: '96vh', overflowY: 'auto', background: 'rgba(16,18,24,0.98)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', padding: '22px', fontFamily: "'DM Mono', monospace", color: 'rgba(255,255,255,0.82)', fontSize: '12px' },
    title: { fontFamily: "'Syne', sans-serif", fontSize: '20px', color: '#fff', marginBottom: '4px' },
    sub: { color: 'rgba(255,255,255,0.5)', marginBottom: '14px', lineHeight: 1.45 },
    seg: { display: 'flex', gap: '6px', marginBottom: '12px' },
    segBtn: (on) => ({ flex: 1, padding: '9px 8px', borderRadius: '10px', cursor: 'pointer', fontFamily: 'inherit', fontSize: '12px', border: `1px solid ${on ? ACCENT : 'rgba(255,255,255,0.14)'}`, background: on ? 'rgba(122,184,232,0.14)' : 'rgba(255,255,255,0.04)', color: on ? ACCENT : 'rgba(255,255,255,0.65)' }),
    badge: { display: 'inline-block', marginLeft: '6px', padding: '1px 6px', borderRadius: '6px', fontSize: '9px', letterSpacing: '0.06em', background: 'rgba(122,184,232,0.18)', color: ACCENT },
    card: { padding: '14px', borderRadius: '12px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)' },
    hint: { color: 'rgba(255,255,255,0.5)', lineHeight: 1.45 },
    step: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' },
    ok: { color: '#8fe3a2' },
    bad: { color: 'rgba(255,255,255,0.45)' },
    btn: { background: 'rgba(122,184,232,0.14)', border: `1px solid rgba(122,184,232,0.4)`, borderRadius: '9px', padding: '6px 10px', color: ACCENT, fontFamily: 'inherit', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' },
    primary: (on) => ({ width: '100%', marginTop: '14px', background: on ? ACCENT : 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '10px', padding: '11px', color: on ? '#0a0d14' : 'rgba(255,255,255,0.35)', fontFamily: 'inherit', fontSize: '12px', fontWeight: 700, cursor: on ? 'pointer' : 'default' }),
    label: { fontSize: '10px', color: 'rgba(255,255,255,0.4)', display: 'block', margin: '10px 0 3px' },
    input: { width: '100%', boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '7px 10px', color: 'rgba(255,255,255,0.9)', fontFamily: 'inherit', fontSize: '12px', outline: 'none' },
    bar: { height: '6px', borderRadius: '3px', background: 'rgba(255,255,255,0.08)', overflow: 'hidden', marginTop: '6px' },
    fill: (p) => ({ height: '100%', width: `${Math.round((p ?? 0) * 100)}%`, background: ACCENT, transition: 'width 0.4s' }),
    err: { color: '#ff8a80', marginTop: '8px' },
    foot: { marginTop: '14px', color: 'rgba(255,255,255,0.35)', fontSize: '10px', lineHeight: 1.5 },
};

const gb = (n) => (n >= 1 ? `${n} GB` : `${Math.round(n * 1024)} MB`);
const hasModel = (models, name) => (models || []).some((m) => m === name || (!name.includes(':') && m === `${name}:latest`));

export function Welcome() {
    const brain = useHannahStore((s) => s.brain);
    const setBrain = useHannahStore((s) => s.setBrain);
    // Derived, not synced: until the person clicks, the mode is what the backend recommends (or
    // what was chosen before), and the provider is the saved one or Groq (free tier, fast).
    const [choice, setChoice] = useState(null);
    const [providerId, setProviderId] = useState(null);
    const mode = choice ?? (brain?.mode || brain?.recommendation || 'cloud');
    const provider = CLOUD.find((c) => c.id === providerId) ?? cloudOf(brain?.baseUrl) ?? CLOUD[2];
    const setMode = setChoice;
    const setProvider = (c) => setProviderId(c.id);
    const [key, setKey] = useState('');
    const [modelChoice, setModelChoice] = useState(null);   // null = el modelo por defecto del proveedor
    const model = modelChoice ?? provider.model;
    const [available, setAvailable] = useState([]);
    const [busy, setBusy] = useState('');
    const [err, setErr] = useState('');
    const brainError = useHannahStore((s) => s.brainError);
    const timer = useRef(null);

    const refresh = useCallback(async () => {
        try {
            const r = await apiFetch('/api/v1/brain');
            if (r.ok) setBrain(await r.json());
        } catch { /* backend restarting; the next tick retries */ }
    }, [setBrain]);

    // Poll while shown: the install/pull jobs report progress here, and Ollama may come up on its own.
    useEffect(() => {
        refresh();
        timer.current = setInterval(refresh, 1500);
        return () => clearInterval(timer.current);
    }, [refresh]);

    const post = async (path, body) => {
        setErr('');
        try {
            const r = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) { setAvailable(j.available || []); throw new Error(j.message || j.error || `HTTP ${r.status}`); }
            setAvailable([]);
            useHannahStore.getState().setBrainError(null);
            await refresh();
            return j;
        } catch (e) { setErr(e.message); return null; }
    };

    if (!brain) return null;
    const job = brain.job;
    const running = job?.status === 'running';
    const o = brain.ollama || {};
    const hw = brain.hardware || {};
    const models = brain.models || {};
    const wanted = [models.brain, models.vision, models.embed].filter(Boolean);
    const missing = wanted.filter((m) => !hasModel(o.models, m));
    const localReady = o.reachable && hasModel(o.models, models.brain);
    const rec = brain.recommendation;
    const hwLine = hw.gpu ? `${hw.gpu.name}${hw.gpu.vramGB ? ` · ${hw.gpu.vramGB} GB VRAM` : ''}`
        : hw.appleSilicon ? `Apple Silicon · ${hw.ramGB} GB RAM` : `Sin GPU NVIDIA · ${hw.ramGB} GB RAM`;

    const chooseLocal = async () => { setBusy('choose'); await post('/api/v1/brain/choose', { mode: 'local', llm: { model: models.brain } }); setBusy(''); };
    const chooseCloud = async () => {
        if (!key.trim() && !brain.hasKey) { setErr('Pega la API key del proveedor.'); return; }
        setBusy('choose');
        await post('/api/v1/brain/choose', { mode: 'cloud', llm: { baseUrl: provider.baseUrl, model, ...(key.trim() ? { apiKey: key.trim() } : {}) } });
        setBusy('');
    };

    return (
        <div style={S.overlay}>
            <div style={S.box}>
                <div style={S.title}>Hola, soy Hannah.</div>
                <div style={S.sub}>¿Dónde quieres que piense? Se puede cambiar luego en ⚙. Hasta que elijas, no hablo.</div>

                <div style={S.seg}>
                    <button style={S.segBtn(mode === 'local')} onClick={() => setMode('local')}>En mi PC{rec === 'local' && <span style={S.badge}>RECOMENDADO</span>}</button>
                    <button style={S.segBtn(mode === 'cloud')} onClick={() => setMode('cloud')}>En la nube{rec === 'cloud' && <span style={S.badge}>RECOMENDADO</span>}</button>
                </div>

                {mode === 'local' ? (
                    <div style={S.card}>
                        <div style={S.hint}>Gratis y privado: nada sale de tu máquina. Piensa con <b>Ollama</b> y un modelo de 7B (≈ 4,7 GB); con él vienen la visión y la memoria (≈ 2 GB más). Todo se instala en tu carpeta de usuario, sin permisos de administrador.</div>
                        <div style={{ ...S.hint, marginTop: '8px' }}>Esta máquina: {hwLine}{rec !== 'local' && ' — le costará; para probar, la nube va más ligera.'}</div>

                        <div style={S.step}>
                            <span style={o.reachable ? S.ok : S.bad}>{o.reachable ? '✓' : '○'}</span>
                            <span style={{ flex: 1 }}>Ollama {o.reachable ? 'en marcha' : o.installed ? 'instalado, parado' : 'no está'}</span>
                            {!o.reachable && (o.installed
                                ? <button style={S.btn} disabled={running} onClick={() => post('/api/v1/brain/ollama/start')}>Arrancar</button>
                                : <button style={S.btn} disabled={running} onClick={() => post('/api/v1/brain/ollama/install')}>Instalar en mi carpeta</button>)}
                        </div>
                        <div style={S.step}>
                            <span style={missing.length ? S.bad : S.ok}>{missing.length ? '○' : '✓'}</span>
                            <span style={{ flex: 1 }}>Modelos {missing.length ? `(faltan ${missing.length} de ${wanted.length})` : 'descargados'}</span>
                            {missing.length > 0 && <button style={S.btn} disabled={running || !o.reachable} onClick={() => post('/api/v1/brain/ollama/pull', { models: missing })}>Descargar ≈ {gb(missing.reduce((a, m) => a + (m === models.brain ? 4.7 : m === models.vision ? 1.7 : 0.3), 0).toFixed(1) * 1)}</button>}
                        </div>
                        {job && (job.status === 'running' || job.status === 'error') && (
                            <div style={{ marginTop: '8px' }}>
                                <div style={S.hint}>{job.kind === 'install' ? 'Instalando Ollama' : 'Descargando'} — {job.detail}{job.progress != null ? ` · ${Math.round(job.progress * 100)}%` : ''}</div>
                                {job.status === 'running' && <div style={S.bar}><div style={S.fill(job.progress)} /></div>}
                                {job.status === 'error' && <div style={S.err}>Falló: {job.error}</div>}
                            </div>
                        )}
                        <button style={S.primary(localReady && !busy)} disabled={!localReady || !!busy} onClick={chooseLocal}>
                            {localReady ? 'Pensar en este PC' : 'Primero Ollama y el modelo'}
                        </button>
                    </div>
                ) : (
                    <div style={S.card}>
                        <div style={S.hint}>Más lista y sin descargas, en cualquier máquina. Lo que le digas viaja al proveedor. La key se guarda en tu PC y nunca se muestra.</div>
                        <label style={S.label}>Proveedor</label>
                        <select style={S.input} value={provider.id} onChange={(e) => { setProvider(CLOUD.find((c) => c.id === e.target.value) || CLOUD[0]); setModelChoice(null); setAvailable([]); }}>
                            {CLOUD.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </select>
                        <label style={S.label}>Modelo</label>
                        <input style={S.input} type="text" value={model} onChange={(e) => setModelChoice(e.target.value)} />
                        {available.length > 0 && (
                            <div style={{ ...S.hint, marginTop: '6px' }}>Disponibles con tu key: {available.map((m) => (
                                <button key={m} type="button" onClick={() => setModelChoice(m)} style={{ ...S.btn, padding: '2px 7px', marginRight: '4px', marginTop: '4px' }}>{m}</button>
                            ))}</div>
                        )}
                        <label style={S.label}>API key <a href={provider.keys} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>(dónde conseguirla)</a></label>
                        <input style={S.input} type="password" value={key} placeholder={brain.hasKey ? '•••••• (guardada)' : 'pega tu key'} onChange={(e) => setKey(e.target.value)} />
                        <button style={S.primary(!busy)} disabled={!!busy} onClick={chooseCloud}>Pensar con {provider.label}</button>
                    </div>
                )}

                {(err || brainError) && <div style={S.err}>{err || `El cerebro fallo: ${brainError}`}</div>}
                <div style={S.foot}>Voz y oído ya están listos en tu PC. Ollama se instala solo si pulsas el botón, y solo en tu carpeta.</div>
            </div>
        </div>
    );
}
