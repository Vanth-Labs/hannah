// La píldora de vigilancia, headless. Lo que no puede romperse en silencio: que "no está
// mirando" acabe pareciéndose a "está mirando". Esa es la promesa entera del feature, y una UI
// donde las dos se ven igual es una mentira dentro de un widget.
// Sin DOM a propósito: renderToStaticMarkup basta para afirmarlo y no obliga a meter jsdom en un
// repo cuyos tests corren en `environment: node`. Sin JSX por la misma razón: la config de vitest
// no monta el plugin de React.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WatchPill, WATCH_LINGER_MS, nextRailWake, visibleWatches } from '../src/components/WatchPill.jsx';

const pill = (watch) => renderToStaticMarkup(
    React.createElement(WatchPill, { watch: { watchId: 'w_abc', label: 'el entrenamiento', fires: 0, ...watch }, onDisarm: () => {} }),
);

describe('WatchPill', () => {
    test('una vigilancia ciega no se parece a una armada', () => {
        const armed = pill({ state: 'armed' });
        const blind = pill({ state: 'blind' });
        expect(armed).toContain('>armed<');
        expect(blind).toContain('>blind<');
        // El borde discontinuo es la diferencia que sobrevive al daltonismo y a una captura en
        // gris: si algún día sólo quedara el color, esto falla.
        expect(armed).toContain('border-style:solid');
        expect(blind).toContain('border-style:dashed');
    });

    test('una vigilancia de otra sesión se pinta sin la etiqueta que dictó su dueña', () => {
        // El backend solo le manda el texto libre a la sesión que armó, así que aquí llega vacío.
        // La píldora igual se pinta —la vigilancia existe y ocupa un cupo— pero sin un hueco donde
        // iba el nombre, que es lo que dejaba el `{watch.label}` pelado.
        const html = pill({ state: 'armed', label: null });
        expect(html).toContain('de otra sesión');
        expect(html).toContain('>armed<');
    });

    test('suspended y expired tampoco se pintan como mirando', () => {
        for (const state of ['suspended', 'expired', 'faulted']) {
            expect(pill({ state })).toContain('border-style:dashed');
        }
    });

    // Nota sobre la línea de aceptación de M5.1.5 en el ROADMAP: pide "armed / degraded / blind".
    // `degraded` NO es uno de los seis estados del contrato (armed, blind, suspended, expired,
    // disarmed, faulted): es un contador de salud de GET /api/v1/health que en esta fase tanto el
    // sidecar como el puente dejan clavado en 0 (senseBridge.js::watchCounters). No hay nada que
    // pintar, así que no hay test que escribir. Se cubren los seis de verdad y uno desconocido.
    test('un estado desconocido falla hacia "no está mirando"', () => {
        // Un backend más nuevo que esta HUD no puede conseguir que una fila mienta diciendo
        // que mira.
        expect(pill({ state: 'quantum' })).toContain('border-style:dashed');
    });

    test('una vigilancia desarmada no ofrece desarmar, pero sigue diciendo cuántas veces saltó', () => {
        const html = pill({ state: 'disarmed', fires: 3 });
        expect(html).toContain('⚡3');
        expect(html).not.toContain('<button');
    });

    test('una vigilancia viva ofrece desarmarla', () => {
        expect(pill({ state: 'armed' })).toContain('<button');
        expect(pill({ state: 'blind' })).toContain('<button');
    });

    test('sin disparos no hay contador que distraiga', () => {
        expect(pill({ state: 'armed', fires: 0 })).not.toContain('⚡');
    });
});

// La columna del HUD. El defecto que se arregló aquí: el filtro llamaba a `Date.now()` dentro del
// render, y `watch_disarmed` es por definición el ÚLTIMO mensaje de esa vigilancia, así que nadie
// volvía a re-renderizar y la fila terminal se quedaba en pantalla para siempre. El comentario del
// componente prometía que se iba a los pocos segundos. Se prueban las dos funciones puras porque
// aquí no hay DOM: sin montar de verdad no hay efectos, y con el store suscrito zustand serviría
// `getInitialState`.
describe('columna de píldoras (WatchesRail)', () => {
    const DONE = 1787000000000;
    const terminal = [{ watchId: 'w_a', label: 'el entrenamiento', state: 'disarmed', doneAt: DONE }];

    test('una fila terminal tiene un despertar programado y al llegar ya no se pinta', () => {
        const wake = nextRailWake(terminal, DONE + 1000);
        expect(wake).toBe(DONE + WATCH_LINGER_MS);
        expect(visibleWatches(terminal, wake - 1)).toHaveLength(1);
        expect(visibleWatches(terminal, wake)).toHaveLength(0);
    });

    test('cuando ya se fue no queda nada que programar', () => {
        // Si esto devolviera un número, el timeout se re-agendaría solo cada 20ms para siempre.
        expect(nextRailWake(terminal, DONE + WATCH_LINGER_MS)).toBe(Infinity);
    });

    test('una vigilancia viva no agenda ningún timer', () => {
        // La columna re-renderiza con cada muestra; un intervalo permanente aquí sería trabajo
        // constante en un HUD que ya se re-renderiza con cada visema.
        const rows = [{ watchId: 'w_a', state: 'armed', doneAt: null }];
        expect(nextRailWake(rows, DONE)).toBe(Infinity);
        expect(visibleWatches(rows, DONE + 10 * WATCH_LINGER_MS)).toHaveLength(1);
    });

    test('con dos filas terminales despierta primero por la que se va antes', () => {
        const rows = [...terminal, { watchId: 'w_b', state: 'faulted', doneAt: DONE - 3000 }];
        expect(nextRailWake(rows, DONE)).toBe(DONE - 3000 + WATCH_LINGER_MS);
    });

    test('el despertar es un timeout, no un intervalo permanente', () => {
        // Se lee el fuente porque sin DOM no hay efectos que espiar. Lo que protege: la columna
        // vive lo que vive el HUD, que se re-renderiza con cada visema, así que un setInterval
        // aquí sería trabajo constante para no mirar nada la mayor parte del tiempo. Antes no
        // había ni lo uno ni lo otro y por eso la fila terminal no se iba nunca.
        const src = readFileSync(new URL('../src/components/WatchPill.jsx', import.meta.url), 'utf8');
        expect(src).toContain('setTimeout(');
        expect(src).not.toContain('setInterval(');
    });
});
