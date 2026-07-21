// tests/unit/lipsync.test.js
import { generateVisemesFromText } from '../../src/pipeline/lipsync.js';

const ARKIT_VISEMES = new Set([
    'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR',
    'aa', 'E', 'I', 'O', 'U',
]);

describe('generateVisemesFromText', () => {
    test('returns the output contract fields', () => {
        const result = generateVisemesFromText('Hola, soy Hannah.');
        expect(Array.isArray(result.visemes)).toBe(true);
        expect(result.visemes.length).toBeGreaterThan(0);
        expect(result.duration_ms).toBeGreaterThan(0);
        expect(typeof result.processing_time_ms).toBe('number');
    });

    test('only emits valid ARKit viseme names', () => {
        const { visemes } = generateVisemesFromText('¿Qué ves en la cámara ahora mismo?');
        for (const entry of visemes) {
            expect(ARKIT_VISEMES.has(entry.viseme)).toBe(true);
        }
    });

    test('timeline is monotonically non-decreasing', () => {
        const { visemes } = generateVisemesFromText('Una frase un poco más larga para probar el timing.');
        for (let i = 1; i < visemes.length; i++) {
            expect(visemes[i].time_ms).toBeGreaterThanOrEqual(visemes[i - 1].time_ms);
        }
    });

    test('weights stay within [0, 1]', () => {
        const { visemes } = generateVisemesFromText('Probando pesos de mezcla.');
        for (const entry of visemes) {
            expect(entry.weight).toBeGreaterThanOrEqual(0);
            expect(entry.weight).toBeLessThanOrEqual(1);
        }
    });

    test('inserts a sil rest after each word', () => {
        const { visemes } = generateVisemesFromText('dos palabras');
        const silEntries = visemes.filter((v) => v.viseme === 'sil');
        expect(silEntries.length).toBe(2);
        for (const entry of silEntries) {
            expect(entry.weight).toBe(0);
        }
    });
});
