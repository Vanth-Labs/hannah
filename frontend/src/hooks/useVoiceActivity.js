// src/hooks/useVoiceActivity.js
// Detección de voz (VAD) local en el navegador con Silero (@ricky0123/vad-web).
// Assets servidos desde /public/vad/ (sin CDN — ver scripts/copy-vad-assets.mjs).
// - onSpeechStart: si Hannah está hablando -> onInterrupt (barge-in).
// - onSpeechEnd(audio Float32 @16kHz): -> onUtterance(wavBuffer) para mandar el turno.
import { useEffect, useRef } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import { useHannahStore } from '../store/hannahStore.js';

// Float32 mono @16kHz -> WAV PCM16 (ArrayBuffer). Whisper acepta 16kHz directamente.
function floatToWav(float32, sampleRate = 16000) {
    const n = float32.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buf);
    const wr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); wr(8, 'WAVE');
    wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    wr(36, 'data'); view.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, float32[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
    }
    return buf;
}

export function useVoiceActivity({ enabled, onUtterance, onInterrupt, onSpeechStart }) {
    const vadRef = useRef(null);
    // refs a los callbacks para no re-crear el VAD en cada render
    const cbUtter = useRef(onUtterance); cbUtter.current = onUtterance;
    const cbStart = useRef(onSpeechStart); cbStart.current = onSpeechStart;
    const cbInterrupt = useRef(onInterrupt); cbInterrupt.current = onInterrupt;

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;

        (async () => {
            try {
                const vad = await MicVAD.new({
                    baseAssetPath: '/vad/',
                    onnxWASMBasePath: '/vad/',
                    model: 'v5',
                    // Robustez (vad-web 0.0.30 lee estas opciones en MILISEGUNDOS; los nombres
                    // antiguos en frames los ignora sin avisar):
                    // - umbral sensible para captar el inicio de tu voz
                    positiveSpeechThreshold: 0.35,
                    // - el silencio se decide con el MISMO umbral: si el de silencio es mas bajo, un
                    //   micro con ruido de fondo deja la probabilidad en la franja gris entre ambos y
                    //   el enunciado no se cierra nunca (no llega SPEECH_END: "no me escucha")
                    negativeSpeechThreshold: 0.35,
                    // - 1.4 s sin voz cierran la frase (no cortar en pausas normales)
                    redemptionMs: 1400,
                    // - poco minimo de voz para no perder palabras cortas ("abre", "si")
                    minSpeechMs: 250,
                    // - capturar el arranque de la palabra (que el ASR no pierda la primera silaba)
                    preSpeechPadMs: 800,
                    onSpeechStart: () => {
                        cbStart.current?.();   // SIEMPRE: el backend stampa el inicio del enunciado
                        if (useHannahStore.getState().isSpeaking) cbInterrupt.current?.();
                    },
                    onSpeechEnd: (audio) => { cbUtter.current?.(floatToWav(audio)); },
                    // arranque sin voz suficiente detras (un golpe, una tos): no hay enunciado
                    onVADMisfire: () => { console.info('[vad] misfire: too short to be speech'); },
                });
                if (cancelled) { vad.destroy?.(); return; }
                vadRef.current = vad;
                vad.start();
                useHannahStore.getState().setMicError(null);
            } catch (e) {
                console.error('VAD init falló:', e);
                // Que se vea en el HUD: sin esto "no me escucha" no tenia ninguna pista en pantalla.
                useHannahStore.getState().setMicError(e?.message || String(e));
            }
        })();

        return () => {
            cancelled = true;
            try { vadRef.current?.pause?.(); vadRef.current?.destroy?.(); } catch { /* noop */ }
            vadRef.current = null;
        };
    }, [enabled]);
}
