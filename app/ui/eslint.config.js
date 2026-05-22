import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import noLowContrastText from './eslint-rules/no-low-contrast-text.js';

export default [
  { ignores: ['dist', 'playwright-report', 'test-results'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      'local': { rules: { 'no-low-contrast-text': noLowContrastText } },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'local/no-low-contrast-text': 'error',
      // React Compiler strict rules — downgrade to warnings until data-fetching
      // patterns are refactored to avoid setState-in-effect (requires Suspense or
      // useTransition migration across all detail pages).
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  {
    // Playwright E2E tests run in Node.js, not the browser
    files: ['e2e/**/*.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
