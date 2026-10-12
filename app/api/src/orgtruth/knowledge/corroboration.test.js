import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('../model/linkedTo.js', () => ({ targetsOf: vi.fn(async (type, id) => (type === 'Identity' ? [{ targetType: 'Identity', id }, { targetType: 'Principal', id: `${id}-acc` }] : [{ targetType: type, id }])) }));
import { query } from '../../db/connection.js';
import { sideTargets, corroborate, rescoreSource, stem, CLEAR_AT } from './corroboration.js';

beforeEach(() => { query.mockReset(); });

const link = (o) => ({ targetType: 'Identity', targetId: 'i1', confidence: 79, status: 'proposed', analystOverride: null, ...o });

describe('sideTargets', () => {
  it('a reviewer-confirmed link wins over any score', () => {
    const s = sideTargets([link({ status: 'accepted', confidence: 40 }), link({ targetId: 'i2', confidence: 99 })], 'ambiguous', 'person');
    expect(s.state).toBe('confirmed');
    expect(s.targets.map(t => t.targetId)).toEqual(['i1']);
  });

  it('clear only above the floor and not ambiguous; rejected links never count', () => {
    expect(sideTargets([link({ confidence: CLEAR_AT })], 'candidates', 'person').state).toBe('clear');
    expect(sideTargets([link({ confidence: CLEAR_AT - 1 })], 'candidates', 'person').state).toBe('unmatched');
    expect(sideTargets([link()], 'ambiguous', 'person').state).toBe('ambiguous');
    expect(sideTargets([link({ status: 'rejected' })], 'candidates', 'person').state).toBe('unmatched');
    expect(sideTargets([], 'unmatched', 'person').state).toBe('unmatched');
  });

  it('the top score of a person as identity and account gives both targets', () => {
    const s = sideTargets([link(), link({ targetType: 'Principal', targetId: 'p1' }), link({ targetId: 'i9', confidence: 60 })], 'candidates', 'person');
    expect(s.targets.map(t => t.targetId)).toEqual(['i1', 'p1']);
  });

  it('a concept is never an object', () => {
    expect(sideTargets([link()], 'candidates', 'concept')).toEqual({ state: 'none', targets: [] });
  });
});

describe('stem', () => {
  it('folds plural and vowel doubling: "Maten" ~ "maat", but not "aspirant-maat"', () => {
    expect(stem('Maten')).toBe(stem('maat'));
    expect(stem('aspirant-maat')).not.toBe(stem('Maten'));
  });
});

describe('corroborate', () => {
  const subj = { targets: [{ targetType: 'Identity', targetId: 'i1', label: 'Mark van Eijken' }] };
  const group = { label: 'IT-commissie', targets: [{ targetType: 'Resource', targetId: 'g1', label: 'IT-Commissie' }] };

  it('a group membership the directory has corroborates; one it lacks contradicts', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await corroborate({ predicate: 'memberOf' }, subj, group)).toEqual({ verdict: 'corroborated', kind: 'directory', detail: 'member of the group "IT-Commissie"' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('FROM "ResourceAssignments"');
    expect(params).toEqual(['g1', ['i1-acc']]);
    query.mockResolvedValueOnce({ rows: [] });
    expect((await corroborate({ predicate: 'memberOf' }, subj, group)).verdict).toBe('contradicted');
  });

  it('a customer in an imported list: linked to the person, or hours on it', async () => {
    const klant = { label: 'Northwind', targets: [{ targetType: 'OrgEntity', targetId: 'k1', label: 'Northwind' }] };
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 12 }] });
    expect(await corroborate({ predicate: 'worksForCustomer' }, subj, klant)).toEqual({ verdict: 'corroborated', kind: 'activity', detail: '12 activity rows on "Northwind"' });
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ entityType: 'Klant', displayName: 'Northwind' }] });
    expect((await corroborate({ predicate: 'memberOf' }, subj, klant)).kind).toBe('list');
  });

  it('a role named like a list ("maat" ↔ "Maten") is the list membership', async () => {
    const role = { label: 'maat', targets: [] };
    query.mockResolvedValueOnce({ rows: [{ entityType: 'Maten', displayName: 'Mark van Eijken' }] });
    expect(await corroborate({ predicate: 'memberOf' }, subj, role, ['Klant', 'Maten'])).toEqual({
      verdict: 'corroborated', kind: 'list', detail: 'on the imported list "Maten" (as Mark van Eijken)',
    });
    expect(query.mock.calls[0][1].slice(0, 2)).toEqual([null, 'Maten']);
  });

  it('nothing to say without a person, for other predicates, or when nothing matches', async () => {
    expect(await corroborate({ predicate: 'memberOf' }, { targets: [] }, group)).toBeNull();
    expect(await corroborate({ predicate: 'hasProperty' }, subj, group)).toBeNull();
    query.mockResolvedValue({ rows: [] });
    expect(await corroborate({ predicate: 'memberOf' }, subj, { label: 'x', targets: [] }, ['Maten'])).toBeNull();
  });
});

describe('rescoreSource', () => {
  it('writes confidence and corroboration on every statement', async () => {
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM "OrgRelations" r')) return { rows: [{ id: 'r1', predicate: 'memberOf', attributes: { claimKey: 'k', support: 'supported', modality: 'stated' }, fromEntityId: 'm1', toEntityId: 'm2' }] };
      if (sql.includes('FROM "OrgEntities" WHERE "sourceId"')) return { rows: [
        { id: 'm1', displayName: 'Mark', attributes: { mentionType: 'person', resolution: 'candidates' } },
        { id: 'm2', displayName: 'IT-commissie', attributes: { mentionType: 'team', resolution: 'candidates' } },
      ] };
      if (sql.includes('FROM "OrgLinks"')) return { rows: [
        { orgEntityId: 'm1', targetType: 'Identity', targetId: 'i1', confidence: 79, status: 'proposed' },
        { orgEntityId: 'm2', targetType: 'Resource', targetId: 'g1', confidence: 100, status: 'proposed' },
      ] };
      if (sql.includes('SELECT DISTINCT "entityType"')) return { rows: [] };
      if (sql.includes('SELECT "displayName" FROM')) return { rows: [{ displayName: 'x' }] };
      if (sql.includes('FROM "ResourceAssignments"')) return { rows: [{ ok: 1 }] };
      return { rows: [] };
    });
    expect(await rescoreSource('s1')).toEqual({ scored: 1, corroborated: 1, contradicted: 0 });
    const [, params] = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "OrgRelations"'));
    expect(params[1]).toBe(100);
    expect(JSON.parse(params[2])).toMatchObject({ claimKey: 'k', corroboration: { verdict: 'corroborated', kind: 'directory' }, confidenceParts: { data: 30 } });
  });
});
