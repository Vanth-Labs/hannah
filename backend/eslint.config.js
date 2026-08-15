// eslint.config.js — backend (Node, ESM). Flat config.
// Objetivo: atrapar en CI/editor la clase de errores que antes solo aparecían hablándole al
// avatar (variables sin usar, símbolos inexistentes, promesas sueltas).
import js from '@eslint/js';

export default [
  {
    ignores: ['node_modules/**', 'data/**', 'logs/**', 'sidecar/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // Node
        process: 'readonly', console: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly',
        AbortSignal: 'readonly', AbortController: 'readonly', TextDecoder: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^req$|^res$|^next$', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    // Tests: jest expone sus globals.
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', test: 'readonly', it: 'readonly', expect: 'readonly',
        beforeAll: 'readonly', afterAll: 'readonly', beforeEach: 'readonly', afterEach: 'readonly',
        jest: 'readonly',
      },
    },
  },
];
