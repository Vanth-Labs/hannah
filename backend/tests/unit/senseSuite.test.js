// tests/unit/senseSuite.test.js
// La suite de Python del sidecar hannah-sense tiene que estar ENCHUFADA a algo.
//
// No prueba código: prueba que exista la forma de correr los 100+ tests de
// `sidecar/sense/tests/`, y que esté escrita donde alguien la va a encontrar. Esa
// suite es la que afirma que la clasificación de rutas del sidecar todavía coincide
// con la del agente (`policy/paths.ts`), caso golden por caso golden. Sin runner, su
// silencio no es "pasa": es que nadie la corre, y las dos listas se separan sin que
// falle nada.
//
// `npm test` (jest) NO la corre y no es un olvido: `sidecar/sense/.venv` se crea a
// mano y puede no existir, así que encadenarla acá convertiría "falta el venv" en una
// suite roja del backend. Por eso es un script aparte y por eso está nombrada en los
// dos README: el script sin la mención es un comando que nadie descubre.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts) => fs.readFileSync(path.join(BACKEND, ...parts), 'utf8');

describe('la suite del sidecar sense tiene runner', () => {
    it('package.json expone test:sense y apunta al venv propio del sidecar', () => {
        const { scripts } = JSON.parse(read('package.json'));
        expect(typeof scripts['test:sense']).toBe('string');
        // El venv PROPIO, no el compartido de sidecar/.venv: ese pinea numpy y
        // onnxruntime para ASR/TTS/visión y no tiene pytest ni fastapi de este.
        expect(scripts['test:sense']).toContain('sidecar/sense');
        expect(scripts['test:sense']).toContain('.venv/bin/python');
        expect(scripts['test:sense']).toContain('pytest');
    });

    it('lo que el script corre existe', () => {
        expect(fs.existsSync(path.join(BACKEND, 'sidecar', 'sense', 'tests'))).toBe(true);
        const casos = fs.readdirSync(path.join(BACKEND, 'sidecar', 'sense', 'tests'))
            .filter((nombre) => nombre.startsWith('test_') && nombre.endsWith('.py'));
        expect(casos.length).toBeGreaterThan(0);
    });

    it('está nombrada en los dos README, que es lo que la hace descubrible', () => {
        expect(read('README.md')).toContain('test:sense');
        expect(read('sidecar', 'sense', 'README.md')).toContain('test:sense');
    });
});
