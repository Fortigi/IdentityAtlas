import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query } from '../../db/connection.js';
import { buildRuleIndex } from '../linking/candidates.js';
import { mentionRules, rankCandidates, resolution, resolveMentions, SHOW_FROM, PROBE_ENTITY_TYPE } from './resolve.js';

const IDS = {
  anna: '00000000-0000-4000-8000-000000000001',
  tom: '00000000-0000-4000-8000-000000000002',
  rob: '00000000-0000-4000-8000-000000000003',
  sgFin: '00000000-0000-4000-8000-000000000010',
  klant: '00000000-0000-4000-8000-000000000020',
};
const identities = [
  { id: IDS.anna, displayName: 'Anna Bakker', email: 'anna@demo.example' },
  { id: IDS.tom, displayName: 'Tom Bakker', email: 'tom@demo.example' },
  { id: IDS.rob, displayName: 'Rob Visser', email: 'rob@demo.example' },
];
const indexFor = (type, rows) => mentionRules(type).map(r => buildRuleIndex(r.targetType === 'Identity' ? rows : [], r));

describe('mentionRules', () => {
  it('a person is looked for among identities and accounts, a customer first in the lists', () => {
    expect(mentionRules('person').map(r => r.targetType)).toEqual(['Identity', 'Principal']);
    expect(mentionRules('customer').map(r => r.targetType)).toEqual(['OrgEntity', 'Resource', 'Context']);
    expect(mentionRules('concept')).toEqual([]);
    expect(mentionRules('planet')).toEqual([]);
    for (const r of mentionRules('team')) expect(r.entityType).toBe(PROBE_ENTITY_TYPE);
  });
});

describe('rankCandidates + resolution', () => {
  it('a full name outranks a first name only, and is the single best candidate', () => {
    const full = rankCandidates('Rob Visser', indexFor('person', identities));
    const first = rankCandidates('Rob', indexFor('person', identities));
    expect(full[0]).toMatchObject({ targetType: 'Identity', targetId: IDS.rob });
    expect(first[0]).toMatchObject({ targetType: 'Identity', targetId: IDS.rob });
    expect(full[0].confidence).toBeGreaterThan(first[0].confidence);
    expect(first[0].confidence).toBeLessThan(90);
    expect(resolution(first).status).toBe('candidates');
  });

  it('two people sharing the mentioned name stay ambiguous', () => {
    const c = rankCandidates('Bakker', indexFor('person', identities));
    expect(c.map(x => x.targetId).sort()).toEqual([IDS.anna, IDS.tom].sort());
    expect(c[0].confidence).toBe(c[1].confidence);
    expect(resolution(c).status).toBe('ambiguous');
  });

  it('an unknown name has no candidates, and nothing below the floor is shown', () => {
    expect(rankCandidates('Taake', indexFor('person', identities))).toEqual([]);
    expect(resolution([])).toEqual({ status: 'unmatched', candidates: [] });
    for (const c of rankCandidates('Rob', indexFor('person', identities))) expect(c.confidence).toBeGreaterThanOrEqual(SHOW_FROM);
  });

  it('candidates carry their reasons', () => {
    const [top] = rankCandidates('Rob Visser', indexFor('person', identities));
    expect(top.signals).toEqual(expect.arrayContaining(['displayName exact']));
    expect(top.label).toBe('Rob Visser');
  });

  it('a tie between target TYPES is not ambiguous (the same person as identity and as account)', () => {
    const c = [{ targetType: 'Identity', targetId: 'a', confidence: 79 }, { targetType: 'Principal', targetId: 'b', confidence: 79 }];
    expect(resolution(c).status).toBe('candidates');
  });

  it('two accounts at the top score are ambiguous even when one identity is unique ("Mark")', () => {
    const c = [
      { targetType: 'Identity', targetId: 'mark-ve', confidence: 79 },
      { targetType: 'Principal', targetId: 'mark-de-vries', confidence: 79 },
      { targetType: 'Principal', targetId: 'mark-ve-acc', confidence: 79 },
    ];
    expect(resolution(c).status).toBe('ambiguous');
    expect(resolution([...c.slice(0, 2), { ...c[2], confidence: 60 }]).status).toBe('candidates');
  });
});

describe('resolveMentions', () => {
  beforeEach(() => { query.mockReset(); });

  it('loads targets once per mention type and answers per mention key', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM "Identities"')) return { rows: identities };
      if (sql.includes('FROM "OrgEntities"')) return { rows: [{ id: IDS.klant, displayName: 'Northwind Traders', entityType: 'Klant' }] };
      if (sql.includes('FROM "Resources"')) return { rows: [{ id: IDS.sgFin, displayName: 'SG-Finance', resourceType: 'Group' }] };
      return { rows: [] };
    });
    const out = await resolveMentions([
      { key: 'person:rob', type: 'person', label: 'Rob' },
      { key: 'person:bakker', type: 'person', label: 'Bakker' },
      { key: 'customer:northwind traders', type: 'customer', label: 'Northwind Traders' },
      { key: 'team:sg finance', type: 'team', label: 'SG-Finance' },
      { key: 'concept:x', type: 'concept', label: 'vijf mensen' },
    ]);
    expect(out.get('person:rob').candidates[0].targetId).toBe(IDS.rob);
    expect(out.get('person:bakker').status).toBe('ambiguous');
    expect(out.get('customer:northwind traders').candidates[0]).toMatchObject({ targetType: 'OrgEntity', targetId: IDS.klant });
    expect(out.get('team:sg finance').candidates[0]).toMatchObject({ targetType: 'Resource', targetId: IDS.sgFin });
    expect(out.get('concept:x')).toEqual({ status: 'unmatched', candidates: [], reason: 'not-resolvable' });
    const identityLoads = query.mock.calls.filter(([sql]) => sql.includes('FROM "Identities"'));
    expect(identityLoads).toHaveLength(1);
  });
});
