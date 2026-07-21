# hannah-frontend
## Setup / assets not included

```bash
npm install --legacy-peer-deps   # (peer conflict vite/plugin-basic-ssl)
npm run dev                      # https, port 5173
```

Excluded from the repo (add locally):
- `public/avatar.glb` — kept (the VRM). `public/smplx_avatar.glb` (debug) is excluded.
- `public/animations/*.fbx` — raw Mixamo clips (Adobe license). Download from Mixamo
  (FBX Binary, Without Skin, 30fps) into `public/animations/`, then bake:
  `node scripts/bake_mixamo.mjs` → regenerates `public/animations/baked/*.json` (committed).
