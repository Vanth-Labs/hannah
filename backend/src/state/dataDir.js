// src/state/dataDir.js
// Único punto de verdad para la carpeta `data/` (config del usuario, memoria, skills) y
// helper de lectura/escritura JSON. Antes cada módulo de estado recalculaba __dirname +
// DATA_DIR y repetía su propio mkdir/writeFile/try-catch/log.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '../../data');

/**
 * Archivo JSON dentro de data/. Devuelve { path, exists, read, write }.
 * `read()` -> objeto o null (si no existe o está corrupto; loguea el error).
 * `write(obj)` -> true/false (crea data/ si falta; loguea el error).
 */
export function jsonFile(name) {
  const file = path.join(DATA_DIR, name);
  return {
    path: file,
    exists: () => fs.existsSync(file),
    read() {
      try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        logger.error(`No se pudo leer ${name}`, { message: error.message });
        return null;
      }
    },
    write(obj) {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(obj, null, 2));
        return true;
      } catch (error) {
        logger.error(`No se pudo persistir ${name}`, { message: error.message });
        return false;
      }
    },
  };
}
