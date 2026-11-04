import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';

// Vitest config for the MCP mutation run (stryker.mcp.config.json).
//
// Explicit file list rather than a directory glob, same reason as the sibling stryker vitest
// configs: Stryker copies app/api into a temp sandbox, so a test that reads the real
// filesystem outside it fails the dry run. Every test here is a real killer for the mutated
// files and is fully mocked (no PostgreSQL, no Entra).

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/mcp/**/*.test.js',
      'src/routes/admin/mcp.test.js',
    ],
    exclude: ['**/node_modules/**'],
    coverage: { ...base.test.coverage, thresholds: undefined },
  },
});
