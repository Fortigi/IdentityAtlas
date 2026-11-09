import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the workbench components mutation run
// (stryker.workbenchui.config.json): the page's mount and hook tests. Standalone
// for the same sandbox reason as vitest.stryker.roles.config.js.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/workbench/WorkbenchPage.mount.test.jsx',
      'src/components/workbench/WorkbenchPage.save.mount.test.jsx',
      'src/components/workbench/useWorkbench.loadSaved.test.js',
      'src/components/workbench/CandidatePanel.mount.test.jsx',
      'src/components/workbench/GridAndPanel.mount.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
