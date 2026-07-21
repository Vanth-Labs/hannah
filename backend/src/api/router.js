// src/api/router.js
import { Router } from 'express';
import { getHealth } from './health.js';
import { createSession, deleteSession } from './sessions.js';
import { generateDialogueStream } from '../pipeline/llm.js';
import { synthesizeSpeechStream } from '../pipeline/tts.js';
import { generateVisemesFromText } from '../pipeline/lipsync.js';

const router = Router();

router.get('/health', getHealth);
router.post('/session', createSession);
router.delete('/session/:id', deleteSession);

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