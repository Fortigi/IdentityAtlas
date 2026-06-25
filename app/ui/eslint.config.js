import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import noLowContrastText from './eslint-rules/no-low-contrast-text.js';
import noNativeDialogs from './eslint-rules/no-native-dialogs.js';
import noLegacyJargon from './eslint-rules/no-legacy-jargon.js';
import noHardcodedCrawlerMeta from './eslint-rules/no-hardcoded-crawler-meta.js';
import noRelativePackageImports from './eslint-rules/no-relative-package-imports.js';
import noDuplicateDarkColor from './eslint-rules/no-duplicate-dark-color.js';

// Files that still use native confirm()/alert()/prompt() (the pre-existing
// backlog). They're downgraded to a warning so CI stays green while new code
// is gated as an error. Remove a file from this list once it's migrated to an
// in-app dialog/toast. See the UI Style Guide § Enforcement.
const NATIVE_DIALOG_ALLOWLIST = [
  '**/components/AccessPackagesPage.jsx',
  '**/components/AdminPage.jsx',
  '**/components/RiskProfileWizard.jsx',
  '**/components/RolesPermissionsSection.jsx',
  '**/components/matrix/MatrixFilterWizard.jsx',
  '**/hooks/useEntityPage.js',
];

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
      'local': {
        rules: {
          'no-low-contrast-text': noLowContrastText,
          'no-native-dialogs': noNativeDialogs,
          'no-legacy-jargon': noLegacyJargon,
          'no-hardcoded-crawler-meta': noHardcodedCrawlerMeta,
          'no-relative-package-imports': noRelativePackageImports,
          'no-duplicate-dark-color': noDuplicateDarkColor,
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'local/no-low-contrast-text': 'error',
      // Flags two plain dark: utilities setting the same color property (the
      // audit's C1/C2/M6 class — the later one silently wins). The missing-hover
      // backlog (`hover:text-X dark:text-Y`) is now cleaned up, so this is an error.
      'local/no-duplicate-dark-color': 'error',
      'local/no-native-dialogs': 'error',
      'local/no-legacy-jargon': 'error',
      'local/no-hardcoded-crawler-meta': 'error',
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
    // Enforce '@ui/' path aliases in src/ — relative traversal ('../X') is a
    // fragile import style that breaks when files move. See app/ui/CLAUDE.md.
    // Test files are exempt: they may import ESLint rules from outside src/.
    files: ['src/**/*.{js,jsx}'],
    ignores: ['src/**/*.test.{js,jsx}', 'src/__tests__/**'],
    rules: { 'local/no-relative-package-imports': 'error' },
  },
  {
    // Pre-existing native-dialog offenders: warn (don't fail CI) until migrated.
    files: NATIVE_DIALOG_ALLOWLIST,
    rules: { 'local/no-native-dialogs': 'warn' },
  },
  {
    // The jargon rule definition, tests, and e2e specs legitimately contain the
    // banned terms (as patterns / assertions / test names) — don't flag them.
    files: ['eslint-rules/**', '**/*.test.{js,jsx}', 'e2e/**'],
    rules: { 'local/no-legacy-jargon': 'off' },
  },
  {
    // Playwright E2E tests run in Node.js, not the browser
    files: ['e2e/**/*.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
