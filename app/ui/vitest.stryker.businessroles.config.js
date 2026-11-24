import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the business-role page mutation run
// (stryker.businessroles.config.json). Standalone for the same reason as
// vitest.stryker.roles.config.js: Stryker sandboxes app/ui alone, so the normal
// include reaching ../../tools/crawlers/** would abort the run.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/businessRoles/*.test.{js,jsx}',
    ],
    exclude: ['**/node_modules/**'],
  },
});
