import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
    plugins: [react(), basicSsl()],
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
