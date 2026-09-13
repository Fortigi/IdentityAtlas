// Tests for the feature-flag resolver shared by /api/features, the admin
// toggle endpoint and the server-side guards.
//
// Every case is chosen to DISCRIMINATE: the stored-override tests set the env
// var to the OPPOSITE value, so a resolver that ignored WorkerConfig (or
// ignored the env var) would fail rather than accidentally agree.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db/connection.js');
import { queryOne } from './db/connection.js';

const { FEATURE_FLAGS, workerConfigKey, getFeatureOverride, isFeatureEnabled, readFeatures } =
  await import('./featureFlags.js');

// Stage WorkerConfig rows by key, e.g. { FEATURE_RISK_SCORING: 'true' }.
function stageRows(rows) {
  queryOne.mockImplementation(async (_sql, [key]) =>
    key in rows ? { configValue: rows[key] } : undefined);
}

const ENV_KEYS = [
  'USE_SQL', 'FEATURE_RISK_SCORING', 'FEATURE_ACCOUNT_LINKING',
  'FEATURE_ACCOUNT_CORRELATION', 'FEATURE_EXPERIMENTAL_CRAWLERS',
];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.USE_SQL = 'true';
  queryOne.mockReset();
  stageRows({});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('workerConfigKey', () => {
  it('maps a flag name to its FEATURE_-prefixed WorkerConfig key', () => {
    expect(workerConfigKey('experimentalCrawlers')).toBe('FEATURE_EXPERIMENTAL_CRAWLERS');
    expect(workerConfigKey('riskScoring')).toBe('FEATURE_RISK_SCORING');
  });
  it('returns null for a name that is not a flag — this is what makes the toggle endpoint 400', () => {
    expect(workerConfigKey('nope')).toBeNull();
    expect(workerConfigKey(undefined)).toBeNull();
  });
});

describe('env-var defaults (no stored override)', () => {
  it('experimentalCrawlers is OFF unless the env var says exactly "true"', async () => {
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(false);
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'yes';   // not "true"
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(false);
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'true';
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(true);
  });

  it('riskScoring is OFF on a fresh install and ON only for the exact string "true"', async () => {
    expect(await isFeatureEnabled('riskScoring')).toBe(false);
    process.env.FEATURE_RISK_SCORING = '1';
    expect(await isFeatureEnabled('riskScoring')).toBe(false);
    process.env.FEATURE_RISK_SCORING = 'true';
    expect(await isFeatureEnabled('riskScoring')).toBe(true);
  });

  it('accountLinking is ON unless explicitly disabled — including via the legacy env var', async () => {
    expect(await isFeatureEnabled('accountLinking')).toBe(true);
    process.env.FEATURE_ACCOUNT_CORRELATION = 'false';
    expect(await isFeatureEnabled('accountLinking')).toBe(false);
    process.env.FEATURE_ACCOUNT_LINKING = 'true';        // new var wins over legacy
    expect(await isFeatureEnabled('accountLinking')).toBe(true);
  });
});

describe('stored overrides beat env vars', () => {
  it('a stored "false" turns experimentalCrawlers off even when the env var enables it', async () => {
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'true';
    stageRows({ FEATURE_EXPERIMENTAL_CRAWLERS: 'false' });
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(false);
  });

  it('a stored "true" turns experimentalCrawlers on with no env var set', async () => {
    stageRows({ FEATURE_EXPERIMENTAL_CRAWLERS: 'true' });
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(true);
  });

  it('falls back to the legacy accountLinking key when only that row exists', async () => {
    stageRows({ FEATURE_ACCOUNT_CORRELATION: 'false' });
    expect(await isFeatureEnabled('accountLinking')).toBe(false);
  });

  it('prefers the current accountLinking key over the legacy one when both exist', async () => {
    stageRows({ FEATURE_ACCOUNT_LINKING: 'true', FEATURE_ACCOUNT_CORRELATION: 'false' });
    expect(await isFeatureEnabled('accountLinking')).toBe(true);
  });

  it('ignores a garbage configValue and uses the env default instead', async () => {
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'true';
    stageRows({ FEATURE_EXPERIMENTAL_CRAWLERS: 'maybe' });
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(true);
  });
});

describe('getFeatureOverride', () => {
  it('looks the flag up by its FEATURE_-prefixed key in WorkerConfig', async () => {
    await getFeatureOverride('EXPERIMENTAL_CRAWLERS');
    const [sql, params] = queryOne.mock.calls[0];
    expect(sql).toContain('FROM "WorkerConfig"');
    expect(sql).toContain('"configKey" = $1');
    expect(params).toEqual(['FEATURE_EXPERIMENTAL_CRAWLERS']);
  });

  it('reads a flag with no legacy key exactly once — no speculative extra lookups', async () => {
    await isFeatureEnabled('experimentalCrawlers');
    expect(queryOne).toHaveBeenCalledTimes(1);
  });

  it('says nothing on the console when the flag simply has no stored row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await getFeatureOverride('EXPERIMENTAL_CRAWLERS')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not touch the database when SQL is not configured', async () => {
    process.env.USE_SQL = 'false';
    stageRows({ FEATURE_EXPERIMENTAL_CRAWLERS: 'true' });
    expect(await getFeatureOverride('EXPERIMENTAL_CRAWLERS')).toBeNull();
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('survives a database error and reports "no override" rather than throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queryOne.mockRejectedValue(new Error('relation "WorkerConfig" does not exist'));
    expect(await getFeatureOverride('EXPERIMENTAL_CRAWLERS')).toBeNull();
    // The warning has to name the flag and the cause, or it is useless to an operator.
    expect(warn.mock.calls[0][0]).toContain('EXPERIMENTAL_CRAWLERS');
    expect(warn.mock.calls[0][0]).toContain('relation "WorkerConfig" does not exist');
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'true';
    expect(await isFeatureEnabled('experimentalCrawlers')).toBe(true);   // env default still applies
    warn.mockRestore();
  });
});

describe('readFeatures', () => {
  it('answers with exactly the declared flags — this is the /api/features payload', async () => {
    process.env.FEATURE_EXPERIMENTAL_CRAWLERS = 'true';
    const payload = await readFeatures();
    expect(Object.keys(payload).sort()).toEqual(Object.keys(FEATURE_FLAGS).sort());
    expect(payload).toEqual({ riskScoring: false, accountLinking: true, experimentalCrawlers: true });
  });
});

describe('isFeatureEnabled on an unknown flag', () => {
  it('is false — an unrecognised name must never read as "enabled"', async () => {
    expect(await isFeatureEnabled('somethingElse')).toBe(false);
    expect(queryOne).not.toHaveBeenCalled();
  });
});
