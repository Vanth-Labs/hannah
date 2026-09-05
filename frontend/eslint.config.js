// eslint.config.js — frontend (React + Vite, ESM). Flat config.
// Lo importante acá son las reglas de hooks: `exhaustive-deps` es justo lo que atrapa los
// efectos con dependencias mal declaradas (la clase de bug que sólo aparecía en runtime).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'public/**', 'scripts/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Reglas experimentales del React Compiler: NO aplican a este código. La escena 3D
      // (react-three-fiber) muta refs dentro de useFrame y usa Math.random para el idle
      // procedural — es el patrón correcto ahí, no un bug. Mantenemos las clásicas
      // (rules-of-hooks / exhaustive-deps), que son las que atrapan errores reales.
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^[A-Z_]' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },
  {
    files: ['vite.config.js', '*.config.js'],
    languageOptions: { globals: { ...globals.node }, sourceType: 'module' },
  },
];
