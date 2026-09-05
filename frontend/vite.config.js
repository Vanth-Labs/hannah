import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Overlay/desktop: servir HTTP (localhost sigue siendo "secure context", el mic/cámara
// funcionan) para que el navegador en modo-app no rechace el cert autofirmado del
// basic-ssl. En el navegador normal (LAN) mantenemos HTTPS para getUserMedia fuera de
// localhost. Flag: HANNAH_HTTP=1.
const httpMode = !!process.env.HANNAH_HTTP;

export default defineConfig({
    plugins: [react(), ...(httpMode ? [] : [basicSsl()])],
    resolve: {
        dedupe: ['react', 'react-dom', 'three'],
    },
    server: {
        // Solo esta máquina por defecto. HANNAH_LAN=1 (lo pone `./hannah services`) lo abre a
        // la red: entonces el backend exige el token de la UI a todo lo que no sea loopback.
        host: process.env.HANNAH_LAN ? '0.0.0.0' : 'localhost',
        port: 5173,
        proxy: {
            // xfwd: el backend ve la IP real del cliente en X-Forwarded-For (api/auth.js) —
            // sin esto todo lo que pasa por aquí parecería 127.0.0.1.
            '/api': { target: 'http://localhost:3001', xfwd: true },
            '/ws': { target: 'ws://localhost:3001', ws: true, xfwd: true },
        },
    },
});
