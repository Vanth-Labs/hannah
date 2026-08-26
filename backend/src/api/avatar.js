// src/api/avatar.js
// The user's avatar, if they uploaded one: data/avatar.vrm (gitignored, like the rest of
// data/). The frontend asks for it first and falls back to the bundled one; the ⚙ panel
// uploads and removes it. Only files that carry the VRM extension are accepted: a plain glb
// has no humanoid map or expressions and would render as a broken doll.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../state/dataDir.js';

export const AVATAR_PATH = path.join(DATA_DIR, 'avatar.vrm');
export const MAX_AVATAR_BYTES = 256 * 1024 * 1024;

/**
 * Pure: is this buffer a glTF binary whose JSON chunk declares the VRM extension (0.x `VRM`
 * or 1.0 `VRMC_vrm`)? Reads the header and the JSON chunk only.
 */
export function isVrmBinary(buf) {
  if (!buf || buf.length < 20) return false;
  if (buf.toString('ascii', 0, 4) !== 'glTF') return false;
  const jsonLen = buf.readUInt32LE(12);
  const jsonType = buf.readUInt32LE(16);
  if (jsonType !== 0x4e4f534a /* 'JSON' */ || jsonLen <= 0 || 20 + jsonLen > buf.length) return false;
  const head = buf.toString('utf8', 20, 20 + Math.min(jsonLen, 4 * 1024 * 1024));
  // extensionsUsed lists the VRM extension; matching the quoted name avoids false positives
  // on node names that merely contain "VRM".
  return /"extensionsUsed"\s*:\s*\[[^\]]*"(VRM|VRMC_vrm)"/.test(head);
}

/** Tries to read the model's display name from the JSON chunk (VRM 0: meta.title; VRM 1: meta.name). */
export function vrmName(buf) {
  try {
    const jsonLen = buf.readUInt32LE(12);
    const g = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    return g?.extensions?.VRMC_vrm?.meta?.name || g?.extensions?.VRM?.meta?.title || null;
  } catch { return null; }
}

function stat() {
  try { return fs.statSync(AVATAR_PATH); } catch { return null; }
}

export const readAvatar = async (req, res) => {
  const st = stat();
  if (!st) return res.status(404).json({ error: 'no_custom_avatar' });
  res.set('Content-Type', 'model/gltf-binary');
  res.set('Content-Length', String(st.size));
  res.set('ETag', `"${st.mtimeMs}-${st.size}"`);
  res.set('Cache-Control', 'no-cache');
  if (req.method === 'HEAD') return res.status(200).end();
  return fs.createReadStream(AVATAR_PATH).pipe(res);
};

export const avatarInfo = async (req, res) => {
  const st = stat();
  if (!st) return res.status(200).json({ custom: false });
  let name = null;
  try {
    const fd = fs.openSync(AVATAR_PATH, 'r');
    const head = Buffer.alloc(Math.min(st.size, 4 * 1024 * 1024));
    fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
    name = vrmName(head);
  } catch { /* name is optional */ }
  return res.status(200).json({ custom: true, name, size: st.size, updatedAt: st.mtimeMs });
};

export const writeAvatar = async (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty_body' });
  if (!isVrmBinary(buf)) return res.status(400).json({ error: 'not_a_vrm', message: 'The file is not a VRM (a .vrm, or a .glb with the VRM extension).' });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${AVATAR_PATH}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, AVATAR_PATH);   // atomic: the frontend never reads a half-written file
  return res.status(200).json({ custom: true, name: vrmName(buf), size: buf.length });
};

export const removeAvatar = async (req, res) => {
  try { fs.unlinkSync(AVATAR_PATH); } catch { /* already gone */ }
  return res.status(200).json({ custom: false });
};
