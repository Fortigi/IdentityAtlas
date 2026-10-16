import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js');
vi.mock('../linking/candidates.js', async (importOriginal) => ({ ...(await importOriginal()), loadRuleIndexes: vi.fn() }));

import { query } from '../../db/connection.js';
import { buildRuleIndex, loadRuleIndexes, ruleKey } from '../linking/candidates.js';
import { normalizeRecipe } from '../contracts.js';
import { activityKeyRules } from '../referenceRules.js';
import { decideKey, loadRoleIndexes, resolveKeys, keyStats, ACCEPT_AT, PROPOSE_AT } from './activityResolve.js';

const P = (id, displayName, email = null) => ({ id, displayName, email, principalType: 'User' });
const I = (id, displayName, email = null) => ({ id, displayName, email });
const O = (id, displayName, entityType = 'Customer') => ({ id, displayName, entityType });

const recipe = normalizeRecipe({
  version: 1, template: 'activity',
  activity: {
    type: 'Hours', actor: { column: 'c3', targetTypes: ['Principal', 'Identity'] },
    subject: { column: 'c4', targetType: 'OrgEntity', targetEntityType: 'Customer' }, when: { yearColumn: 'c1', monthColumn: 'c2' },
  },
});

const indexesFor = (role, rowsByType) => activityKeyRules(recipe, role).map(r => buildRuleIndex(rowsByType[r.targetType] ?? [], r));

beforeEach(() => { query.mockReset(); loadRuleIndexes.mockReset(); });

describe('decideKey', () => {
  const people = indexesFor('actor', {
    Principal: [P('p-ann', 'Ann Example', 'ann@contoso.com'), P('p-bob', 'Bob Sample'), P('p-cas1', 'Cas Twin'), P('p-cas2', 'Cas Twin')],
    Identity: [I('i-ann', 'Ann Example')],
  });

  it('accepts a value one account matches at ≥ 90, preferring the first target type on an equal score', () => {
    expect(ACCEPT_AT).toBe(90);
    const d = decideKey('Ann Example', people);
    expect(d).toMatchObject({ status: 'accepted', targetType: 'Principal', targetId: 'p-ann', confidence: 100 });
    // the identity scored the same: it is a candidate, not an ambiguity
    expect(d.candidates.map(c => c.targetId)).toEqual(['p-ann', 'i-ann']);
    expect(d.signals.split(',')).toContain('displayName exact');
  });

  it('an address finds the account too', () => {
    expect(decideKey('ann@contoso.com', people)).toMatchObject({ status: 'accepted', targetId: 'p-ann' });
  });

  it('a tie between two accounts at the top is proposed (the first), never accepted', () => {
    const d = decideKey('Cas Twin', people);
    expect(d.status).toBe('proposed');
    expect(d.confidence).toBe(100);
    expect(['p-cas1', 'p-cas2']).toContain(d.targetId);
    expect(d.candidates.slice(0, 2).map(c => c.targetId).sort()).toEqual(['p-cas1', 'p-cas2']);
  });

  it('nothing at all: unmatched with no target and no candidates', () => {
    expect(decideKey('Zed Nobody', people)).toEqual({ status: 'unmatched', targetType: null, targetId: null, confidence: 0, signals: null, candidates: [] });
  });

  const customers = indexesFor('subject', {
    OrgEntity: [O('o-nw', 'Northwind Traders'), O('o-port', 'Havenbedrijf Rotterdam'), O('o-other', 'Northwind', 'Supplier')],
  });

  it('between the thresholds: proposed with the best target (a fuzzy name of another list)', () => {
    expect(PROPOSE_AT).toBe(60);
    const d = decideKey('Northwind', customers);
    expect(d).toMatchObject({ status: 'proposed', targetType: 'OrgEntity', targetId: 'o-nw' });
    expect(d.confidence).toBeGreaterThanOrEqual(PROPOSE_AT);
    expect(d.confidence).toBeLessThan(ACCEPT_AT);
    // the Supplier list is not the subject's list
    expect(d.candidates.map(c => c.targetId)).toEqual(['o-nw']);
  });

  it('under the proposal threshold: unmatched, but the candidate is still offered for review', () => {
    const d = decideKey('PortOfRotterdam', customers);
    expect(d).toMatchObject({ status: 'unmatched', targetType: null, targetId: null, confidence: 50 });
    expect(d.candidates).toEqual([{ targetType: 'OrgEntity', targetId: 'o-port', label: 'Havenbedrijf Rotterdam', confidence: 50 }]);
  });
});

describe('loadRoleIndexes', () => {
  it('loads the role\'s rules once and returns their indexes in the recipe\'s order', async () => {
    const rules = activityKeyRules(recipe, 'actor');
    loadRuleIndexes.mockResolvedValue(new Map([[ruleKey(rules[1]), 'identity-index'], [ruleKey(rules[0]), 'principal-index']]));
    expect(await loadRoleIndexes(recipe, 'actor')).toEqual(['principal-index', 'identity-index']);
    expect(loadRuleIndexes).toHaveBeenCalledWith(rules);
  });
});

describe('resolveKeys', () => {
  it('re-decides only the unsettled keys, per role, and the update keeps the analyst guard', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'k1', role: 'actor', rawValue: 'Ann Example' }, { id: 'k2', role: 'actor', rawValue: 'Zed' }] });
    query.mockResolvedValue({ rows: [], rowCount: 2 });
    const rules = activityKeyRules(recipe, 'actor');
    loadRuleIndexes.mockResolvedValue(new Map([
      [ruleKey(rules[0]), buildRuleIndex([P('p-ann', 'Ann Example')], rules[0])],
      [ruleKey(rules[1]), buildRuleIndex([], rules[1])],
    ]));
    expect(await resolveKeys({ profileName: 'Hours', recipe })).toEqual({ actor: 2, subject: 0 });
    const [selectSql, selectParams] = query.mock.calls[0];
    expect(selectSql).toMatch(/"status" IN \('unmatched', 'proposed'\) AND NOT "analystOverride"/);
    expect(selectParams).toEqual(['Hours']);
    // no subject key: the subject targets are not even loaded
    expect(loadRuleIndexes).toHaveBeenCalledTimes(1);
    const [updateSql, p] = query.mock.calls[1];
    expect(updateSql).toMatch(/WHERE k\."id" = u\.id AND NOT k\."analystOverride" AND k\."status" IN \('unmatched', 'proposed'\)/);
    expect(p).toEqual([['k1', 'k2'], ['accepted', 'unmatched'], ['Principal', null], ['p-ann', null], [100, 0], [expect.any(String), null]]);
  });

  it('nothing unsettled: no load, no update', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveKeys({ profileName: 'Hours', recipe })).toEqual({ actor: 0, subject: 0 });
    expect(query).toHaveBeenCalledTimes(1);
    expect(loadRuleIndexes).not.toHaveBeenCalled();
  });
});

describe('keyStats', () => {
  it('counts per role over the given keys; a rejected key counts as unmatched', async () => {
    query.mockResolvedValueOnce({ rows: [
      { role: 'actor', status: 'accepted', n: 3 }, { role: 'actor', status: 'rejected', n: 1 }, { role: 'actor', status: 'unmatched', n: 2 },
      { role: 'subject', status: 'proposed', n: 4 },
    ] });
    const out = await keyStats({ actor: new Map([['Ann', 'k1'], ['Bob', 'k2']]), subject: new Map([['Contoso', 'k3']]) });
    expect(out).toEqual({ actor: { total: 6, accepted: 3, proposed: 0, unmatched: 3 }, subject: { total: 4, accepted: 0, proposed: 4, unmatched: 0 } });
    expect(query.mock.calls[0][1]).toEqual([['k1', 'k2', 'k3']]);
  });

  it('no keys: zeros without a query', async () => {
    const zero = { total: 0, accepted: 0, proposed: 0, unmatched: 0 };
    expect(await keyStats({ actor: new Map(), subject: new Map() })).toEqual({ actor: zero, subject: zero });
    expect(query).not.toHaveBeenCalled();
  });
});
