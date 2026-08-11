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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      exclude: ['src/**/*.test.{js,jsx}', 'src/main.jsx', 'src/test-utils/**'],
      // Coverage ratchet: a committed FLOOR enforced by the PR Checks job (which
      // runs `npm run test:coverage`). A change that drops UI coverage below
      // these fails CI. Set just under current so normal variance doesn't flake;
      // RAISE these when you raise coverage (never lower them — same discipline
      // as the complexity baseline). Measured: S71.1 B62.4 F65.1 L74.5.
      thresholds: {
        statements: 70,
        branches: 61,
        functions: 64,
        lines: 73,
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
