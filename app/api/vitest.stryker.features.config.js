import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config used only by stryker.features.config.json.
//
// Same sandbox constraint as vitest.stryker.config.js: Stryker copies app/api
// into a temp directory, so any test that reads the real filesystem (uploads,
// the crawler manifests at ../../tools/crawlers) fails the dry run and aborts
// the whole run. featureFlags.test.js reads neither — its only dependency is
// the shared db manual mock — so a narrow include keeps the scope clean.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['src/featureFlags.test.js'],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
