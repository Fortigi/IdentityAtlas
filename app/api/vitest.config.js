import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // '@api/X' → app/api/src/X  (use in tools/crawlers/ tests that import API utilities)
      '@api': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    // Also pick up tests co-located with their crawler plugin that exercise
    // core Node logic (discover.js handlers, crawler.json schema validation)
    // — these can't live under src/routes/ per the "nothing crawler-specific
    // outside tools/crawlers/<type>/" rule. Scoped to specific filenames
    // (not **/*.test.js) because most other tools/crawlers/**/*.test.js
    // files import their ConfigWizard.jsx, which needs the React/JSX plugin
    // app/ui's vitest has and this config doesn't. See tools/crawlers/CLAUDE.md
    // → "JS/UI Testing" → "Testing a discover.js handler".
    include: [
      'src/**/*.test.js',
      '../../tools/crawlers/**/discover.test.js',
      '../../tools/crawlers/**/configValidation.test.js',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.js'],
      // src/**/__mocks__/** is test infrastructure (vitest manual mocks), not
      // product code — keep it out of the coverage numbers.
      exclude: ['src/**/*.test.js', 'src/**/__mocks__/**', 'src/index.js'],
      // Coverage ratchet: a committed FLOOR that `npm run test:coverage` (run in
      // the PR Checks job) enforces — a change that drops unit coverage below
      // these fails CI. Set just under the current numbers so normal variance
      // doesn't flake. When you raise coverage, RAISE these too (the same
      // manual-ratchet discipline as the complexity baseline; never lower them).
      // Measured on this suite (unit only; contract tests add more): S67.8 B59.9 F67.9 L71.2.
      thresholds: {
        statements: 67,
        branches: 59,
        functions: 67,
        lines: 71,
      },
    },
  },
});
