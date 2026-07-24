import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import sonarjs from 'eslint-plugin-sonarjs';
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
  { ignores: ['dist', 'playwright-report', 'test-results', 'coverage'] },
  {
    // Register the sonarjs plugin WITHOUT enabling any of its rules, so the
    // `sonarjs/cognitive-complexity` rule id resolves when the complexity
    // ratchet injects it via `--rule` (tools/complexity/ratchet.py measure_js).
    // Deliberately not `sonarjs.configs.recommended` — that would enable a raft
    // of rules and fail `npm run lint`. Same treatment as the core `complexity`
    // (cyclomatic) rule: measured by the ratchet, never enforced in the lint job.
    plugins: { sonarjs },
  },
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
      // Core correctness rule: flag references to identifiers that aren't
      // declared in scope. This is the cheapest gate against a whole class of
      // bugs — a typo'd variable, or a value used inside an extracted child
      // component without being threaded in as a prop. A dropped `isDark` prop
      // in EntityListPage's extracted table row (#762) reached production
      // precisely because this rule was off; it renders as a client-side
      // `ReferenceError` the moment the affected branch is hit. Kept as an
      // explicit rule rather than pulling in all of `@eslint/js` recommended,
      // so the ruleset stays intentional.
      'no-undef': 'error',
      'local/no-low-contrast-text': 'error',
      // Flags two plain dark: utilities setting the same color property (the
      // audit's C1/C2/M6 class — the later one silently wins). The missing-hover
      // backlog (`hover:text-X dark:text-Y`) is now cleaned up, so this is an error.
      'local/no-duplicate-dark-color': 'error',
      'local/no-native-dialogs': 'error',
      'local/no-legacy-jargon': 'error',
      'local/no-hardcoded-crawler-meta': 'error',
      // React Compiler strict rule — enforced as an error now that every UI
      // data-fetching/effect site is set-state-in-effect-clean (see #417). New
      // violations must be fixed (e.g. a .then() chain, a reducer-backed state,
      // or a render-time "adjust state on prop change") rather than reintroduced.
      'react-hooks/set-state-in-effect': 'error',
      // Also clean (0 violations), so enforce it too — together these are the
      // React Compiler-aware lint rules. Reading/writing ref.current during
      // render must move into an effect or event handler.
      'react-hooks/refs': 'error',
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
    // Vitest/jsdom unit + mount tests reference Node globals: `global` (jsdom
    // env shims) and `Buffer` (byte assertions in the Excel-export tests).
    // Merge Node globals on top of the browser set so `no-undef` doesn't flag
    // them. (Flat config merges languageOptions across matching blocks.)
    files: ['**/*.test.{js,jsx}', 'src/__tests__/**/*.{js,jsx}', 'src/test-utils/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Build/test tooling configs run in Node (`process`, `__dirname`, …).
    files: ['*.config.{js,ts}'],
    languageOptions: {
      globals: { ...globals.node },
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
