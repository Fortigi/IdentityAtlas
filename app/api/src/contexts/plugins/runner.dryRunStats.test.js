import { describe, it, expect, vi } from 'vitest';

const run = vi.fn();
vi.mock('../../db/connection.js'); // picks up src/db/__mocks__/connection.js
vi.mock('./registry.js', () => ({
  getPlugin: () => ({ name: 'p', parametersSchema: {}, run }),
  REGISTERED_PLUGINS: [],
}));

const { dryRun } = await import('./runner.js');

describe('dryRun — what the filter kept', () => {
  it('passes on the stats of a plugin that reports them', async () => {
    const stats = { accountsTotal: 5, peopleIncluded: 3, filteredOut: 1, secondAccounts: 1 };
    run.mockResolvedValueOnce({ contexts: [{ externalId: 'root' }], members: [], stats });
    expect(await dryRun('p', {})).toMatchObject({ contextCount: 1, memberCount: 0, stats });
  });

  it('has no stats key for a plugin that does not', async () => {
    run.mockResolvedValueOnce({ contexts: [], members: [] });
    expect(await dryRun('p', {})).not.toHaveProperty('stats');
  });
});
