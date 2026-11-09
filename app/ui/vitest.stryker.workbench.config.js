import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the workbench logic mutation run (stryker.workbench.config.json),
// split out of the context-interviews run (#1548): each logic file's own unit test.
// Standalone for the same sandbox reason as vitest.stryker.roles.config.js.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/workbench/workbench.model.test.js',
      'src/components/workbench/workbench.labels.test.js',
      'src/components/workbench/workbench.roles.test.js',
      'src/components/workbench/workbench.columns.test.js',
      'src/components/workbench/workbench.rule.test.js',
      'src/components/workbench/workbench.save.test.js',
      'src/components/workbench/workbench.link.test.js',
      'src/components/workbench/workbench.permissions.test.js',
      'src/components/workbench/workbench.transposed.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
