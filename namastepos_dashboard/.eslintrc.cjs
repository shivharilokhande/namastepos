// NamastePOS dashboard — ESLint (D-17, 2026-09-05).
//
// `npm run lint` had never worked for this package: the devDependencies
// (eslint 8 + @typescript-eslint 7 + react-hooks + react-refresh) were
// installed but no config existed, so eslint exited 2 and CI only ran tsc.
// This is the standard Vite React-TS ruleset, the same plugin set the admin
// package declares. Rules that would flag the existing codebase in bulk are
// kept at "warn" so the gate is 0 ERRORS today and the warnings burn down
// over time (mirrors the backend's 190-warning baseline policy).
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: [
    'dist', 'dist_new', 'node_modules', '.eslintrc.cjs',
    'tests', 'testsprite_tests', 'playwright.config.ts',
    'postcss.config.js', 'tailwind.config.js',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    // Codebase-wide baseline: `any` is used at ~every API boundary today.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', {
      argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none',
    }],
    // `catch {}` with a comment is the house style for best-effort calls.
    'no-empty': ['error', { allowEmptyCatch: true }],
    'react-hooks/exhaustive-deps': 'warn',
  },
};
