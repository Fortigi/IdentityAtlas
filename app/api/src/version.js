// Single source of truth for the running module version.
//
// On the published Docker images MODULE_VERSION is baked in as an env var. On
// source / dev / local builds (e.g. a `docker compose build` from a clone, or
// `npm start`) and in the portable ZIP it is NOT set — there the version lives in
// setup/IdentityAtlas.psd1, which is on disk. Both /api/version and the
// auto-update channel logic resolve through here so they always agree, on every
// kind of deployment.
//
// `read` is injectable so unit tests can exercise the fallback without the file.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PSD1_CANDIDATES = [
  '/app/setup/IdentityAtlas.psd1',                       // mounted in Docker
  join(__dirname, '../../../setup/IdentityAtlas.psd1'),  // running from a clone
  // Portable ZIP: this module is bundled into app-bundle.mjs at the ZIP root,
  // next to the scripts it ships.
  join(__dirname, 'bundled-scripts/setup/IdentityAtlas.psd1'),
];

// The version a manifest describes. ModuleVersion must be a System.Version for
// Import-Module, so a pre-release build (tools/release/Set-ManifestVersion.ps1)
// carries its label in PSData.Prerelease: '6.2.0' + 'beta.1' is '6.2.0-beta.1'.
// The commented-out `# Prerelease = ''` template line is not a label.
export function parseModuleVersion(text) {
  const m = text.match(/ModuleVersion\s*=\s*'([^']+)'/);
  if (!m) return null;
  const pre = text.match(/^\s*Prerelease\s*=\s*'([^']+)'/m);
  return pre ? `${m[1]}-${pre[1]}` : m[1];
}

export function resolveModuleVersion(env = process.env, read = (p) => readFileSync(p, 'utf-8')) {
  if (env.MODULE_VERSION) return env.MODULE_VERSION;
  for (const p of PSD1_CANDIDATES) {
    try {
      const v = parseModuleVersion(read(p));
      if (v) return v;
    } catch { /* not at this path — try the next */ }
  }
  return null;
}
