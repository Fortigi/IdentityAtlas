// Feature flags steered by a test, for route tests that mock the database.
//
// The real flags read WorkerConfig through db.queryOne, so under a mocked
// database every flag lookup would consume a `mockResolvedValueOnce` meant for
// the handler (and read as "off"). A test file replaces the module instead —
// the vi.mock call itself must stay in the file, because vitest hoists it:
//
//   const flags = vi.hoisted(() => ({ riskScoring: true }));
//   vi.mock('../featureFlags.js', async (orig) =>
//     (await import('../../test-utils/featureFlagMock.js')).steeredFeatureFlags(await orig(), flags));
//
// and flips `flags.riskScoring` per test. A flag missing from `state` is off.
// Everything else (FEATURE_FLAGS, workerConfigKey, …) stays real. How a flag
// really resolves (stored override vs env var) is featureFlags.test.js's job.
export function steeredFeatureFlags(real, state) {
  const isFeatureEnabled = async (name) => state[name] === true;
  return {
    ...real,
    isFeatureEnabled,
    riskScoringEnabled: () => isFeatureEnabled('riskScoring'),
    orgKnowledgeEnabled: () => isFeatureEnabled('orgKnowledge'),
    requireFeature: (name) => async (_req, res, next) => {
      if (await isFeatureEnabled(name)) return next();
      res.status(404).json({ error: 'This feature is not enabled' });
    },
  };
}
