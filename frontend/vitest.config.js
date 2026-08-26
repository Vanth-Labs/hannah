import { defineConfig } from 'vitest/config';

// Tests puros de la matemática del retarget + una prueba headless con three-vrm en Node.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 30000,
  },
});
