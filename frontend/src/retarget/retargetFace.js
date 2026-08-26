// src/retarget/retargetFace.js
// The face, through the VRM standard: expressions by their preset names (three-vrm maps the
// VRM 0.x presets of VRoid — joy→happy, sorrow→sad, a→aa… — onto the same names). Hannah's
// emotions and visemes use an ARKit-ish vocabulary; here they become VRM expression weights.
//
// Two layers:
//   1. EMOTION_TO_VRM / VISEME_TO_VRM: standard expressions, work on any VRM.
//   2. VROID_EXTRAS: raw VRoid morphs (Fcl_*) that add nuance (brows for "thinking") when the
//      model happens to have them. Optional; silently absent elsewhere.

export const EMOTION_TO_VRM = {
    neutral:   {},
    happy:     { happy: 0.7 },
    happiness: { happy: 0.7 },
    surprised: { surprised: 0.7 },
    surprise:  { surprised: 0.7 },
    thinking:  { relaxed: 0.25 },
    sad:       { sad: 0.7 },
    sadness:   { sad: 0.7 },
    angry:     { angry: 0.7 },
    anger:     { angry: 0.7 },
    curious:   { surprised: 0.4 },
    alert:     { surprised: 0.5 },
};
export const ALL_EMOTION_VRM = Array.from(new Set(Object.values(EMOTION_TO_VRM).flatMap(Object.keys)));

// Viseme (lipsync.js code) -> VRM mouth expression. VRM has five vowels; consonants take
// the nearest mouth shape; PP (bilabials) and sil = everything at zero, i.e. closed.
export const VISEME_TO_VRM = {
    aa: 'aa', E: 'ee', I: 'ih', O: 'oh', U: 'ou',
    PP: null, FF: 'ih', TH: 'ee', DD: 'ee', kk: 'aa', CH: 'ih', SS: 'ih', nn: 'ee', RR: 'aa',
    sil: null,
};
export const ALL_VISEME_VRM = ['aa', 'ih', 'ou', 'ee', 'oh'];
export const BLINK_VRM = 'blink';

// Raw VRoid morphs layered on top when present (brows, eye spread). Keyed by emotion.
export const VROID_EXTRAS = {
    thinking: { Fcl_BRW_Angry: 0.35, Fcl_EYE_Spread: 0.15 },
    curious:  { Fcl_BRW_Surprised: 0.4 },
};
export const ALL_EXTRA_MORPHS = Array.from(new Set(Object.values(VROID_EXTRAS).flatMap(Object.keys)));

/**
 * Resolve an expression name on this VRM: preset first, then a custom expression with the
 * same name (VRoid exports "Surprised" as a custom, not a preset, in VRM 0.x), case-insensitive.
 * Returns the name to pass to expressionManager.setValue, or null if the model lacks it.
 */
export function resolveExpression(vrm, name) {
    const em = vrm?.expressionManager;
    if (!em) return null;
    if (em.presetExpressionMap?.[name]) return name;
    const custom = em.customExpressionMap || {};
    if (custom[name]) return name;
    const lower = name.toLowerCase();
    for (const key of Object.keys(custom)) if (key.toLowerCase() === lower) return key;
    return null;
}
