// src/pipeline/brain.js
// "Where should I think?" — the brain is chosen on FIRST RUN, in the window, not by the installer.
//
//   mode 'local'  -> Ollama on this machine (private, free). Needs Ollama reachable AND the model
//                    pulled; vision (moondream) and memory recall (nomic-embed) come with it.
//   mode 'cloud'  -> an OpenAI-compatible provider + key (Groq/OpenAI/Anthropic/OpenRouter).
//                    No local models: vision and recall are switched off.
//   mode ''       -> not chosen yet: the overlay shows the welcome screen; no turn runs.
//
// This module also installs Ollama PER USER (never system-wide, never sudo) and pulls models,
// as one background job at a time with progress the overlay polls. It never installs anything
// on its own: every step is a button the person pressed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const execFileP = promisify(execFile);

export const LOCAL_MODELS = {
  brain: 'qwen2.5:7b',        // ~4.7 GB
  vision: 'moondream',        // ~1.7 GB
  embed: 'nomic-embed-text',  // ~0.3 GB
};
const OLLAMA_DEFAULT = 'http://127.0.0.1:11434';
const RELEASES = 'https://github.com/ollama/ollama/releases/latest/download';

// Where a per-user Ollama goes when the app installs it (nothing outside $HOME / %LOCALAPPDATA%).
export function installDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hannah', 'ollama');
  return path.join(os.homedir(), '.local', 'share', 'hannah', 'ollama');
}

export const isLocalUrl = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(String(u || ''));

/** Ollama's base URL: the LLM base URL if it points at a local Ollama, else the default port. */
function ollamaBase() {
  const u = String(config.llm.baseUrl || '');
  if (isLocalUrl(u)) return u.replace(/\/v1\/?$/, '').replace(/\/$/, '');
  return OLLAMA_DEFAULT;
}

/** The `ollama` executable: PATH first (the user's own install), then ours. */
function ollamaBin() {
  const ours = process.platform === 'win32'
    ? [path.join(installDir(), 'ollama.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')]
    : [path.join(installDir(), 'bin', 'ollama'), path.join(installDir(), 'ollama'), path.join(os.homedir(), '.local', 'bin', 'ollama')];
  for (const p of ours) if (p && fs.existsSync(p)) return p;
  return 'ollama';   // rely on PATH; spawn errors are reported by the job
}

// ── status ─────────────────────────────────────────────────────────────────────────────
let ollamaCache = { at: 0, value: { reachable: false, models: [], url: OLLAMA_DEFAULT } };

/** Is Ollama answering, and with which models? Cached for a few seconds (the overlay polls). */
export async function ollamaStatus(force = false) {
  const url = ollamaBase();
  if (!force && Date.now() - ollamaCache.at < 4000 && ollamaCache.value.url === url) return ollamaCache.value;
  let value = { reachable: false, models: [], url };
  try {
    const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const j = await r.json();
      value = { reachable: true, url, models: (j.models || []).map((m) => m.name || m.model).filter(Boolean) };
    }
  } catch { /* down */ }
  ollamaCache = { at: Date.now(), value };
  return value;
}

/** `qwen2.5:7b` matches `qwen2.5:7b` and a bare `qwen2.5` matches `qwen2.5:latest`. */
export function hasModel(models, name) {
  const want = String(name || '').trim();
  if (!want) return false;
  return (models || []).some((m) => m === want || (!want.includes(':') && m === `${want}:latest`));
}

let hwCache = null;
/** What this machine can carry: NVIDIA VRAM (nvidia-smi), Apple Silicon, RAM. Computed once. */
export async function hardware() {
  if (hwCache) return hwCache;
  const hw = { platform: process.platform, arch: process.arch, ramGB: Math.round(os.totalmem() / 2 ** 30), gpu: null, appleSilicon: process.platform === 'darwin' && process.arch === 'arm64' };
  try {
    const { stdout } = await execFileP('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 });
    const [name, mem] = stdout.trim().split('\n')[0].split(',').map((s) => s.trim());
    if (name) hw.gpu = { name, vramGB: Math.round(Number(mem) / 1024) || null };
  } catch { /* no NVIDIA tooling */ }
  hwCache = hw;
  return hw;
}

/** local when the machine can run a 7B comfortably; cloud otherwise. Pure, tested. */
export function recommend(hw) {
  if (hw?.gpu?.vramGB >= 8) return 'local';
  if (hw?.appleSilicon && hw.ramGB >= 16) return 'local';
  return 'cloud';
}

/** Is the chosen brain actually usable? Pure, tested. */
export function computeConfigured({ mode, ollama, model, apiKey, baseUrl }) {
  if (mode === 'local') return !!ollama?.reachable && hasModel(ollama.models, model);
  if (mode === 'cloud') return !!apiKey && !isLocalUrl(baseUrl) && !!baseUrl;
  return false;
}

export async function status() {
  const [ollama, hw] = await Promise.all([ollamaStatus(), hardware()]);
  const mode = config.brain.mode || '';
  return {
    mode,
    configured: computeConfigured({ mode, ollama, model: config.llm.model, apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl }),
    model: config.llm.model,
    baseUrl: isLocalUrl(config.llm.baseUrl) ? '' : (config.llm.baseUrl || ''),
    hasKey: !!config.llm.apiKey && !isLocalUrl(config.llm.baseUrl),
    ollama: { ...ollama, installed: ollamaBin() !== 'ollama' || await onPath('ollama'), installDir: installDir() },
    hardware: hw,
    recommendation: recommend(hw),
    models: LOCAL_MODELS,
    vision: config.vision.provider,
    job: job ? { ...job } : null,
  };
}

async function onPath(bin) {
  try { await execFileP(process.platform === 'win32' ? 'where' : 'which', [bin], { timeout: 2000 }); return true; } catch { return false; }
}

/** True when a conversation turn may run at all (the orchestrator asks before the LLM). */
export function isReady() {
  const mode = config.brain.mode || '';
  if (mode === 'cloud') return computeConfigured({ mode, model: config.llm.model, apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl });
  if (mode === 'local') return computeConfigured({ mode, ollama: ollamaCache.value, model: config.llm.model });
  return false;
}

/**
 * Vision and memory recall follow the brain: with a cloud brain there is no local moondream /
 * nomic-embed, so they are off; with no brain chosen yet, everything waits. Called after every
 * settings change and at boot. The .env value is the ceiling (VISION_PROVIDER=off stays off).
 */
const envVision = config.vision.provider;
const envRecall = config.memory.recallEnabled;
export function syncBrain() {
  const mode = config.brain.mode || '';
  config.vision.provider = mode === 'local' ? envVision : 'off';
  config.memory.recallEnabled = mode === 'local' ? envRecall : false;
}

// ── jobs: install Ollama / start it / pull models ───────────────────────────────────────
let job = null;   // { kind, status: 'running'|'done'|'error', progress: 0..1|null, detail, error, startedAt }

function begin(kind, detail) {
  if (job?.status === 'running') throw Object.assign(new Error(`a ${job.kind} job is already running`), { status: 409 });
  job = { kind, status: 'running', progress: null, detail: detail || '', error: null, startedAt: Date.now() };
  return job;
}
const finish = (error) => { if (!job) return; job.status = error ? 'error' : 'done'; job.error = error ? String(error.message || error) : null; job.progress = error ? job.progress : 1; };

/** Download `url` to `file`, reporting progress on the job (content-length permitting). */
async function download(url, file) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
  const total = Number(r.headers.get('content-length')) || 0;
  let seen = 0;
  const meter = new Transform({ transform(chunk, _e, cb) { seen += chunk.length; if (total) job.progress = seen / total; cb(null, chunk); } });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { Readable } = await import('node:stream');
  await pipeline(Readable.fromWeb(r.body), meter, fs.createWriteStream(file));
}

async function run(bin, args, opts = {}) {
  return execFileP(bin, args, { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, ...opts });
}

/** Per-user Ollama install. Linux/macOS: the official tarball under ~/.local/share/hannah; Windows: winget (per-user) or the zip. */
export function startInstallOllama() {
  begin('install', 'downloading Ollama');
  (async () => {
    const dir = installDir();
    const tmp = path.join(os.tmpdir(), `hannah-ollama-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      if (process.platform === 'win32') {
        let ok = false;
        try {
          job.detail = 'installing with winget (per-user)'; job.progress = null;
          await run('winget', ['install', '-e', '--id', 'Ollama.Ollama', '--scope', 'user', '--silent', '--accept-source-agreements', '--accept-package-agreements']);
          ok = fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'));
        } catch { ok = false; }
        if (!ok) {
          job.detail = 'downloading Ollama (zip, ~1.4 GB)';
          const zip = path.join(tmp, 'ollama.zip');
          await download(`${RELEASES}/ollama-windows-amd64.zip`, zip);
          job.detail = 'extracting'; job.progress = null;
          fs.mkdirSync(dir, { recursive: true });
          await run('tar', ['-xf', zip, '-C', dir]);
        }
      } else {
        const asset = process.platform === 'darwin' ? 'ollama-darwin.tgz' : `ollama-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
        const tgz = path.join(tmp, asset);
        job.detail = `downloading ${asset}`;
        await download(`${RELEASES}/${asset}`, tgz);
        job.detail = 'extracting'; job.progress = null;
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        await run('tar', ['-xzf', tgz, '-C', dir]);
        // the launchers look for `ollama` on PATH: link it into ~/.local/bin (user-owned)
        const bin = fs.existsSync(path.join(dir, 'bin', 'ollama')) ? path.join(dir, 'bin', 'ollama') : path.join(dir, 'ollama');
        if (!fs.existsSync(bin)) throw new Error('ollama binary not found after extraction');
        fs.chmodSync(bin, 0o755);
        const linkDir = path.join(os.homedir(), '.local', 'bin');
        fs.mkdirSync(linkDir, { recursive: true });
        try { fs.rmSync(path.join(linkDir, 'ollama'), { force: true }); fs.symlinkSync(bin, path.join(linkDir, 'ollama')); } catch { /* PATH link is a nicety */ }
      }
      job.detail = 'starting'; job.progress = null;
      await startOllama();
      logger.info('Ollama installed per-user', { dir });
      finish();
    } catch (e) {
      logger.error('Ollama install failed', { message: e.message });
      finish(e);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  })();
  return job;
}

/** `ollama serve` detached in the user's session; resolves when /api/tags answers. */
export async function startOllama() {
  if ((await ollamaStatus(true)).reachable) return true;
  const bin = ollamaBin();
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env } });
  child.on('error', (e) => logger.warn('ollama serve could not start', { message: e.message, bin }));
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if ((await ollamaStatus(true)).reachable) return true;
  }
  throw new Error('Ollama did not answer on ' + ollamaBase());
}

/** Pull one or more models through Ollama's streaming API, in order, with progress. */
export function startPull(models) {
  const list = (Array.isArray(models) ? models : [models]).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('no model given'), { status: 400 });
  begin('pull', `pulling ${list[0]}`);
  (async () => {
    try {
      if (!(await ollamaStatus(true)).reachable) await startOllama();
      for (let i = 0; i < list.length; i++) {
        const name = list[i];
        job.detail = `${list.length > 1 ? `${i + 1}/${list.length} · ` : ''}${name}`; job.progress = null;
        const r = await fetch(`${ollamaBase()}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, stream: true }) });
        if (!r.ok || !r.body) throw new Error(`pull ${name}: HTTP ${r.status}`);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev; try { ev = JSON.parse(line); } catch { continue; }
            if (ev.error) throw new Error(`pull ${name}: ${ev.error}`);
            if (ev.total && ev.completed != null) job.progress = ((i + ev.completed / ev.total) / list.length);
          }
        }
        job.progress = (i + 1) / list.length;
      }
      ollamaCache.at = 0;
      finish();
    } catch (e) {
      logger.error('model pull failed', { message: e.message });
      finish(e);
    }
  })();
  return job;
}

export const currentJob = () => (job ? { ...job } : null);
export function _reset() { job = null; ollamaCache = { at: 0, value: { reachable: false, models: [], url: OLLAMA_DEFAULT } }; hwCache = null; }
