import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { getTemplateGraph, shapeTemplateGraph, templatesByType, enrichmentAttributes, keyCounts } from './templateGraph.js';

const SRC = 'a0000000-0000-4000-8000-0000000000aa';

const PROFILES = [
  {
    name: 'Staff skills',
    recipe: {
      template: 'enrichment', enrich: { targetType: 'Identity' },
      entities: [{ type: 'Maten', attributes: [{ column: 'c2', name: 'expertises', multi: true }, { column: 'c3' }] }],
    },
  },
  {
    name: 'Timesheet',
    // a JSONB value that arrives as a string still reads
    recipe: JSON.stringify({
      template: 'activity',
      activity: { type: 'Uren', actor: { column: 'c3', targetTypes: ['Principal', 'Identity'] },
        subject: { column: 'c4', targetType: 'OrgEntity', targetEntityType: 'Klant' }, measure: { column: 'c5', unit: 'h' } },
    }),
  },
  {
    name: 'SoD',
    recipe: { template: 'relation', relation: { type: 'Incompatibility', predicate: 'incompatibleWith',
      left: { column: 'c1', targetType: 'Resource' }, right: { column: 'c2', targetType: 'OrgEntity', targetEntityType: 'Klant' } } },
  },
];

describe('templatesByType', () => {
  it('keeps the first (most frequent) template per type', () => {
    const m = templatesByType([
      { type: 'Maten', template: 'enrichment', n: 50 }, { type: 'Maten', template: 'collection', n: 2 },
      { type: 'Klant', template: 'collection', n: 58 },
    ]);
    expect([...m.entries()]).toEqual([['Maten', 'enrichment'], ['Klant', 'collection']]);
  });
});

describe('enrichmentAttributes', () => {
  it('reads the definition of the type itself, the column standing in for a missing name', () => {
    const recipe = { entities: [{ type: 'Other', attributes: [{ column: 'x', multi: true }] }, { type: 'Maten', attributes: [{ column: 'c2', name: 'level' }, { column: 'c9', multi: true }] }] };
    expect(enrichmentAttributes(recipe, 'Maten')).toEqual([{ name: 'level', multi: false }, { name: 'c9', multi: true }]);
  });

  it('falls back to the only definition, and to nothing without one', () => {
    expect(enrichmentAttributes({ entities: [{ type: 'Renamed', attributes: [{ column: 'a', multi: 'yes' }] }] }, 'Maten'))
      .toEqual([{ name: 'a', multi: false }]); // only a literal true is multi
    expect(enrichmentAttributes({}, 'Maten')).toEqual([]);
    expect(enrichmentAttributes({ entities: [{ type: 'Maten' }] }, 'Maten')).toEqual([]);
  });
});

describe('keyCounts', () => {
  it('sums per profile, role and status; rejected keys and unknown roles are not counted', () => {
    const m = keyCounts([
      { profileName: 'Timesheet', role: 'actor', status: 'accepted', n: 40 },
      { profileName: 'Timesheet', role: 'actor', status: 'proposed', n: 3 },
      { profileName: 'Timesheet', role: 'actor', status: 'rejected', n: 9 },
      { profileName: 'Timesheet', role: 'subject', status: 'unmatched', n: 2 },
      { profileName: 'Timesheet', role: 'witness', status: 'accepted', n: 7 },
    ]);
    expect(m.get('Timesheet')).toEqual({
      actor: { accepted: 40, proposed: 3, unmatched: 0 },
      subject: { accepted: 0, proposed: 0, unmatched: 2 },
    });
  });
});

describe('shapeTemplateGraph', () => {
  const out = shapeTemplateGraph({
    templates: [],
    enrichments: [{ type: 'Maten', profileName: 'Staff skills', linked: 48, rowCount: 51 }],
    activities: [
      { type: 'Uren', profileName: 'Timesheet', rowCount: 1152, unit: null, total: 8123.456, firstOn: '2024-01-01', lastOn: '2026-09-01' },
      { type: 'Calls', profileName: 'Gone', rowCount: 4, unit: 'min', total: 12, firstOn: '2026-01-05', lastOn: '2026-01-09' },
    ],
    keys: [{ profileName: 'Timesheet', role: 'subject', status: 'accepted', n: 55 }],
    pairs: [{ type: 'Incompatibility', profileName: 'SoD', count: 12 }],
    profiles: PROFILES,
  });

  it('an enrichment carries its target type and attributes from the recipe, and unlinked = rows − linked', () => {
    expect(out.enrichments).toEqual([{
      type: 'Maten', targetType: 'Identity', profileName: 'Staff skills',
      attributes: [{ name: 'expertises', multi: true }, { name: 'c3', multi: false }], linked: 48, unlinked: 3,
    }]);
  });

  it('an activity carries its actor/subject types from the recipe, the recipe unit when the rows have none, and zero-filled keys', () => {
    expect(out.activities[0]).toEqual({
      type: 'Uren', profileName: 'Timesheet', actorTypes: ['Principal', 'Identity'], subjectType: 'OrgEntity', subjectEntityType: 'Klant',
      rows: 1152, unit: 'h', total: 8123.46, firstOn: '2024-01-01', lastOn: '2026-09-01',
      keys: { actor: { accepted: 0, proposed: 0, unmatched: 0 }, subject: { accepted: 55, proposed: 0, unmatched: 0 } },
    });
  });

  it('an activity whose profile is gone still lists, with its own unit and empty recipe facts', () => {
    expect(out.activities[1]).toMatchObject({ actorTypes: [], subjectType: null, subjectEntityType: null, unit: 'min', keys: { actor: { accepted: 0 } } });
  });

  it('a relation names its predicate and end types, another list by its entity type', () => {
    expect(out.pairs).toEqual([{ type: 'Incompatibility', predicate: 'incompatibleWith', leftType: 'Resource', rightType: 'Klant', count: 12 }]);
  });
});

describe('getTemplateGraph', () => {
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

  it('applies the claim filter to the entity queries and the source filter to the activity rows', async () => {
    await getTemplateGraph({ includeClosed: false, sourceId: SRC }, []);
    const calls = query.mock.calls;
    const enrich = calls.find(([sql]) => sql.includes(`p."template" = 'enrichment' AND`));
    expect(enrich[0]).toMatch(/e\.status <> 'rejected' AND e\."validTo" IS NULL AND e\."sourceId" = \$1::uuid/);
    expect(enrich[0]).toMatch(/LEFT JOIN t ON t\."entityId" = e\."id"/);
    expect(enrich[1]).toEqual([SRC]);
    const pairs = calls.find(([sql]) => sql.includes(`p."template" = 'relation'`));
    expect(pairs[0]).toMatch(/COUNT\(\*\) FILTER \(WHERE e\.status = 'accepted'\)::int AS count/);
    const acts = calls.find(([sql]) => sql.includes('FROM "OrgActivities" a'));
    expect(acts[0]).toMatch(/WHERE \(\$1::uuid IS NULL OR a\."sourceId" = \$1::uuid\)/);
    expect(acts[1]).toEqual([SRC]);
    expect(calls).toHaveLength(5);
  });

  it('binds no source when none is asked', async () => {
    await getTemplateGraph({ includeClosed: true, sourceId: null }, []);
    const acts = query.mock.calls.find(([sql]) => sql.includes('FROM "OrgActivities" a'));
    expect(acts[1]).toEqual([null]);
    const tpl = query.mock.calls.find(([sql]) => sql.includes('AS template'));
    expect(tpl[0]).not.toMatch(/"validTo" IS NULL/);
    expect(tpl[1]).toEqual([]);
  });
});
