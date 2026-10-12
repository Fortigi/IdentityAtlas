import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import { listMentions, listClaims, statementsAbout, exportPackage } from './read.js';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('listMentions', () => {
  it('joins each mention to its candidates with the target label and the reasons', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM "OrgEntities" e')) return { rows: [{ id: 'm1', displayName: 'Rob', attributes: { mentionType: 'person', resolution: 'ambiguous', occurrences: [{ seq: 1 }], mentionOrigin: 'model' } }] };
      if (sql.includes('FROM "OrgLinks"')) return { rows: [{ id: 'l1', orgEntityId: 'm1', targetType: 'Identity', targetId: 'i1', confidence: 79, signals: 'displayName token,displayName fuzzy', matchedValue: 'Rob Visser', status: 'proposed', analystOverride: null }] };
      if (sql.includes('FROM "Identities"')) return { rows: [{ id: 'i1', displayName: 'Rob Visser', kind: null }] };
      return { rows: [] };
    });
    const [m] = await listMentions('s1');
    expect(m).toMatchObject({ id: 'm1', type: 'person', label: 'Rob', resolution: 'ambiguous', origin: 'model' });
    expect(m.candidates).toEqual([expect.objectContaining({
      linkId: 'l1', targetType: 'Identity', label: 'Rob Visser', confidence: 79, reasons: ['displayName token', 'displayName fuzzy'], status: 'proposed',
    })]);
  });

  it('only model mentions of the prefixed types are listed', async () => {
    query.mockResolvedValue({ rows: [] });
    await listMentions('s1');
    expect(query.mock.calls[0][0]).toContain(`"origin" = 'model'`);
    expect(query.mock.calls[0][0]).toContain(`'Mentioned person'`);
    expect(query.mock.calls).toHaveLength(1); // no mentions → no link query
  });
});

describe('listClaims', () => {
  it('shapes a statement with both sides and its exact evidence', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM "OrgRelations" r')) {
        return { rows: [{ id: 'r1', predicate: 'memberOf', status: 'proposed', confidence: 80, fromEntityId: 'm1', toEntityId: 'm2', subject: 'Rob', subjectType: 'person', object: 'kernteam', objectType: 'team',
          attributes: { qualifier: null, modality: 'stated', topic: 'membership', support: 'supported' } }] };
      }
      return { rows: [{ id: 'e1', relationId: 'r1', seq: 3, startChar: 10, endChar: 30, quote: 'Rob zit in het kernteam', support: 'supported', verifier: 'model' }] };
    });
    const [c] = await listClaims('s1', { status: 'proposed' });
    expect(c).toMatchObject({
      id: 'r1', predicate: 'memberOf', modality: 'stated', support: 'supported', status: 'proposed', rejectedBy: null,
      subject: { mentionId: 'm1', label: 'Rob', type: 'person' }, object: { mentionId: 'm2', label: 'kernteam', type: 'team' },
      evidence: [{ id: 'e1', seq: 3, startChar: 10, endChar: 30, quote: 'Rob zit in het kernteam', support: 'supported', verifier: 'model' }],
    });
    expect(query.mock.calls[0][1]).toEqual(['s1', 'proposed']);
  });
});

describe('statementsAbout', () => {
  it('reads accepted statements through accepted links and says who said what about whom', async () => {
    query.mockResolvedValue({ rows: [
      { id: 'r1', predicate: 'memberOf', qualifier: null, mention: 'Rob', asSubject: true, other: 'Omada-kernteam', sourceId: 's', sourceName: 'Interview Wim', observedAt: '2026-10-11', quote: 'Led, Rob, Mark en Taake' },
      { id: 'r2', predicate: 'leads', qualifier: null, mention: 'Rob', asSubject: false, other: 'Grace', sourceId: 's', sourceName: 'x', observedAt: null, quote: null },
      { id: 'r3', predicate: 'memberOf', qualifier: 'aspirant', mention: 'Rob', asSubject: true, other: 'maten', sourceId: 's', sourceName: 'x', observedAt: null, quote: null },
      { id: 'r4', predicate: 'other', qualifier: 'signs contracts for', mention: 'Rob', asSubject: true, other: 'bestuur', sourceId: 's', sourceName: 'x', observedAt: null, quote: null },
      { id: 'r5', predicate: 'invented', qualifier: null, mention: 'Rob', asSubject: true, other: 'x', sourceId: 's', sourceName: 'x', observedAt: null, quote: null },
    ] });
    const out = await statementsAbout([{ targetType: 'Identity', id: 'i1' }]);
    expect(out.map(s => s.text)).toEqual([
      'Rob is a member of Omada-kernteam', 'Grace leads Rob', 'Rob is a member of maten (aspirant)', 'Rob signs contracts for bestuur', 'Rob — x',
    ]);
    expect(out[4].predicate).toBe('other');
    expect(query.mock.calls[0][0]).toContain(`l."status" = 'accepted'`);
    expect(query.mock.calls[0][0]).toContain(`r."status" = 'accepted'`);
    expect(query.mock.calls[0][1]).toEqual([['Identity'], ['i1']]);
    expect(await statementsAbout([])).toEqual([]);
  });
});

describe('exportPackage', () => {
  it('null for an unknown transcript; otherwise everything plus versions and no external AI', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await exportPackage('00000000-0000-4000-8000-000000000001')).toBeNull();
    queryOne.mockResolvedValueOnce({ id: 's', displayName: 'I', textContent: 'Rob zit in het kernteam.', metadata: {} });
    query.mockResolvedValue({ rows: [] });
    const pkg = await exportPackage('00000000-0000-4000-8000-000000000001');
    expect(pkg).toMatchObject({ schemaVersion: '0.1', externalAiUsed: false, source: { id: 's', text: 'Rob zit in het kernteam.' } });
    expect(pkg.source.textContent).toBeUndefined();
    expect(pkg.pipelineVersion).toBeTruthy();
    expect(pkg.promptVersion).toBeTruthy();
  });
});
