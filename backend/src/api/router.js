// src/api/router.js
import express, { Router } from 'express';
import { handler } from './handler.js';
import { getHealth } from './health.js';
import { createSession, deleteSession } from './sessions.js';
import { readSettings, writeSettings } from './settings.js';
import { readBrain, chooseBrain, installOllama, startOllama, pullModels } from './brain.js';
import { readShortcuts, writeShortcuts } from './shortcuts.js';
import { readVoices, previewVoice } from './tts.js';
import { readAvatar, avatarInfo, writeAvatar, removeAvatar, MAX_AVATAR_BYTES } from './avatar.js';
import { readSkills, writeSkill, removeSkill } from './skills.js';
import { listWatches, createWatch, deleteWatch } from './watches.js';
import { requireWatchAuth } from './auth.js';

const router = Router();

// `handler(slug, fn)` centraliza el try/catch -> 500 { error: slug } (antes copiado en
// cada endpoint). El slug es el que ya devolvía cada uno.
router.get('/health', handler('health_failed', getHealth));
router.post('/session', handler('session_creation_failed', createSession));
router.delete('/session/:id', handler('session_deletion_failed', deleteSession));

// Config de proveedores (BYO model/API) — global, redactada al leer
// First run: where Hannah thinks. The overlay shows the welcome screen until `configured`.
router.get('/brain', handler('brain_status_failed', readBrain));
router.post('/brain/choose', handler('brain_choose_failed', chooseBrain));
router.post('/brain/ollama/install', handler('ollama_install_failed', installOllama));
router.post('/brain/ollama/start', handler('ollama_start_failed', startOllama));
router.post('/brain/ollama/pull', handler('ollama_pull_failed', pullModels));
router.get('/settings', handler('settings_read_failed', readSettings));
router.post('/settings', handler('settings_write_failed', writeSettings));
router.get('/shortcuts', handler('shortcuts_read_failed', readShortcuts));
router.post('/shortcuts', handler('shortcuts_write_failed', writeShortcuts));
router.get('/tts/voices', readVoices);   // ya degrada solo (200 con lista vacía)
router.get('/tts/preview', previewVoice);  // ?voice=ef_dora -> audio/wav de una frase corta (503 si no hay sidecar)
// El avatar del usuario (data/avatar.vrm): el frontend hace HEAD y cae al de fábrica si 404.
router.get('/avatar', readAvatar);
router.head('/avatar', readAvatar);
router.get('/avatar/info', handler('avatar_info_failed', avatarInfo));
router.put('/avatar', express.raw({ type: () => true, limit: MAX_AVATAR_BYTES }), handler('avatar_write_failed', writeAvatar));
router.delete('/avatar', handler('avatar_delete_failed', removeAvatar));
router.get('/skills', handler('skills_read_failed', readSkills));
router.post('/skills', handler('skill_write_failed', writeSkill));
router.delete('/skills/:name', handler('skill_delete_failed', removeSkill));

// Vigilancias (plan VIGILANCE M5.1.4). Detrás de `requireWatchAuth`, que NO es el guardia del
// resto de la API: pide el token aunque el cliente sea de esta máquina y rechaza con 403 a
// cualquiera que traiga `Origin`, o sea a todo navegador. El HUD ve y desarma sus vigilancias por
// el WebSocket; estas rutas son para el launcher y `hannah doctor`.
router.get('/watches', requireWatchAuth, handler('watches_read_failed', listWatches));
router.post('/watches', requireWatchAuth, handler('watch_arm_failed', createWatch));
router.delete('/watches/:id', requireWatchAuth, handler('watch_disarm_failed', deleteWatch));

// (La ruta de prueba POST /text se quitó: corría el bucle de acciones sin sesión ni auth.)

export { router };