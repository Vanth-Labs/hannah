// src/api/router.js
import express, { Router } from 'express';
import { handler } from './handler.js';
import { getHealth } from './health.js';
import { createSession, deleteSession } from './sessions.js';
import { readSettings, writeSettings } from './settings.js';
import { readShortcuts, writeShortcuts } from './shortcuts.js';
import { readVoices, previewVoice } from './tts.js';
import { readAvatar, avatarInfo, writeAvatar, removeAvatar, MAX_AVATAR_BYTES } from './avatar.js';
import { readSkills, writeSkill, removeSkill } from './skills.js';

const router = Router();

// `handler(slug, fn)` centraliza el try/catch -> 500 { error: slug } (antes copiado en
// cada endpoint). El slug es el que ya devolvía cada uno.
router.get('/health', handler('health_failed', getHealth));
router.post('/session', handler('session_creation_failed', createSession));
router.delete('/session/:id', handler('session_deletion_failed', deleteSession));

// Config de proveedores (BYO model/API) — global, redactada al leer
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

// (La ruta de prueba POST /text se quitó: corría el bucle de acciones sin sesión ni auth.)

export { router };