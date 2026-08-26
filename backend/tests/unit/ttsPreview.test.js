import { previewSample } from '../../src/api/tts.js';

describe('previewSample — frase de muestra por idioma de la voz', () => {
  test('el prefijo elige el idioma', () => {
    expect(previewSample('ef_dora')).toMatch(/^Hola, soy Hannah/);
    expect(previewSample('af_heart')).toMatch(/^Hi, I'm Hannah/);
    expect(previewSample('bm_george')).toMatch(/^Hi, I'm Hannah/);
    expect(previewSample('ff_siwis')).toMatch(/^Bonjour/);
  });
  test('un id que no es de Kokoro se rechaza (nunca llega al sidecar)', () => {
    expect(previewSample('')).toBeNull();
    expect(previewSample('../etc/passwd')).toBeNull();
    expect(previewSample('AF_HEART')).toBeNull();
    expect(previewSample('voice id with spaces')).toBeNull();
  });
  test('prefijo desconocido cae al inglés', () => {
    expect(previewSample('qf_x')).toMatch(/^Hi, I'm Hannah/);
  });
});
