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

export function validateCrawlerConfig(type, config) {
  const validate = _configValidators[type];
  if (!validate) return null;
  if (validate(config ?? {})) return null;
  return _ajv.errorsText(validate.errors, { separator: '; ' });
}
