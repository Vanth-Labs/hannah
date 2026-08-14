// Copia los assets del VAD (Silero + onnxruntime-web) a public/vad/ para servirlos
// LOCAL (sin CDN). Se ejecuta en predev/prebuild. public/vad/ está gitignored:
// los .wasm de ORT pesan decenas de MB y se regeneran desde node_modules.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vad');
fs.mkdirSync(out, { recursive: true });

const vad = path.join(root, 'node_modules', '@ricky0123', 'vad-web', 'dist');
const ort = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');

const files = [
  [vad, 'vad.worklet.bundle.min.js'],
  [vad, 'silero_vad_v5.onnx'],
  [vad, 'silero_vad_legacy.onnx'],
  // ORT 1.17.x: el wasm es autocontenido (SIN loaders .mjs -> evita el choque con
  // Vite al importar desde /public). Copiamos las variantes que el runtime elige
  // según capacidades (threads vs single-thread SIMD vs base).
  [ort, 'ort-wasm-simd-threaded.wasm'],
  [ort, 'ort-wasm-simd.wasm'],
  [ort, 'ort-wasm-threaded.wasm'],
  [ort, 'ort-wasm.wasm'],
];

let copied = 0;
for (const [dir, name] of files) {
  const src = path.join(dir, name);
  if (!fs.existsSync(src)) { console.warn(`[vad] falta ${name} en ${dir} — ¿npm install?`); continue; }
  fs.copyFileSync(src, path.join(out, name));
  copied++;
}
console.log(`[vad] ${copied}/${files.length} assets copiados a public/vad/`);
