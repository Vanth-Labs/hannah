// src/components/SettingsPanel.jsx
// Panel ⚙. Arriba, lo que una persona normal decide de verdad — tres tarjetas:
//   Cerebro  -> "en mi PC" (gratis, privado) o "en la nube" (proveedor + key)
//   Voz      -> idioma + voz con nombre humano, con botón para escucharla
//   Look     -> subir un VRM (cualquiera) o volver al de fábrica
//   Manos    -> estado del agente + su key + la frase de privacidad
// Y, debajo, Vigilancia -> qué está mirando ahora mismo, en qué peldaño y hace cuánto la vio.
// Debajo, plegado, "Avanzado": URLs, ids de modelo, sidecars, personalidad, atajos, skills.
// Todo escribe en el MISMO formulario y se guarda con un solo botón (POST /settings, en
// caliente). Un campo en blanco = conservar; la key nunca vuelve del backend (hasApiKey).
import { useEffect, useRef, useState } from 'react';
import { useHannahStore, WATCH_TERMINAL } from '../store/hannahStore.js';
import { API_BASE, apiFetch } from '../lib/api.js';
import { watchLook } from './WatchPill.jsx';

// Proveedores en la nube (OpenAI-compatible). El modelo es el "bueno y barato" de cada uno;
// se puede afinar en Avanzado.
const CLOUD = [
    { id: 'anthropic', label: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1/', model: 'claude-haiku-4-5-20251001', keys: 'https://console.anthropic.com' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keys: 'https://platform.openai.com/api-keys' },
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', keys: 'https://console.groq.com/keys' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct', keys: 'https://openrouter.ai/keys' },
];
const LOCAL = { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' };
const isLocalUrl = (u) => /localhost|127\.0\.0\.1|:11434/.test(u || '');
const cloudOf = (u) => CLOUD.find((c) => (u || '').startsWith(c.baseUrl.replace(/\/$/, '')));

// Presets del modo avanzado (mismo dato, otra vista).
const LLM_PRESETS = [{ label: 'Ollama (local)', ...LOCAL }, ...CLOUD.map((c) => ({ label: c.label, baseUrl: c.baseUrl, model: c.model }))];

// Definición de campos por sección (mismo whitelist que el backend). Es la vista "Avanzado".
const SECTIONS = [
    {
        key: 'llm', title: 'Modelo de lenguaje (cerebro)',
        fields: [
            { name: 'baseUrl', label: 'Base URL', type: 'text', ph: 'https://…/v1  (vacío = conservar)' },
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
        key: 'agent', title: 'Manos (agente de tareas)',
        // La API key es SENSIBLE: campo password, nunca se muestra, y el backend solo devuelve
        // si hay una guardada (hasApiKey). Dejarla en blanco = conservar la actual.
        fields: [
            { name: 'apiKey', label: 'API key (Anthropic u OpenRouter)', type: 'password' },
            { name: 'mode', label: 'Permisos', type: 'text', ph: 'companion | trusted-project | paranoid' },
            { name: 'url', label: 'URL del agente', type: 'text', ph: 'http://127.0.0.1:8006' },
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
        // Por encima del dock y la píldora del HUD (31/32): si no, los iconos tapan los campos.
        position: 'fixed', inset: 0, zIndex: 40, pointerEvents: 'auto',
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
    // Vista simple
    card: {
        marginTop: '14px', padding: '14px', borderRadius: '12px',
        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
    },
    cardTitle: { fontFamily: "'Syne', sans-serif", fontSize: '13px', color: 'rgba(255,255,255,0.9)', marginBottom: '2px' },
    hint: { fontSize: '10px', color: 'rgba(255,255,255,0.42)', lineHeight: 1.45 },
    seg: { display: 'flex', gap: '6px', marginTop: '10px' },
    segBtn: (on) => ({
        flex: 1, padding: '8px 6px', borderRadius: '9px', cursor: 'pointer', fontSize: '11px',
        fontFamily: "'DM Mono', monospace",
        background: on ? 'rgba(122,184,232,0.18)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${on ? 'rgba(122,184,232,0.55)' : 'rgba(255,255,255,0.12)'}`,
        color: on ? '#bcdcf5' : 'rgba(255,255,255,0.6)',
    }),
    small: { ...{}, fontSize: '10px', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer',
        background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.8)', fontFamily: "'DM Mono', monospace" },
    dot: (ok) => ({ display: 'inline-block', width: '7px', height: '7px', borderRadius: '50%', marginRight: '6px', background: ok ? '#4ade80' : '#f87171' }),
};

// ── Voces Kokoro: el prefijo de la voz define el idioma (e=español, a=inglés US, …) y el 2º
// carácter el género (f/m); el resto es el nombre. `ef_dora` -> Español · Dora ♀.
const LANG_BY_PREFIX = { e: 'Español', a: 'Inglés (US)', b: 'Inglés (UK)', f: 'Francés', i: 'Italiano', p: 'Portugués', j: 'Japonés', z: 'Chino', h: 'Hindi' };
const LANG_ORDER = ['e', 'a', 'b', 'f', 'i', 'p', 'j', 'z', 'h'];   // Español primero
const FALLBACK_VOICES = ['ef_dora', 'em_alex', 'em_santa', 'af_heart', 'af_bella', 'am_adam', 'bf_emma', 'bm_george'];
const voiceName = (v) => {
    const raw = (v || '').slice(3) || v;
    const name = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, ' ');
    const g = v?.[1] === 'f' ? ' ♀' : v?.[1] === 'm' ? ' ♂' : '';
    return `${name}${g}`;
};

function useVoices(enabled) {
    const [voices, setVoices] = useState([]);
    useEffect(() => {
        if (!enabled) return;
        apiFetch(`/api/v1/tts/voices`)
            .then((r) => r.json())
            .then((d) => setVoices(d.voices?.length ? d.voices : FALLBACK_VOICES))
            .catch(() => setVoices(FALLBACK_VOICES));
    }, [enabled]);
    return voices;
}

// Botón "Escuchar": pide GET /tts/preview?voice=… y lo reproduce. Un solo audio a la vez.
function ListenButton({ voice }) {
    const [state, setState] = useState('idle');   // idle | loading | playing | error
    const audioRef = useRef(null);
    const play = async () => {
        if (!voice) return;
        audioRef.current?.pause();
        setState('loading');
        try {
            const r = await apiFetch(`/api/v1/tts/preview?voice=${encodeURIComponent(voice)}`);
            if (!r.ok) throw new Error(String(r.status));
            const url = URL.createObjectURL(await r.blob());
            const a = new Audio(url);
            audioRef.current = a;
            a.onended = () => { setState('idle'); URL.revokeObjectURL(url); };
            a.onerror = () => setState('error');
            await a.play();
            setState('playing');
        } catch { setState('error'); }
    };
    useEffect(() => () => audioRef.current?.pause(), []);
    const label = { idle: '▶ Escuchar', loading: '…', playing: '♪ sonando', error: 'sin voz (¿sidecar?)' }[state];
    return <button style={{ ...S.small, flexShrink: 0 }} onClick={play} disabled={state === 'loading'}>{label}</button>;
}

// ── Tarjeta CEREBRO. Escribe llm.baseUrl / llm.model / llm.apiKey en el formulario común.
function BrainCard({ form, saved, setField }) {
    const url = form.llm?.baseUrl ?? '';
    const local = !url || isLocalUrl(url);
    const cloud = cloudOf(url);
    const hasKey = saved.llm?.hasApiKey;
    const choose = (c) => { setField('llm', 'baseUrl', c.baseUrl); setField('llm', 'model', c.model); };
    return (
        <div style={S.card}>
            <div style={S.cardTitle}>Cerebro</div>
            <div style={S.hint}>Quién piensa por Hannah.</div>
            <div style={S.seg}>
                <button style={S.segBtn(local)} onClick={() => choose(LOCAL)}>En mi PC</button>
                <button style={S.segBtn(!local)} onClick={() => choose(cloud || CLOUD[0])}>En la nube</button>
            </div>
            {local ? (
                <div style={{ ...S.hint, marginTop: '8px' }}>Gratis y privado: nada sale de tu máquina. Usa el modelo que instaló el instalador ({form.llm?.model || LOCAL.model}).</div>
            ) : (
                <div>
                    <label style={S.label}>Proveedor</label>
                    <select style={S.input} value={cloud?.id || ''} onChange={(e) => choose(CLOUD.find((c) => c.id === e.target.value) || CLOUD[0])}>
                        {!cloud && <option value="">Otro (ver Avanzado)</option>}
                        {CLOUD.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <label style={S.label}>API key {cloud && <a href={cloud.keys} target="_blank" rel="noreferrer" style={{ color: '#7ab8e8' }}>(dónde conseguirla)</a>}</label>
                    <input style={S.input} type="password" value={form.llm?.apiKey ?? ''}
                        placeholder={hasKey ? '•••••• (guardada)' : 'pega tu key'}
                        onChange={(e) => setField('llm', 'apiKey', e.target.value)} />
                    <div style={{ ...S.hint, marginTop: '6px' }}>Más listo, pero lo que le digas viaja al proveedor. La key se guarda en tu PC y nunca se muestra.</div>
                </div>
            )}
        </div>
    );
}

// ── Tarjeta VOZ. Idioma + voz (Kokoro) con nombre humano y "Escuchar". ElevenLabs se
// configura en Avanzado; aquí solo se avisa.
function VoiceCard({ form, setField }) {
    const provider = form.tts?.provider || 'kokoro';
    const voices = useVoices(provider !== 'elevenlabs');
    const current = form.tts?.voiceId || '';
    const list = (current && !voices.includes(current)) ? [current, ...voices] : voices;
    const groups = {};
    for (const v of list) (groups[v[0]] ||= []).push(v);
    const langs = [...LANG_ORDER.filter((p) => groups[p]), ...Object.keys(groups).filter((p) => !LANG_ORDER.includes(p))];
    const [lang, setLang] = useState(current?.[0] || 'e');
    useEffect(() => { if (current?.[0] && current[0] !== lang) setLang(current[0]); /* eslint-disable-line */ }, [current]);
    const pickLang = (p) => { setLang(p); if (groups[p]?.length && current?.[0] !== p) setField('tts', 'voiceId', groups[p][0]); };

    return (
        <div style={S.card}>
            <div style={S.cardTitle}>Voz</div>
            <div style={S.hint}>Cómo suena. El idioma de la voz es el idioma en que habla.</div>
            {provider === 'elevenlabs' ? (
                <div style={{ ...S.hint, marginTop: '8px' }}>Usando ElevenLabs (nube). La voz se elige en Avanzado.</div>
            ) : (
                <div>
                    <label style={S.label}>Idioma</label>
                    <select style={S.input} value={groups[lang] ? lang : (langs[0] || '')} onChange={(e) => pickLang(e.target.value)}>
                        {langs.map((p) => <option key={p} value={p}>{LANG_BY_PREFIX[p] || p.toUpperCase()}</option>)}
                    </select>
                    <label style={S.label}>Voz</label>
                    <div style={{ display: 'flex', gap: '6px' }}>
                        <select style={S.input} value={current} onChange={(e) => setField('tts', 'voiceId', e.target.value)}>
                            {(groups[lang] || []).map((v) => <option key={v} value={v}>{voiceName(v)}</option>)}
                        </select>
                        <ListenButton voice={current} />
                    </div>
                </div>
            )}
        </div>
    );
}

// ── Tarjeta LOOK. Sube un VRM (.vrm, o .glb con la extensión VRM) al backend
// (PUT /api/v1/avatar) y recarga el avatar sin reiniciar; "de fábrica" lo borra.
function LookCard() {
    const [info, setInfo] = useState(null);      // { custom, name, size } desde el backend
    const [status, setStatus] = useState('');
    const setAvatarUrl = useHannahStore((s) => s.setAvatarUrl);
    const avatarError = useHannahStore((s) => s.avatarError);
    const load = () => apiFetch(`/api/v1/avatar/info`).then((r) => r.json()).then(setInfo).catch(() => setInfo({ custom: false }));
    useEffect(() => { load(); }, []);

    const reload = async () => {
        const r = await apiFetch(`/api/v1/avatar`, { method: 'HEAD' }).catch(() => null);
        setAvatarUrl(r?.ok ? `${API_BASE}/api/v1/avatar?v=${encodeURIComponent(r.headers.get('etag') || Date.now())}` : '/avatar.glb');
    };
    const upload = async (file) => {
        if (!file) return;
        setStatus(`subiendo ${file.name}…`);
        try {
            const r = await apiFetch(`/api/v1/avatar`, { method: 'PUT', body: file, headers: { 'Content-Type': 'application/octet-stream' } });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setStatus(d.error === 'not_a_vrm' ? 'ese archivo no es un VRM (.vrm, o .glb con extensión VRM)' : `error (${r.status})`); return; }
            setStatus('listo ✓'); await load(); await reload();
        } catch { setStatus('backend no disponible'); }
    };
    const reset = async () => {
        setStatus('volviendo al de fábrica…');
        try { await apiFetch(`/api/v1/avatar`, { method: 'DELETE' }); setStatus(''); await load(); await reload(); }
        catch { setStatus('backend no disponible'); }
    };
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    return (
        <div style={S.card}>
            <div style={S.cardTitle}>Look</div>
            <div style={S.hint}>Cómo se ve. Cualquier avatar VRM (VRoid Studio, VRM 1.0): un archivo .vrm, o .glb con la extensión VRM.</div>
            <div style={{ ...S.hint, marginTop: '8px', color: 'rgba(255,255,255,0.7)' }}>
                {info == null ? 'Actual: …'
                    : info.custom ? `Actual: ${info.name || 'avatar subido'} (${mb(info.size)})`
                        : 'Actual: el de fábrica (Anna)'}
                {avatarError === 'not_a_vrm' && <span style={{ color: '#f87171' }}> · el archivo cargado no es un VRM</span>}
            </div>
            <div style={{ display: 'flex', gap: '6px', marginTop: '10px', alignItems: 'center' }}>
                <label style={{ ...S.small, cursor: 'pointer' }}>
                    Elegir archivo…
                    <input type="file" accept=".vrm,.glb,model/gltf-binary" style={{ display: 'none' }}
                        onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {info?.custom && <button style={S.small} onClick={reset}>Volver al de fábrica</button>}
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)' }}>{status}</span>
            </div>
            <div style={{ ...S.hint, marginTop: '6px' }}>Se queda en tu PC (data/avatar.vrm). Gestos, cara y pelo funcionan solos: el retarget se calcula al cargar.</div>
        </div>
    );
}

// ── Tarjeta MANOS. El agente se enciende desde el launcher (AGENT_ENABLED); aquí se ve si
// está y se le da su key. Una línea de privacidad, porque su modelo es remoto.
function HandsCard({ form, saved, setField, health }) {
    const agent = health?.agent;
    const hasKey = saved.agent?.hasApiKey;
    return (
        <div style={S.card}>
            <div style={S.cardTitle}>Manos</div>
            <div style={S.hint}>Un agente que hace tareas en tu PC (ordenar carpetas, buscar archivos…) y te pide permiso antes de tocar nada.</div>
            <div style={{ ...S.hint, marginTop: '8px', color: 'rgba(255,255,255,0.7)' }}>
                {agent == null ? 'Estado: …'
                    : !agent.enabled ? <span><span style={S.dot(false)} />Apagadas. Se encienden con <code>AGENT_ENABLED=true</code> (instalador/launcher).</span>
                        : agent.healthy ? <span><span style={S.dot(true)} />Encendidas y listas{hasKey ? '' : ' — falta la key'}.</span>
                            : <span><span style={S.dot(false)} />Encendidas pero no responden (¿arrancó el agente?).</span>}
            </div>
            <label style={S.label}>API key (Anthropic u OpenRouter)</label>
            <input style={S.input} type="password" value={form.agent?.apiKey ?? ''}
                placeholder={hasKey ? '•••••• (guardada)' : 'pega tu key'}
                onChange={(e) => setField('agent', 'apiKey', e.target.value)} />
            <div style={{ ...S.hint, marginTop: '6px' }}>Lo que toque una tarea (nombres de archivos, salidas de comandos) viaja al proveedor de esa key. Cuesta centavos por tarea.</div>
        </div>
    );
}

// ── Vigilancia (watches). La pregunta que contesta es "¿sigue mirando?", así que muestra el
// peldaño que armó y la antigüedad de la ÚLTIMA MUESTRA: sin ese dato, un watch ciego y uno
// armado se leen igual. El aspecto lo comparte con la píldora del HUD (watchLook) justo para que
// "ciega" no signifique dos cosas distintas en dos pantallas.
//
// De dónde salen las filas: del store, que las recibe por el WebSocket (al attachear, el backend
// manda un watch_armed y un watch_state por cada vigilancia viva). NO se pide GET
// /api/v1/watches: ese plano de control contesta 403 a cualquier petición con cabecera Origin
// ("The watch control plane does not serve browsers", backend/src/api/auth.js) y 401 sin token de
// la UI, que es el flujo normal en navegador. Desde esta pantalla fallaba siempre, y su catch era
// justo lo que pintaba "Nada vigilado ahora mismo": la pantalla afirmando que no vigila nada
// cuando lo único que sabía era que no había podido preguntar.
//
// La vista va separada del contenedor porque el contenedor lee el store, y en los tests (sin DOM)
// zustand sirve `getInitialState`: un componente suscrito no se puede poner en un estado concreto
// desde fuera. Con la vista pura, la regla de abajo sí se puede afirmar.
export function WatchesView({ watches, connected, health, onDisarm, now }) {
    const ago = (ts) => {
        if (!ts) return 'sin muestra todavía';
        const s = Math.max(0, Math.round((now - ts) / 1000));
        return s < 90 ? `hace ${s}s` : `hace ${Math.round(s / 60)} min`;
    };
    // DOS EJES, no uno. «No hay nada vigilado» solo se puede afirmar sabiendo las dos cosas: que
    // este HUD está attacheado (el socket es el único camino de la lista) Y que el backend pudo
    // preguntarle al sidecar. Lo segundo lo dice GET /api/v1/health en `watches.error`
    // ('sense_unavailable' cuando :8007 está caído o apagado), y esta vista lo tiraba: con el
    // sidecar caído y dos vigilancias guardadas al otro lado, la pantalla escribía «Nada vigilado
    // ahora mismo» sabiendo únicamente que no había podido preguntar. Un error y un vacío son
    // cosas distintas, y esta sección existe por esa diferencia.
    const w = health?.watches;
    // `health === null` es «todavía no contestó»: ni afirma ni desmiente, no dice ninguna de las
    // dos frases. `{}` es el catch del fetch de /health (backend no disponible), y eso sí se sabe.
    const answered = health != null;
    const canAsk = Boolean(w) && !w.error;
    const cannotAsk = answered && !canAsk;
    const summary = canAsk ? `${w.armed ?? 0} armadas · ${w.blind ?? 0} ciegas · ${w.suspended ?? 0} suspendidas`
        : (cannotAsk ? 'sin respuesta' : '');

    const chip = { fontSize: '8px', padding: '1px 5px', borderRadius: '6px', marginLeft: '6px' };
    const delBtn = { flexShrink: 0, width: '26px', height: '26px', borderRadius: '7px', cursor: 'pointer',
        background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171', fontSize: '13px' };

    return (
        <div style={S.sec}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={S.secTitle}>Vigilancia (lo que está mirando)</div>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)' }}>{summary}</span>
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>
                Una fila que no dice «armed» es una que NO está mirando.
            </div>
            {/* "No vigilo nada" y "no lo sé" son dos frases distintas y aquí no pueden colapsar en
                una. La lista solo es la respuesta del servidor mientras el socket está attacheado;
                con el socket caído es una caché del último momento en que lo estuvo, y decir
                "nada vigilado" con una vigilancia armada al otro lado es el fallo que este feature
                existe para no cometer. */}
            {!connected && (
                <div style={{ ...S.hint, marginTop: '6px', color: '#f5c842' }}>
                    {watches.length
                        ? 'Sin conexión con el backend: esto es lo último que se supo, no lo que está pasando.'
                        : 'Sin conexión con el backend: no sé qué está vigilando ahora mismo.'}
                </div>
            )}
            {/* El otro eje: el socket está bien, pero el backend no pudo preguntarle a los ojos. */}
            {connected && cannotAsk && (
                <div style={{ ...S.hint, marginTop: '6px', color: '#f5c842' }}>
                    {`Sin respuesta de los ojos (${w?.error || 'el backend no contestó'}): `}
                    {watches.length
                        ? 'esto es lo último que se supo, no lo que está pasando.'
                        : 'no sé qué está vigilando ahora mismo.'}
                </div>
            )}
            {connected && canAsk && !watches.length && (
                <div style={{ ...S.hint, marginTop: '6px' }}>Nada vigilado ahora mismo.</div>
            )}
            {watches.map((row) => {
                const look = watchLook(row.state);
                return (
                    <div key={row.watchId} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.8)' }}>
                                <span style={{ color: look.color, marginRight: '5px' }}>{look.icon}</span>
                                {/* La etiqueta es texto libre que dictó una persona, y el backend
                                    solo se la manda a la sesión que armó (senseBridge: armedMsg).
                                    La fila igual se pinta: ocupa un cupo de SENSE_MAX_WATCHES y
                                    explica por qué ella habló sola. Callarla entera sería mentir
                                    por omisión hacia el otro lado. */}
                                {row.mine === false && !row.label
                                    ? <span title="La armó otra conversación: se ve la fila, no las palabras que dictó."
                                        style={{ fontStyle: 'italic', color: 'rgba(255,255,255,0.45)' }}>vigilancia de otra sesión</span>
                                    : row.label}
                                <span style={{ ...chip, background: 'rgba(255,255,255,0.06)', color: look.color }}>{row.state}</span>
                                {row.rung && <span style={{ ...chip, background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.45)' }}>{row.rung}</span>}
                            </div>
                            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {ago(row.lastSampleAt)}
                                {row.sensorKind ? ` · ${row.sensorKind}` : ''}
                                {row.fires > 0 ? ` · saltó ${row.fires} ${row.fires === 1 ? 'vez' : 'veces'}` : ''}
                            </div>
                        </div>
                        {/* Terminal = ya no hay nada que desarmar; el botón se va en vez de mandar
                            una orden que el servidor contestaría con un 404. */}
                        {!WATCH_TERMINAL.includes(row.state) && (
                            <button style={delBtn} onClick={() => onDisarm?.(row.watchId)} title="Dejar de vigilar">✕</button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

// El contenedor. Se suscribe con selectores atómicos (`s.watches`, `s.connected`) para que una
// muestra cada 15s no re-renderice el formulario entero, y lleva el reloj de la antigüedad: sin
// tick se congela en el instante en que se abrió el panel y "hace 3s" es mentira a los cuatro
// segundos.
function WatchesSection({ health, onDisarm }) {
    const watches = useHannahStore((s) => s.watches);
    const connected = useHannahStore((s) => s.connected);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);

    return <WatchesView watches={watches} connected={connected} health={health} onDisarm={onDisarm} now={now} />;
}

// ── Atajos de voz (abrir apps/páginas). Estado propio: carga GET /shortcuts, edita
// filas clave→valor y guarda POST /shortcuts. Sin tocar la config de proveedores.
function ShortcutsSection() {
    const [sites, setSites] = useState([]);   // [[clave, dominio], ...]
    const [apps, setApps] = useState([]);      // [[clave, appKey], ...]
    const [status, setStatus] = useState('cargando…');

    useEffect(() => {
        apiFetch(`/api/v1/shortcuts`)
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
            const r = await apiFetch(`/api/v1/shortcuts`, {
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

// ── Skills (estilo Claude Code): lista las skills y edita el SKILL.md crudo. Model-agnóstico:
// el modelo lee el índice y decide; el backend ejecuta. GET/POST/DELETE /api/v1/skills.
const NEW_SKILL_TPL = `---
name: mi-skill
description: qué hace, en una línea
run: echo hola {arg}
phrases: ["frase que la dispara"]
---
Cuándo usarla y un ejemplo (esto lo lee el modelo).
`;

function SkillsSection() {
    const [skills, setSkills] = useState([]);
    const [editing, setEditing] = useState(null);   // null | { name, content, isNew }
    const [status, setStatus] = useState('cargando…');

    const load = () => apiFetch(`/api/v1/skills`).then((r) => r.json())
        .then((d) => { setSkills(d.skills || []); setStatus(''); })
        .catch(() => setStatus('backend no disponible'));
    useEffect(() => { load(); }, []);

    const save = async () => {
        const name = (editing.name || '').trim();
        if (!name || !editing.content.trim()) { setStatus('faltan nombre/contenido'); return; }
        setStatus('guardando…');
        try {
            await apiFetch(`/api/v1/skills`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, content: editing.content }),
            });
            setEditing(null); setStatus('guardado ✓'); load();
        } catch { setStatus('error al guardar'); }
    };
    const del = async (name) => {
        setStatus('borrando…');
        try { await apiFetch(`/api/v1/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }); setStatus(''); load(); }
        catch { setStatus('error al borrar'); }
    };

    const chip = { fontSize: '8px', padding: '1px 5px', borderRadius: '6px', marginLeft: '6px' };
    const smallBtn = { ...S.preset, marginTop: 0, marginRight: '4px', padding: '2px 7px' };

    if (editing) {
        return (
            <div style={S.sec}>
                <div style={S.secTitle}>{editing.isNew ? 'Nueva skill' : `Editar: ${editing.name}`}</div>
                {editing.isNew && (
                    <input style={{ ...S.input, marginBottom: '6px' }} placeholder="nombre (ej. deploy)"
                        value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                )}
                <textarea
                    style={{ ...S.input, minHeight: '180px', resize: 'vertical', lineHeight: 1.4, whiteSpace: 'pre', fontSize: '11px' }}
                    value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} />
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                    <button style={S.save} onClick={save}>Guardar skill</button>
                    <button style={S.close} onClick={() => setEditing(null)}>Cancelar</button>
                </div>
            </div>
        );
    }

    return (
        <div style={S.sec}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={S.secTitle}>Skills (capacidades)</div>
                <span style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)' }}>{status}</span>
            </div>
            <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.35)', marginBottom: '6px' }}>
                Habilidades que Hannah puede usar (cualquier modelo). El backend las ejecuta.
            </div>
            {skills.map((s) => (
                <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '11px', color: 'rgba(255,255,255,0.8)' }}>
                            {s.name}
                            <span style={{ ...chip, background: s.source === 'user' ? 'rgba(110,231,183,0.15)' : 'rgba(255,255,255,0.08)', color: s.source === 'user' ? '#6ee7b7' : 'rgba(255,255,255,0.4)' }}>
                                {s.source === 'user' ? 'tuya' : 'incluida'}
                            </span>
                        </div>
                        <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description || s.action}</div>
                    </div>
                    <button style={smallBtn} onClick={() => setEditing({ name: s.name, content: s.content, isNew: false })}>✎</button>
                    <button style={{ ...smallBtn, background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.3)', color: '#f87171' }} onClick={() => del(s.name)}>✕</button>
                </div>
            ))}
            <button style={{ ...S.preset, marginTop: '10px', display: 'inline-block' }}
                onClick={() => setEditing({ name: '', content: NEW_SKILL_TPL, isNew: true })}>+ nueva skill</button>
        </div>
    );
}

// ── Vista AVANZADO: las cuatro secciones crudas (mismo formulario que las tarjetas).
function AdvancedSections({ form, saved, setField, applyPreset }) {
    return SECTIONS.map((s) => (
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
    ));
}

export function SettingsPanel({ onClose, onWatchDisarm }) {
    const autoLookat = useHannahStore((s) => s.autoLookat);
    const setAutoLookat = useHannahStore((s) => s.setAutoLookat);
    const [form, setForm] = useState(Object.fromEntries(SECTIONS.map((s) => [s.key, {}])));
    const [saved, setSaved] = useState({});   // { llm:{hasApiKey}, ... } desde el backend
    const [health, setHealth] = useState(null);
    const [status, setStatus] = useState('cargando…');
    const [advanced, setAdvanced] = useState(false);

    useEffect(() => {
        apiFetch(`/api/v1/settings`)
            .then((r) => r.json())
            .then((d) => {
                // apiKey/token se dejan vacíos en el form; hasApiKey/hasToken guían el placeholder.
                // Las secciones salen de SECTIONS: una sección nueva sin su entrada aquí hacía
                // fallar la carga entera y el formulario se guardaba vacío (borrando el cerebro).
                const f = Object.fromEntries(SECTIONS.map((s) => [s.key, {}]));
                for (const s of SECTIONS) for (const key in (d[s.key] || {})) {
                    if (key === 'hasApiKey' || key === 'hasToken') continue;
                    f[s.key][key] = d[s.key][key] ?? '';
                }
                setForm(f);
                setSaved(d);
                setStatus('');
            })
            .catch(() => setStatus('backend no disponible'));
        apiFetch(`/api/v1/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth({}));
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
            const r = await apiFetch(`/api/v1/settings`, {
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

                <BrainCard form={form} saved={saved} setField={setField} />
                <VoiceCard form={form} setField={setField} />
                <LookCard />
                <HandsCard form={form} saved={saved} setField={setField} health={health} />
                <WatchesSection health={health} onDisarm={onWatchDisarm} />

                <div style={S.row}>
                    <button style={S.save} onClick={save}>Guardar</button>
                    <button style={S.close} onClick={onClose}>Cerrar</button>
                </div>

                {/* Avanzado: plegado. Mismo formulario, mismo botón Guardar. */}
                <button style={{ ...S.small, width: '100%', marginTop: '26px', textAlign: 'left' }} onClick={() => setAdvanced((v) => !v)}>
                    {advanced ? '▾' : '▸'} Avanzado <span style={{ opacity: 0.5 }}>— modelos, URLs, personalidad, atajos, skills</span>
                </button>
                {advanced && (
                    <div>
                        <AdvancedSections form={form} saved={saved} setField={setField} applyPreset={applyPreset} />
                        <ShortcutsSection />
                        <SkillsSection />
                        <div style={S.sec}>
                            <div style={S.secTitle}>Avatar</div>
                            <label style={{ ...S.label, display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                                <input type="checkbox" checked={autoLookat} onChange={(e) => setAutoLookat(e.target.checked)} />
                                Seguir a la cámara con la mirada (auto-lookat)
                            </label>
                        </div>
                        <div style={S.row}>
                            <button style={S.save} onClick={save}>Guardar</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
