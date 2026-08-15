# hannah-frontend

Cliente de Hannah: React + Vite + react-three-fiber. Renderiza el avatar **VRoid/VRM**, captura
micrófono y cámara, y convierte lo que llega del backend en **voz sincronizada con la boca, el
cuerpo y la mirada**.

```bash
npm install --legacy-peer-deps   # obligatorio: vite 5 vs @vitejs/plugin-basic-ssl 2.3 (peer vite >=6)
npm run dev                      # https en :5173; el predev copia los assets del VAD
npm run build
npm run lint
```

Necesita el **backend en `:3001`**. En modo web se entra **siempre a través de Vite**, que proxea
`/api` y `/ws` hacia allí — el frontend usa rutas relativas y el backend sigue escuchando en
`127.0.0.1`, así que la terminal, las API keys y la memoria nunca quedan expuestas a la red. Lo
que se expone es Vite (`host: 0.0.0.0`), que es por donde entra el celular.

`HANNAH_HTTP=1` sirve HTTP en vez de HTTPS: es el modo que usa el launcher para el overlay. El
HTTPS existe porque `getUserMedia` (micrófono y cámara) solo funciona en contexto seguro cuando
entrás por IP desde otro dispositivo.

---

## Cómo llega una respuesta hasta la pantalla

Todo el camino vive en `src/hooks/useWebSocket.js`, que es el **dueño de la conexión**.

1. `POST /api/v1/session` → `{sessionId}` → se abre `ws://…/ws?sessionId=…`.
2. Por cada oración llega un `audio_chunk` con el **WAV completo** en base64 (por eso completo:
   se decodifica con `decodeAudioData`, que necesita el archivo entero), sus visemas y,
   opcionalmente, el motion.
3. El chunk se decodifica y entra en una **cola de reproducción**. `drainQueue` encadena
   `source.onended = drainQueue`: **una oración a la vez y en orden**.
4. Justo antes de `source.start()` se sella el tiempo del motion (`startedAt`) y se programan los
   visemas con `setTimeout`. **Esa es toda la sincronía audio↔cuerpo**: los visemas se programan
   cuando el chunk *empieza a sonar*, no cuando llega.
5. `VrmAvatar` lee el estado en su `useFrame` y aplica todo a 60fps.

**Barge-in**: hablar mientras Hannah habla corta la reproducción y manda `INTERRUPT`. Los timers
de visemas se registran para poder cancelarlos — incluido el de reposo, porque si no sobrevivía a
la interrupción y cerraba la boca a mitad de la frase siguiente.

## Estado: la regla de los selectores atómicos

Todo el estado que ve el avatar vive en un único store zustand (`src/store/hannahStore.js`).

> **Siempre suscribirse con selectores atómicos** (`useHannahStore(s => s.campo)`). Nunca
> `useHannahStore()` a secas.

No es estilo: en zustand v4 el hook sin selector devuelve el objeto entero y compara por
identidad, así que **cualquier** escritura re-renderiza a ese consumidor. Y los escritores son de
alta frecuencia — visemas (dos escrituras por fonema), mirada (~12 Hz), logs, motion por oración.
Suscribirse al store entero desde `App` re-renderizaba **todo el árbol, incluido el `<Canvas>` de
r3f**, a ritmo de visema.

Fuera de la UI el patrón es no suscribirse en absoluto: los hooks toman las acciones una vez con
`getState()`, y `VrmAvatar` lee sus seis campos con `getState()` **dentro** del `useFrame` — ese
bucle ya corre a 60fps, un re-render de React sería puro coste.

## El retarget: calculado, no adivinado

El movimiento llega como SMPL-X (T×165, axis-angle, 55 joints, 30fps) y el avatar es un VRoid con
huesos `J_Bip_*`. La corrección por hueso es:

```
vroid_local[j] = A_parent⁻¹ · quat(axis_angle[j]) · A_self[j]
```

**Los offsets `A` se calculan desde la geometría de los dos esqueletos en reposo**
(`scripts/compute_retarget_offsets.py`): posiciones reales de SMPL-X (`J_regressor @ v_template`)
y del VRoid (recorriendo el árbol del `.glb`), dirección hueso→hijo en ambos rigs, y de ahí una
base ortonormal. Se le pasa a cada rig **su propio eje "adelante"** — SMPL-X mira a +Z, VRoid a
−Z — así el giro de 180° queda horneado en el offset y los gestos salen por el frente de la malla,
no por la espalda.

> **La lección "zombie pose"**: un intento anterior mapeó SMPL-X sobre nombres de hueso ajenos
> adivinando la rotación de corrección. El resultado fue una pose contorsionada. El mapa de
> nombres existe (`retarget/boneMap.js`), pero **la rotación nunca se adivina**.

Sobre eso hay **cinco correcciones deliberadas**, todas por un motivo observado en el render:

| Zona | Qué se hace | Por qué |
|---|---|---|
| Pelvis | solo se conserva el giro en Y | el offset traía ~28° de pitch que ladeaba el cuerpo entero |
| Columna | se conserva la mitad | la generación encorva: "parece jorobada" |
| Pies y puntas | fijos al reposo | el movimiento gira las suelas hacia afuera; de pie van plantados |
| Dedos (30 índices) | fijos al reposo | el modelo es débil ahí (mucha dimensión, poca varianza): salen crispados |
| Hombros | abducción de 0.22 rad | el torso VRoid es más angosto que el de SMPL-X |

## El avatar, capa por capa

`VrmAvatar.jsx` es el **único** componente del avatar, y aplica todo en un solo `useFrame`, en
este orden: cuerpo co-speech o idle → gesto deliberado encima → auto-lookat → emoción → visemas →
parpadeo → mirada de ojos → respiración → spring bones. **El orden importa**: la mirada y el
gesto se mezclan *sobre* lo que dejó el co-speech, no lo reemplazan.

- **Visemas**: se traduce con `VISEME_TO_FCL` y se interpola rápido; el resto de morphs de boca
  van a cero. VRoid tiene pocas formas de boca, así que varios fonemas comparten destino.
- **Emoción**: el tag `[EMOTION:…]` del LLM se mapea a blendshapes `Fcl_*` con peso.
- **Gestos deliberados**: clips de Mixamo horneados a JSON (`scripts/bake_mixamo.mjs`) que se
  aplican por encima y reemplazan el co-speech durante esa oración.
- **Spring bones**: física verlet propia para las cadenas `J_Sec_*` (pelo, falda). No se usa el
  plugin de `@pixiv/three-vrm` en runtime: el retarget escribe directo sobre los huesos crudos.
  `pixiv` solo se usa **offline**, dentro del horneado de Mixamo.

## Entrada: micrófono y cámara

- **Push-to-talk**: `MediaRecorder` (webm) mientras mantenés el botón.
- **Manos libres**: VAD Silero local (`@ricky0123/vad-web`) que manda WAV a 16 kHz y, si detecta
  voz mientras Hannah habla, dispara el barge-in.
- Ambos usan la misma tripleta: `SPEECH_START` → binario → `SPEECH_END`.
- **Visión**: `useVision` manda un JPEG base64 cada 2 s reutilizando un solo canvas.

## Interfaz

`HUD.jsx` tiene toda la UI 2D: estado de conexión, dock flotante de cuatro botones, toast con la
salida real de los comandos, y el **modal de confirmación** de comandos destructivos. En modo web
suma la barra inferior clásica (push-to-talk, entrada de texto, visión) y el transcript flotante.

`SettingsPanel.jsx` es el panel ⚙ "traé tu propio modelo": proveedores de LLM/ASR/TTS, selector de
voces de Kokoro, atajos de voz y skills — todo contra la API del backend, **sin reiniciar nada**.
`TerminalPanel.jsx` es una terminal real (xterm.js) anclada abajo al 40% de la ventana, para poder
ver qué hizo Hannah sin abrir otra consola.

**Modo overlay**: una sola fuente de verdad, `src/lib/overlay.js` — `window.__HANNAH_DESKTOP__`
(inyectado por el preload de Electron) o `?overlay=1` en la query. Cambia el layout a widget.
De la misma manera, `src/lib/api.js` es la única fuente del base URL del backend (vacío en el
navegador, absoluto en Electron): **todo `fetch` tiene que usarlo**.

## Assets que no están en el repo

- `public/avatar.glb` — el VRM, el único avatar que se renderiza hoy.
- `public/vad/` — lo genera `predev` (`scripts/copy-vad-assets.mjs`), gitignorado.
- `public/animations/*.fbx` — clips crudos de Mixamo (licencia de Adobe). Bajalos de Mixamo
  (FBX Binary, Without Skin, 30fps) y horneá con `node scripts/bake_mixamo.mjs` → regenera
  `public/animations/baked/*.json` (esos sí se commitean).
- `public/smplx_avatar.glb` — solo para depurar, y ya no se renderiza. Se regenera con
  `hannah-backend/sidecar/motion/build_avatar.py` si alguna vez hace falta.

Ver también `../README.md` (mapa del workspace) y `../hannah-backend/README.md` (el otro lado del
WebSocket).
