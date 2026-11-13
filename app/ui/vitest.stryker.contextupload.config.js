import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the context-upload mutation run
// (stryker.contextupload.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include traces the importers of the three
// mutated modules: their own unit test, and the wizard mount test that drives
// the flow end to end.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/contexts/upload/uploadMapping.helpers.test.js',
      'src/components/contexts/upload/UploadListFlow.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
