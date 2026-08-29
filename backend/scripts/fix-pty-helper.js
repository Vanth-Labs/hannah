// scripts/fix-pty-helper.js
// Devuelve el bit de ejecución a `spawn-helper` de node-pty después de cada instalación.
//
// Por qué existe: el tarball de npm de node-pty 1.1.0 publica
// `prebuilds/darwin-<arch>/spawn-helper` con modo 644 (sin +x), y su propio
// `scripts/prebuild.js` solo comprueba que la carpeta exista — nunca copia ni hace chmod de
// nada. En arranque, `lib/unixTerminal.js` calcula `helperPath = native.dir + '/spawn-helper'`,
// que resuelve a esa copia de `prebuilds/`, y el `pty.fork` nativo llama a posix_spawnp sobre un
// archivo no ejecutable -> EACCES -> "posix_spawnp failed.". Resultado: el panel de terminal
// (TERMINAL_START) muere en cada instalación de macOS, con este error en el log del launcher:
//
//     error: Error ejecutando comando WebSocket posix_spawnp failed.
//     {"action":"TERMINAL_START", ... "at new UnixTerminal (.../lib/unixTerminal.js:92:24)"}
//
// Un `npm install`, un `npm ci` o volver a pasar el instalador de macOS re-extraen el tarball y
// rompen la terminal otra vez en silencio, así que el arreglo vive acá, colgado del `postinstall`
// del backend, y no en node_modules/ (que es desechable).
//
// Reglas: solo POSIX (en win32 no hay spawn-helper y el bit de ejecución no existe), idempotente,
// callado cuando no hay nada que arreglar, y NUNCA falla la instalación — sale 0 pase lo que pase.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODE = 0o755;

/** La raíz del paquete node-pty: por resolución de módulos (aguanta hoisting) o al lado nuestro. */
function ptyRoot() {
  try {
    const require = createRequire(import.meta.url);
    return path.dirname(require.resolve('node-pty/package.json'));
  } catch {
    // node-pty todavía no instalado, o resolución rara: probamos el node_modules del backend.
    return path.resolve(__dirname, '../node_modules/node-pty');
  }
}

/**
 * Los mismos directorios, y en el mismo orden, que `loadNativeModule()` de node-pty
 * (lib/utils.js) — de ahí sale el `native.dir` con el que unixTerminal.js arma `helperPath`.
 */
function helperPaths(root) {
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  return dirs.map((d) => path.join(root, d, 'spawn-helper'));
}

function main() {
  if (process.platform === 'win32') return;   // no aplica: en Windows el pty es conpty/winpty

  const fixed = [];
  for (const helper of helperPaths(ptyRoot())) {
    try {
      const st = fs.statSync(helper);
      if (!st.isFile()) continue;
      if ((st.mode & 0o111) === 0o111) continue;   // ya ejecutable: nada que hacer
      fs.chmodSync(helper, MODE);
      fixed.push(helper);
    } catch { /* no está, o sin permiso para tocarlo: no es motivo para romper el install */ }
  }

  if (fixed.length) {
    console.log(`> node-pty: bit de ejecución restaurado en ${fixed.length} spawn-helper (la terminal necesita +x)`);
  }
}

try { main(); } catch { /* pase lo que pase, el install sigue */ }
process.exit(0);
