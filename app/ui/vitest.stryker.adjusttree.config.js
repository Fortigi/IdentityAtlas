import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the Adjust tree mutation run
// (stryker.adjusttree.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include traces the importers of the
// mutated modules: the helper and hook tests, and the mounted screen tests.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/adjustTree/*.test.js',
      'src/components/adjustTree/*.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
