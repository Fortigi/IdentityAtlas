import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the natural-language conversation mutation run
// (stryker.nlconversation.config.json): each mutated file's own unit test, which the
// reports run these files came from never listed.
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it fails the dry run and aborts the whole run. conversations.test.js
// reads a migration, but from inside app/api, which the sandbox has.

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/nlreports/autofix.test.js',
      'src/nlreports/autofix.activity.test.js',
      'src/nlreports/autofix.followup.test.js',
      'src/nlreports/contradictions.test.js',
      'src/nlreports/followUp.test.js',
      'src/nlreports/state.test.js',
      'src/nlreports/conversations.test.js',
      'src/nlreports/language.test.js',
      'src/nlreports/prompt.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
