// src/api/router.js
import { Router } from 'express';
import { handler } from './handler.js';
import { getHealth } from './health.js';
import { createSession, deleteSession } from './sessions.js';
import { readSettings, writeSettings } from './settings.js';
import { readShortcuts, writeShortcuts } from './shortcuts.js';
import { readVoices, previewVoice } from './tts.js';
import { readSkills, writeSkill, removeSkill } from './skills.js';
import { generateDialogueStream } from '../pipeline/llm.js';
import { synthesizeSpeechStream } from '../pipeline/tts.js';
import { generateVisemesFromText } from '../pipeline/lipsync.js';

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
router.get('/skills', handler('skills_read_failed', readSkills));
router.post('/skills', handler('skill_write_failed', writeSkill));
router.delete('/skills/:name', handler('skill_delete_failed', removeSkill));

// TESTING FALLBACK: Evaluates all internal Core AI modules working smoothly as a unified chain
router.post('/text', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing mandatory text body query param' });

    // 1. Mock standard conversational interaction mapping context flow
    const mockHistory = [{ role: 'user', content: text }];

    // 2. Drive text parsing downstream through Claude
    await generateDialogueStream(mockHistory, null, async (llmResult) => {
      if (llmResult.error) return res.status(500).json({ error: 'llm_failed', data: llmResult });

      // 3. Drive response parsing downstream into ElevenLabs
      const ttsResult = await synthesizeSpeechStream(llmResult.text);
      if (ttsResult.error) return res.status(500).json({ error: 'tts_failed', data: ttsResult });

      // 4. Generate corresponding animation blendshape commands concurrently
      const lipsyncResult = generateVisemesFromText(llmResult.text);

      // Collect the stream data into a solid testing buffer
      const audioChunks = [];
      ttsResult.audioStream.on('data', (chunk) => audioChunks.push(chunk));

      ttsResult.audioStream.on('end', () => {
        const fullAudioBuffer = Buffer.concat(audioChunks);

        // Return complete validation envelope payload structure cleanly
        res.status(200).json({
          transcript: text,
          response: llmResult.text,
          emotion: llmResult.emotion,
          audioBase64: fullAudioBuffer.toString('base64'),
          audioFormat: ttsResult.format,
          visemes: lipsyncResult.visemes,
          latency: {
            llm_ms: llmResult.duration_ms,
            tts_ms: ttsResult.tts_latency_ms,
            lipsync_ms: lipsyncResult.processing_time_ms,
            total_ms: llmResult.duration_ms + ttsResult.tts_latency_ms + lipsyncResult.processing_time_ms
          }
        });
      });
    });

  } catch (error) {
    res.status(500).json({ error: 'pipeline_chain_failed', message: error.message });
  }
});

export { router };