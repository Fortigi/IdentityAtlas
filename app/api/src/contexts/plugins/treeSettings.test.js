import { describe, it, expect, vi } from 'vitest';
import { loadTreeSettings } from './treeSettings.js';

const ALGO = '11111111-1111-4111-8111-111111111111';
const KEY = `gen~${ALGO}~inst-1`;
const dbWith = (row) => ({ queryOne: vi.fn(async () => row) });

describe('loadTreeSettings', () => {
  it('returns the plugin, the tree key and the settings without the old instance key', async () => {
    const db = dbWith({ pluginName: 'manager-hierarchy', parameters: { scopeSystemId: 3, managerPlacement: 'ownTeam', instanceKey: 'stale' } });
    expect(await loadTreeSettings(db, KEY)).toEqual({
      pluginName: 'manager-hierarchy', instanceKey: 'inst-1',
      params: { scopeSystemId: 3, managerPlacement: 'ownTeam' },
    });
    const [sql, params] = db.queryOne.mock.calls[0];
    expect(params).toEqual([ALGO, 'inst-1']);
    expect(sql).toMatch(/ORDER BY r\."startedAt" DESC\s+LIMIT 1/);
  });

  it('copes with a run that stored no parameters', async () => {
    expect((await loadTreeSettings(dbWith({ pluginName: 'p', parameters: null }), KEY)).params).toEqual({});
  });

  it('answers null for an unknown tree', async () => {
    expect(await loadTreeSettings(dbWith(null), KEY)).toBeNull();
  });

  it.each([
    ['not a key'],
    [`gen~${ALGO}~`], // legacy tree: a run without a key would build a second tree
    ['sync~1~OrganizationalUnit'],
    [`ctx~${ALGO}`],
  ])('does not query for %s', async (key) => {
    const db = dbWith({ pluginName: 'p', parameters: {} });
    expect(await loadTreeSettings(db, key)).toBeNull();
    expect(db.queryOne).not.toHaveBeenCalled();
  });
});
