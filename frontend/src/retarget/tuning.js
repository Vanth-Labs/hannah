// src/retarget/tuning.js
// The deliberate corrections on top of the computed retarget. Every one of them exists for a
// reason seen in the render (see README, "five deliberate corrections"). They act in the
// VRM's normalized space, where a radian means the same thing on every avatar — but if a
// particular model needs a different number, this is the one place to change it.
export const TUNING = {
    pelvisYawOnly: true,   // keep the pelvis vertical: drop the pitch the offset brings (~28° on VRoid)
    spineKeep: 0.5,        // fraction of the generated spine motion kept (the model hunches)
    pinFeet: true,         // ankles and toes stay at rest (the motion splays the soles)
    pinFingers: true,      // fingers stay at rest (the model is weak there: clenched, shaky)
    shoulderAbduct: 0.22,  // rad, upper arms pushed away from a torso wider than SMPL-X's
    // Idle rest pose (arms down), on normalized nodes: rest is T-pose for every VRM.
    restArmZ: 1.2, restForearmZ: 0.25,
};
