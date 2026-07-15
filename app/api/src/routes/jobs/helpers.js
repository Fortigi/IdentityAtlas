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
import { hasConfigSecret, OTHER_SECRET_FIELDS } from '../../secrets/crawlerSecrets.js';
import { VALID_JOB_TYPES, validateCrawlerConfig, isSingletonJob } from '../../crawlerManifests.js';

// Re-exported for existing consumers (scheduler.js, jobs.*.test.js) that import
// these directly from routes/jobs.js rather than from crawlerManifests.js.
export { VALID_JOB_TYPES, validateCrawlerConfig };

export const gate = requirePermission('admin.crawlers');
export const useSql = process.env.USE_SQL === 'true';

// CSV uploads live under this base; configCsvFolder must stay within it.
const CSV_BASE_DIR = path.resolve(process.env.UPLOAD_ROOT || '/data/uploads');
export const SECRET_MASK = '••••••••';
const SECRET_FIELDS = ['clientSecret', ...OTHER_SECRET_FIELDS];

export function maskConfig(config) {
  if (!config) return null;
  const parsed = typeof config === 'string' ? JSON.parse(config) : config;
  const masked = { ...parsed };
  for (const field of SECRET_FIELDS) {
    if (masked[field]) masked[field] = SECRET_MASK;
  }
  return masked;
}


// Like maskConfig, but also surfaces the mask when the clientSecret lives in the
// vault (the normal case now) rather than in the stored config JSON.
export async function maskedConfigForResponse(id, config) {
  const masked = maskConfig(config);
  if (await hasConfigSecret(id)) return { ...(masked || {}), clientSecret: SECRET_MASK };
  return masked;
}

// Merge an incoming config-patch onto the stored config for PATCH. clientSecret
// (if a real value, not the mask) is pulled out for the vault; other secret
// fields are kept from the existing config when blank/masked. Returns the merged
// config (never carries plaintext clientSecret) + the new secret to vault (if any).
// Pure. Exported for unit tests.
export function mergeConfigForUpdate(existingConfig, incomingConfig) {
  let mergedConfig = (typeof existingConfig === 'string' ? JSON.parse(existingConfig) : existingConfig) || {};
  let newSecret = null;
  if (incomingConfig) {
    const incoming = { ...incomingConfig };
    // clientSecret goes to the vault; mask or empty means "keep existing"
    if (incoming.clientSecret && incoming.clientSecret !== SECRET_MASK) newSecret = incoming.clientSecret;
    // Other secret fields (password, apiToken, cookieString): preserve existing if blank/masked
    for (const field of SECRET_FIELDS.filter(f => f !== 'clientSecret')) {
      if (!incoming[field] || incoming[field] === SECRET_MASK) {
        if (mergedConfig[field]) incoming[field] = mergedConfig[field];
        else delete incoming[field];
      }
    }
    delete incoming.clientSecret;
    mergedConfig = { ...mergedConfig, ...incoming };
  }
  delete mergedConfig.clientSecret; // never persist plaintext in the JSON
  return { mergedConfig, newSecret };
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
// CrawlerConfigs row. Returns { resolvedConfig, configNextRunMode } or
// { error: { status, body } }. Exported for unit tests.
export async function resolveJobConfig(pool, inlineConfig, configId) {
  if (!configId) return { resolvedConfig: inlineConfig || null, configNextRunMode: null };
  const cfgResult = await pool.query(
    `SELECT config, "nextRunMode" FROM "CrawlerConfigs" WHERE id = $1 AND "enabled" = TRUE`,
    [configId]
  );
  if (cfgResult.rows.length === 0) return { error: { status: 404, body: { error: 'Crawler config not found' } } };
  // jsonb is auto-parsed by pg; legacy string column may still appear in tests.
  const raw = cfgResult.rows[0].config;
  return {
    resolvedConfig: (typeof raw === 'string') ? JSON.parse(raw) : raw,
    configNextRunMode: cfgResult.rows[0].nextRunMode || 'delta',
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

// Prepare the job's stored config: pick the effective syncMode, stamp the source
// configId, and strip every credential field (vaulted per-job, injected at claim
// time). Returns { inlineSecret, configToStore, configJson, extraCreds }. Pure.
// Exported for unit tests.
export function prepareJobConfig(resolvedConfig, configId, effectiveSyncMode) {
  const inlineSecret = (!configId && resolvedConfig?.clientSecret) ? resolvedConfig.clientSecret : null;
  const configToStore = configId
    ? { ...(resolvedConfig || {}), _scheduledByConfigId: configId, _syncMode: effectiveSyncMode }
    : (resolvedConfig ? { ...resolvedConfig, _syncMode: effectiveSyncMode } : null);
  const extraCreds = {};
  if (configToStore) {
    delete configToStore.clientSecret;
    for (const f of OTHER_SECRET_FIELDS) {
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
