import { publicHostOnly } from '../../src/pipeline/tools.js';

describe('publicHostOnly — lo que el modelo puede leer por red', () => {
  test('direcciones internas: nunca', async () => {
    for (const u of ['http://127.0.0.1:8006/hannah/v0/tasks', 'http://localhost:3001/api/v1/settings', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8002/', 'http://100.64.0.1/', 'http://hannah.local/', 'ftp://example.com/']) {
      expect(await publicHostOnly(u)).not.toBe('');
    }
  });
  test('una IP pública pasa', async () => {
    expect(await publicHostOnly('https://8.8.8.8/')).toBe('');
  });
  test('un nombre que no resuelve se rechaza', async () => {
    expect(await publicHostOnly('https://definitely-not-a-real-host.invalid/')).toBe('unresolvable');
  });
});
