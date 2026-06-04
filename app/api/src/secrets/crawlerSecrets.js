// Vault helpers for crawler Graph credentials (clientSecret).
//
// The secret is stored encrypted in the Secrets vault — never in plaintext in
// CrawlerConfigs / CrawlerJobs (security finding H-02). It is keyed by the
// source config id where one exists, otherwise by the job id for inline
// ("Run Now") jobs that carry their own credentials.

import { putSecret, getSecret, hasSecret, deleteSecret } from './vault.js';

const CONFIG_SCOPE = 'crawler-config';
const JOB_SCOPE = 'crawler-job';
const configKey = (id) => `crawler-config:${id}:clientSecret`;
const jobKey = (id) => `crawler-job:${id}:clientSecret`;

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

// Inject the clientSecret back into a claimed job's config for dispatch to the
// authenticated worker. Source-config secret takes precedence; falls back to a
// job-scoped secret (inline jobs). Returns the parsed config object with
// clientSecret populated if one is found, otherwise unchanged.
export async function injectJobSecret(job) {
  const cfg = typeof job.config === 'string' ? JSON.parse(job.config) : { ...(job.config || {}) };
  let secret = null;
  if (cfg._scheduledByConfigId != null) secret = await getConfigSecret(cfg._scheduledByConfigId);
  if (!secret) secret = await getSecret(jobKey(job.id));
  if (secret) cfg.clientSecret = secret;
  return cfg;
}
