// src/components/springBones.js
// Física ligera de spring bones para las cadenas J_Sec_* del VRM (pelo/falda/busto).
// Algoritmo estándar tipo VRM (verlet sobre la "cola" de cada hueso), corriendo sobre
// el árbol de huesos crudo — NO usa el plugin de pixiv, así no toca el retarget humano.
import * as THREE from 'three';

const _jointPos = new THREE.Vector3();
const _parentQ = new THREE.Quaternion();
const _parentQinv = new THREE.Quaternion();
const _restDir = new THREE.Vector3();
const _restTail = new THREE.Vector3();
const _inertia = new THREE.Vector3();
const _next = new THREE.Vector3();
const _worldDir = new THREE.Vector3();
const _localDir = new THREE.Vector3();
const _scale = new THREE.Vector3();
const GRAVITY = new THREE.Vector3(0, -1, 0);

// Parámetros por tipo de cadena (ajustables). stiffness = fuerza que regresa al reposo;
// drag = pérdida de inercia (más alto = menos rebote); gravity = caída.
function paramsFor(name) {
    // drag alto = amortigua el rebote (evita el "gelatinoso"); stiffness = regresa al reposo.
    if (name.includes('Hair')) return { stiffness: 0.30, drag: 0.55, gravity: 0.0015 };
    if (name.includes('Bust')) return { stiffness: 0.35, drag: 0.50, gravity: 0.001 };
    return { stiffness: 0.20, drag: 0.45, gravity: 0.0025 }; // falda
}

// Construye la lista de joints: cada hueso J_Sec_ que tiene un hijo (su "cola").
export function buildSpringBones(root) {
    const joints = [];
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
        if (!o.name || !o.name.startsWith('J_Sec')) return;
        const child = o.children && o.children[0];
        if (!child) return; // punta de la cadena (sin cola) -> no simula
        const boneAxis = child.position.clone();       // dirección a la cola en espacio local
        const length = boneAxis.length();
        if (length < 1e-5) return;
        boneAxis.normalize();
        o.updateWorldMatrix(true, false);
        const tail = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld);
        joints.push({
            bone: o,
            restRot: o.quaternion.clone(),
            boneAxis, length,
            currentTail: tail.clone(),
            prevTail: tail.clone(),
            ...paramsFor(o.name),
        });
    });
    return joints;
}

export function updateSpringBones(joints, delta) {
    // normaliza a ~60fps para estabilidad (evita explotar en frames largos)
    const step = Math.min(delta, 1 / 30) * 60;
    for (const j of joints) {
        const bone = j.bone;
        const parent = bone.parent;
        parent.updateWorldMatrix(true, false);
        parent.matrixWorld.decompose(_jointPos, _parentQ, _scale); // pose del padre (ya animado)

        // posición mundial del joint = padreWorld * posLocal
        _jointPos.copy(bone.position).applyMatrix4(parent.matrixWorld);

        // dirección de reposo de la cola (en mundo) y su posición de reposo
        _restDir.copy(j.boneAxis).applyQuaternion(_parentQ).applyQuaternion(j.restRot).normalize();
        _restTail.copy(_restDir).multiplyScalar(j.length).add(_jointPos);

        // verlet: inercia amortiguada + resorte hacia el reposo + gravedad
        _inertia.copy(j.currentTail).sub(j.prevTail).multiplyScalar(1 - j.drag);
        _next.copy(j.currentTail)
            .add(_inertia)
            .add(_restTail.sub(j.currentTail).multiplyScalar(j.stiffness * step))
            .add(GRAVITY.clone().multiplyScalar(j.gravity * step));

        // restringir a la longitud del hueso desde el joint
        _next.sub(_jointPos);
        if (_next.lengthSq() < 1e-10) _next.copy(_restDir).multiplyScalar(j.length);
        else _next.normalize().multiplyScalar(j.length);
        _next.add(_jointPos);

        j.prevTail.copy(j.currentTail);
        j.currentTail.copy(_next);

        // orientar el hueso para que su boneAxis apunte a la cola
        _worldDir.copy(_next).sub(_jointPos).normalize();
        _parentQinv.copy(_parentQ).invert();
        _localDir.copy(_worldDir).applyQuaternion(_parentQinv).normalize();
        bone.quaternion.setFromUnitVectors(j.boneAxis, _localDir);
    }
}
