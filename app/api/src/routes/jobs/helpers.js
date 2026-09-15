// Job-config helpers + shared constants for the crawler-jobs endpoints.
//
// Extracted from routes/jobs.js (audit finding C1). The pure helpers are unit-
// tested via jobs.helpers.test.js / jobs.configValidation.test.js and re-exported
// by routes/jobs.js, alongside VALID_JOB_TYPES / validateCrawlerConfig (which
// scheduler.js and the tests import from ./jobs.js). No behaviour change.

import { requirePermission } from '../../middleware/auth.js';
import { readdirSync } from 'fs';
import path from 'path';
import { getUploadFolderPath } from '../crawlerFiles.js';
import { vaultedConfigFields, CONFIG_SECRET_FIELDS } from '../../secrets/crawlerSecrets.js';
import { stampConfigName } from '../../lib/jobConfig.js';
import { VALID_JOB_TYPES, validateCrawlerConfig, isSingletonJob } from '../../crawlerManifests.js';

// Re-exported for existing consumers (scheduler.js, jobs.*.test.js) that import
// these directly from routes/jobs.js rather than from crawlerManifests.js.
export { VALID_JOB_TYPES, validateCrawlerConfig };

export const gate = requirePermission('admin.crawlers');
export const useSql = process.env.USE_SQL === 'true';

// CSV uploads live under this base; configCsvFolder must stay within it.
const CSV_BASE_DIR = path.resolve(process.env.UPLOAD_ROOT || '/data/uploads');
export const SECRET_MASK = '••••••••';
const SECRET_FIELDS = CONFIG_SECRET_FIELDS;

export function maskConfig(config) {
  if (!config) return null;
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const masked = { ...parsed };
  for (const field of SECRET_FIELDS) {
    if (masked[field]) masked[field] = SECRET_MASK;
  }
  return masked;
}


// Like maskConfig, but also surfaces the mask for every credential field that
// lives in the vault (the normal case now) rather than in the stored JSON.
export async function maskedConfigForResponse(id, config) {
  const masked = maskConfig(config);
  const vaulted = await vaultedConfigFields(id);
  if (vaulted.length === 0) return masked;
  const out = { ...(masked || {}) };
  for (const field of vaulted) out[field] = SECRET_MASK;
  return out;
}

const isRealSecret = (v) => !!v && v !== SECRET_MASK;
const parseStored = (config) => (typeof config === 'string' ? JSON.parse(config) : config) || {};

// Split a config into its non-credential fields and the real (non-empty,
// non-mask) credential values it carries. Pure. Exported for unit tests.
export function splitConfigSecrets(config) {
  const rest = { ...(config || {}) };
  const secrets = {};
  for (const field of SECRET_FIELDS) {
    if (isRealSecret(rest[field])) secrets[field] = rest[field];
    delete rest[field];
  }
  return { rest, secrets };
}

// Merge an incoming config-patch onto the stored config for PATCH. Every
// credential field is pulled out: a real incoming value becomes a new secret
// to vault; a mask or blank means "keep what is stored". A plaintext value
// still sitting in a legacy stored config is carried into newSecrets so it gets
// vaulted now. Returns the merged config (never carries a credential field),
// the { field: value } secrets to vault, and the credential fields the caller
// did not re-enter. Pure. Exported for unit tests.
export function mergeConfigForUpdate(existingConfig, incomingConfig) {
  const { rest: existingRest, secrets: legacySecrets } = splitConfigSecrets(parseStored(existingConfig));
  const { rest: incomingRest, secrets: incomingSecrets } = splitConfigSecrets(incomingConfig);
  return {
    mergedConfig: { ...existingRest, ...incomingRest },
    newSecrets: { ...legacySecrets, ...incomingSecrets },
    keptFields: SECRET_FIELDS.filter(f => !incomingSecrets[f]),
  };
}

// Scheme + host of a URL-ish config value, or the trimmed raw string when it
// does not parse (so any edit to an unparseable value still counts as a change).
function endpointOrigin(value) {
  if (value == null || value === '') return '';
  const raw = String(value).trim();
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return raw;
  }
}

// Host-bearing fields whose scheme/host differs between the stored and merged
// config. Pure. Exported for unit tests.
export function changedHostFields(fields, existingConfig, mergedConfig) {
  const existing = parseStored(existingConfig);
  return fields.filter(f => endpointOrigin(existing[f]) !== endpointOrigin(mergedConfig[f]));
}

// SEC-2026-09 M-02: a stored credential must never follow an endpoint to a new
// host. When a PATCH changes a host-bearing field while keeping (not
// re-entering) a credential stored for this config, returns the 400 the route
// should send; otherwise null. Exported for unit tests.
export function credentialReentryError(changedFields, keptStoredFields) {
  if (changedFields.length === 0 || keptStoredFields.length === 0) return null;
  return {
    status: 400,
    body: {
      error: `Changing ${changedFields.join(', ')} changes where this crawler sends its credentials. ` +
        `Re-enter ${keptStoredFields.join(', ')} to save the change.`,
      reenterFields: keptStoredFields,
    },
  };
}

// Validate the create-job request body. Returns { jobType, configId,
// explicitSyncMode } on success, or { error: { status, body } }. Pure.
// Exported for unit tests.
export function validateCreateJobBody(body) {
  const { jobType, configId: rawConfigId, syncMode: explicitSyncMode } = body;
  const configId = rawConfigId != null ? parseInt(rawConfigId, 10) : null;
  if (rawConfigId != null && (isNaN(configId) || configId <= 0)) {
    return { error: { status: 400, body: { error: 'configId must be a positive integer' } } };
  }
  if (!jobType || !VALID_JOB_TYPES.includes(jobType)) {
    return { error: { status: 400, body: { error: `jobType must be one of: ${VALID_JOB_TYPES.join(', ')}` } } };
  }
  if (explicitSyncMode !== undefined && explicitSyncMode !== 'full' && explicitSyncMode !== 'delta') {
    return { error: { status: 400, body: { error: 'syncMode must be "full" or "delta"' } } };
  }
  return { jobType, configId, explicitSyncMode };
}

// Resolve the config a job should run with: inline (no configId) or the stored
// CrawlerConfigs row. Returns { resolvedConfig, configNextRunMode, configName }
// or { error: { status, body } }. An inline config has no CrawlerConfigs row and
// so carries no configName. Exported for unit tests.
export async function resolveJobConfig(pool, inlineConfig, configId) {
  if (!configId) return { resolvedConfig: inlineConfig || null, configNextRunMode: null };
  const cfgResult = await pool.query(
    `SELECT config, "nextRunMode", "displayName" FROM "CrawlerConfigs" WHERE id = $1 AND "enabled" = TRUE`,
    [configId]
  );
  if (cfgResult.rows.length === 0) return { error: { status: 404, body: { error: 'Crawler config not found' } } };
  // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
  const raw = cfgResult.rows[0].config;
  return {
    resolvedConfig: (typeof raw === 'string') ? JSON.parse(raw) : raw,
    configNextRunMode: cfgResult.rows[0].nextRunMode || 'delta',
    configName: cfgResult.rows[0].displayName || null,
  };
}

// For file-upload crawler types: resolve the upload folder (the config's stored
// csvFolder if it's inside CSV_BASE_DIR, else the standard per-config path) and
// confirm it contains at least one file. Returns { folder } or
// { error: { status, body } }. Exported for unit tests.
export function resolveUploadFolder(jobType, configId, resolvedConfig) {
  if (!configId) {
    return { error: { status: 400, body: { error: `${jobType} jobs require a configId — inline configs are not supported` } } };
  }
  const configCsvFolder = resolvedConfig?.csvFolder;
  let folder = getUploadFolderPath(jobType, configId);
  if (configCsvFolder) {
    // Derive a relative path and rebuild from the trusted base so the resulting
    // path is constructed from a constant, not raw user data.
    const relPart = path.relative(CSV_BASE_DIR, path.resolve(configCsvFolder));
    if (relPart && !relPart.startsWith('..') && !path.isAbsolute(relPart)) {
      const safeCustom = path.join(CSV_BASE_DIR, relPart);
      try { readdirSync(safeCustom); folder = safeCustom; } catch { /* fall back to default */ }
    }
  }
  // Check for uploaded files — use try/catch to avoid TOCTOU (existsSync + read).
  let uploadedFiles = [];
  try { uploadedFiles = readdirSync(folder); } catch { /* folder missing or unreadable */ }
  if (uploadedFiles.length === 0) {
    return { error: { status: 400, body: { error: 'No files found. Upload files or configure the folder path.' } } };
  }
  return { folder };
}

// Drop every `_`-prefixed key. Those are server-owned job metadata
// (`_scheduledByConfigId`, `_syncMode`, `_scheduleIndex`, `_configName`) and must
// never be taken from a caller- or admin-supplied config (SEC-2026-09 H-02). Pure.
export function stripServerOwnedKeys(config) {
  if (!config || typeof config !== 'object') return null;
  return Object.fromEntries(Object.entries(config).filter(([k]) => !k.startsWith('_')));
}

// Prepare the job's stored config: drop caller-supplied server-owned keys, pick
// the effective syncMode, stamp the source configId and the crawler's own name,
// and strip every credential field (vaulted per-job, injected at claim time).
// Which config's credentials a job receives comes from the CrawlerJobs."configId"
// column the caller writes; `_scheduledByConfigId` in the JSON is informational
// only (UI + the worker's delta-mode callback). The server-owned keys are stripped
// BEFORE the name is stamped, so a caller cannot supply `_configName` either.
// Returns { inlineSecret, configToStore, configJson, extraCreds }. Pure. Exported
// for unit tests.
export function prepareJobConfig(resolvedConfig, configId, effectiveSyncMode, configName) {
  const base = stripServerOwnedKeys(resolvedConfig);
  const inlineSecret = (!configId && base?.clientSecret) ? base.clientSecret : null;
  const configToStore = configId
    ? { ...(base || {}), _scheduledByConfigId: configId, _syncMode: effectiveSyncMode }
    : (base ? { ...base, _syncMode: effectiveSyncMode } : null);
  // The crawler can only name what it registers after the crawler's own name if
  // that name reaches the run — see stampConfigName's note on the reserved key.
  stampConfigName(configToStore, configName);
  const extraCreds = {};
  if (configToStore) {
    delete configToStore.clientSecret;
    for (const f of SECRET_FIELDS.filter(x => x !== 'clientSecret')) {
      if (configToStore[f]) { extraCreds[f] = configToStore[f]; delete configToStore[f]; }
    }
  }
  const configJson = configToStore ? JSON.stringify(configToStore) : null;
  return { inlineSecret, configToStore, configJson, extraCreds };
}

// Singleton-job types (manifest `singletonJob: true`) allow only one
// queued/running job at a time. Returns a 409 { status, body } when one is
// already active, else null. Exported for unit tests.
export async function checkSingletonConflict(pool, jobType) {
  if (!isSingletonJob(jobType)) return null;
  const dup = await pool.query(
    `SELECT 1 FROM "CrawlerJobs" WHERE "jobType" = $1 AND status IN ('queued', 'running')`,
    [jobType]
  );
  if (dup.rows.length > 0) return { status: 409, body: { error: `A ${jobType} job is already queued or running` } };
  return null;
}

// Best display name to stamp as the job's creator. Exported for unit tests.
export function resolveCreatedBy(req) {
  return req.user?.preferred_username || req.user?.name || 'ui';
}
