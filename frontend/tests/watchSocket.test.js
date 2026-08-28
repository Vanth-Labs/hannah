// El sobre `watch_armed` del backend, traducido a fila del store. Se prueba el traductor y no el
// hook porque en `environment: node` no hay DOM donde montarlo, pero el traductor ES el punto que
// se rompió: una lista de campos escrita a mano, en la que faltaba uno que el backend manda a
// propósito. Un test que solo mirara el mensaje o solo el store no lo habría visto nunca; el que
// vale es el que va del mensaje a lo que se dibuja.
import { describe, expect, test, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { watchArmedPatch } from '../src/hooks/useWebSocket.js';
import { useHannahStore } from '../src/store/hannahStore.js';
import { WatchesView } from '../src/components/SettingsPanel.jsx';

const NOW = 1787000000000;
const HEALTH_OK = { watches: { armed: 1, blind: 0, suspended: 0, lastSampleAt: NOW } };
const armed = (extra = {}) => ({ type: 'watch_armed', watchId: 'w_a', mine: true,
    label: 'el entrenamiento', rung: 'R2', sensorKind: 'logmatch', tier: 'observe',
    expiresAt: NOW + 3600000, ...extra });

describe('watch_armed -> fila', () => {
    beforeEach(() => useHannahStore.getState().setWatches([]));

    test('`sensorKind` sobrevive al traductor: es con QUÉ se está mirando', () => {
        // senseBridge lo manda a propósito ("sin él la fila del panel no puede decir con qué se
        // está mirando") y la lista de campos lo tiraba: los dos lados creían que viajaba.
        expect(watchArmedPatch(armed()).sensorKind).toBe('logmatch');
    });

    test('de punta a punta: del mensaje al sufijo de sensor en la fila del panel', () => {
        useHannahStore.getState().upsertWatch(watchArmedPatch(armed()));
        const html = renderToStaticMarkup(React.createElement(WatchesView, {
            watches: useHannahStore.getState().watches, connected: true, health: HEALTH_OK,
            onDisarm: () => {}, now: NOW,
        }));
        expect(html).toContain('logmatch');
        expect(html).toContain('el entrenamiento');
    });

    test('la propiedad viaja en el sobre: una vigilancia ajena llega sin palabras y marcada', () => {
        const patch = watchArmedPatch(armed({ mine: false, label: null }));
        expect(patch.mine).toBe(false);
        // `null` explícito y no ausente: el store mezcla por watchId y una clave que no viene
        // significa "no cambió", así que omitirla dejaría una etiqueta vieja en pantalla.
        expect(patch.label).toBe(null);
    });

    test('un servidor sin `mine` no se toma por propio: adivinar hacia ahí es lo que filtra', () => {
        expect(watchArmedPatch({ watchId: 'w_a', label: 'x' }).mine).toBe(false);
    });
});
