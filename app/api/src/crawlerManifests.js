/**
 * Crawler manifest registry — scans each tools/crawlers/<type>/crawler.json
 * once at startup. Shared by routes/jobs.js (job dispatch, discover.js
 * loading) and routes/crawlerFiles.js (file-upload support, schema
 * templates), which would otherwise need to import from each other
 * circularly to share this.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import { hasConfigSecret } from './secrets/crawlerSecrets.js';

// In Docker: manifests are at /app/crawlers/ (COPY'd from tools/crawlers/).
// In local dev: resolve relative to the repo root via IA_APP_ROOT or __dirname.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CRAWLER_MANIFESTS_DIR = process.env.CRAWLER_MANIFESTS_DIR ||
  (process.env.IA_APP_ROOT
    ? path.join(process.env.IA_APP_ROOT, 'crawlers')
    : path.resolve(__dirname, '../../../tools/crawlers'));

const _ajv = new Ajv({ allErrors: true });
export const _crawlerManifests = {};   // type → manifest object
const _configValidators = {};          // type → compiled ajv validator (or null)

try {
  for (const dir of readdirSync(CRAWLER_MANIFESTS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const mPath = path.join(CRAWLER_MANIFESTS_DIR, dir.name, 'crawler.json');
    try {
      const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
      _crawlerManifests[manifest.type] = manifest;
      _configValidators[manifest.type] = manifest.configSchema
        ? _ajv.compile(manifest.configSchema) : null;
    } catch (e) { console.warn(`Crawler manifest skipped (${mPath}): ${e.message}`); }
  }
} catch (e) { console.error(`Crawler manifests directory not accessible (${CRAWLER_MANIFESTS_DIR}): ${e.message}`); }

export const VALID_JOB_TYPES = Object.keys(_crawlerManifests);

// ── Manifest-driven type behaviours ─────────────────────────────────────────
// Core code (routes/jobs.js, routes/crawlers.js) must never branch on a
// hardcoded crawler-type string — a crawler stays fully described by its own
// tools/crawlers/<type>/crawler.json. These helpers read capability flags from
// the manifest so the core carries no per-type knowledge. (See issue #368.)

// A "singleton job" type may have at most one queued/running job at a time —
// a second concurrent run is meaningless (the demo data generator sets this).
// Manifest: `"singletonJob": true`.
export function isSingletonJob(type) {
  return !!_crawlerManifests[type]?.singletonJob;
}

// A "push-mode" type receives data via the Ingest API instead of a scheduled
// pull job. It is registered by issuing a Crawlers API-key row paired with a
// CrawlerConfigs card; either delete path unwinds the other row. Manifest:
// `"pushMode": true`. See tools/crawlers/CLAUDE.md → "Push-mode crawler types".
export function isPushModeType(type) {
  return !!_crawlerManifests[type]?.pushMode;
}

// The crawler type that backs API-key registrations (POST /admin/crawlers).
// Resolved from the manifest flag so the endpoint carries no hardcoded type.
// Returns null if no push-mode crawler is installed.
export function getPushModeType() {
  return Object.keys(_crawlerManifests).find(t => _crawlerManifests[t].pushMode) ?? null;
}

export function validateCrawlerConfig(type, config) {
  const validate = _configValidators[type];
  if (!validate) return null;
  if (validate(config ?? {})) return null;
  return _ajv.errorsText(validate.errors, { separator: '; ' });
}

// Some crawler types declare clientSecret as schema-required (directly, or
// conditionally via an authMethod allOf/if-then — omada and midPoint both do
// this for OAuth2CC/OAuth2ROPC). But clientSecret is deliberately stripped
// out of CrawlerConfigs.config once saved — it lives only in the secrets
// vault (see secrets/crawlerSecrets.js) — so a config freshly loaded from
// storage (an edit, a "Run Now", a scheduled run) never has it, and a plain
// validateCrawlerConfig() call on that config always fails the `required`
// check, even though credentials are genuinely present. Any caller
// validating a config that came from storage rather than a fresh wizard
// submission must call this instead, passing the configId so the vault can
// be checked. No crawler-type branching here — this generically applies to
// whichever type's schema happens to require clientSecret.
const VAULTED_SECRET_PLACEHOLDER = '__vaulted-secret-present__';
export async function validateStoredCrawlerConfig(type, config, configId) {
  const err = validateCrawlerConfig(type, config);
  if (!err) return null;
  // Only worth a vault round-trip if clientSecret is plausibly the reason
  // this failed — every other type/config keeps the cheap synchronous path.
  if (configId && config && !config.clientSecret && /clientSecret/.test(err) && await hasConfigSecret(configId)) {
    return validateCrawlerConfig(type, { ...config, clientSecret: VAULTED_SECRET_PLACEHOLDER });
  }
  return err;
}
