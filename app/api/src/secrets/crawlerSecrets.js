// Vault helpers for crawler credentials.
//
// Every credential field a crawler config can carry — clientSecret, password,
// apiToken, cookieString — is vaulted per config, one row per field, keyed
// `crawler-config:<configId>:<field>` (SEC-2026-09 M-10). None of them is ever
// persisted in CrawlerConfigs.config or CrawlerJobs.config.
//
// Inline jobs (no stored config) vault their clientSecret per job and the other
// fields as one JSON bundle per job.
//
// At claim time injectJobSecret() puts the credentials back into the config
// handed to the worker. Which config's credentials a job receives is decided
// ONLY by the server-owned CrawlerJobs."configId" column — never by anything in
// the job's config JSON, which for an inline job is caller-supplied
// (SEC-2026-09 H-02).

import { putSecret, getSecret, hasSecret, deleteSecret, existingSecretIds } from './vault.js';

const CONFIG_SCOPE = 'crawler-config';
const JOB_SCOPE = 'crawler-job';
const configFieldKey = (id, field) => `crawler-config:${id}:${field}`;
const jobKey = (id) => `crawler-job:${id}:clientSecret`;
const jobCredsKey = (id) => `crawler-job:${id}:credentials`;

// Non-clientSecret credential fields (Omada / OData / midPoint / SCIM).
export const OTHER_SECRET_FIELDS = ['password', 'apiToken', 'cookieString'];
// Every credential field vaulted per config.
export const CONFIG_SECRET_FIELDS = ['clientSecret', ...OTHER_SECRET_FIELDS];

// ─── Per-config credentials ──────────────────────────────────────────

export async function storeConfigField(configId, field, value) {
  if (!CONFIG_SECRET_FIELDS.includes(field)) throw new Error(`Not a vaulted crawler credential field: ${field}`);
  await putSecret(configFieldKey(configId, field), CONFIG_SCOPE, String(value), `Crawler config ${configId} ${field}`);
}

// Vault every non-empty field in `values` ({ field: plaintext }).
export async function storeConfigFields(configId, values) {
  for (const [field, value] of Object.entries(values || {})) {
    if (value) await storeConfigField(configId, field, value);
  }
}

export const storeConfigSecret = (configId, clientSecret) => storeConfigField(configId, 'clientSecret', clientSecret);
export const getConfigSecret = (configId) => getSecret(configFieldKey(configId, 'clientSecret'), CONFIG_SCOPE);
export const hasConfigSecret = (configId) => hasSecret(configFieldKey(configId, 'clientSecret'), CONFIG_SCOPE);

// Names of the credential fields this config has in the vault (no decryption).
export async function vaultedConfigFields(configId) {
  const ids = CONFIG_SECRET_FIELDS.map(f => configFieldKey(configId, f));
  const present = await existingSecretIds(ids, CONFIG_SCOPE);
  return CONFIG_SECRET_FIELDS.filter(f => present.has(configFieldKey(configId, f)));
}

// Decrypted { field: value } for every credential this config has vaulted.
export async function getConfigCredentials(configId) {
  const out = {};
  for (const field of await vaultedConfigFields(configId)) {
    const value = await getSecret(configFieldKey(configId, field), CONFIG_SCOPE);
    if (value) out[field] = value;
  }
  return out;
}

export async function deleteConfigFields(configId, fields) {
  for (const field of fields) await deleteSecret(configFieldKey(configId, field), CONFIG_SCOPE);
}

export const deleteConfigSecrets = (configId) => deleteConfigFields(configId, CONFIG_SECRET_FIELDS);

// ─── Per-job credentials (inline jobs) ───────────────────────────────

export async function storeJobSecret(jobId, clientSecret) {
  await putSecret(jobKey(jobId), JOB_SCOPE, clientSecret, `Crawler job ${jobId} clientSecret`);
}
export const deleteJobSecret = (jobId) => deleteSecret(jobKey(jobId), JOB_SCOPE);

// Vault the non-clientSecret credential fields for a job.
// Only stores fields that are present and non-empty in `creds`.
export async function storeJobCredentials(jobId, creds) {
  const payload = Object.fromEntries(
    OTHER_SECRET_FIELDS.map(f => [f, creds[f]]).filter(([, v]) => v)
  );
  if (Object.keys(payload).length === 0) return;
  await putSecret(jobCredsKey(jobId), JOB_SCOPE, JSON.stringify(payload),
    `Crawler job ${jobId} credentials`);
}
export const deleteJobCredentials = (jobId) => deleteSecret(jobCredsKey(jobId), JOB_SCOPE);

// Remove every per-job credential row (called when a job finishes).
export async function deleteJobSecrets(jobId) {
  await deleteJobSecret(jobId);
  await deleteJobCredentials(jobId);
}

async function getJobCredentials(jobId) {
  const out = {};
  const secret = await getSecret(jobKey(jobId), JOB_SCOPE);
  if (secret) out.clientSecret = secret;
  const bundled = await getSecret(jobCredsKey(jobId), JOB_SCOPE);
  if (!bundled) return out;
  try {
    for (const [k, v] of Object.entries(JSON.parse(bundled))) {
      if (v && OTHER_SECRET_FIELDS.includes(k)) out[k] = v;
    }
  } catch { /* malformed bundle — ignore */ }
  return out;
}

// The job's source config id, from the server-owned column only.
function sourceConfigId(job) {
  const id = Number(job.configId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// Inject all vaulted credentials back into a claimed job's config for dispatch
// to the authenticated worker. Per-job credentials first, then — for a job the
// server created from a stored config — that config's current credentials on
// top (they win, as the config's clientSecret always has).
//
// `_scheduledByConfigId` in the returned config is rewritten from the column
// too, so the worker's config-scoped callbacks (e.g. mark-delta-mode) can only
// ever name the job's real source config.
export async function injectJobSecret(job) {
  const cfg = typeof job.config === 'string' ? JSON.parse(job.config) : { ...(job.config || {}) };
  delete cfg._scheduledByConfigId;

  Object.assign(cfg, await getJobCredentials(job.id));

  const configId = sourceConfigId(job);
  if (configId) {
    cfg._scheduledByConfigId = configId;
    Object.assign(cfg, await getConfigCredentials(configId));
  }
  return cfg;
}
