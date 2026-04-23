import { describe, it, expect } from 'vitest';
import { plugin } from './index.js';

// Fake db that returns a fixed result-set for the single SELECT the plugin
// issues. The plugin only consumes `rows`, so that's all we need to fake.
function makeDb(resources) {
  return {
    query: async () => ({ rows: resources }),
  };
}

function resourcesByName(...names) {
  return names.map((displayName, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
    displayName,
  }));
}

describe('resource-cluster plugin metadata', () => {
  it('targets Resource', () => {
    expect(plugin.targetType).toBe('Resource');
  });
  it('has no required parameters (scopeSystemId is optional)', () => {
    expect(plugin.parametersSchema.required || []).toEqual([]);
  });
  it('documents minMembers default of 4', () => {
    expect(plugin.parametersSchema.properties.minMembers.default).toBe(4);
  });
});

describe('resource-cluster plugin run()', () => {
  it('returns just the synthetic root when no tokens reach minMembers', async () => {
    const db = makeDb(resourcesByName('SG_Finance_Admins', 'SG_HR_Users'));
    const result = await plugin.run({ minMembers: 4 }, { db });
    // Only the root survives.
    expect(result.contexts).toHaveLength(1);
    expect(result.contexts[0].externalId).toBe('root');
    expect(result.contexts[0].parentExternalId).toBeUndefined();
    expect(result.members).toEqual([]);
  });

  it('clusters resources that share a significant token, regardless of wrapping', async () => {
    const db = makeDb(resourcesByName(
      'SG_APP_HAMIS_Admins_P',
      'GRP-HAMIS-ReadOnly-TST',
      'AG_AzureDevOps_Hamis_Developer',
      'AG_AzureTeam_HaMIS_Readers',
      'SG_FINANCE_BookKeepers', // wrong cluster — shouldn't land in HAMIS
    ));
    const result = await plugin.run({ minMembers: 4 }, { db });
    const byExt = new Map(result.contexts.map(c => [c.externalId, c]));
    expect(byExt.has('token:hamis')).toBe(true);
    // FINANCE has only 1 resource — below minMembers of 4.
    expect(byExt.has('token:finance')).toBe(false);
    // HAMIS cluster attaches to the root, not as a top-level node.
    expect(byExt.get('token:hamis').parentExternalId).toBe('root');
    // All four HAMIS resources are members, Finance resource is not.
    const hamisMembers = result.members.filter(m => m.contextExternalId === 'token:hamis');
    expect(hamisMembers).toHaveLength(4);
  });

  it('minMembers is respected at the edges', async () => {
    const db = makeDb(resourcesByName(
      'app_foo', 'app_foo_admins', 'app_foo_readers', // 3 rows with "foo"
      'app_bar_admins', 'app_bar_users', 'app_bar_readers', 'app_bar_writers', // 4 rows with "bar"
    ));

    const min3 = await plugin.run({ minMembers: 3 }, { db });
    const ids3 = min3.contexts.map(c => c.externalId).sort();
    expect(ids3).toEqual(['root', 'token:bar', 'token:foo'].sort());

    const min4 = await plugin.run({ minMembers: 4 }, { db });
    const ids4 = min4.contexts.map(c => c.externalId).sort();
    expect(ids4).toEqual(['root', 'token:bar']);
  });

  it('maxTokenCoverage drops tokens that appear in too many resources', async () => {
    // 10 resources, all of them contain "shared". With maxTokenCoverage=0.5
    // the "shared" token is present in 100% of rows → rejected.
    const names = Array.from({ length: 10 }, (_, i) => `app_shared_widget${i}`);
    const db = makeDb(resourcesByName(...names));
    const result = await plugin.run({ minMembers: 2, maxTokenCoverage: 0.5 }, { db });
    const ids = result.contexts.map(c => c.externalId);
    expect(ids).not.toContain('token:shared');
  });

  it('applies additionalStopwords on top of defaults', async () => {
    const db = makeDb(resourcesByName(
      'ROL_HAMIS_Admins',
      'ROL_HAMIS_Readers',
      'ROL_HAMIS_Writers',
      'ROL_HAMIS_Owners',
    ));
    // Without the extra stopword, "rol" (4 hits) and "hamis" (4 hits) both cluster.
    const baseline = await plugin.run({ minMembers: 4 }, { db });
    const baselineIds = baseline.contexts.map(c => c.externalId).sort();
    expect(baselineIds).toContain('token:rol');
    expect(baselineIds).toContain('token:hamis');

    // With rol in additionalStopwords, only hamis survives.
    const tuned = await plugin.run(
      { minMembers: 4, additionalStopwords: ['rol'] },
      { db },
    );
    const tunedIds = tuned.contexts.map(c => c.externalId).sort();
    expect(tunedIds).toEqual(['root', 'token:hamis']);
  });

  it('member rows reference the right contextExternalId', async () => {
    const db = makeDb(resourcesByName(
      'sg_hamis_admins', 'sg_hamis_readers', 'sg_hamis_writers', 'sg_hamis_users',
    ));
    const result = await plugin.run({ minMembers: 4 }, { db });
    // Every member row points at 'token:hamis'.
    for (const m of result.members) {
      expect(m.contextExternalId).toBe('token:hamis');
      // Member ids are the synthetic uuids produced by resourcesByName.
      expect(m.memberId).toMatch(/^0{8}-0{4}-0{4}-0{4}-[0-9a-f]{12}$/);
    }
    expect(result.members).toHaveLength(4);
  });

  it('uses rootName parameter for the synthetic root display name', async () => {
    const db = makeDb(resourcesByName('a', 'b'));
    const result = await plugin.run({ rootName: 'Teams and clusters' }, { db });
    expect(result.contexts[0].displayName).toBe('Teams and clusters');
  });

  it('emits clusters sorted largest first', async () => {
    const db = makeDb(resourcesByName(
      // 4 "small" resources
      'sg_small_admins', 'sg_small_users', 'sg_small_readers', 'sg_small_writers',
      // 6 "big" resources
      'sg_big_admins', 'sg_big_users', 'sg_big_readers', 'sg_big_writers',
      'sg_big_owners', 'sg_big_contributors',
    ));
    const result = await plugin.run({ minMembers: 4 }, { db });
    const nonRoot = result.contexts.filter(c => c.externalId !== 'root');
    expect(nonRoot.map(c => c.externalId)).toEqual(['token:big', 'token:small']);
  });

  it('returns {contexts:[], members:[]} on empty input', async () => {
    const db = makeDb([]);
    const result = await plugin.run({}, { db });
    expect(result.contexts).toEqual([]);
    expect(result.members).toEqual([]);
  });
});
