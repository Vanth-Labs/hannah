// src/hooks/useVision.js
import { useRef, useCallback, useEffect } from 'react';
import { useHannahStore } from '../store/hannahStore.js';

export function useVision(sendCommand) {
    const videoRef = useRef(null);
    const intervalRef = useRef(null);
    const streamRef = useRef(null);
    const canvasRef = useRef(null);   // un solo canvas reutilizado (antes: uno nuevo cada 2s)

    const { setVisionActive, addLog } = useHannahStore.getState();

    const startVision = useCallback(async () => {
        if (streamRef.current) return;   // ya activa (dos clics, o el arranque automático + el botón): una sola cámara y un solo interval
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: true });
            streamRef.current = stream;

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
            }

            sendCommand({ command: 'VISION_START' });
            setVisionActive(true);
            addLog('[visión] cámara activa', 'vision');

            // Enviar frames cada 2s
            intervalRef.current = setInterval(() => {
                const video = videoRef.current;
                if (!video || !video.videoWidth) return;

                let canvas = canvasRef.current;
                if (!canvas) {
                    canvas = document.createElement('canvas');
                    canvas.width = 640;
                    canvas.height = 480;
                    canvasRef.current = canvas;
                }
                canvas.getContext('2d').drawImage(video, 0, 0, 640, 480);
                const frame = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
                sendCommand({ command: 'VISION_FRAME', frame });
            }, 2000);

        } catch (e) {
            addLog(`[visión] error: ${e.message}`, 'error');
        }
    }, [sendCommand, setVisionActive, addLog]);

    const stopVision = useCallback(() => {
        clearInterval(intervalRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        sendCommand({ command: 'VISION_STOP' });
        setVisionActive(false);
        addLog('[visión] detenida', 'vision');
    }, [sendCommand, setVisionActive, addLog]);

    // Al desmontar: cortar el interval y APAGAR la cámara (si no, el stream y su luz seguían
    // vivos aunque el componente ya no exista).
    useEffect(() => () => {
        clearInterval(intervalRef.current);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
    }, []);

    return { videoRef, startVision, stopVision };
}
