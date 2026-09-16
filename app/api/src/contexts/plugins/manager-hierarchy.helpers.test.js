import { describe, it, expect } from 'vitest';
import {
  compileExcludeRegexes,
  matchesExclude,
  resolveNameFields,
  buildSelectParts,
  buildNodeName,
  effectiveManagerId,
  buildManagerIds,
  buildManagerContexts,
  buildMemberRows,
} from './manager-hierarchy.helpers.js';

describe('manager-hierarchy helpers — compileExcludeRegexes', () => {
  it('returns an empty array for missing/empty patterns', () => {
    expect(compileExcludeRegexes(undefined)).toEqual([]);
    expect(compileExcludeRegexes([])).toEqual([]);
  });

  it('compiles each pattern case-insensitively', () => {
    const [re] = compileExcludeRegexes(['\\(Quanza\\)']);
    expect(re.test('Rick (quanza)')).toBe(true);
  });

  it('throws a clear indexed error for an invalid pattern', () => {
    expect(() => compileExcludeRegexes(['ok', '[invalid'])).toThrow(/excludeNamePatterns\[1\]/);
  });
});

describe('manager-hierarchy helpers — matchesExclude', () => {
  const regexes = compileExcludeRegexes(['\\(Quanza\\)']);

  it('is false for empty/falsy names', () => {
    expect(matchesExclude('', regexes)).toBe(false);
    expect(matchesExclude(null, regexes)).toBe(false);
    expect(matchesExclude(undefined, regexes)).toBe(false);
  });

  it('is false when no regex matches', () => {
    expect(matchesExclude('Alice CEO', regexes)).toBe(false);
    expect(matchesExclude('Alice', [])).toBe(false);
  });

  it('is true when any regex matches', () => {
    expect(matchesExclude('Rick (Quanza)', regexes)).toBe(true);
  });
});

describe('manager-hierarchy helpers — resolveNameFields', () => {
  const validCols = new Set(['department', 'jobTitle', 'companyName']);
  const validExtKeys = new Set(['costCenter']);

  it('resolves real columns and extended keys, tagging real', () => {
    expect(resolveNameFields(['jobTitle', 'costCenter'], validCols, validExtKeys)).toEqual([
      { name: 'jobTitle', real: true },
      { name: 'costCenter', real: false },
    ]);
  });

  it('drops unknown fields and non-strings, falling back to department', () => {
    expect(resolveNameFields(['notAColumn', 42], validCols, validExtKeys)).toEqual([
      { name: 'department', real: true },
    ]);
  });

  it('falls back to department for a non-array / empty nameFields', () => {
    expect(resolveNameFields(undefined, validCols, validExtKeys)).toEqual([{ name: 'department', real: true }]);
    expect(resolveNameFields([], validCols, validExtKeys)).toEqual([{ name: 'department', real: true }]);
  });

  it('does not fall back when department is not a valid column', () => {
    expect(resolveNameFields(['nope'], new Set(['jobTitle']), validExtKeys)).toEqual([]);
  });
});

describe('manager-hierarchy helpers — buildSelectParts', () => {
  it('emits base columns and the scope param with no name fields', () => {
    const { selectParts, queryParams } = buildSelectParts([], 7);
    expect(selectParts).toEqual(['id', '"displayName"', '"managerId"']);
    expect(queryParams).toEqual([7]);
  });

  it('inlines a real column and parameterises an extended key by alias', () => {
    const resolved = [{ name: 'department', real: true }, { name: 'costCenter', real: false }];
    const { selectParts, queryParams } = buildSelectParts(resolved, 1);
    expect(selectParts).toEqual([
      'id', '"displayName"', '"managerId"',
      '"department"',
      '"extendedAttributes" ->> $2 AS "costCenter"',
    ]);
    expect(queryParams).toEqual([1, 'costCenter']);
  });
});

describe('manager-hierarchy helpers — buildNodeName', () => {
  const naming = (over = {}) => ({ resolved: [{ name: 'department', real: true }], separator: ' · ', includeManagerName: true, ...over });

  it('renders "<value> (<manager>)" by default', () => {
    expect(buildNodeName({ displayName: 'Carol', department: 'Engineering' }, naming())).toBe('Engineering (Carol)');
  });

  it('omits the manager name when includeManagerName is false', () => {
    expect(buildNodeName({ displayName: 'Carol', department: 'Engineering' }, naming({ includeManagerName: false }))).toBe('Engineering');
  });

  it('joins multiple fields with the separator and collapses consecutive duplicates', () => {
    const n = naming({ resolved: [{ name: 'a' }, { name: 'b' }], includeManagerName: false });
    expect(buildNodeName({ displayName: 'X', a: 'Commercie', b: 'commercie' }, n)).toBe('Commercie');
    expect(buildNodeName({ displayName: 'X', a: 'Sales', b: 'EMEA' }, n)).toBe('Sales · EMEA');
  });

  it('falls back to the manager name when no attribute values are present', () => {
    expect(buildNodeName({ displayName: 'Rick (Quanza)', department: '' }, naming())).toBe('Rick (Quanza)');
  });

  it('uses "Unknown" when the manager itself is missing', () => {
    expect(buildNodeName(undefined, naming())).toBe('Unknown');
  });
});

describe('manager-hierarchy helpers — effectiveManagerId', () => {
  it('prefers an override (including a null override) over the source managerId', () => {
    const overrides = new Map([['p1', 'boss'], ['p2', null]]);
    expect(effectiveManagerId({ id: 'p1', managerId: 'src' }, overrides)).toBe('boss');
    expect(effectiveManagerId({ id: 'p2', managerId: 'src' }, overrides)).toBeNull();
  });

  it('falls back to the source managerId with no override', () => {
    expect(effectiveManagerId({ id: 'p3', managerId: 'src' }, new Map())).toBe('src');
  });
});

describe('manager-hierarchy helpers — buildManagerIds', () => {
  const rows = [
    { id: 'ceo', managerId: null },
    { id: 'vp', managerId: 'ceo' },
    { id: 'ic', managerId: 'vp' },
    { id: 'con', managerId: 'ext' },
  ];
  const byId = new Map(rows.map((r) => [r.id, r]));
  byId.set('ext', { id: 'ext', displayName: 'Rick (Quanza)', managerId: 'vp' });

  it('collects every referenced managerId when nothing is excluded', () => {
    const { managerIds, excludedCount } = buildManagerIds(rows, byId, [], new Map());
    expect([...managerIds].sort()).toEqual(['ceo', 'ext', 'vp']);
    expect(excludedCount).toBe(0);
  });

  it('excludes managers whose displayName matches and counts them', () => {
    const regexes = compileExcludeRegexes(['\\(Quanza\\)']);
    const { managerIds, excludedCount } = buildManagerIds(rows, byId, regexes, new Map());
    expect(managerIds.has('ext')).toBe(false);
    expect(excludedCount).toBe(1);
  });

  it('adds existing override targets even without source reports, and ignores absent/null ones', () => {
    const overrides = new Map([['ic', 'ceo'], ['x', 'ghost'], ['y', null]]);
    const { managerIds } = buildManagerIds(rows, byId, [], overrides);
    expect(managerIds.has('ceo')).toBe(true);
    expect(managerIds.has('ghost')).toBe(false);
  });
});

describe('manager-hierarchy helpers — buildManagerContexts', () => {
  const naming = { resolved: [{ name: 'department', real: true }], separator: ' · ', includeManagerName: true };
  const byId = new Map([
    ['ceo', { id: 'ceo', displayName: 'Alice', managerId: null, department: 'Exec' }],
    ['vp', { id: 'vp', displayName: 'Bob', managerId: 'ceo', department: 'Eng' }],
  ]);

  it('parents a manager under their own manager when that person is also a node, else root', () => {
    const managerIds = new Set(['ceo', 'vp']);
    const contexts = buildManagerContexts(managerIds, byId, 'root', naming);
    const byExt = Object.fromEntries(contexts.map((c) => [c.externalId, c]));
    expect(byExt.ceo).toMatchObject({ parentExternalId: 'root', displayName: 'Exec (Alice)', contextType: 'ManagerHierarchy' });
    expect(byExt.vp).toMatchObject({ parentExternalId: 'ceo', displayName: 'Eng (Bob)' });
  });

  it('roots a manager whose own manager is not itself a node', () => {
    const contexts = buildManagerContexts(new Set(['vp']), byId, 'root', naming);
    expect(contexts[0]).toMatchObject({ externalId: 'vp', parentExternalId: 'root' });
  });
});

describe('manager-hierarchy helpers — buildMemberRows', () => {
  const rows = [
    { id: 'ceo', managerId: null }, // top-level manager node
    { id: 'vp', managerId: 'ceo' },
    { id: 'ic1', managerId: 'mgr' },
    { id: 'ic2', managerId: 'mgr' },
    { id: 'lonely', managerId: null },
  ];

  it('routes reports to their manager and orphans to root, skipping top-level managers', () => {
    const managerIds = new Set(['ceo', 'mgr', 'vp']); // vp also reports to ceo
    const members = buildMemberRows(rows, managerIds, new Map(), 'root');
    const of = (id) => members.filter((m) => m.memberId === id).map((m) => m.contextExternalId);
    expect(of('ic1')).toEqual(['mgr']);
    expect(of('vp')).toEqual(['ceo']); // a manager that also reports to another manager is that manager's member
    expect(of('lonely')).toEqual(['root']);
    expect(of('ceo')).toEqual([]); // top-level manager: no manager and is itself a node → neither node member nor root
  });

  it('honours an override target and routes a null override to root', () => {
    const managerIds = new Set(['ceo', 'mgr', 'vp']);
    const overrides = new Map([['ic1', 'vp'], ['ic2', null]]);
    const members = buildMemberRows(rows, managerIds, overrides, 'root');
    const of = (id) => members.filter((m) => m.memberId === id).map((m) => m.contextExternalId);
    expect(of('ic1')).toEqual(['vp']);
    expect(of('ic2')).toEqual(['root']);
  });
});
