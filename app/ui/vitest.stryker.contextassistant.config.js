// GENERATED from stryker.contextassistant.config.json by `npm run mutation-scopes:generate`
// (app/api). Do not edit: that file's `tests` list is the one declaration of what
// runs against its `mutate` list, and its `tests_comment` says why.
//
// A narrow include, not a growing exclude list: Stryker runs in a sandbox copy of
// app/ui, where a test reading files outside it fails the dry run, and an
// excluded test that was some mutant's only killer would read as a false survivor.
//
// Standalone rather than spreading vite.config.js: its include reaches
// ../../tools/crawlers/**, outside the sandbox, and its tailwind plugin and
// '@crawlers' alias are build concerns the mutation run does not need.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/contexts/assistant/recipeDraft.test.js',
      'src/components/contexts/assistant/useContextSave.test.jsx',
      'src/components/contexts/assistant/useRecipeEvaluation.test.jsx',
      'src/components/contexts/assistant/useTermConversation.test.jsx',
      'src/components/contexts/assistant/ContextBuilderPage.mount.test.jsx',
      'src/components/contexts/assistant/TermsPanel.mount.test.jsx',
      'src/hooks/useCanBuildContexts.test.js',
      'src/components/contexts/header/headerActions.test.js',
      'src/components/contexts/header/MoreMenu.mount.test.jsx',
      'src/components/contexts/ContextAccessCounts.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
