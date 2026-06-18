import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Also pick up tests co-located with their crawler plugin that exercise
    // core Node logic (discover.js handlers, crawler.json schema validation)
    // — these can't live under src/routes/ per the "nothing crawler-specific
    // outside tools/crawlers/<type>/" rule. Scoped to specific filenames
    // (not **/*.test.js) because most other tools/crawlers/**/*.test.js
    // files import their ConfigWizard.jsx, which needs the React/JSX plugin
    // app/ui's vitest has and this config doesn't. See tools/crawlers/CLAUDE.md
    // → "JS/UI Testing" → "Testing a discover.js handler".
    include: [
      'src/**/*.test.js',
      '../../tools/crawlers/**/discover.test.js',
      '../../tools/crawlers/**/configValidation.test.js',
    ],
  },
});
