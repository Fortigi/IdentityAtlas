import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the context-activity mutation run
// (stryker.contextactivity.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include traces the importers of the mutated
// modules: the helpers' own unit test and the two mount tests (the wizard through
// its card, the Activity section) that drive them end to end.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/contexts/activity/activity.helpers.test.js',
      'src/components/contexts/activity/UploadActivityWizard.mount.test.jsx',
      'src/components/contexts/activity/ActivitySection.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
