// Optional-feature flags — one definition shared by every consumer:
//   • GET  /api/features            (app.js)            — what the SPA reads
//   • POST /api/admin/features/toggle (routes/admin/settings.js) — the toggle
//   • server-side guards (e.g. routes/jobs/configs.js)  — enforcement
//
// A flag resolves in two steps: a WorkerConfig row `FEATURE_<KEY>` written by
// the admin toggle wins; otherwise the matching env var is the default. That
// makes an admin's choice survive container restarts while still letting a
// deployment ship a different default via compose.
//
// Adding a flag here is all that's needed — the /api/features payload and the
// set of toggleable feature names are both derived from this table.

export const FEATURE_FLAGS = {
  // Risk scoring is opt-in on a fresh install: it needs an LLM provider and a
  // risk profile before it produces anything, so default OFF.
  riskScoring: {
    key: 'RISK_SCORING',
    envDefault: env => env.FEATURE_RISK_SCORING === 'true',
  },
  // Account linking (formerly "account correlation") is on unless explicitly
  // disabled. The legacy key/env var are honoured so upgrades keep their setting.
  accountLinking: {
    key: 'ACCOUNT_LINKING',
    legacyKeys: ['ACCOUNT_CORRELATION'],
    envDefault: env => (env.FEATURE_ACCOUNT_LINKING ?? env.FEATURE_ACCOUNT_CORRELATION) !== 'false',
  },
  // Experimental crawlers: connectors that are built and tested but have had
  // only limited exposure to real-world endpoints. Default OFF — an operator
  // opts in from Admin → Experimental. See docs/reference/experimental-features.md.
  experimentalCrawlers: {
    key: 'EXPERIMENTAL_CRAWLERS',
    envDefault: env => env.FEATURE_EXPERIMENTAL_CRAWLERS === 'true',
  },
};

// WorkerConfig key for a flag name, e.g. 'riskScoring' → 'FEATURE_RISK_SCORING'.
export function workerConfigKey(name) {
  const def = FEATURE_FLAGS[name];
  return def ? `FEATURE_${def.key}` : null;
}

// Read a stored override. Returns true/false, or null when there is no row
// (or no SQL) and the env-var default should be used instead.
export async function getFeatureOverride(key) {
  if (process.env.USE_SQL !== 'true') return null;
  try {
    const db = await import('./db/connection.js');
    const r = await db.queryOne(
      `SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`,
      [`FEATURE_${key}`]
    );
    if (!r) return null;
    const v = r.configValue;
    return v === 'true' ? true : v === 'false' ? false : null;
  } catch (err) {
    console.warn(`getFeatureOverride(${key}) failed: ${err.message}`);
    return null;
  }
}

// Resolve one flag to a boolean: stored override (incl. legacy keys) → env default.
export async function isFeatureEnabled(name) {
  const def = FEATURE_FLAGS[name];
  if (!def) return false;
  let override = await getFeatureOverride(def.key);
  for (const legacy of def.legacyKeys || []) {
    if (override === null) override = await getFeatureOverride(legacy);
  }
  return override !== null ? override : def.envDefault(process.env);
}

// The whole /api/features payload.
export async function readFeatures() {
  const out = {};
  for (const name of Object.keys(FEATURE_FLAGS)) out[name] = await isFeatureEnabled(name);
  return out;
}
