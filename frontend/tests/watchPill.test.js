// La píldora de vigilancia, headless. Lo que no puede romperse en silencio: que "no está
// mirando" acabe pareciéndose a "está mirando". Esa es la promesa entera del feature, y una UI
// donde las dos se ven igual es una mentira dentro de un widget.
// Sin DOM a propósito: renderToStaticMarkup basta para afirmarlo y no obliga a meter jsdom en un
// repo cuyos tests corren en `environment: node`. Sin JSX por la misma razón: la config de vitest
// no monta el plugin de React.
import { describe, expect, test } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WatchPill } from '../src/components/WatchPill.jsx';

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

    test('suspended y expired tampoco se pintan como mirando', () => {
        for (const state of ['suspended', 'expired', 'faulted']) {
            expect(pill({ state })).toContain('border-style:dashed');
        }
    });

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
