// La slice de watches. Lo que aprendió por las malas la slice del agente: el servidor re-anuncia
// lo mismo en cada reconexión, así que un reductor que APILA en vez de MEZCLAR llena el HUD de
// filas duplicadas de la misma vigilancia.
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { useHannahStore } from '../src/store/hannahStore.js';

describe('slice de watches', () => {
    beforeEach(() => useHannahStore.getState().setWatches([]));

    test('un watch_armed repetido MEZCLA en vez de duplicar la fila', () => {
        const { upsertWatch } = useHannahStore.getState();
        upsertWatch({ watchId: 'w_a', label: 'el entrenamiento', rung: 'R2', state: 'armed' });
        upsertWatch({ watchId: 'w_a', label: 'el entrenamiento', rung: 'R2', state: 'armed', expiresAt: 1787000000000 });
        const list = useHannahStore.getState().watches;
        expect(list).toHaveLength(1);
        expect(list[0].expiresAt).toBe(1787000000000);
        expect(list[0].rung).toBe('R2');
    });

    test('una muestra sin label ni fires no borra lo que ya sabíamos', () => {
        const st = useHannahStore.getState();
        st.upsertWatch({ watchId: 'w_a', label: 'el entrenamiento', rung: 'R2', state: 'armed', fires: 2 });
        st.upsertWatch({ watchId: 'w_a', state: 'blind', lastSampleAt: 1787000000000 });
        const [row] = useHannahStore.getState().watches;
        expect(row.label).toBe('el entrenamiento');
        expect(row.rung).toBe('R2');
        expect(row.fires).toBe(2);
        expect(row.state).toBe('blind');
    });

    test('un disparo sin `fires` en el mensaje igual mueve el contador', () => {
        const st = useHannahStore.getState();
        st.upsertWatch({ watchId: 'w_a', label: 'el entrenamiento', state: 'armed' });
        st.tripWatch({ watchId: 'w_a', label: 'el entrenamiento', trippedAt: 1787000000000 });
        expect(useHannahStore.getState().watches[0].fires).toBe(1);
        // Y cuando el servidor sí manda el número, manda él.
        st.tripWatch({ watchId: 'w_a', fires: 7 });
        expect(useHannahStore.getState().watches[0].fires).toBe(7);
    });

    test('doneAt se sella una vez: si se re-sellara, la píldora no se iría nunca', () => {
        const st = useHannahStore.getState();
        st.upsertWatch({ watchId: 'w_a', label: 'x', state: 'armed' });
        expect(useHannahStore.getState().watches[0].doneAt).toBe(null);
        st.upsertWatch({ watchId: 'w_a', state: 'disarmed' });
        const first = useHannahStore.getState().watches[0].doneAt;
        expect(typeof first).toBe('number');
        st.upsertWatch({ watchId: 'w_a', state: 'disarmed', samplesOk: 9 });
        expect(useHannahStore.getState().watches[0].doneAt).toBe(first);
    });

    test('la instantánea del servidor manda: una fila que ya no está, no está', () => {
        const st = useHannahStore.getState();
        st.upsertWatch({ watchId: 'w_a', label: 'vieja', state: 'armed' });
        st.setWatches([{ watchId: 'w_b', label: 'el entrenamiento', state: 'armed', rung: 'R2' }]);
        const list = useHannahStore.getState().watches;
        expect(list).toHaveLength(1);
        expect(list[0].watchId).toBe('w_b');
    });

    test('un parche sin watchId no crea filas fantasma', () => {
        useHannahStore.getState().upsertWatch({ label: 'ninguna' });
        expect(useHannahStore.getState().watches).toHaveLength(0);
    });

    test('una instantánea no re-sella doneAt: la fila terminal no revive su cuenta atrás', () => {
        // La instantánea reconstruía cada fila desde WATCH_DEFAULTS, y el servidor no manda
        // `doneAt` (es un reloj local), así que cada instantánea le regalaba a la terminal otros
        // WATCH_LINGER_MS en pantalla. Con reloj falso porque con el real las dos marcas pueden
        // caer en el mismo milisegundo y el test pasaría estando roto.
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1787000000000);
            const st = useHannahStore.getState();
            st.upsertWatch({ watchId: 'w_a', label: 'el entrenamiento', state: 'disarmed' });
            const first = useHannahStore.getState().watches[0].doneAt;
            expect(first).toBe(1787000000000);

            vi.setSystemTime(1787000030000);
            st.setWatches([{ watchId: 'w_a', label: 'el entrenamiento', state: 'disarmed' }]);
            expect(useHannahStore.getState().watches[0].doneAt).toBe(first);
        } finally {
            vi.useRealTimers();
        }
    });

    test('una instantánea que trae la fila viva otra vez le quita el doneAt', () => {
        // Re-armada: ya no hay desenlace que leer, y una cuenta atrás pendiente haría desaparecer
        // una píldora que sí está mirando.
        const st = useHannahStore.getState();
        st.upsertWatch({ watchId: 'w_a', label: 'x', state: 'disarmed' });
        expect(typeof useHannahStore.getState().watches[0].doneAt).toBe('number');
        st.setWatches([{ watchId: 'w_a', label: 'x', state: 'armed' }]);
        expect(useHannahStore.getState().watches[0].doneAt).toBe(null);
    });

    test('una fila terminal que la instantánea trae por primera vez sí se sella', () => {
        useHannahStore.getState().setWatches([{ watchId: 'w_z', label: 'x', state: 'expired' }]);
        expect(typeof useHannahStore.getState().watches[0].doneAt).toBe('number');
    });
});
