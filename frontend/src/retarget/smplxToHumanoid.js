// src/retarget/smplxToHumanoid.js
// SMPL-X (55 joints, the motion model's output) -> VRM humanoid bone names (the standard
// every VRM 0.x / 1.0 carries, whatever its raw bones are called). One map for all avatars.
// jaw (22) has no humanoid bone (mouth is expressions); eyes (23, 24) are driven by the
// VRM look-at, not by the motion.

export const SMPLX_TO_HUMANOID = {
    0: 'hips',
    1: 'leftUpperLeg', 2: 'rightUpperLeg',
    3: 'spine',
    4: 'leftLowerLeg', 5: 'rightLowerLeg',
    6: 'chest',
    7: 'leftFoot', 8: 'rightFoot',
    9: 'upperChest',
    10: 'leftToes', 11: 'rightToes',
    12: 'neck',
    13: 'leftShoulder', 14: 'rightShoulder',
    15: 'head',
    16: 'leftUpperArm', 17: 'rightUpperArm',
    18: 'leftLowerArm', 19: 'rightLowerArm',
    20: 'leftHand', 21: 'rightHand',
    25: 'leftIndexProximal', 26: 'leftIndexIntermediate', 27: 'leftIndexDistal',
    28: 'leftMiddleProximal', 29: 'leftMiddleIntermediate', 30: 'leftMiddleDistal',
    31: 'leftLittleProximal', 32: 'leftLittleIntermediate', 33: 'leftLittleDistal',
    34: 'leftRingProximal', 35: 'leftRingIntermediate', 36: 'leftRingDistal',
    37: 'leftThumbMetacarpal', 38: 'leftThumbProximal', 39: 'leftThumbDistal',
    40: 'rightIndexProximal', 41: 'rightIndexIntermediate', 42: 'rightIndexDistal',
    43: 'rightMiddleProximal', 44: 'rightMiddleIntermediate', 45: 'rightMiddleDistal',
    46: 'rightLittleProximal', 47: 'rightLittleIntermediate', 48: 'rightLittleDistal',
    49: 'rightRingProximal', 50: 'rightRingIntermediate', 51: 'rightRingDistal',
    52: 'rightThumbMetacarpal', 53: 'rightThumbProximal', 54: 'rightThumbDistal',
};

// SMPL-X kinematic parents (index -> parent index), 55-joint order.
export const SMPLX_PARENT = {
    0: -1, 1: 0, 2: 0, 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, 11: 8,
    12: 9, 13: 9, 14: 9, 15: 12, 16: 13, 17: 14, 18: 16, 19: 17, 20: 18, 21: 19,
    22: 15, 23: 15, 24: 15,
    25: 20, 26: 25, 27: 26, 28: 20, 29: 28, 30: 29, 31: 20, 32: 31, 33: 32,
    34: 20, 35: 34, 36: 35, 37: 20, 38: 37, 39: 38,
    40: 21, 41: 40, 42: 41, 43: 21, 44: 43, 45: 44, 46: 21, 47: 46, 48: 47,
    49: 21, 50: 49, 51: 50, 52: 21, 53: 52, 54: 53,
};

// Primary child used to define each bone's direction (bone -> child).
export const PRIMARY_CHILD = {
    0: 3, 3: 6, 6: 9, 9: 12, 12: 15, 13: 16, 16: 18, 18: 20, 20: 28,
    14: 17, 17: 19, 19: 21, 21: 43, 1: 4, 4: 7, 7: 10, 2: 5, 5: 8, 8: 11,
    25: 26, 26: 27, 28: 29, 29: 30, 31: 32, 32: 33, 34: 35, 35: 36, 37: 38, 38: 39,
    40: 41, 41: 42, 43: 44, 44: 45, 46: 47, 47: 48, 49: 50, 50: 51, 52: 53, 53: 54,
};

// Groups, for tuning and for the gesture filter (hips/legs never take a Mixamo clip).
export const LOWER_BODY = new Set([
    'hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg',
    'leftFoot', 'rightFoot', 'leftToes', 'rightToes',
]);
export const FEET_IDX = new Set(['7', '8', '10', '11']);
export const SPINE_IDX = new Set(['3', '6', '9']);
export const FINGER_IDX = new Set(Array.from({ length: 30 }, (_, i) => String(25 + i)));
