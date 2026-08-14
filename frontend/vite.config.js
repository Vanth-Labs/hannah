import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// En Tauri servimos HTTP (localhost sigue siendo "secure context", el mic/cámara
// funcionan) para que el webview no rechace el cert autofirmado del basic-ssl.
// En el navegador (LAN) mantenemos HTTPS para getUserMedia fuera de localhost.
const inTauri = !!process.env.TAURI;

export default defineConfig({
    plugins: [react(), ...(inTauri ? [] : [basicSsl()])],
    resolve: {
        dedupe: ['react', 'react-dom', 'three'],
    },
    server: {
        host: '0.0.0.0',   // ← expuesto en red local
        port: 5173,
        proxy: {
            '/api': 'http://localhost:3001',   // ← backend sigue privado
            '/ws': {
                target: 'ws://localhost:3001', // ← websocket sigue privado
                ws: true,
            },
        },
    },
});
