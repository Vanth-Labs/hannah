#!/usr/bin/env node
// Arranca Electron con los flags que corresponden a ESTE sistema operativo.
//
// Existe porque los flags tienen que ir en argv y no se pueden poner desde main.js: cuando ese
// archivo corre, Chromium ya bifurcó el zygote y ya eligió plataforma, así que
// app.commandLine.appendSwitch('no-sandbox') y el de ozone llegan tarde (el síntoma es
// engañoso: un FATAL sobre permisos de /dev/shm que está perfecto).
//
// Y existe en Node, no en el script de npm, porque ahí la sintaxis era de shell POSIX
// (`VAR=1 cmd`, `${VAR:-x}`): en Windows npm usa cmd.exe y eso ni siquiera arranca. Además
// los flags de Linux se aplicaban en Windows y macOS, donde no hacen falta y solo restan.
const { spawn } = require('child_process');
const electron = require('electron');

const args = ['.'];
const env = { ...process.env };

// --dev: usar el servidor de Vite en vez del dist empaquetado.
if (process.argv.includes('--dev')) env.HANNAH_DEV = '1';

if (process.platform === 'linux') {
  // El sandbox de Chromium necesita SUID/namespaces; para una app local de confianza se apaga.
  args.push('--no-sandbox');
  // Fuerza X11/XWayland: en Wayland nativo el protocolo prohíbe que una app se ponga encima o
  // se mueva sola. HANNAH_OZONE=wayland para experimentar (se pierde el overlay).
  args.push(`--ozone-platform=${env.HANNAH_OZONE || 'x11'}`);
  // En esta máquina (RTX 5070 Ti) el proceso GPU muere por SIGSEGV en bucle y la ventana no
  // llega a mapearse; con el GPU en proceso deja de pasar. HANNAH_GPU=separate para no usarlo.
  if (env.HANNAH_GPU !== 'separate') args.push('--in-process-gpu');
}

// Los flags extra de la línea de comandos se pasan tal cual: `npm start -- --disable-gpu`.
args.push(...process.argv.slice(2).filter((a) => a !== '--dev'));

spawn(electron, args, { stdio: 'inherit', env })
  .on('close', (code) => process.exit(code ?? 0));
