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

describe('sección de Vigilancia', () => {
    test('sin socket NO dice «nada vigilado»: eso sería afirmar algo que no sabe', () => {
        // La lista solo es la respuesta del servidor mientras el WebSocket está attacheado (el
        // backend manda un watch_armed y un watch_state por vigilancia viva al attachear). Con el
        // socket caído es una caché vieja, y una caché vacía no prueba nada.
        const html = view();
        expect(html).not.toContain(NADA);
        expect(html).toContain('no sé qué está vigilando');
    });

    test('con el socket attacheado y la lista vacía sí puede decirlo', () => {
        expect(view({ connected: true })).toContain(NADA);
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
