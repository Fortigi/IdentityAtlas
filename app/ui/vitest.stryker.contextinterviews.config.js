import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the context-interviews mutation run
// (stryker.contextinterviews.config.json). Standalone for the same sandbox reason as
// vitest.stryker.roles.config.js. The include is the helpers tests and the mount
// tests that drive the interviews UI through ContextProfile and the members tab.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/components/contexts/interviews/claims.helpers.test.js',
      'src/components/contexts/interviews/interviews.mount.test.jsx',
      'src/components/contexts/interviews/interviewForms.mount.test.jsx',
      'src/components/contexts/interviews/interviewKnowledge.mount.test.jsx',
      'src/components/contexts/interviews/transcript.helpers.test.js',
      'src/components/contexts/interviews/memberInterview.helpers.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
