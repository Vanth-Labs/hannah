# hannah-frontend

Hannah's client: React + Vite + react-three-fiber. It renders the **VRoid/VRM** avatar, captures
microphone and camera, and turns whatever arrives from the backend into **voice synced to mouth,
body and gaze**.

```bash
npm install --legacy-peer-deps   # required: vite 5 vs @vitejs/plugin-basic-ssl 2.3 (peer wants vite >=6)
npm run dev                      # https on :5173; predev copies the VAD assets
npm run build
npm run lint
```

It needs the **backend on `:3001`**. In web mode you always go in **through Vite**, which proxies
`/api` and `/ws` over there — the frontend uses relative URLs and the backend keeps listening on
`127.0.0.1`, so the terminal, the API keys and the memory are never exposed to the network. What is
exposed is Vite (`host: 0.0.0.0`), which is how the phone gets in.

`HANNAH_HTTP=1` serves HTTP instead of HTTPS: that is the mode the launcher uses for the overlay.
HTTPS is there because `getUserMedia` (microphone and camera) only works in a secure context when
you connect by IP from another device.

---

## How a response makes it to the screen

The whole path lives in `src/hooks/useWebSocket.js`, which is the **owner of the connection**.

1. `POST /api/v1/session` → `{sessionId}` → `ws://…/ws?sessionId=…` is opened.
2. For each sentence an `audio_chunk` arrives with the **complete WAV** in base64 (complete for a
   reason: it is decoded with `decodeAudioData`, which needs the whole file), its visemes and,
   optionally, the motion.
3. The chunk is decoded and enters a **playback queue**. `drainQueue` chains
   `source.onended = drainQueue`: **one sentence at a time and in order**.
4. Right before `source.start()` the motion time is stamped (`startedAt`) and the visemes are
   scheduled with `setTimeout`. **That is the entirety of the audio↔body sync**: visemes are
   scheduled when the chunk *starts sounding*, not when it arrives.
5. `VrmAvatar` reads the state in its `useFrame` and applies everything at 60fps.

**Barge-in**: speaking while Hannah speaks cuts the playback and sends `INTERRUPT`. The viseme
timers are registered so they can be cancelled — including the rest-pose one, which otherwise used
to survive the interruption and shut the mouth halfway through the next sentence.

## State: the atomic-selector rule

All the state the avatar sees lives in a single zustand store (`src/store/hannahStore.js`).

> **Always subscribe with atomic selectors** (`useHannahStore(s => s.field)`). Never plain
> `useHannahStore()`.

This is not a style preference: in zustand v4 the hook without a selector returns the whole object
and compares by identity, so **any** write re-renders that consumer. And the writers are
high-frequency — visemes (two writes per phoneme), gaze (~12 Hz), logs, motion per sentence.
Subscribing to the whole store from `App` re-rendered **the entire tree, including r3f's
`<Canvas>`**, at viseme rate.

Outside the UI the pattern is not to subscribe at all: the hooks grab the actions once with
`getState()`, and `VrmAvatar` reads its six fields with `getState()` **inside** the `useFrame` —
that loop already runs at 60fps, so a React re-render would be pure overhead.

## Any VRM: the retarget is computed at load, not guessed

The avatar is **any VRM** — 0.x (VRoid Studio exports) or 1.0 — as a `.vrm` or a `.glb` that
carries the VRM extension. A plain glb without it (Mixamo, Sketchfab, a bare Blender export) is
refused on purpose: it has no humanoid map and no expressions, and guessing bones by name is how
the "zombie pose" happened. Everything below goes through `@pixiv/three-vrm`:

- **Bones**: the motion is applied to the VRM's *normalized* humanoid
  (`vrm.humanoid.getNormalizedBoneNode('leftUpperArm')`, …): standard names, identity rest pose
  on every model. `vrm.update(delta)` copies it onto the real bones, whatever they are called.
- **Face**: `vrm.expressionManager` presets (`happy`, `sad`, `angry`, `surprised`, `relaxed`,
  the `aa/ih/ou/ee/oh` visemes, `blink`). three-vrm maps VRoid's VRM 0 presets onto the same
  names; VRoid's extra brow morphs (`Fcl_BRW_*`) are layered on top only when present
  (`retarget/retargetFace.js`).
- **Look-at and spring bones**: `vrm.lookAt` (bone- or expression-based, whatever the model
  ships) with a target placed from the cursor; `vrm.springBoneManager` with the file's own
  hair/skirt parameters.

The motion arrives as SMPL-X (T×165, axis-angle, 55 joints, 30 fps). The per-bone correction is

```
local[j] = A[parent]⁻¹ · quat(axis_angle[j]) · A[j]
```

and **the `A` offsets are computed from the geometry of the two rest poses when the model
loads** (`src/retarget/offsets.js`): SMPL-X rest joint positions (`src/retarget/smplxRest.json`,
55 points exported once by `scripts/export_smplx_rest.py` — the mesh is never shipped) and the
VRM's normalized rest positions, bone→child direction in both rigs, and from there an
orthonormal basis. Each rig gets **its own forward axis** — SMPL-X faces +Z, a VRM 1.0 faces +Z,
a VRM 0.x faces −Z in its own frame — so the facing (including the 180° turn a VRoid needs) is
baked into the hips offset and gestures come out of the front of the mesh. `scripts/
check_offsets.mjs` shows the port reproduces the retired Python script's numbers for the
bundled avatar to 0.1°. `scripts/probe_vrm.mjs <file>` prints what a VRM brings (bones,
expressions, springs) before you try it.

On top of that there are **five deliberate corrections** (`src/retarget/tuning.js`), all for a
reason observed in the render, and all expressed in normalized space so they mean the same on
any avatar:

| Zone | What we do | Why |
|---|---|---|
| Pelvis | keep only the Y rotation | the offset brought ~28° of pitch that tilted the whole body |
| Spine | keep half of it | the generated motion hunches: "she looks hunchbacked" |
| Feet and toes | pin to the rest pose | the motion splays the soles outwards; when she is standing they should stay planted |
| Fingers (30 joints) | pin to the rest pose | the model is weak there (many dimensions, little variance): they come out clenched |
| Shoulders | add 0.22 rad of abduction | the VRoid torso is narrower than SMPL-X's |

Deliberate gestures (`public/animations/baked/*.json`, from Mixamo via `scripts/bake_mixamo.mjs`)
are stored as normalized-bone quaternions in the VRM 1.0 local frame, keyed by humanoid name;
for a VRM 0.x the X/Z components are mirrored at play time.

**Changing the avatar**: the ⚙ panel's *Look* card uploads a VRM to the backend
(`PUT /api/v1/avatar` → `data/avatar.vrm`); `Scene.jsx` asks `HEAD /api/v1/avatar` on start and
falls back to the bundled `public/avatar.glb`.

## The avatar, layer by layer

`VrmAvatar.jsx` is the **only** avatar component, and it applies everything in a single `useFrame`,
in this order: co-speech or idle body → deliberate gesture on top → auto-lookat → emotion → visemes
→ blinking → eye gaze → breathing → spring bones. **The order matters**: gaze and gesture are mixed
*over* whatever the co-speech left behind; they do not replace it.

- **Visemes**: translated with `VISEME_TO_FCL` and interpolated fast; the rest of the mouth morphs
  go to zero. VRoid has few mouth shapes, so several phonemes share a target.
- **Emotion**: the LLM's `[EMOTION:…]` tag is mapped to `Fcl_*` blendshapes with a weight.
- **Deliberate gestures**: Mixamo clips baked to JSON (`scripts/bake_mixamo.mjs`) that are applied
  on top and replace the co-speech during that sentence.
- **Spring bones**: our own Verlet physics for the `J_Sec_*` chains (hair, skirt). The
  `@pixiv/three-vrm` plugin is not used at runtime: the retarget writes straight onto the raw bones.
  `pixiv` is only used **offline**, inside the Mixamo bake.

## Input: microphone and camera

- **Push-to-talk**: `MediaRecorder` (webm) while you hold the button.
- **Hands-free**: local Silero VAD (`@ricky0123/vad-web`) that sends WAV at 16 kHz and, if it detects
  voice while Hannah is speaking, triggers the barge-in.
- Both use the same triplet: `SPEECH_START` → binary → `SPEECH_END`.
- **Vision**: `useVision` sends a base64 JPEG every 2 s reusing a single canvas.

## Interface

`HUD.jsx` holds all the 2D UI: connection status, floating dock of four buttons, toast with the real
command output, and the **confirmation modal** for destructive commands. In web mode it adds the
classic bottom bar (push-to-talk, text input, vision) and the floating transcript.

`SettingsPanel.jsx` is the ⚙ panel. The top is for people, not developers — three cards, one
decision each: **Brain** ("on my PC" or a cloud provider + key), **Voice** (language, a voice
with a human name, and a *Listen* button backed by `GET /tts/preview`), **Hands** (agent status,
its key, one line of privacy). Everything else — base URLs, model ids, sidecars, persona, ASR,
voice shortcuts, skills — lives under a folded **Advanced**. Both views write the same form and
save with one button, against the backend API, **without restarting anything**; a blank field
means "keep".
`TerminalPanel.jsx` is a real terminal (xterm.js) docked at the bottom at 40% of the window, so you
can see what Hannah did without opening another console.

**Overlay mode**: a single source of truth, `src/lib/overlay.js` — `window.__HANNAH_DESKTOP__`
(injected by Electron's preload) or `?overlay=1` in the query. It switches the layout to widget.
In the same way, `src/lib/api.js` is the single source of truth for the backend base URL (empty in
the browser, absolute in Electron): **every `fetch` has to use it**.

## Assets that are not in the repo

- `public/avatar.glb` — the VRM, the only avatar rendered today.
- `public/vad/` — generated by `predev` (`scripts/copy-vad-assets.mjs`), gitignored.
- `public/animations/*.fbx` — raw Mixamo clips (Adobe license). Download them from Mixamo
  (FBX Binary, Without Skin, 30fps) and bake with `node scripts/bake_mixamo.mjs` → it regenerates
  `public/animations/baked/*.json` (those do get committed).
- `public/smplx_avatar.glb` — for debugging only, and no longer rendered. It is regenerated with
  `hannah-backend/sidecar/motion/build_avatar.py` if it is ever needed.

See also `../README.md` (workspace map) and `../hannah-backend/README.md` (the other side of the
WebSocket).
