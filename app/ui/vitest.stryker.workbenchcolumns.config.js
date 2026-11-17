import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the workbench people-as-columns mutation run
// (stryker.workbenchcolumns.config.json): that view's mount and hook tests. Standalone
// for the same sandbox reason as vitest.stryker.roles.config.js.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/workbench/WorkbenchColumnsGrid.mount.test.jsx',
      'src/components/workbench/PageStickyTable.mount.test.jsx',
      'src/components/workbench/usePageVirtualRows.test.jsx',
    ],
    exclude: ['**/node_modules/**'],
  },
});
