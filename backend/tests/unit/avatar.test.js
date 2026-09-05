import { isVrmBinary, vrmName } from '../../src/api/avatar.js';

// A minimal glTF binary: 12-byte header + one JSON chunk.
function glb(json) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (body.length % 4)) % 4;
  const chunk = Buffer.concat([body, Buffer.alloc(pad, 0x20)]);
  const header = Buffer.alloc(20);
  header.write('glTF', 0, 'ascii'); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, chunk]);
}

describe('avatar upload guard — only files with the VRM extension', () => {
  test('a VRM 0.x (VRoid) and a VRM 1.0 pass', () => {
    expect(isVrmBinary(glb({ extensionsUsed: ['KHR_materials_unlit', 'VRM'], extensions: { VRM: { meta: { title: 'Anna' } } } }))).toBe(true);
    expect(isVrmBinary(glb({ extensionsUsed: ['VRMC_vrm', 'VRMC_springBone'], extensions: { VRMC_vrm: { meta: { name: 'Seed-san' } } } }))).toBe(true);
  });
  test('a plain glb (Mixamo, Sketchfab) is refused', () => {
    expect(isVrmBinary(glb({ extensionsUsed: ['KHR_materials_unlit'], nodes: [{ name: 'VRM_armature' }] }))).toBe(false);
    expect(isVrmBinary(glb({ nodes: [] }))).toBe(false);
  });
  test('garbage is refused without throwing', () => {
    expect(isVrmBinary(Buffer.from('hello'))).toBe(false);
    expect(isVrmBinary(Buffer.alloc(0))).toBe(false);
    expect(isVrmBinary(Buffer.from('glTF' + 'x'.repeat(30)))).toBe(false);
  });
  test('the display name comes from either meta', () => {
    expect(vrmName(glb({ extensionsUsed: ['VRM'], extensions: { VRM: { meta: { title: 'Anna' } } } }))).toBe('Anna');
    expect(vrmName(glb({ extensionsUsed: ['VRMC_vrm'], extensions: { VRMC_vrm: { meta: { name: 'Seed-san' } } } }))).toBe('Seed-san');
    expect(vrmName(Buffer.from('nope'))).toBeNull();
  });
});
