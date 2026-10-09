import { describe, it, expect } from 'vitest';
import { linkRun } from './run.js';

// Placeholder contract test: workstream T2 replaces this file together with run.js.
describe('linkRun (stub)', () => {
  it('returns the run id and zero counts, and says it is not built', async () => {
    const out = await linkRun({ runId: 'run-1', profile: { recipe: null, linkRules: [] } });
    expect(out).toEqual({ runId: 'run-1', linked: 0, proposed: 0, ambiguous: 0, none: 0, notBuilt: true });
  });
});
