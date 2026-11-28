import { describe, it, expect } from 'vitest';
import {
  MIN_CONFIDENCE, MIN_HOLDERS, MAX_PERMISSIONS, matchScore, confidencePct, permissionSuggestions,
  sharedConditions, conditionSets, ruleSuggestion, withoutDeclined,
} from './roleImprovementScoring.js';

const SINCE = new Date('2026-09-01T00:00:00Z');
const NEW = '2026-10-15T08:00:00Z';
const OLD = '2025-01-01T00:00:00Z';
const candidate = (id, membersHolding, othersHolding, createdDateTime = OLD) =>
  ({ id, displayName: `SG-${id}`, resourceType: 'Group', createdDateTime, membersHolding, othersHolding });

describe('matchScore', () => {
  it('is the overlap over everyone in either set', () => {
    expect(matchScore({ both: 10, onlyRole: 0, onlyOther: 0 })).toBe(1);
    expect(matchScore({ both: 19, onlyRole: 1, onlyOther: 0 })).toBe(0.95);
    expect(matchScore({ both: 19, onlyRole: 0, onlyOther: 1 })).toBe(0.95);
    expect(matchScore({ both: 18, onlyRole: 1, onlyOther: 1 })).toBe(0.9);
    expect(matchScore({ both: 0, onlyRole: 0, onlyOther: 0 })).toBe(0);
  });
});

describe('confidencePct', () => {
  it('is never rounded up', () => {
    expect(confidencePct(1)).toBe(100);
    expect(confidencePct(0.95)).toBe(95);
    expect(confidencePct(0.9999)).toBe(99);
    expect(confidencePct(38 / 39)).toBe(97);
  });
});

describe('permissionSuggestions', () => {
  it('suggests a permission every holder has and nobody else, however old', () => {
    const [s, ...rest] = permissionSuggestions([candidate('a', 6, 0)], { holderCount: 6, since: SINCE });
    expect(rest).toEqual([]);
    expect(s).toEqual({
      key: 'permission:a', kind: 'addPermission', confidence: 100, exact: true,
      resource: { id: 'a', displayName: 'SG-a', resourceType: 'Group', createdDateTime: OLD },
      recent: false, holders: 6, holdersWithIt: 6, othersWithIt: 0,
    });
  });

  it('suggests nothing for a role held by fewer than MIN_HOLDERS people, exact or not', () => {
    expect(MIN_HOLDERS).toBe(5);
    expect(permissionSuggestions([candidate('a', 4, 0)], { holderCount: 4, since: SINCE })).toEqual([]);
    expect(permissionSuggestions([candidate('a', 5, 0)], { holderCount: 5, since: SINCE })).toHaveLength(1);
  });

  it('drops an exact match on the holders that one other person also has, when it is old', () => {
    expect(permissionSuggestions([candidate('a', 6, 1)], { holderCount: 6, since: SINCE })).toEqual([]);
  });

  it('suggests a near match only when it appeared since the last review', () => {
    const near = [candidate('n', 19, 0, NEW), candidate('o', 19, 0, OLD), candidate('u', 19, 0, null)];
    const out = permissionSuggestions(near, { holderCount: 20, since: SINCE });
    expect(out.map(s => [s.key, s.confidence, s.exact, s.recent])).toEqual([['permission:n', 95, false, true]]);
  });

  it('counts the start of the window itself as recent', () => {
    expect(permissionSuggestions([candidate('n', 19, 0, SINCE.toISOString())], { holderCount: 20, since: SINCE })).toHaveLength(1);
  });

  it('never shows anything under MIN_CONFIDENCE, recent or not', () => {
    expect(MIN_CONFIDENCE).toBe(0.95);
    // 18 of 20 holders and nobody else: 90%.
    expect(permissionSuggestions([candidate('n', 18, 0, NEW)], { holderCount: 20, since: SINCE })).toEqual([]);
    // 19 of 20 and one other: 19/21 = 90%.
    expect(permissionSuggestions([candidate('n', 19, 1, NEW)], { holderCount: 20, since: SINCE })).toEqual([]);
  });

  it('puts the surest first, then the most holders, then by name; at most MAX_PERMISSIONS', () => {
    const rows = [
      candidate('b', 39, 0, NEW), // 97%
      candidate('z', 40, 0), // exact
      candidate('y', 40, 0),
      ...Array.from({ length: 6 }, (_, i) => candidate(`x${i}`, 40, 0)),
    ];
    const out = permissionSuggestions(rows, { holderCount: 40, since: SINCE });
    expect(out).toHaveLength(MAX_PERMISSIONS);
    expect(out.slice(0, 3).map(s => s.resource.displayName)).toEqual(['SG-x0', 'SG-x1', 'SG-x2']);
    expect(out.every(s => s.exact)).toBe(true);
    const few = permissionSuggestions([candidate('b', 39, 0, NEW), candidate('z', 40, 0)], { holderCount: 40, since: SINCE });
    expect(few.map(s => s.key)).toEqual(['permission:z', 'permission:b']);
  });

  it('keys a permission by its id in lower case, so a later read finds the same suggestion', () => {
    const [s] = permissionSuggestions([candidate('AbC', 5, 0)], { holderCount: 5, since: SINCE });
    expect(s.key).toBe('permission:abc');
  });
});

const person = (id, department, jobTitle = 'Engineer', companyName = 'Contoso') => ({ id, department, jobTitle, companyName });
const team = (n, department = 'Development', prefix = 'h') => Array.from({ length: n }, (_, i) => person(`${prefix}${i}`, department));

describe('sharedConditions', () => {
  it('keeps per attribute the value at least 95% of the holders share, trimmed', () => {
    // 19 of 20 is exactly 95%: enough. An empty value counts as not sharing it.
    const holders = [...team(19), person('odd', 'Sales', ' Engineer ', '')];
    expect(sharedConditions(holders)).toEqual([
      { attribute: 'department', value: 'Development' },
      { attribute: 'jobTitle', value: 'Engineer' },
      { attribute: 'companyName', value: 'Contoso' },
    ]);
  });

  it('keeps nothing the holders do not share enough', () => {
    const holders = [...team(18), person('a', 'Sales'), person('b', 'Sales')];
    expect(sharedConditions(holders).map(c => c.attribute)).toEqual(['jobTitle', 'companyName']);
    expect(sharedConditions([person('a', null, null, null)])).toEqual([]);
  });
});

describe('conditionSets', () => {
  it('is every combination, fewest conditions first', () => {
    const sets = conditionSets(['a', 'b', 'c']);
    expect(sets).toHaveLength(7);
    expect(sets.map(s => s.length)).toEqual([1, 1, 1, 2, 2, 2, 3]);
    expect(conditionSets([])).toEqual([]);
  });
});

describe('ruleSuggestion', () => {
  it('finds the rule that picks exactly the holders, with as few conditions as that takes', () => {
    const holders = team(6);
    // Others in Development are no engineers; other engineers are not in Development.
    const population = [...holders, person('o1', 'Development', 'Manager'), person('o2', 'Sales')];
    expect(ruleSuggestion(holders, population)).toEqual({
      key: 'rule:department=Development&jobTitle=Engineer',
      kind: 'automaticRule', confidence: 100, exact: true,
      conditions: [{ attribute: 'department', value: 'Development' }, { attribute: 'jobTitle', value: 'Engineer' }],
      holders: 6, holdersMatched: 6, othersMatched: 0,
    });
  });

  it('prefers one condition over two when both are exact', () => {
    const holders = team(6);
    expect(ruleSuggestion(holders, holders).conditions).toEqual([{ attribute: 'department', value: 'Development' }]);
  });

  it('suggests a rule that is 95% right, and none that is less', () => {
    const holders = team(19);
    const one = ruleSuggestion(holders, [...holders, person('x', 'Development')]);
    expect(one).toMatchObject({ confidence: 95, exact: false, othersMatched: 1 });
    expect(ruleSuggestion(holders, [...holders, person('x', 'Development'), person('y', 'Development')])).toBeNull();
  });

  it('suggests nothing for fewer than MIN_HOLDERS holders, or holders who share nothing', () => {
    expect(ruleSuggestion(team(4), team(4))).toBeNull();
    const mixed = [person('a', 'A', 'x', 'p'), person('b', 'B', 'y', 'q'), person('c', 'C', 'z', 'r'), person('d', 'D', 'w', 's'), person('e', 'E', 'v', 't')];
    expect(ruleSuggestion(mixed, mixed)).toBeNull();
  });

  it('matches holders by id in any case', () => {
    const holders = team(5).map(h => ({ ...h, id: h.id.toUpperCase() }));
    expect(ruleSuggestion(holders, team(5))).toMatchObject({ exact: true, othersMatched: 0 });
  });
});

describe('withoutDeclined', () => {
  it('leaves out what was declined before, and says how many', () => {
    const out = withoutDeclined([{ key: 'a' }, { key: 'b' }, { key: 'c' }], ['b', 'x']);
    expect(out).toEqual({ suggestions: [{ key: 'a' }, { key: 'c' }], declinedBefore: 1 });
    expect(withoutDeclined([{ key: 'a' }], [])).toEqual({ suggestions: [{ key: 'a' }], declinedBefore: 0 });
  });
});
