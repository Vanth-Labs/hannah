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

export function useVoiceActivity({ enabled, onUtterance, onInterrupt }) {
    const vadRef = useRef(null);
    // refs a los callbacks para no re-crear el VAD en cada render
    const cbUtter = useRef(onUtterance); cbUtter.current = onUtterance;
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
                    // Ajustes de robustez:
                    // - umbral algo más sensible para captar el inicio de tu voz
                    positiveSpeechThreshold: 0.45,
                    negativeSpeechThreshold: 0.30,
                    // - esperar más antes de dar por terminada la frase (no cortar en pausas)
                    redemptionFrames: 16,
                    // - exigir varios frames de voz -> ignora blips cortos de ruido de fondo
                    minSpeechFrames: 4,
                    // - capturar el arranque de la palabra (que el ASR no pierda la primera sílaba)
                    preSpeechPadFrames: 4,
                    onSpeechStart: () => {
                        if (useHannahStore.getState().isSpeaking) cbInterrupt.current?.();
                    },
                    onSpeechEnd: (audio) => { cbUtter.current?.(floatToWav(audio)); },
                });
                if (cancelled) { vad.destroy?.(); return; }
                vadRef.current = vad;
                vad.start();
            } catch (e) {
                console.error('VAD init falló:', e);
            }
        })();

        return () => {
            cancelled = true;
            try { vadRef.current?.pause?.(); vadRef.current?.destroy?.(); } catch { /* noop */ }
            vadRef.current = null;
        };
    }, [enabled]);
}
