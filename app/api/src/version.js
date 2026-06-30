// Single source of truth for the running module version.
//
// On the published Docker images MODULE_VERSION is baked in as an env var. On
// source / dev / local builds (e.g. a `docker compose build` from a clone, or
// `npm start`) it is NOT set — there the version lives in setup/IdentityAtlas.psd1,
// which is on disk. Both /api/version and the auto-update channel logic resolve
// through here so they always agree, on every kind of deployment.
//
// `read` is injectable so unit tests can exercise the fallback without the file.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PSD1_CANDIDATES = [
  '/app/setup/IdentityAtlas.psd1',                       // mounted in Docker
  join(__dirname, '../../../setup/IdentityAtlas.psd1'),  // running from a clone
];

export function resolveModuleVersion(env = process.env, read = (p) => readFileSync(p, 'utf-8')) {
  if (env.MODULE_VERSION) return env.MODULE_VERSION;
  for (const p of PSD1_CANDIDATES) {
    try {
      const m = read(p).match(/ModuleVersion\s*=\s*'([^']+)'/);
      if (m) return m[1];
    } catch { /* not at this path — try the next */ }
  }
  return null;
}
