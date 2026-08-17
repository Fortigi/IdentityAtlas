import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vitest config used only by the mutation runs (stryker.*.config.json).
//
// Deliberately standalone rather than spreading vite.config.js, for two reasons
// that both come down to what Stryker copies: it sandboxes app/ui alone.
//
//   * the normal test `include` reaches ../../tools/crawlers/**, which does not
//     exist inside the sandbox — every crawler wizard test fails collection and
//     aborts the run before a single mutant is evaluated;
//   * the tailwind plugin and the '@crawlers' alias are build concerns that
//     resolve outside app/ui and buy the mutation run nothing.
//
// Narrow include, not a growing exclude list: an excluded test that happened to
// be some mutant's only killer would surface as a false survivor, which is a
// worse outcome than measuring less. Add a file here when you add it to the
// `mutate` list in a stryker config.

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@ui': path.resolve(import.meta.dirname, 'src') },
  },
  test: {
    include: [
      'src/auth/usePermissions.test.jsx',
      'src/utils/matrixFilter.test.js',
    ],
    exclude: ['**/node_modules/**'],
  },
});
