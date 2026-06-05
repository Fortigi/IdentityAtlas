// Vault helpers for crawler credentials.
//
// clientSecret is vaulted per-config (keyed by config id) and per-job for inline
// runs.  Other Omada credential fields — password, apiToken, cookieString — are
// bundled as JSON and vaulted per-job so they are never stored in plaintext in
// CrawlerJobs.config (security finding H-02 + extension for Omada auth types).

import { putSecret, getSecret, hasSecret, deleteSecret } from './vault.js';

const CONFIG_SCOPE = 'crawler-config';
const JOB_SCOPE = 'crawler-job';
const configKey = (id) => `crawler-config:${id}:clientSecret`;
const jobKey = (id) => `crawler-job:${id}:clientSecret`;
const jobCredsKey = (id) => `crawler-job:${id}:credentials`;

// Non-clientSecret credential fields that Omada crawlers use.
// These are stripped from CrawlerJobs.config and vaulted separately.
export const OTHER_SECRET_FIELDS = ['password', 'apiToken', 'cookieString'];

export async function storeConfigSecret(configId, clientSecret) {
  await putSecret(configKey(configId), CONFIG_SCOPE, clientSecret, `Crawler config ${configId} clientSecret`);
}
export const getConfigSecret = (configId) => getSecret(configKey(configId));
export const hasConfigSecret = (configId) => hasSecret(configKey(configId));
export const deleteConfigSecret = (configId) => deleteSecret(configKey(configId));

export async function storeJobSecret(jobId, clientSecret) {
  await putSecret(jobKey(jobId), JOB_SCOPE, clientSecret, `Crawler job ${jobId} clientSecret`);
}
export const deleteJobSecret = (jobId) => deleteSecret(jobKey(jobId));

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
export const deleteJobCredentials = (jobId) => deleteSecret(jobCredsKey(jobId));

// Inject all vaulted credentials back into a claimed job's config for dispatch
// to the authenticated worker.  For config-based jobs clientSecret comes from
// the config vault; for inline jobs it comes from the job vault.  All other
// credential fields (password, apiToken, cookieString) come from the per-job
// credentials bundle written at job-creation time.
export async function injectJobSecret(job) {
  const cfg = typeof job.config === 'string' ? JSON.parse(job.config) : { ...(job.config || {}) };

  // clientSecret
  let secret = null;
  if (cfg._scheduledByConfigId != null) secret = await getConfigSecret(cfg._scheduledByConfigId);
  if (!secret) secret = await getSecret(jobKey(job.id));
  if (secret) cfg.clientSecret = secret;

  // Other credential fields (Omada: password, apiToken, cookieString)
  const bundled = await getSecret(jobCredsKey(job.id));
  if (bundled) {
    try {
      const extra = JSON.parse(bundled);
      for (const [k, v] of Object.entries(extra)) if (v) cfg[k] = v;
    } catch { /* malformed bundle — ignore */ }
  }

  return cfg;
}
