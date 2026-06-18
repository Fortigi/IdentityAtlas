// @ts-check
/**
 * Generic loader for crawler-plugin e2e tests.
 *
 * tools/crawlers/<type>/*.e2e.mjs files contain real interaction tests for
 * that crawler's wizard, but can't import { test, expect } from
 * '@playwright/test' themselves — @playwright/test is only installed under
 * app/ui/node_modules, and tools/crawlers/ isn't a descendant of app/ui, so
 * Node's module resolution can't reach it (same root cause as the Docker
 * frontend-build's node_modules-hoisting fix — see app/api/Dockerfile's
 * frontend-build stage comment). Each *.e2e.mjs file instead exports
 * register(test, expect), and this file is the only place that actually
 * imports @playwright/test, discovers every *.e2e.mjs file, and calls
 * register() on it — so no crawler-specific test code has to live in
 * app/ui. Mirrors crawler-wizard-discovery.spec.js's discovery style.
 *
 * The .mjs extension (not .js) is required: Playwright's own loader doesn't
 * apply Node's "detect module syntax" auto-detection, and tools/crawlers/
 * has no ancestor package.json declaring "type": "module" to disambiguate.
 */

import { test, expect } from '@playwright/test';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRAWLERS_ROOT = join(__dirname, '..', '..', '..', 'tools', 'crawlers');

if (existsSync(CRAWLERS_ROOT)) {
  for (const entry of readdirSync(CRAWLERS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(CRAWLERS_ROOT, entry.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.e2e.mjs')) continue;
      const mod = await import(pathToFileURL(join(dir, file)).href);
      mod.register(test, expect);
    }
  }
}
