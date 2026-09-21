import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the context-assistant mutation run
// (stryker.contextassistant.config.json).
//
// Standalone rather than spreading vite.config.js, for the same reasons as the sibling
// stryker vitest configs: Stryker sandboxes app/ui alone, so the normal test `include`
// reaching ../../tools/crawlers/** resolves nothing there and aborts the run before a mutant
// is evaluated, and the tailwind plugin plus the '@crawlers' alias are build concerns that
// buy the mutation run nothing.
//
// The mutated files are covered by exactly these tests: the draft helpers' own unit test,
// one per hook, the permission gate's, and the two mount tests that exercise the helpers
// through the screens (the builder page end to end, and the terms panel's numbers).

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
    ],
    exclude: ['**/node_modules/**'],
  },
});
