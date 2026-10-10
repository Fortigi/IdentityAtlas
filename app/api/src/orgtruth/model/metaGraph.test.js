import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getMetaGraph, groupAttributeKeys, ATTRIBUTE_KEY_CAP } from './metaGraph.js';

const SRC = 'a0000000-0000-4000-8000-0000000000aa';
const LAST = new Date('2026-09-30T00:00:00.000Z');

// Every query getMetaGraph sends, recognised by a fragment only that query
// carries — so the fixture follows the SQL, not the call order.
const QUERIES = {
  types:       (sql) => sql.includes('COUNT(DISTINCT e."sourceId")'),
  keys:        (sql) => sql.includes('jsonb_object_keys'),
  predicates:  (sql) => sql.includes('FROM "OrgRelations"'),
  links:       (sql) => sql.includes('FROM "OrgLinks"') && sql.includes(`l."targetType" <> 'OrgEntity'`),
  entityLinks: (sql) => sql.includes('FROM "OrgLinks"') && sql.includes(`l."targetType" = 'OrgEntity'`),
  sources:     (sql) => sql.includes('FROM "OrgSources"'),
  system:      (sql) => sql.includes('FROM "Principals"'),
  profiles:    (sql) => sql.includes('WHERE p.version = (SELECT MAX'),
  // the T10 template parts (templateGraph.js)
  templates:   (sql) => sql.includes('AS template'),
  enrichments: (sql) => sql.includes("p.\"template\" = 'enrichment'"),
  pairs:       (sql) => sql.includes("p.\"template\" = 'relation'"),
  activities:  (sql) => sql.includes('FROM "OrgActivities" a'),
  activityKeys:(sql) => sql.includes('FROM "OrgActivityKeys"'),
};
const kindOf = (sql) => Object.keys(QUERIES).filter(k => QUERIES[k](sql));

const PROFILE = {
  id: 'b0000000-0000-4000-8000-000000000002', name: 'Uren', version: 3,
  recipe: { entities: [] },
  linkRules: [{ entityType: 'Uren', targetType: 'OrgEntity', targetEntityType: 'FortigiTeam', via: 'klant' }],
  lastSourceId: SRC, lastRunStatus: 'completed',
};

const ROWS = {
  types: [
    { type: 'Person', count: 51, proposed: 2, sources: 1, lastObservedAt: LAST },
    { type: 'Project', count: 87, proposed: 0, sources: 2, lastObservedAt: LAST },
  ],
  keys: [
    { type: 'Project', key: 'budget', n: 80 },
    { type: 'Project', key: 'costCenter', n: 12 },
  ],
  predicates: [{ predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85, proposed: 3 }],
  // two attributes of one entity type to one target type stay two edges
  links: [
    { entityType: 'Project', targetType: 'Principal', via: 'eigenaar', accepted: 51, proposed: 9 },
    { entityType: 'Project', targetType: 'Principal', via: 'team', accepted: 7, proposed: 0 },
  ],
  entityLinks: [{ fromType: 'Uren', toType: 'FortigiTeam', via: 'klant', accepted: 4, proposed: 1 }],
  sources: [{ n: 2 }],
  system: [{ Principal: 1127, Resource: 1385, Identity: 600, Context: 42 }],
  profiles: [PROFILE],
};

function stage(rows = ROWS) {
  query.mockImplementation(async (sql) => {
    const kinds = kindOf(sql);
    if (kinds.length !== 1) throw new Error(`unrecognised or ambiguous query (${kinds.join(',')}): ${sql}`);
    return { rows: rows[kinds[0]] ?? [] };
  });
}
const callOf = (kind) => {
  const calls = query.mock.calls.filter(([sql]) => kindOf(sql)[0] === kind);
  expect(calls, kind).toHaveLength(1);
  return calls[0];
};

beforeEach(() => { query.mockReset(); });

describe('getMetaGraph', () => {
  it('shapes types (with their attribute keys), predicates, links, entity links, system types, profiles and totals', async () => {
    stage();
    const out = await getMetaGraph();
    expect(out).toEqual({
      entityTypes: [
        { type: 'Person', count: 51, proposed: 2, sources: 1, lastObservedAt: LAST, attributeKeys: [], template: 'collection' },
        { type: 'Project', count: 87, proposed: 0, sources: 2, lastObservedAt: LAST, attributeKeys: ['budget', 'costCenter'], template: 'collection' },
      ],
      predicates: [{ predicate: 'owner', fromType: 'Project', toType: 'Person', count: 85, proposed: 3 }],
      links: ROWS.links,
      entityLinks: ROWS.entityLinks,
      systemTypes: [
        { targetType: 'Principal', count: 1127 }, { targetType: 'Resource', count: 1385 },
        { targetType: 'Identity', count: 600 }, { targetType: 'Context', count: 42 },
      ],
      profiles: [PROFILE],
      enrichments: [], activities: [], pairs: [],
      // links = 51+9+7+0 to the system truth + 4+1 between lists
      totals: { entities: 140, relations: 88, links: 72, sources: 2 },
    });
    expect(query).toHaveBeenCalledTimes(13);
  });

  it('stamps each entity type with its template and passes the template parts through', async () => {
    stage({
      ...ROWS,
      // Person: more rows from an enrichment than as a collection → the most frequent wins (order = n DESC)
      templates: [{ type: 'Person', template: 'enrichment', n: 40 }, { type: 'Person', template: 'collection', n: 11 }],
      pairs: [{ type: 'SoD', profileName: 'SoD', count: 3 }],
    });
    const out = await getMetaGraph();
    expect(out.entityTypes.map(t => [t.type, t.template])).toEqual([['Person', 'enrichment'], ['Project', 'collection']]);
    expect(out.pairs).toEqual([{ type: 'SoD', predicate: null, leftType: null, rightType: null, count: 3 }]);
    expect(callOf('templates')[0]).toMatch(/COALESCE\(\(SELECT p\."template" FROM "OrgImportProfiles" p WHERE p\."id" = e\."profileId"\), 'collection'\)/);
  });

  it('counts links between lists in totals.links even with no system links', async () => {
    stage({ ...ROWS, links: [] });
    const out = await getMetaGraph();
    expect(out.links).toEqual([]);
    expect(out.totals.links).toBe(5);
  });

  it('groups system links per entity type, target type and attribute, leaving links to another list out', async () => {
    stage();
    await getMetaGraph();
    const [sql] = callOf('links');
    expect(sql).toMatch(/SELECT e\."entityType", l\."targetType", COALESCE\(l\.via, 'displayName'\) AS via/);
    expect(sql).toMatch(/GROUP BY e\."entityType", l\."targetType", COALESCE\(l\.via, 'displayName'\)/);
    expect(sql).toMatch(/l\.status <> 'rejected' AND l\."targetType" <> 'OrgEntity' AND/);
  });

  it('groups links between lists per from type, to type and attribute, only for OrgEntity targets', async () => {
    stage();
    await getMetaGraph();
    const [sql, params] = callOf('entityLinks');
    expect(sql).toMatch(/e\."entityType" AS "fromType", t\."entityType" AS "toType", COALESCE\(l\.via, 'displayName'\) AS via/);
    expect(sql).toMatch(/JOIN "OrgEntities" t ON t\.id = l\."targetId"/);
    expect(sql).toMatch(/GROUP BY 1, 2, 3/);
    expect(sql).toMatch(/l\.status <> 'rejected' AND l\."targetType" = 'OrgEntity' AND e\.status <> 'rejected' AND e\."validTo" IS NULL/);
    expect(params).toEqual([]);
  });

  it('reads the newest version per profile name with the source and status of its last run', async () => {
    stage();
    await getMetaGraph({ sourceId: SRC });
    const [sql, params] = callOf('profiles');
    expect(sql).toMatch(/WHERE p\.version = \(SELECT MAX\(v\.version\) FROM "OrgImportProfiles" v WHERE v\.name = p\.name\)/);
    // the last run of ANY version of that profile name, newest first
    expect(sql).toMatch(/SELECT r\."sourceId" FROM "OrgImportRuns" r JOIN "OrgImportProfiles" pv ON pv\.id = r\."profileId"\s+WHERE pv\.name = p\.name ORDER BY r\."createdAt" DESC LIMIT 1\) AS "lastSourceId"/);
    expect(sql).toMatch(/SELECT r\.status FROM "OrgImportRuns" r JOIN "OrgImportProfiles" pv ON pv\.id = r\."profileId"\s+WHERE pv\.name = p\.name ORDER BY r\."createdAt" DESC LIMIT 1\) AS "lastRunStatus"/);
    // the source filter does not narrow the profiles
    expect(params).toBeUndefined();
  });

  it('filters open, non-rejected rows by default and binds nothing', async () => {
    stage();
    await getMetaGraph();
    for (const kind of ['types', 'keys', 'predicates']) {
      const [sql, params] = callOf(kind);
      expect(sql).toMatch(/status <> 'rejected'/);
      expect(sql).toMatch(/"validTo" IS NULL/);
      expect(params).toEqual([]);
    }
    expect(callOf('links')[0]).toMatch(/AND e\.status <> 'rejected' AND e\."validTo" IS NULL/);
    expect(callOf('sources')[1]).toEqual([null]);
  });

  it('includes closed rows and binds the source on request', async () => {
    stage();
    await getMetaGraph({ includeClosed: true, sourceId: SRC });
    for (const kind of ['types', 'keys', 'predicates', 'links', 'entityLinks']) {
      const [sql, params] = callOf(kind);
      expect(sql).not.toMatch(/"validTo" IS NULL/);
      expect(sql).toMatch(/"sourceId" = \$1::uuid/);
      expect(params).toEqual([SRC]);
    }
    expect(callOf('entityLinks')[0]).toMatch(/e\."sourceId" = \$1::uuid/);
    expect(callOf('sources')[1]).toEqual([SRC]);
  });

  it('skips the system counts when asked, and survives empty result sets', async () => {
    stage({});
    const out = await getMetaGraph({ withSystemCounts: false });
    expect(query).toHaveBeenCalledTimes(12);
    expect(query.mock.calls.some(([sql]) => QUERIES.system(sql))).toBe(false);
    expect(out).toEqual({
      entityTypes: [], predicates: [], links: [], entityLinks: [], systemTypes: [], profiles: [],
      enrichments: [], activities: [], pairs: [],
      totals: { entities: 0, relations: 0, links: 0, sources: 0 },
    });
  });

  it('reports zero for a system table the count row lacks', async () => {
    query.mockResolvedValue({ rows: [] });
    const out = await getMetaGraph();
    expect(out.systemTypes).toEqual([
      { targetType: 'Principal', count: 0 }, { targetType: 'Resource', count: 0 },
      { targetType: 'Identity', count: 0 }, { targetType: 'Context', count: 0 },
    ]);
  });
});

describe('groupAttributeKeys', () => {
  it('keeps the row order per type and caps each type', () => {
    const rows = [
      { type: 'A', key: 'x' }, { type: 'B', key: 'y' }, { type: 'A', key: 'z' }, { type: 'A', key: 'w' },
    ];
    const byType = groupAttributeKeys(rows, 2);
    expect(byType.get('A')).toEqual(['x', 'z']);
    expect(byType.get('B')).toEqual(['y']);
  });

  it('caps at 50 by default', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ type: 'A', key: `k${i}` }));
    expect(ATTRIBUTE_KEY_CAP).toBe(50);
    expect(groupAttributeKeys(rows).get('A')).toHaveLength(50);
    expect(groupAttributeKeys(rows).get('A')[49]).toBe('k49');
  });
});
