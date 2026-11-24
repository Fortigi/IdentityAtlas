// GENERATED from stryker.auth.config.json by `npm run mutation-scopes:generate`
// (app/api). Do not edit: that file's `tests` list is the one declaration of what
// runs against its `mutate` list, and its `tests_comment` says why.
//
// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of
// app/api, where a test reading files outside it fails the dry run, and an
// excluded test that was some mutant's only killer would read as a false survivor.

import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/auth/**/*.test.js',
      'src/routes/matrix/shareRecipients.test.js',
      'src/routes/crawlers/crawlerGuards.test.js',
      'src/lib/crawlerJobQueue.test.js',
      'src/secrets/masterKeyStore.test.js',
      'src/config/fileSecrets.test.js',
      'src/middleware/requestOriginGuard.test.js',
      'src/middleware/rateLimitKeys.test.js',
      'src/middleware/crawlerAuthFailureLimiter.test.js',
      'src/lib/oneLineForLog.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
