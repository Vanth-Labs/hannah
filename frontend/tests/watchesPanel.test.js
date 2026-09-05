// La sección «Vigilancia» del panel de ajustes. Lo único que esta pantalla no puede hacer nunca:
// decir «nada vigilado» sin saberlo. Un fallo (socket caído, backend reiniciado) y una lista de
// verdad vacía son dos cosas distintas, y la promesa entera del feature es esa diferencia: una
// vigilancia armada de la que la UI dice que no existe es peor que no tener panel.
//
// Se prueba `WatchesView`, la vista pura, y no el contenedor: en `environment: node` zustand
// sirve `getInitialState` (zustand/esm/index.mjs), así que un componente suscrito al store se
// pinta siempre con la lista vacía inicial y no se puede poner en un estado concreto desde fuera.
// Sin DOM y sin JSX por lo mismo que watchPill.test.js: la config de vitest no monta jsdom ni el
// plugin de React.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WatchesView } from '../src/components/SettingsPanel.jsx';

const NOW = 1787000000000;
const view = (props = {}) => renderToStaticMarkup(React.createElement(WatchesView, {
    watches: [], connected: false, health: null, onDisarm: () => {}, now: NOW, ...props,
}));
const NADA = 'Nada vigilado ahora mismo';
// Las dos respuestas de GET /api/v1/health: la de un backend que pudo preguntarle al sidecar y la
// de uno que no. El campo `error` es el que existía y la vista tiraba.
const HEALTH_OK = { watches: { armed: 0, blind: 0, suspended: 0, lastSampleAt: null } };
const HEALTH_CIEGO = { watches: { armed: 0, degraded: 0, blind: 0, suspended: 0, lastSampleAt: null, error: 'sense_unavailable' } };

describe('sección de Vigilancia', () => {
    test('sin socket NO dice «nada vigilado»: eso sería afirmar algo que no sabe', () => {
        // La lista solo es la respuesta del servidor mientras el WebSocket está attacheado (el
        // backend manda un watch_armed y un watch_state por vigilancia viva al attachear). Con el
        // socket caído es una caché vieja, y una caché vacía no prueba nada.
        const html = view();
        expect(html).not.toContain(NADA);
        expect(html).toContain('no sé qué está vigilando');
    });

    test('con el socket attacheado, el sidecar contestando y la lista vacía sí puede decirlo', () => {
        expect(view({ connected: true, health: HEALTH_OK })).toContain(NADA);
    });

    // El segundo eje, el que faltaba. El socket está perfecto y la lista llega vacía, pero el
    // backend acaba de decir que no pudo hablar con :8007 (`watches.error`): entonces la lista
    // vacía no es una lista, es una pregunta sin responder. En vivo: sidecar apagado, DOS
    // vigilancias guardadas en su store, y la pantalla escribiendo «Nada vigilado ahora mismo».
    test('con el sidecar caído NO dice «nada vigilado», aunque el socket esté attacheado', () => {
        const html = view({ connected: true, health: HEALTH_CIEGO });
        expect(html).not.toContain(NADA);
        expect(html).toContain('no sé qué está vigilando');
        expect(html).toContain('sense_unavailable');
        // Y el resumen del encabezado tampoco puede contar ceros que nadie contó.
        expect(html).not.toContain('0 armadas');
    });

    test('con el sidecar caído y filas en pantalla, se marcan como lo último que se supo', () => {
        const html = view({ connected: true, health: HEALTH_CIEGO,
            watches: [{ watchId: 'w_a', label: 'el entrenamiento', state: 'armed', fires: 0, mine: true }] });
        expect(html).toContain('el entrenamiento');
        expect(html).toContain('no lo que está pasando');
        expect(html).not.toContain(NADA);
    });

    test('mientras /health no contestó todavía, no afirma ninguna de las dos cosas', () => {
        // `health` es null hasta que vuelve el fetch. Ni «nada vigilado» (no lo sabe) ni el aviso
        // de ciego (tampoco lo sabe): callarse es la única frase honesta de ese medio segundo.
        const html = view({ connected: true, health: null });
        expect(html).not.toContain(NADA);
        expect(html).not.toContain('Sin respuesta de los ojos');
    });

    // La otra mitad de la misma regla, en la fila: la etiqueta es texto libre que dictó UNA
    // persona y el backend solo se la manda a ella (senseBridge: armedMsg). Antes salía por
    // broadcast a cualquier HUD, incluida la de una sesión muerta en un arranque anterior.
    test('una vigilancia de otra sesión se pinta como fila, sin las palabras de su dueña', () => {
        const html = view({ connected: true, health: HEALTH_OK, watches: [
            { watchId: 'w_ajena', label: null, mine: false, state: 'armed', rung: 'R2', sensorKind: 'file', fires: 0 },
        ] });
        expect(html).toContain('vigilancia de otra sesión');
        // Existe, ocupa un cupo y se ve con qué mira: esconderla entera sería mentir al revés.
        expect(html).toContain('armed');
        expect(html).toContain('file');
        expect(html).not.toContain(NADA);
    });

    test('la suya sí se pinta entera', () => {
        const html = view({ connected: true, health: HEALTH_OK, watches: [
            { watchId: 'w_mia', label: 'el log del entrenamiento', mine: true, state: 'armed', fires: 0 },
        ] });
        expect(html).toContain('el log del entrenamiento');
        expect(html).not.toContain('vigilancia de otra sesión');
    });

    test('sin socket, lo que quedó en pantalla se marca como lo último que se supo', () => {
        const html = view({ watches: [{ watchId: 'w_a', label: 'el entrenamiento', state: 'armed', fires: 0 }] });
        expect(html).toContain('el entrenamiento');
        expect(html).toContain('no lo que está pasando');
        expect(html).not.toContain(NADA);
    });

    test('el panel no llama al plano de control de vigilancias', () => {
        // GET /api/v1/watches contesta 403 a cualquier petición con cabecera Origin
        // (backend/src/api/auth.js: «The watch control plane does not serve browsers») y 401 sin
        // token de la UI, que es el flujo normal en navegador. O sea: desde esta pantalla fallaba
        // SIEMPRE, y el catch de esa llamada era justo lo que pintaba «nada vigilado».
        // Se afirma leyendo el fuente porque aquí no hay DOM: renderToStaticMarkup no corre
        // efectos, así que un espía sobre fetch no vería nunca la llamada, ni la buena ni la mala.
        const src = readFileSync(new URL('../src/components/SettingsPanel.jsx', import.meta.url), 'utf8');
        expect(src).not.toContain('apiFetch(`/api/v1/watches');
        expect(src).not.toContain("apiFetch('/api/v1/watches");
    });
});
