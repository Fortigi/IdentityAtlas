import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the context-activity mutation run (stryker.contextactivity.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it fails the dry run. These tests only use os.tmpdir() folders.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/contexts/activity/*.test.js',
      'src/routes/contexts/activity.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
