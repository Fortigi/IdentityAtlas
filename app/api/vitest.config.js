import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Also pick up discover.js handler tests co-located with their crawler
    // plugin (tools/crawlers/<type>/discover.test.js) — these can't live
    // under src/routes/ per the "nothing crawler-specific outside
    // tools/crawlers/<type>/" rule. See tools/crawlers/CLAUDE.md →
    // "JS/UI Testing" → "Testing a discover.js handler".
    include: ['src/**/*.test.js', '../../tools/crawlers/**/discover.test.js'],
  },
});
