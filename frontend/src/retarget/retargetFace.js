// src/retarget/retargetFace.js
// Mapeos de la cara para avatares VRoid (blendshapes Fcl_*).
// La emoción y los visemas de Hannah usan un vocabulario tipo ARKit; aquí se
// traducen a las 57 formas VRoid que trae cualquier export de VRoid.

// Emoción (lo que emite el LLM) -> conjunto de blendshapes VRoid con peso.
export const EMOTION_TO_FCL = {
    neutral:   {},
    happy:     { Fcl_ALL_Joy: 0.7, Fcl_MTH_Joy: 0.3 },
    happiness: { Fcl_ALL_Joy: 0.7, Fcl_MTH_Joy: 0.3 },
    surprised: { Fcl_ALL_Surprised: 0.7 },
    surprise:  { Fcl_ALL_Surprised: 0.7 },
    thinking:  { Fcl_BRW_Angry: 0.35, Fcl_EYE_Spread: 0.15 },
    sad:       { Fcl_ALL_Sorrow: 0.7 },
    sadness:   { Fcl_ALL_Sorrow: 0.7 },
    angry:     { Fcl_ALL_Angry: 0.7 },
    anger:     { Fcl_ALL_Angry: 0.7 },
    curious:   { Fcl_BRW_Surprised: 0.4 },
    alert:     { Fcl_ALL_Surprised: 0.5 },
};

// Todas las keys de emoción posibles (para hacer decay de las inactivas).
export const ALL_EMOTION_FCL = Array.from(new Set(
    Object.values(EMOTION_TO_FCL).flatMap(Object.keys)
));

// Visema (código de lipsync.js) -> vocal VRoid. VRoid solo tiene 5 vocales,
// así que las consonantes se aproximan a la forma de boca más cercana.
export const VISEME_TO_FCL = {
    aa: 'Fcl_MTH_A',
    E:  'Fcl_MTH_E',
    I:  'Fcl_MTH_I',
    O:  'Fcl_MTH_O',
    U:  'Fcl_MTH_U',
    PP: 'Fcl_MTH_Close',  // bilabiales p/b/m -> boca cerrada
    FF: 'Fcl_MTH_I',      // labiodental -> boca estrecha
    TH: 'Fcl_MTH_E',
    DD: 'Fcl_MTH_E',
    kk: 'Fcl_MTH_A',
    CH: 'Fcl_MTH_I',
    SS: 'Fcl_MTH_I',
    nn: 'Fcl_MTH_E',
    RR: 'Fcl_MTH_A',
    sil: null,
};

export const ALL_VISEME_FCL = Array.from(new Set(
    Object.values(VISEME_TO_FCL).filter(Boolean)
));

export const BLINK_FCL = 'Fcl_EYE_Close';
