// src/pipeline/llm.js
import { OpenAI } from 'openai';
import { config } from '../config.js';
import { memoryStore } from '../state/memoryStore.js';
import { embed, cosine } from '../state/embeddings.js';
import { runTool, WATCH_SENSORS, armableWatchSensors } from './tools.js';
import * as senseClient from './senseClient.js';
import { skillsPromptSection, resolveSkill } from '../state/skills.js';
import { isHealthy as agentHealthy, handsStatus, dispatch as dispatchTask } from './agentBridge.js';
import { referencePromptSection } from '../state/reference.js';
import { startTimer } from '../utils/timer.js';
import { logger } from '../utils/logger.js';

// Recall vectorial: embebe el último mensaje del usuario, busca por coseno en la
// memoria y devuelve los fragmentos OLD relevantes (los que NO están ya en la ventana).
async function recallContext(history) {
    if (!config.memory.recallEnabled) return '';
    const lastUser = [...history].reverse().find((t) => t.role === 'user');
    if (!lastUser?.content) return '';
    const q = await embed(lastUser.content);
    if (!q) return '';
    const inWindow = new Set(history.map((t) => t.content));
    const scored = memoryStore.embeddings(2000)
        .filter((r) => !inWindow.has(r.text))
        .map((r) => ({ text: r.text, s: cosine(q, r.vec) }))
        .filter((r) => r.s > 0.55)
        .sort((a, b) => b.s - a.s)
        .slice(0, config.memory.recallK);
    return scored.length ? scored.map((r) => `- ${r.text}`).join('\n') : '';
}

// Cliente OpenAI-compatible (Groq, Ollama, OpenRouter, OpenAI…) construido bajo
// demanda y memoizado. Se reconstruye SOLO si cambian apiKey o baseUrl en runtime
// (vía POST /settings), así el usuario puede cambiar de proveedor sin reiniciar.
let _client = null;
let _clientKey = '';
const getLlmClient = () => {
    const key = `${config.llm.apiKey}|${config.llm.baseUrl}`;
    if (!_client || key !== _clientKey) {
        _client = new OpenAI({
            apiKey: config.llm.apiKey || 'not-needed', // Ollama/local ignoran la key
            baseURL: config.llm.baseUrl || undefined,
        });
        _clientKey = key;
    }
    return _client;
};

// System prompt = persona + memoria (resumen + recall vectorial) + protocolo.
// Exportado como helper puro para tests (qué entra al prompt y cuándo); el resto del módulo no cambia.
export async function buildSystemPrompt(history, withActions, noActions = false) {
    const summary = memoryStore.getSummary();
    const recalled = await recallContext(history);
    let memorySection = '';
    if (summary) memorySection += `\n\n[What you remember about the user and past conversations]\n${summary}`;
    if (recalled) memorySection += `\n\n[Relevant things from earlier conversations]\n${recalled}`;
    // Los cheat-sheets enseñan a escribir [RUN:]: solo entran cuando [RUN:] está permitido.
    const skillsSection = withActions ? skillsPromptSection() + (runAllowed() ? referencePromptSection() : '') : '';
    // Las "manos" entran en el prompt SOLO si el agente está encendido y sano: sin eso el
    // modelo no ve [TASK:] y no puede emitirlo. Mismo criterio que el índice de skills: tras
    // una acción determinista tampoco se ofrece, para no repetir la acción.
    // Las manos NO dependen de TOOLS_ENABLED (son otro sistema, con su propia seguridad); sí
    // se omiten tras una acción determinista (noActions), para no repetir la acción.
    const handsOn = !noActions && config.agent.enabled && agentHealthy();
    const run = runAllowed();
    // Política de comandos libres (config.tools.runPolicy): con [RUN:] permitido el modelo ve
    // la sección RUN y, si hay manos, la frontera RUN/TASK; sin [RUN:] permitido, las manos son
    // la ÚNICA vía para un comando que no sea skill (o, sin manos, no hay vía y se le dice).
    const runSection = withActions && run ? config.llm.runProtocol : '';
    const hands = handsOn ? (run ? TASK_PROTOCOL : TASK_ONLY_PROTOCOL) : (withActions && !run ? NO_RUN_PROTOCOL : '');
    const protocol = config.llm.protocol.replace('{{RUN_PROTOCOL}}', runSection);
    // Las vigilancias entran con el MISMO criterio que las manos (encendidas y con algo que
    // ofrecer), y su vocabulario se arma acá, con la sonda viva: el turno de narración no lo ve,
    // y un escalón que esta máquina no tiene no se nombra. El [WATCH STATUS], en cambio, va
    // siempre — como handsStatus() —, porque preguntar "¿cómo va?" es narración, no acción.
    const watch = !noActions && config.sense.enabled ? await watchProtocolSection() : '';
    return `${config.llm.persona}${memorySection}\n\n${protocol}${skillsSection}${hands}${watch}${handsStatus()}${await watchStatus()}`;
}

/**
 * Streaming wrapper. `ctx` (p.ej. { sessionId }) se pasa a las tools que lo necesitan.
 */
export const generateDialogueStream = async (history, onToken, onComplete, signal, ctx = {}) => {
    const timer = startTimer();
    try {
        // Si una acción determinista ya corrió (ctx.noActions), el LLM SOLO narra el
        // resultado: sin loop de tags (evita doble ejecución, p.ej. ssh dos veces) y sin
        // índice de skills en el prompt (no lo tienta a re-actuar).
        const useActions = config.tools.enabled && !ctx.noActions;
        // Con manos, la respuesta también pasa por la vía NO streaming aunque las tools estén
        // apagadas: hay que ver la respuesta entera para poder descartar la prosa que rodea a
        // un [TASK:] (ver keepOnlyTask) antes de que una sola sílaba llegue al TTS.
        const handsOn = !ctx.noActions && config.agent.enabled && agentHealthy();
        const systemPrompt = await buildSystemPrompt(history, useActions, !!ctx.noActions);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map((turn) => ({
                role: turn.role === 'assistant' ? 'assistant' : 'user',
                content: turn.content,
            })),
        ];
        const text = (useActions || handsOn)
            ? await generateWithActions(messages, onToken, signal, ctx)
            : await streamAnswer(messages, onToken, signal);
        if (text === null) return;   // abortado (barge-in)
        finalizeLlmTurn(text, timer.stop(), onComplete);
    } catch (error) {
        if (signal?.aborted || error.name === 'APIUserAbortError' || error.name === 'AbortError') {
            logger.info('LLM stream abortado (barge-in)');
            return;
        }
        logger.error('OpenAI-compatible stream engine runtime error', { message: error.message });
        if (onComplete) onComplete({ error: 'llm_failed', message: error.message });
    }
};

// Streamea una respuesta (sin tools) por la ruta token→onToken. Devuelve el texto
// acumulado, o null si se abortó (barge-in).
async function streamAnswer(messages, onToken, signal) {
    const stream = await getLlmClient().chat.completions.create(
        { model: config.llm.model, messages, max_tokens: 400, stream: true }, { signal });
    let content = '';
    for await (const chunk of stream) {
        if (signal?.aborted) return null;
        const tok = chunk.choices[0]?.delta?.content || '';
        if (tok) { content += tok; if (onToken) onToken(tok); }
    }
    return content;
}

// Acciones por TAGS (determinista, fiable en modelos locales — no depende del
// function-calling que los 7B/8B hacen a medias): el modelo emite un tag de acción,
// el backend lo ejecuta y le realimenta el resultado. Ver el protocolo en config.js.
// La frontera entre las dos formas de actuar. Sin esta frase escrita, un 7B elige el tag que
// vio más recientemente (hannah-agent/docs/COEXISTENCE.md). Solo entra al prompt con el agente
// sano (ver buildSystemPrompt).
/**
 * Si la respuesta delega con [TASK:], se queda SOLO el tag. Un 7B, al delegar, suele
 * "responder" igual: inventa cifras y nombres de archivo ("your Documents folder has 24
 * files, the biggest is report2023.docx") y recién al final pone el tag. Esa prosa no puede
 * llegar a la voz: la única verdad sobre la tarea son los eventos de las manos, y el puente
 * ya narra "acabo de tomar la tarea" cuando el agente la acepta — ese es el "voy". Se lleva
 * también cualquier otro tag colado en la misma respuesta ([MOVE:] espontáneos incluidos).
 * Puro; exportado para tests.
 */
export const HANDS_LABEL_RE = /[[(*]\s*YOUR HANDS\s*[\])*]/i;
export function keepOnlyTask(text) {
    const m = String(text || '').match(/[[(*]\s*TASK:\s*[^\])*\n]+?\s*[\])*]/i);
    // Sin [TASK:] pero con "[YOUR HANDS]" escrito: el 7B quiso delegar y copió la etiqueta de los
    // eventos (pasa con "use your hands"). Se deja SOLO la etiqueta: el orquestador despacha las
    // palabras del usuario como tarea y la prosa ("Creating the file…") no llega a la voz.
    if (!m) return HANDS_LABEL_RE.test(text || '') ? '[YOUR HANDS]' : text;
    if (m[0].length < text.trim().length) logger.info('reply prose dropped around [TASK:]', { dropped: text.length - m[0].length });
    return m[0];
}

/**
 * ¿Puede el modelo ejecutar un comando libre ([RUN:]) en el pty del backend AHORA?
 *   free        -> sí.
 *   agent-first -> solo si las manos no están (apagadas o caídas): si están, van al agente.
 *   skills-only -> nunca.
 * Las skills, la capa determinista y la terminal del usuario no pasan por acá.
 */
export function runAllowed() {
    const policy = config.tools.runPolicy;
    if (policy === 'skills-only') return false;
    if (policy === 'agent-first') return !(config.agent.enabled && agentHealthy());
    return true;
}

/**
 * Un [RUN:] emitido cuando la política no lo permite. Con manos, se convierte en una tarea
 * (el agente decide el riesgo y pide permiso; la persona narra el resultado); sin manos, se
 * rechaza y el modelo tiene que decírselo al usuario. Devuelve el texto que ve el modelo
 * como resultado de la acción — nunca ejecuta el comando.
 */
export async function handleRunTag(cmd, ctx = {}) {
    const command = String(cmd || '').trim();
    if (!command) return 'refused: empty command';
    if (config.agent.enabled && agentHealthy() && ctx.sessionId) {
        const r = await dispatchTask(ctx.sessionId, `Run this command and report its result: ${command}`,
            { title: `run: ${command.slice(0, 50)}` });
        if (!r.error) {
            return 'handed to your HANDS (under this policy, commands you write yourself go through the agent, which '
                + 'asks the user before anything risky). Tell the user you are on it; do NOT claim a result yet — '
                + 'your hands will report back and you will relay it.';
        }
        return `not run: your hands could not take it (${r.error}). Tell the user you cannot run that right now.`;
    }
    return 'refused: running commands directly is disabled here (only skills and your hands may act). '
        + 'Use a skill if one fits; otherwise tell the user you cannot run that.';
}

// Variantes del protocolo de manos según la política de comandos (ver runAllowed).
const TASK_ONLY_PROTOCOL = `

To act on the computer you have SKILLS ([SKILL: name | input], listed above if any) and your
HANDS: [TASK: imperative description in English] hands a job to a separate agent that runs the
commands, asks the user before anything risky, and reports back. You can NOT run commands
yourself: never write [RUN:]. For ANY request that needs the computer and is not a skill — one
command or many — emit exactly ONE [TASK:] at the very end of your reply, say briefly that you
are on it, and wait. Never claim a task started, progressed or finished unless a [YOUR HANDS]
event told you so. "[YOUR HANDS]" is only the label of the events you RECEIVE about the agent's
progress: never write it yourself. When the user says "use your hands", they mean [TASK:].
Example — user: "use your hands: make a file notes.txt in Documents" → you: "On it. [TASK: create
a file named notes.txt in the Documents folder]".`;

const NO_RUN_PROTOCOL = `

You can NOT run commands on this computer: never write [RUN:]. If a SKILL fits the request use
it; otherwise say plainly that you cannot do that here.`;

const TASK_PROTOCOL = `

You have two ways to act on the computer. [RUN: cmd] runs ONE command whose exact shape you already know (list a folder, open an app, read a file) — it is instant. [TASK: imperative description in English] hands a job to your HANDS, a separate agent, when it needs SEVERAL steps or DECISIONS ("organize my downloads by type", "find the report I edited last week", "free up disk space"). Emit at most ONE [TASK:] per reply, only when the user asked for something actionable on the computer, and place it at the very end. After emitting it, say briefly that you are on it. Your hands will report back and you will relay what they say. Never claim a task started, progressed or finished unless a [YOUR HANDS] event told you so. "[YOUR HANDS]" is only the label of the events you RECEIVE: never write it yourself; "use your hands" means [TASK:].`;

const ACTION_TOOL = {
    run: ['run_command', 'command'], search: ['web_search', 'query'], fetch: ['fetch_url', 'url'],
    browse: ['open_url', 'url'], close: ['close_window', 'target'], weather: ['get_weather', 'location'], look: ['look_now', null],
    time: ['get_datetime', null], open: ['open_app', 'name'],
};
// ÚNICA fuente del vocabulario de tags: de acá salen tanto el parseo (ACTION_RE) como la
// limpieza previa al TTS (stripActionTags, que usa el orchestrator). Antes eran dos regex
// escritas a mano: agregar un tag y olvidar la otra hacía que el TTS lo leyera en voz alta.
// RECALL sigue en la lista de STRIP (la tool ya no existe, pero si el modelo lo emite igual
// no debe llegar al audio).
export const ACTION_TAGS = [...Object.keys(ACTION_TOOL).map((k) => k.toUpperCase()), 'SKILL'];
// TASK no es una acción del bucle síncrono (una tarea dura minutos): la despacha el orquestador
// como [MOTION:]/[MOVE:]. Pero SÍ se stripea: el TTS jamás debe leerla.
// WATCH viaja acá por lo mismo que TASK: la arma el orquestador, no el bucle síncrono, pero el
// TTS jamás debe leerla. 'WATCH STATUS' va ANTES que 'WATCH' porque la alternancia prueba en
// orden y la más larga tiene que ganar.
const STRIP_TAGS = [...ACTION_TAGS, 'RECALL', 'TASK', 'WATCH STATUS', 'WATCH', 'YOUR HANDS', 'HANDS STATUS', 'YOUR EYES'];
const ACTION_RE = new RegExp(`\\[\\s*(${ACTION_TAGS.join('|')})\\b\\s*(?::\\s*([^\\]\\n]*))?\\]`, 'gi');

// GUARDIA DE TAG SIN CERRAR. `max_tokens` es 400: una respuesta cortada a mitad de tag deja
// "[WATCH: pid 1234" o "[SEARCH: how to" SIN delimitador de cierre, y el regex de arriba lo
// EXIGE — así que hasta acá ese resto llegaba al TTS y se oía en voz alta. Anclado a fin de
// línea o de texto (`m`) a propósito: un tag sin cerrar en medio de una frase es texto del
// modelo, no un tag truncado, y borrar desde ahí hasta el final se comería la frase entera.
const UNCLOSED_TAG_RE = new RegExp(`[[(*]\\s*(?:${STRIP_TAGS.join('|')})\\b[^\\])*\\n]*$`, 'gim');

/** Quita los tags de acción del texto hablado (con [ ], ( ) o * * como delimitador). */
export const stripActionTags = (text) => String(text)
    .replace(new RegExp(`[[(*]\\s*(${STRIP_TAGS.join('|')}|YOUR HANDS)\\b\\s*:?[^\\])*\\n]*[\\])*]`, 'gi'), '')
    .replace(UNCLOSED_TAG_RE, '');

// ── VIGILANCIAS: el vocabulario se ARMA, no se escribe (plan VIGILANCE §6 y M5.1.3) ─────
// Encabezado de la sección, exportado porque los tests cortan el prompt por acá: afirmar "no
// hay vocabulario de pantalla" sobre el prompt ENTERO sería falso por culpa de
// [MOVE:next-screen], que no tiene nada que ver con vigilar.
export const WATCH_HEADER = '### WATCHING SOMETHING FOR THE USER';

/**
 * La sección de [WATCH:] del system prompt, construida con la sonda VIVA de capacidades del
 * sidecar. Es la regla del catálogo de macros llevada a la escalera de detección: un escalón
 * que esta máquina no puede muestrear no se le NOMBRA al modelo. Si se lo nombráramos "por
 * completitud", el 7B lo emitiría, POST /v1/watches lo rechazaría — y para entonces Hannah ya
 * dijo que sí. Vacía (sección ausente) si no hay nada armable: no poder vigilar nada se dice
 * callándose el tag, no explicando un tag que no sirve.
 * El vocabulario sale de WATCH_SENSORS (tools.js), que es también quien construye el spec: una
 * sola fuente para lo que se ofrece y lo que se arma.
 */
export async function watchProtocolSection() {
    const armable = armableWatchSensors(await senseClient.survey());
    if (!armable.length) return '';
    const menu = armable.map((s) => `  ${s.usage.padEnd(38)}${s.hint}`).join('\n');
    return `\n\n${WATCH_HEADER}
The user can ask you to keep an eye on something while they are away ("check that my training
doesn't stop", "tell me if the render dies"). Emit exactly ONE [WATCH: kind | argument] at the
very end of your reply, and say in one sentence what you will be looking at. A watch only
LOOKS: it never restarts, fixes or touches anything. Never say you are watching something
unless a [WATCH STATUS] line says you are. These are the ONLY things you can watch:
${menu}
Anything that is not on that list you can NOT watch: say so plainly instead of promising it.`;
}

// Estados y sensores son ENUMS del contrato sense.v1, no texto libre. Se validan contra estas
// listas antes de entrar al prompt: lo que llegue en esos campos y no esté acá es un sidecar
// roto o suplantado, y se dice "unknown" en vez de copiarlo.
const WATCH_STATES = new Set(['armed', 'blind', 'suspended', 'expired', 'disarmed', 'faulted']);
// Perezoso, y no una constante de módulo: agentBridge -> conversationManager -> llm.js -> tools.js
// es un ciclo ESM que ya existía, así que el cuerpo de este módulo puede correr ANTES que el de
// tools.js y WATCH_SENSORS estar en su zona muerta. Al llamarla, ya está.
let watchKinds = null;
const kindEnum = () => (watchKinds ??= new Set([...WATCH_SENSORS.map((s) => s.kind), 'gpu']));
// Las que siguen mirando (o creen mirar). Las terminales son cosa del HUD: el prompt habla de
// lo que está pasando ahora, y veinte filas desarmadas no le dicen nada al modelo.
const WATCH_LIVE = new Set(['armed', 'blind', 'suspended']);
const asEnum = (value, allowed) => (allowed.has(value) ? value : 'unknown');

// ── La ETIQUETA, saneada para el MODELO ────────────────────────────────────────────────
// Una PALABRA de la etiqueta son letras (con acentos y ñ) y dígitos, y nada más. Todo lo otro
// —'/', '~', '@', '.', '-', '_', ':', '|', ';', las comillas invertidas, los corchetes— es
// exactamente el material con el que se escriben una ruta, un host, un flag, una URL o un tag,
// que es lo único que esta línea no puede llevar (plan §10).
const LABEL_WORD = /^[\p{L}\p{N}]{1,24}$/u;
// Puntuación de FRASE, y solo en los extremos del token: el ASR puntúa lo que dicta el usuario
// ("...que no se pare.") y tirar la última palabra de cada oración dejaría la etiqueta
// irreconocible. En los extremos y no adentro, a propósito: '/home/u/.ssh/id_rsa' sigue teniendo
// barras en el medio y se cae entero igual.
const LABEL_EDGE = /^[¿¡"'«(]+|[,.;:!?"'»)…]+$/g;
// Verbos que ACTÚAN: son letras, así que pasan el filtro de arriba, y son lo que hace que la
// línea se lea como un comando en vez de como el nombre de algo. Están los que mandan y no los
// que el usuario dice de verdad al pedir una vigilancia ('python', 'node', 'git' se quedan): sin
// ruta, sin flag y sin separador ninguno de esos dos grupos puede hacer nada, y perder una
// palabra que el usuario sí dijo es justo lo que vuelve irreconocible su etiqueta.
const LABEL_COMMANDS = new Set(['rm', 'rmdir', 'unlink', 'mkfs', 'dd', 'chmod', 'chown', 'chattr',
    'kill', 'killall', 'pkill', 'sudo', 'doas', 'shutdown', 'reboot', 'poweroff', 'halt', 'curl',
    'wget', 'ssh', 'scp', 'nc', 'ncat', 'bash', 'sh', 'zsh', 'eval', 'exec', 'whoami', 'cat',
    'tail', 'head', 'ls', 'mv', 'cp', 'ln', 'systemctl', 'nohup', 'crontab', 'base64', 'xxd']);
const LABEL_MAX_WORDS = 8;
const LABEL_MAX_CHARS = 60;
// Cuando no sobrevive nada. Es la MISMA frase con la que tools.js arma una vigilancia sin
// etiqueta: "no sé cómo se llama esto" ya tenía una forma de decirse y no hacen falta dos.
const LABEL_NONE = 'what you asked me to watch';

/**
 * La etiqueta como la ve el MODELO. `clean()` (el saneador del puente del agente) no alcanza acá
 * y la diferencia es concreta: colapsa los separadores en espacios, así que deja
 * '/home/u/.ssh/id_rsa' como "/home/u/.ssh/id rsa" y una ruta entra igual. Acá se mira el token
 * ENTERO y se tira completo el que no sea una palabra.
 *
 * EL CANJE, dicho: la etiqueta existe para que el usuario RECONOZCA su vigilancia cuando Hannah
 * la nombra, así que romperla no es gratis y lo que se conserva son sus palabras. Lo que se
 * pierde es todo lo que no es una palabra, y con eso una etiqueta nacida de una inyección se
 * queda sin corchetes, sin ruta, sin host, sin flag y sin verbo de comando: no puede abrir un
 * tag, no puede NOMBRAR un archivo ni una máquina, y lo que sobreviva son ocho palabras sueltas
 * entre comillas. Escribir una orden con puras palabras sigue siendo posible; que esa orden
 * apunte a algo, no. Y si no sobrevive ninguna se dice el sustantivo genérico: la vigilancia
 * sigue existiendo y "¿cómo va?" se sigue pudiendo contestar, que es para lo que está la línea.
 * Exportada para tests.
 */
export function watchLabel(raw) {
    const kept = [];
    let chars = 0;
    for (const token of String(raw ?? '').split(/\s+/)) {
        if (kept.length >= LABEL_MAX_WORDS) break;
        const word = token.replace(LABEL_EDGE, '');
        if (!LABEL_WORD.test(word) || LABEL_COMMANDS.has(word.toLowerCase())) continue;
        const grows = word.length + (kept.length ? 1 : 0);
        if (chars + grows > LABEL_MAX_CHARS) break;
        chars += grows;
        kept.push(word);
    }
    return kept.join(' ') || LABEL_NONE;
}

/**
 * El estado de las vigilancias para el system prompt. Hermano de handsStatus() y con su MISMA
 * cláusula final, palabra por palabra: sin ella el 7B, preguntado "¿cómo va el entrenamiento?",
 * inventa una curva de pérdida.
 *
 * Emite SOLO cuatro cosas: la etiqueta (las palabras del usuario, por watchLabel), el NOMBRE del
 * sensor como enum, el estado y los disparos. Ni un valor muestreado, ni una línea de log, ni
 * una ruta, ni un host, ni un comando. La razón es estructural, no estética: esto se anexa al
 * system prompt de CADA turno mientras la vigilancia esté armada, así que cualquier contenido
 * observado que entrara acá sería un punto de inyección permanente durante horas (plan §10,
 * §9 T9) — leído por el modelo justo cuando el usuario no está para desmentirlo.
 *
 * Los tres campos de máquina se validan contra su enum; el cuarto, la ETIQUETA, es el único
 * texto libre que queda, y por eso es el que hay que sanear acá y no confiar en quien lo escribió
 * (el sidecar puede estar suplantado, y la ruta REST acepta la etiqueta que le manden).
 */
export async function watchStatus() {
    const { watches } = await senseClient.watchRows();
    const live = watches.filter((w) => WATCH_LIVE.has(w?.state));
    if (!live.length) return '';
    return '\n\n[WATCH STATUS] ' + live.slice(0, 5).map((w) =>
        `"${watchLabel(w.label)}": ${asEnum(w.state, WATCH_STATES)}, watching ${asEnum(w.sensorKind, kindEnum())}`
        + `, ${Number.isInteger(w.fires) ? w.fires : 0} trips`).join(' | ')
        + '\nIf the user asks how a watch is going, answer from this status only.';
}

function parseActions(text) {
    const acts = []; let m; ACTION_RE.lastIndex = 0;
    while ((m = ACTION_RE.exec(text || ''))) acts.push({ key: m[1].toLowerCase(), arg: (m[2] || '').trim() });
    return acts;
}

async function generateWithActions(messages, onToken, signal, ctx) {
    for (let depth = 0; depth < 3; depth++) {
        // Pasada NO-streaming para poder detectar tags de acción antes de hablar.
        const resp = await getLlmClient().chat.completions.create(
            { model: config.llm.model, messages, max_tokens: 400, stream: false }, { signal });
        if (signal?.aborted) return null;
        const text = keepOnlyTask(resp.choices[0]?.message?.content || '');
        const acts = parseActions(text);
        if (!acts.length) { if (onToken && text) onToken(text); return text; }   // sin acción -> es la respuesta

        // Ejecutar las acciones y realimentar los resultados para la respuesta final.
        const results = [];
        for (const a of acts) {
            // [SKILL: nombre | input] -> resuelve la skill (estilo Claude Code); el backend ejecuta.
            if (a.key === 'skill') {
                const [nm, ...rest] = a.arg.split('|');
                const r = await resolveSkill(nm.trim(), rest.join('|').trim(), ctx);
                results.push(`SKILL ${a.arg} -> ${r ?? `skill "${nm.trim()}" no existe`}`);
                continue;
            }
            // [RUN:] bajo una política que no lo permite: a las manos (o rechazado), nunca al pty.
            if (a.key === 'run' && !runAllowed()) {
                results.push(`RUN ${a.arg} -> ${await handleRunTag(a.arg, ctx)}`);
                continue;
            }
            const [tool, argName] = ACTION_TOOL[a.key] || [];
            if (!tool) continue;
            const r = await runTool(tool, argName ? { [argName]: a.arg } : {}, ctx);
            results.push(`${a.key.toUpperCase()}${a.arg ? ` ${a.arg}` : ''} -> ${r}`);
        }
        messages.push({ role: 'assistant', content: text });
        messages.push({ role: 'user', content: `[resultados de la acción]\n${results.join('\n')}\n\nResponde al usuario AHORA usando estos resultados, breve y natural. NO emitas más tags de acción.` });
    }
    return streamAnswer(messages, onToken, signal);   // profundidad agotada
}

/**
 * Resume la conversación en una memoria de largo plazo concisa (no-streaming).
 * Toma el resumen previo + los turnos nuevos y devuelve la memoria actualizada.
 */
export const summarizeConversation = async (oldSummary, turns) => {
    const convo = turns
        .map((t) => `${t.role === 'assistant' ? 'Hannah' : 'User'}: ${t.content}`)
        .join('\n');
    const sys = 'You maintain a concise long-term memory for the AI avatar Hannah. '
        + 'Update the memory with DURABLE facts about the user (name, preferences, ongoing '
        + 'topics, plans, promises) and key context. Keep it short (max ~1000 chars), third '
        + 'person, terse, drop stale trivia and small talk. '
        + 'NEVER store volatile system/technical state (hostname, IP addresses, disk/memory/CPU '
        + 'numbers, command outputs, file listings, connected servers): those are checked LIVE '
        + 'with skills, not remembered. Output ONLY the updated memory text.';
    const user = `Current memory:\n${oldSummary || '(empty)'}\n\nNew conversation to fold in:\n${convo}`;
    try {
        const res = await getLlmClient().chat.completions.create({
            model: config.llm.model,
            messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
            max_tokens: 400,
            stream: false,
        });
        return res.choices[0]?.message?.content?.trim() || oldSummary;
    } catch (error) {
        logger.error('Resumen de memoria falló', { message: error.message });
        return oldSummary;
    }
};

/**
 * Pure helper: extracts the system-enforced [EMOTION:xx] tag and strips it from the text.
 * Exported for unit testing.
 */
// Emociones que el rig de cara (retargetFace.js EMOTION_TO_FCL) sabe expresar.
const EMOTIONS = ['neutral', 'happy', 'surprised', 'thinking', 'sad', 'angry', 'curious', 'alert'];

export const parseLlmResponse = (rawResponse) => {
    // llama3.1:8b a veces omite los corchetes -> aceptar [EMOTION:x], (EMOTION:x),
    // *EMOTION:x* o EMOTION:x pelado.
    const emotionMatch = rawResponse.match(/[[(*]?\s*EMOTION\s*:\s*([a-z]+)\s*[\])*]?/i);
    const raw = emotionMatch ? emotionMatch[1].toLowerCase() : 'neutral';
    const emotion = EMOTIONS.includes(raw) ? raw : 'neutral';   // desconocida -> neutral

    // Quitar la etiqueta (con o sin delimitadores) antes de mandar a texto/audio.
    const text = rawResponse.replace(/[[(*]?\s*EMOTION\s*:[^\])*\n]*[\])*]?/gi, '').trim();

    return { text, emotion };
};

/**
 * Shared Utility: structures the pipeline contract uniformly
 */
const finalizeLlmTurn = (accumulatedResponse, durationMs, onComplete) => {
    const { text, emotion } = parseLlmResponse(accumulatedResponse);

    if (onComplete) {
        onComplete({
            text,
            emotion,
            duration_ms: durationMs,
            tokens_used: Math.round(accumulatedResponse.length / 4),
        });
    }
};


/**
 * Clasificador de UNA palabra para las aprobaciones por voz del agente: ¿el enunciado
 * responde a la pregunta pendiente? Solo se llama cuando el atajo léxico (sí/no/para) no
 * decidió. Las únicas salidas válidas son ALLOW/DENY/CANCEL/ANSWER; cualquier otra cosa —
 * incluido un error — la trata el puente como "no relacionado", y eso NUNCA concede.
 */
export async function classifyIntent(question, utterance, kind = 'approval') {
    const sys = kind === 'question'
        ? 'The assistant asked the user a question. Reply with exactly one word: ANSWER if the user is answering it, CANCEL if they want to stop the task, OTHER if unrelated.'
        : 'The assistant asked the user for permission to perform an action. Reply with exactly one word: ALLOW if the user agrees, DENY if they refuse, CANCEL if they want to stop the whole task, OTHER if unrelated.';
    const resp = await getLlmClient().chat.completions.create({
        model: config.llm.model, max_tokens: 3, temperature: 0, stream: false,
        messages: [{ role: 'system', content: sys },
            { role: 'user', content: `Question: ${question}\nUser said: ${utterance}` }],
    });
    return String(resp.choices?.[0]?.message?.content || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}
