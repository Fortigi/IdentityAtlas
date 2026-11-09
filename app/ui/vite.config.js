import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // '@ui/X' → app/ui/src/X  (use in import statements within src/ and tools/crawlers/)
      '@ui': path.resolve(__dirname, 'src'),
      // '@crawlers/X' → tools/crawlers/X  (use in import statements within tools/crawlers/)
      '@crawlers': path.resolve(__dirname, '../../tools/crawlers'),
    },
    // Crawler wizards live outside this package (tools/crawlers/<type>/) with no
    // node_modules of their own. Resolve React from here for them, so a wizard
    // mount test under the jsdom environment finds it — and there is only ever
    // one React instance, whichever side imported it.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    // Also pick up tests co-located with crawler wizard plugins (outside src/,
    // tools/crawlers/<type>/*.test.{js,jsx}) and the custom ESLint rule tests
    // (eslint-rules/*.test.js).
    include: ['src/**/*.test.{js,jsx}', '../../tools/crawlers/**/*.test.{js,jsx}', 'eslint-rules/**/*.test.{js,jsx}'],
    // configValidation.test.js imports app/api/src/crawlerManifests.js, which
    // transitively requires the 'pg' package — only installed under
    // app/api/node_modules. Those tests run under app/api's vitest instead
    // (see app/api/vitest.config.js); exclude here so the UI run doesn't
    // fail trying to load a dependency it doesn't have.
    exclude: [...configDefaults.exclude, '../../tools/crawlers/**/configValidation.test.js'],
    // Worker threads, not forked processes. Most of this suite's time is per-file
    // jsdom environment setup (199 mount tests); in threads that setup cost roughly
    // halves and the suite runs ~35% faster, with identical results and coverage.
    // Each file still gets its own module graph and jsdom (isolate stays on — turning
    // it off breaks ~135 files that rely on a fresh environment). The one thing a
    // worker thread cannot do is process.chdir(); src/test-utils/threadsPool.guard.test.js
    // keeps that out of the suite.
    pool: 'threads',
    coverage: {
      provider: 'v8',
      // json-summary feeds tools/coverage/aggregate_floors.py (coverage.yml).
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/*.test.{js,jsx}', 'src/main.jsx', 'src/test-utils/**'],
      // Coverage ratchet: a committed FLOOR enforced by the PR Checks job (which
      // runs `npm run test:coverage`). A change that drops UI coverage below
      // these fails CI. Set at measured minus 2, rounded down, so normal variance
      // doesn't flake but a real loss does; RAISE these when you raise coverage
      // (never lower them). Both these and the per-file floors
      // (.ci/coverage-baseline.json) also rise on their own after every merge:
      // coverage.yml runs tools/coverage/aggregate_floors.py on main's numbers.
      // Measured Nov 2026: S89.7 B83.0 F88.3 L91.4.
      thresholds: {
        statements: 87,
        branches: 81,
        functions: 86,
        lines: 89,
      },
    },
  },
  server: {
    fs: {
      // Allow the dev server to serve files from the repo root so that
      // import.meta.glob can reach tools/crawlers/* wizard files.
      allow: [path.resolve(__dirname, '../..')],
    },
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
})
