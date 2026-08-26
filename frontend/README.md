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

## The retarget: computed, not guessed

The motion arrives as SMPL-X (T×165, axis-angle, 55 joints, 30fps) and the avatar is a VRoid with
`J_Bip_*` bones. The per-bone correction is:

```
vroid_local[j] = A_parent⁻¹ · quat(axis_angle[j]) · A_self[j]
```

**The `A` offsets are computed from the geometry of the two skeletons in their rest pose**
(`scripts/compute_retarget_offsets.py`): real SMPL-X positions (`J_regressor @ v_template`) and
VRoid ones (walking the `.glb` tree), bone→child direction in both rigs, and from there an
orthonormal basis. Each rig is given **its own "forward" axis** — SMPL-X faces +Z, VRoid −Z — so the
180° flip is baked into the offset and the gestures come out the front of the mesh, not out its
back.

> **The "zombie pose" lesson**: an earlier attempt mapped SMPL-X onto foreign bone names by guessing
> the correction rotation. The result was a contorted pose. The name map exists
> (`retarget/boneMap.js`), but **the rotation is never guessed**.

On top of that there are **five deliberate corrections**, all of them for a reason observed in the
render:

| Zone | What we do | Why |
|---|---|---|
| Pelvis | keep only the Y rotation | the offset brought ~28° of pitch that tilted the whole body |
| Spine | keep half of it | the generated motion hunches: "she looks hunchbacked" |
| Feet and toes | pin to the rest pose | the motion splays the soles outwards; when she is standing they should stay planted |
| Fingers (30 indices) | pin to the rest pose | the model is weak there (many dimensions, little variance): they come out clenched |
| Shoulders | add 0.22 rad of abduction | the VRoid torso is narrower than SMPL-X's |

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
