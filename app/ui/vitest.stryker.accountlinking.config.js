import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the account-linking UI mutation run
// (stryker.accountlinking.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reasons as the sibling
// stryker vitest configs: Stryker sandboxes app/ui alone, so the normal test `include`
// reaching ../../tools/crawlers/** resolves nothing there and aborts the run before a
// mutant is evaluated, and the tailwind plugin plus the '@crawlers' alias are build
// concerns that buy the mutation run nothing.
//
// The mutated file is covered by exactly these tests: its own unit test, plus the two
// mount tests that exercise it through the screens — the admin panel's run notice and the
// held-for-review card's "newest measured run" selection.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/utils/accountLinkingRuns.test.js',
      'src/components/AccountLinkingSettings.mount.test.jsx',
      'src/components/NameOnlyMatchesCard.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
