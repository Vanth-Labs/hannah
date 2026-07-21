// src/retarget/boneMap.js
// Mapa SMPL-X (55 joints) -> huesos VRoid J_Bip_*. Confirmado contra el
// EXACT_MAP del calibrador del usuario y derivado del esqueleto de avatar.glb.
// jaw (22) no tiene hueso VRM (se anima por blendshape); ojos (23,24) los
// maneja la mirada procedural. Índices null = sin destino.

export const SMPLX_TO_VROID = {
    0:  'J_Bip_C_Hips',
    1:  'J_Bip_L_UpperLeg',
    2:  'J_Bip_R_UpperLeg',
    3:  'J_Bip_C_Spine',
    4:  'J_Bip_L_LowerLeg',
    5:  'J_Bip_R_LowerLeg',
    6:  'J_Bip_C_Chest',
    7:  'J_Bip_L_Foot',
    8:  'J_Bip_R_Foot',
    9:  'J_Bip_C_UpperChest',
    10: 'J_Bip_L_ToeBase',
    11: 'J_Bip_R_ToeBase',
    12: 'J_Bip_C_Neck',
    13: 'J_Bip_L_Shoulder',
    14: 'J_Bip_R_Shoulder',
    15: 'J_Bip_C_Head',
    16: 'J_Bip_L_UpperArm',
    17: 'J_Bip_R_UpperArm',
    18: 'J_Bip_L_LowerArm',
    19: 'J_Bip_R_LowerArm',
    20: 'J_Bip_L_Hand',
    21: 'J_Bip_R_Hand',
    // 22 jaw -> blendshape, 23/24 eyes -> gaze
    25: 'J_Bip_L_Index1',  26: 'J_Bip_L_Index2',  27: 'J_Bip_L_Index3',
    28: 'J_Bip_L_Middle1', 29: 'J_Bip_L_Middle2', 30: 'J_Bip_L_Middle3',
    31: 'J_Bip_L_Little1', 32: 'J_Bip_L_Little2', 33: 'J_Bip_L_Little3',   // pinky = Little
    34: 'J_Bip_L_Ring1',   35: 'J_Bip_L_Ring2',   36: 'J_Bip_L_Ring3',
    37: 'J_Bip_L_Thumb1',  38: 'J_Bip_L_Thumb2',  39: 'J_Bip_L_Thumb3',
    40: 'J_Bip_R_Index1',  41: 'J_Bip_R_Index2',  42: 'J_Bip_R_Index3',
    43: 'J_Bip_R_Middle1', 44: 'J_Bip_R_Middle2', 45: 'J_Bip_R_Middle3',
    46: 'J_Bip_R_Little1', 47: 'J_Bip_R_Little2', 48: 'J_Bip_R_Little3',
    49: 'J_Bip_R_Ring1',   50: 'J_Bip_R_Ring2',   51: 'J_Bip_R_Ring3',
    52: 'J_Bip_R_Thumb1',  53: 'J_Bip_R_Thumb2',  54: 'J_Bip_R_Thumb3',
};

// Grupos para depurar/corregir por analítica si algún eje sale con twist.
export const BONE_GROUPS = {
    spine: [0, 3, 6, 9, 12, 15],
    leftArm: [13, 16, 18, 20],
    rightArm: [14, 17, 19, 21],
    leftLeg: [1, 4, 7, 10],
    rightLeg: [2, 5, 8, 11],
    leftHand: [25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39],
    rightHand: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54],
};
