import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// El token se genera en un archivo temporal para no tocar data/ del usuario.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hannah-auth-'));
process.env.HANNAH_UI_TOKEN_FILE = path.join(tmp, 'ui-token');
const { authorize, clientIp, isLoopback, uiToken, requireUiAuth } = await import('../../src/api/auth.js');

const req = (h = {}, remote = '127.0.0.1', url = '/api/v1/settings') => ({ headers: h, socket: { remoteAddress: remote }, url, path: url.replace('/api/v1', ''), method: 'POST' });

describe('UI auth — esta máquina entra, el resto con token', () => {
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('loopback real: sin token', () => {
    expect(authorize(req({}, '127.0.0.1')).ok).toBe(true);
    expect(authorize(req({}, '::1')).ok).toBe(true);
    expect(authorize(req({}, '::ffff:127.0.0.1')).ok).toBe(true);
  });
  test('detrás del proxy de Vite manda la ÚLTIMA IP de X-Forwarded-For', () => {
    expect(clientIp(req({ 'x-forwarded-for': '127.0.0.1' }))).toBe('127.0.0.1');
    // un cliente de la LAN que intenta colar su propio X-Forwarded-For: Vite añade la suya al final
    expect(clientIp(req({ 'x-forwarded-for': '127.0.0.1, 192.168.1.30' }))).toBe('192.168.1.30');
    expect(isLoopback('192.168.1.30')).toBe(false);
    expect(authorize(req({ 'x-forwarded-for': '127.0.0.1, 192.168.1.30' })).ok).toBe(false);
  });
  test('el token se genera una vez, 0600, y autoriza por cabecera o por query', () => {
    const t = uiToken();
    expect(t).toMatch(/^[0-9a-f]{48}$/);
    expect(fs.statSync(process.env.HANNAH_UI_TOKEN_FILE).mode & 0o777).toBe(0o600);
    expect(uiToken()).toBe(t);
    expect(authorize(req({ 'x-forwarded-for': '10.0.0.5', authorization: `Bearer ${t}` })).ok).toBe(true);
    expect(authorize(req({ 'x-forwarded-for': '10.0.0.5' }, '127.0.0.1', `/ws?sessionId=x&token=${t}`)).ok).toBe(true);
    expect(authorize(req({ 'x-forwarded-for': '10.0.0.5', authorization: 'Bearer nope' })).ok).toBe(false);
  });
  test('el middleware deja pasar /health y GET /avatar sin token, y rechaza el resto', () => {
    const next = jest.fn(); const res = { status: jest.fn(() => res), json: jest.fn(() => res) };
    requireUiAuth({ ...req({ 'x-forwarded-for': '10.0.0.5' }), path: '/health', method: 'GET' }, res, next);
    requireUiAuth({ ...req({ 'x-forwarded-for': '10.0.0.5' }), path: '/avatar', method: 'GET' }, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    requireUiAuth({ ...req({ 'x-forwarded-for': '10.0.0.5' }), path: '/settings', method: 'POST' }, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
