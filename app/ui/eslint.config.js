import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import noLowContrastText from './eslint-rules/no-low-contrast-text.js';
import noNativeDialogs from './eslint-rules/no-native-dialogs.js';
import noLegacyJargon from './eslint-rules/no-legacy-jargon.js';
import noHardcodedCrawlerMeta from './eslint-rules/no-hardcoded-crawler-meta.js';

// Files that still use native confirm()/alert()/prompt() (the pre-existing
// backlog). They're downgraded to a warning so CI stays green while new code
// is gated as an error. Remove a file from this list once it's migrated to an
// in-app dialog/toast. See the UI Style Guide § Enforcement.
const NATIVE_DIALOG_ALLOWLIST = [
  '**/components/AccessPackagesPage.jsx',
  '**/components/AdminPage.jsx',
  '**/components/CrawlersPage.jsx',
  '**/components/RiskProfileWizard.jsx',
  '**/components/RolesPermissionsSection.jsx',
  '**/components/matrix/MatrixFilterWizard.jsx',
  '**/hooks/useEntityPage.js',
];

// CrawlersPage.jsx still has hardcoded CRAWLER_TYPES entries for crawlers not
// yet migrated to the manifest-based plugin system (entra-id, csv, demo,
// custom-connector). Downgrade the rule to warn so CI stays green during the
// migration. Remove this override once all crawlers have their own CrawlerMeta.js.
const CRAWLER_META_MIGRATION_PENDING = [
  '**/components/CrawlersPage.jsx',
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
        },
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'local/no-low-contrast-text': 'error',
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
    // Pre-existing native-dialog offenders: warn (don't fail CI) until migrated.
    files: NATIVE_DIALOG_ALLOWLIST,
    rules: { 'local/no-native-dialogs': 'warn' },
  },
  {
    // CrawlersPage.jsx has pre-existing hardcoded CRAWLER_TYPES entries — warn
    // until each crawler is migrated to its own CrawlerMeta.js.
    files: CRAWLER_META_MIGRATION_PENDING,
    rules: { 'local/no-hardcoded-crawler-meta': 'warn' },
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
