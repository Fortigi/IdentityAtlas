// @ts-check
/**
 * Throwaway crawler configs for e2e specs, derived from the crawler manifests on
 * disk — so a spec about a generic crawler mechanism (what a run is told, which
 * mode it runs in, …) never names a crawler type. A hardcoded crawler-type
 * string under app/ui/ fails the crawler-manifest CI job and belongs in that
 * crawler's own folder anyway.
 *
 * A plain .js (not *.spec.js) so Playwright's testMatch doesn't collect it as an
 * empty suite. Used by crawler-run-naming.spec.js and
 * crawler-force-full-next-run.spec.js.
 */

import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CRAWLERS_ROOT = join(__dirname, '..', '..', '..', 'tools', 'crawlers');

/**
 * A value that satisfies one required config field, derived from the field's own
 * schema so no crawler type has to be known here. Nothing is ever dialled by the
 * specs that use this: every run they queue is cancelled before the worker can
 * claim it.
 */
function sampleValue(field, schema, urlFields) {
  if (Array.isArray(schema?.enum)) return schema.enum[0];
  if (schema?.type === 'boolean') return true;
  if (schema?.type === 'number' || schema?.type === 'integer') return 1;
  // A required list (the SQL crawler's `queries`) gets one sampled item, and an
  // object item gets its own required fields, sampled the same way.
  if (schema?.type === 'array') return [sampleValue(field, schema.items, urlFields)];
  if (schema?.type === 'object') {
    return Object.fromEntries((schema.required || []).map(f => [f, sampleValue(f, schema.properties?.[f], urlFields)]));
  }
  if (urlFields.includes(field)) return 'https://e2e.example.com/api';
  return 'e2e-placeholder';
}

/**
 * The extra fields a schema requires once the sampled values are in — a config
 * schema states its auth matrix as `allOf: [{ if: { properties: { authMethod:
 * { const: X } } }, then: { required: [...] } }]`, so picking the first
 * `authMethod` enum value silently incurs that branch's requirements. Creating
 * the config succeeds without them (the branch is only enforced on the way to a
 * run), so leaving them out fails later, at queue time, and looks like a failure
 * of whatever the spec was actually about. Still derived from the manifest — no
 * crawler type is named here.
 */
function conditionalRequirements(schema, config) {
  const required = [];
  for (const branch of Array.isArray(schema.allOf) ? schema.allOf : []) {
    const conditions = Object.entries(branch?.if?.properties || {});
    if (!conditions.length) continue;
    // As in JSON Schema, a `properties` condition holds for a field the config
    // does not have — which is how a schema makes one branch the default for an
    // optional `authMethod`.
    const holds = conditions.every(([field, rule]) => !(field in config) || (
      'const' in (rule || {}) ? config[field] === rule.const : (rule?.enum || []).includes(config[field])
    ));
    if (holds) required.push(...(branch?.then?.required || []));
  }
  return required;
}

/**
 * Crawler types a throwaway config + run can be created for without inventing
 * type-specific knowledge. Excluded, and why:
 *  - no CrawlerMeta.js — a library type that is never run on its own;
 *  - experimental — creating a config is refused unless a feature flag is on;
 *  - singleton — the deployment's single job slot for that type isn't ours;
 *  - push mode — it has no runnable job at all, data is pushed to the ingest API;
 *  - file uploads — a run is refused until files have been uploaded for it.
 * Types whose required fields carry no URL sort first, so the run of the mill
 * case doesn't depend on the SSRF guard resolving a hostname.
 *
 * @returns {{type: string, config: Record<string, any>, hasUrlField: boolean}[]}
 */
export function queueableCrawlerTypes() {
  if (!existsSync(CRAWLERS_ROOT)) return [];
  const types = [];
  for (const entry of readdirSync(CRAWLERS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(CRAWLERS_ROOT, entry.name);
    if (!existsSync(join(dir, 'CrawlerMeta.js'))) continue;
    const manifestPath = join(dir, 'crawler.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.experimental || manifest.singletonJob || manifest.pushMode || manifest.supportsFileUploads) continue;
    const urlFields = Array.isArray(manifest.urlFields) ? manifest.urlFields : [];
    const schema = manifest.configSchema || {};
    const config = {};
    for (const field of schema.required || []) {
      config[field] = sampleValue(field, schema.properties?.[field], urlFields);
    }
    for (const field of conditionalRequirements(schema, config)) {
      config[field] = sampleValue(field, schema.properties?.[field], urlFields);
    }
    types.push({ type: manifest.type, config, hasUrlField: urlFields.some(f => f in config) });
  }
  return types.sort((a, b) => (a.hasUrlField - b.hasUrlField) || a.type.localeCompare(b.type));
}
