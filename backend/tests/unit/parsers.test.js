// tests/unit/parsers.test.js
// La capa determinista (lo que hace que Hannah no dependa de que el LLM acierte) es toda
// regex sobre lo que dice el usuario. Antes solo se validaba hablándole al avatar; acá se
// testean los parsers puros con frases reales, incluyendo acentos y voseo.
import { parseMoveIntent } from '../../src/pipeline/windowControl.js';
import { stripActionTags } from '../../src/pipeline/llm.js';
import { parseFrontmatter, sshArg } from '../../src/state/skills.js';

describe('parseMoveIntent (mover la ventana por voz)', () => {
    test.each([
        ['pantalla completa', 'fullscreen'],
        ['ponete en pantalla completa', 'fullscreen'],
        ['ponte en pantalla completa por favor', 'fullscreen'],
        ['andá al centro', 'center'],
        ['ponete en el centro', 'center'],
        ['móvete a la otra pantalla', 'next-screen full'],
        ['pasate a la otra pantalla', 'next-screen full'],
    ])('%s -> %s', (frase, esperado) => {
        expect(parseMoveIntent(frase)).toBe(esperado);
    });

    test('esquinas', () => {
        expect(parseMoveIntent('ponete arriba a la derecha')).toBe('top-right');
        expect(parseMoveIntent('ponete abajo a la izquierda')).toBe('bottom-left');
    });

    test('una charla normal NO mueve la ventana', () => {
        expect(parseMoveIntent('hola, cómo estás')).toBeNull();
        expect(parseMoveIntent('contame algo de la pantalla del cine')).not.toBe('fullscreen');
    });
});

describe('stripActionTags (lo que NO debe llegar al TTS)', () => {
    test('quita los tags de acción con cualquier delimitador', () => {
        expect(stripActionTags('[RUN: ls -la] Listo.').trim()).toBe('Listo.');
        expect(stripActionTags('Mirá [SKILL: ping | 8.8.8.8] ya está.').replace(/\s+/g, ' ').trim())
            .toBe('Mirá ya está.');
        expect(stripActionTags('(BROWSE: youtube.com) abriendo').trim()).toBe('abriendo');
    });

    test('NO toca palabras comunes sueltas (run, time, open)', () => {
        const t = 'Voy a run un rato, es time de open bar.';
        expect(stripActionTags(t)).toBe(t);
    });
});

describe('parseFrontmatter (SKILL.md que edita el usuario)', () => {
    test('lee claves, arrays y booleanos', () => {
        const { meta, body } = parseFrontmatter([
            '---',
            'name: ping',
            'description: Ver si un host responde',
            'run: ping -c 3 {arg}',
            'phrases: ["hacé ping a", "ping a"]',
            'confirm: false',
            '---',
            'Guía para el modelo.',
        ].join('\n'));
        expect(meta.name).toBe('ping');
        expect(meta.run).toBe('ping -c 3 {arg}');
        expect(meta.phrases).toEqual(['hacé ping a', 'ping a']);
        expect(meta.confirm).toBe(false);
        expect(body).toBe('Guía para el modelo.');
    });

    test('no rompe comandos con comillas ni con # (bug real que tuvimos)', () => {
        const { meta } = parseFrontmatter('---\nrun: curl -s "wttr.in/{arg}?format=3"\n---\n');
        expect(meta.run).toBe('curl -s "wttr.in/{arg}?format=3"');
    });

    test('acepta claves por-OS', () => {
        const { meta } = parseFrontmatter('---\nrun.linux: free -h\nrun.mac: vm_stat\n---\n');
        expect(meta['run.linux']).toBe('free -h');
        expect(meta['run.mac']).toBe('vm_stat');
    });

    test('sin frontmatter devuelve solo body', () => {
        const { meta, body } = parseFrontmatter('solo texto');
        expect(meta).toEqual({});
        expect(body).toBe('solo texto');
    });
});

describe('sshArg (arma user@host desde lo dictado)', () => {
    test.each([
        ['192.168.1.30 con el usuario drocho', 'drocho@192.168.1.30'],
        ['drocho@192.168.1.30', 'drocho@192.168.1.30'],
        ['192.168.1.30', '192.168.1.30'],
        ['mi-server.local como drocho', 'drocho@mi-server.local'],
    ])('%s -> %s', (dicho, esperado) => {
        expect(sshArg(dicho)).toBe(esperado);
    });

    test('pasa a minúscula (el ASR suele capitalizar)', () => {
        expect(sshArg('192.168.1.30 con el usuario DROCHO')).toBe('drocho@192.168.1.30');
    });
});

describe('parseMoveIntent — no dispara sobre frases que no son un pedido de mover', () => {
  test('una tarea larga con "go"/"move"/"right" sueltos no mueve la ventana', () => {
    expect(parseMoveIntent('Go through my Downloads folder, figure out which files are duplicates of each other, and tell me how much space they waste. Do not delete or move anything.')).toBeNull();
  });
  test('la negación explícita no mueve', () => {
    expect(parseMoveIntent('no te muevas')).toBeNull();
    expect(parseMoveIntent("don't move")).toBeNull();
  });
  test('un pedido largo que menciona la pantalla sí mueve', () => {
    expect(parseMoveIntent('can you go to the left side of the screen please')).toBe('left screen full');
    expect(parseMoveIntent('please move to the top right corner of the other screen')).toBe('next-screen full');
  });
});

describe('resolveDataAction — el borrado negado no es una orden', () => {
  test('"do not delete the file X" no ejecuta nada', async () => {
    const { resolveDataAction } = await import('../../src/pipeline/tools.js');
    const sent = [];
    const r = await resolveDataAction('Go through my Downloads folder and tell me what is there. Do not delete the file report.txt', { send: (m) => sent.push(m) });
    expect(r).toBeFalsy();
    expect(sent.find((m) => m.type === 'command_run')).toBeUndefined();
  });
  test('"no borres nada" tampoco', async () => {
    const { resolveDataAction } = await import('../../src/pipeline/tools.js');
    expect(await resolveDataAction('revisá mis descargas pero no borres el archivo notas.txt', {})).toBeFalsy();
  });
});

describe('deterministic layer hands writes to the agent when the hands are on', () => {
  test('crea un archivo … goes to the agent with the user\'s own words, not to a local touch', async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.TOOLS_RUN_POLICY = 'agent-first';
    const bridge = await import('../../src/pipeline/agentBridge.js');
    const { config } = await import('../../src/config.js');
    config.agent.enabled = true; config.tools.runPolicy = 'agent-first';
    const created = [];
    const fake = {
      health: async () => ({ healthy: true, version: 't' }),
      listTasks: async () => ({ tasks: [] }),
      subscribe: () => ({ close() {} }),
      createTask: async (req) => { created.push(req); return { taskId: 't_1', title: req.title, state: 'queued' }; },
    };
    bridge._reset();
    await bridge.init({ client: fake, narrate: async () => {} });
    bridge._setHealthy(true);
    const { resolveDataAction } = await import('../../src/pipeline/tools.js');
    const out = await resolveDataAction('crea un archivo prueba.txt en mi carpeta Documentos que diga hola', { sessionId: 's1', send: () => {} });
    expect(created).toHaveLength(1);
    expect(created[0].prompt).toContain('crea un archivo prueba.txt en mi carpeta Documentos que diga hola');
    expect(out).toMatch(/Handed to your HANDS/);
    await bridge.shutdown().catch(() => {});
  });
});

describe('wavDurationS', () => {
  test('reads channels, rate and bits from the header', async () => {
    const { wavDurationS } = await import('../../src/pipeline/motion.js');
    const rate = 22050, channels = 2, bits = 16, seconds = 1.5;
    const dataLen = Math.round(rate * channels * (bits / 8) * seconds);
    const b = Buffer.alloc(44 + dataLen);
    b.write('RIFF', 0); b.writeUInt32LE(36 + dataLen, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * bits / 8, 28); b.writeUInt16LE(channels * bits / 8, 32); b.writeUInt16LE(bits, 34);
    b.write('data', 36); b.writeUInt32LE(dataLen, 40);
    expect(wavDurationS(b)).toBeCloseTo(seconds, 3);
    expect(wavDurationS(Buffer.alloc(44 + 24000 * 2), 24000)).toBeCloseTo(1, 3);   // no header: fallback
  });
});

describe('references, not names', () => {
  test('"delete the file you just created" is not a deterministic rm', async () => {
    const { resolveDataAction } = await import('../../src/pipeline/tools.js');
    const { config } = await import('../../src/config.js');
    config.agent.enabled = false;   // sin manos: tiene que caer al modelo, no a rm "you"
    expect(await resolveDataAction('delete the file you just created', { sessionId: 's', send: () => {} })).toBeFalsy();
    expect(await resolveDataAction('borra ese archivo que creaste', { sessionId: 's', send: () => {} })).toBeFalsy();
  });

  test('a task prompt carries what the hands did before and the recent turns', async () => {
    const bridge = await import('../../src/pipeline/agentBridge.js');
    const { conversationManager } = await import('../../src/state/conversationManager.js');
    const { config } = await import('../../src/config.js');
    config.agent.enabled = true;
    const created = [];
    const fake = { health: async () => ({ healthy: true }), listTasks: async () => ({ tasks: [] }), subscribe: () => ({ close() {} }),
      createTask: async (req) => { created.push(req); return { taskId: `t_${created.length}` }; } };
    bridge._reset(); await bridge.init({ client: fake, narrate: async () => {} }); bridge._setHealthy(true);
    const sid = conversationManager.createSession().sessionId;
    conversationManager.addTurn(sid, 'user', 'create a file notes.txt in Documents');
    conversationManager.addTurn(sid, 'assistant', 'On it.');
    const r = await bridge.dispatch(sid, 'create a file named notes.txt in Documents', { title: 'create a file' });
    await bridge.onEvent({ v: 'hannah.v0', type: 'task.completed', taskId: r.taskId, seq: 1, ts: 1, data: { summary: 'created ~/Documents/notes.txt' } });
    await bridge.dispatch(sid, 'delete the file you just created', { title: 'delete' });
    expect(created[1].prompt).toMatch(/Earlier tasks[\s\S]*notes\.txt[\s\S]*Recent conversation[\s\S]*Request: delete the file you just created/);
    await bridge.shutdown().catch(() => {});
  });
});
