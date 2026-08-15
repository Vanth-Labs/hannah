// src/pipeline/desktop/sh.js
// Ejecutar un comando del compositor (hyprctl/wmctrl/xdotool) y devolver su stdout, o null
// si falla. Compartido por todos los adaptadores de escritorio (antes copiado en cada uno).
import { exec } from 'child_process';

export const sh = (cmd) => new Promise((res) => exec(cmd, { timeout: 3000 }, (e, out) => res(e ? null : out)));
