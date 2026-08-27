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
    shoulderRaise: 0.09,   // rad, collars lifted while co-speech plays (the motion model rolls them down)
    // Body-shape bones take the motion as a DELTA over the avatar's own rest (its shoulder
    // slope, its neck) instead of adopting SMPL-X's shape; limbs are absolute (see offsets.js).
    deltaBones: new Set(['spine', 'chest', 'upperChest', 'neck', 'head', 'leftShoulder', 'rightShoulder']),
    // Idle rest pose, from the model's own arm geometry: the upper arm hangs this far from
    // vertical (rad, outward), the forearm bends a bit further along the same axis.
    restArmFromVertical: 0.37, restForearmBend: 0.25,
};
