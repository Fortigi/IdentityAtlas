import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the relationship-graph mutation run
// (stryker.graph.config.json). Standalone for the same reasons as the sibling
// stryker vitest configs (Stryker sandboxes app/ui alone). The pure modules'
// own tests plus the mount tests that drive the hook and the pointer handling.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/graph/graphModel.test.js',
      'src/components/graph/graphState.test.js',
      'src/components/graph/graphLayout.test.js',
      'src/components/graph/graphNeighbours.test.js',
      'src/components/graph/graphDraw.test.js',
      'src/components/graph/RelationGraph.mount.test.jsx',
      'src/components/IdentityDetailPage.mount.test.jsx',
      'src/components/orgtruth/OrgEntityDetailPage.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
