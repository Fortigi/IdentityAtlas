import { describe, it, expect } from 'vitest';
import { compileSpec } from './compile.js';
import { validateSpec } from './spec.js';
import { explainSpec } from './explain.js';

const compile = (raw) => {
  const { ok, spec, errors } = validateSpec(raw);
  if (!ok) throw new Error(errors.join('; '));
  return { spec, ...compileSpec(spec) };
};

describe('compileSpec', () => {
  it('never puts a value into the SQL text — hostile values only reach params', () => {
    const hostile = `x'); DROP TABLE "Principals"; --`;
    const { text, params } = compile({
      entity: 'resource',
      conditions: [{ field: 'displayName', op: 'contains', value: hostile }],
    });
    expect(text).not.toContain('DROP');
    expect(params).toContain(`%x'); DROP TABLE "Principals"; --%`);
  });

  it('escapes LIKE wildcards so "100%" matches literally', () => {
    const { params } = compile({ entity: 'resource', conditions: [{ field: 'displayName', op: 'startsWith', value: '100%_a\\' }] });
    expect(params[0]).toBe('100\\%\\_a\\\\%');
  });

  it('compiles "guests without a manager or with a disabled manager"', () => {
    const { text, params } = compile({
      entity: 'account',
      conditions: [
        { field: 'userType', op: 'eq', value: 'Guest' },
        { type: 'group', match: 'any', conditions: [
          { relation: 'manager', quantifier: 'none', conditions: [] },
          { relation: 'manager', quantifier: 'some', conditions: [{ field: 'accountEnabled', op: 'eq', value: false }] },
        ] },
      ],
      columns: ['displayName', 'manager.displayName'],
    });
    expect(text).toContain(`t0."extendedAttributes"->>'userType' = $1`);
    expect(text).toMatch(/\(NOT EXISTS \(SELECT 1 FROM "Principals" t\d+ WHERE t\d+\."id" = t0\."managerId"[^)]*\) OR EXISTS/);
    expect(text).toMatch(/"accountEnabled" = \$2::boolean/);
    expect(text).toContain('AS "manager.displayName"');
    expect(params).toEqual(['Guest', false, 1001]);
  });

  it('uses distinct aliases for every subquery', () => {
    const { text } = compile({
      entity: 'account',
      conditions: [
        { relation: 'memberOf', conditions: [{ field: 'displayName', op: 'contains', value: 'LIC' }] },
        { relation: 'owns', conditions: [] },
      ],
      columns: ['displayName', 'memberOf.names', 'owns.count'],
    });
    const aliases = [...text.matchAll(/ (t\d+) (?:ON|WHERE|JOIN)/g)].map(m => m[1]);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('matches ALL by default, ANY on request, TRUE when there are no conditions', () => {
    const two = [{ field: 'displayName', op: 'isEmpty' }, { field: 'email', op: 'isNotEmpty' }];
    expect(compile({ entity: 'account', conditions: two }).text).toMatch(/ AND \(t0\."email" IS NOT NULL/);
    expect(compile({ entity: 'account', match: 'any', conditions: two }).text).toMatch(/ OR \(t0\."email"/);
    expect(compile({ entity: 'account' }).text).toMatch(/IS NULL AND TRUE\n/);
  });

  it('orders by the requested field and fetches one row beyond the limit', () => {
    const { text, params } = compile({ entity: 'resource', sort: { field: 'memberCount', direction: 'desc' }, limit: 10 });
    expect(text).toMatch(/ORDER BY \(SELECT count\(\*\)[\s\S]*\) DESC NULLS LAST, t0\."id"/);
    expect(params.at(-1)).toBe(11);
  });

  it('comparison operators cast their parameter to the field type', () => {
    const { text } = compile({
      entity: 'resource',
      conditions: [
        { field: 'memberCount', op: 'lt', value: 3 },
        { field: 'createdDateTime', op: 'withinLastDays', value: 30 },
        { field: 'description', op: 'neq', value: 'x' },
        { field: 'riskTier', op: 'neq', value: 'High' },
      ],
    });
    expect(text).toMatch(/< \$1::numeric/);
    expect(text).toMatch(/make_interval\(days => \$2::int\)/);
    expect(text).toMatch(/lower\(t0\."description"\) <> lower\(\$3\)/);
    expect(text).toMatch(/t0\."riskTier" <> \$4\)/);
  });
});

describe('explainSpec', () => {
  it('reads the interpretation back in analyst language', () => {
    const { spec } = compile({
      entity: 'account',
      conditions: [
        { field: 'accountEnabled', op: 'eq', value: false },
        { relation: 'memberOf', conditions: [{ field: 'displayName', op: 'contains', value: 'LIC' }] },
        { type: 'group', match: 'any', conditions: [
          { relation: 'manager', quantifier: 'none', conditions: [] },
          { field: 'createdDateTime', op: 'olderThanDays', value: 90 },
        ] },
      ],
    });
    expect(explainSpec(spec)).toEqual({
      title: 'Accounts matching all of:',
      lines: [
        { depth: 0, text: 'Enabled is No' },
        { depth: 0, text: 'is a member of a group where Name contains "LIC"' },
        { depth: 0, text: 'any of:' },
        { depth: 1, text: 'has no manager' },
        { depth: 1, text: 'Created is more than 90 days ago' },
      ],
    });
    expect(explainSpec({ entity: 'resource', conditions: [] }).title).toBe('All resources');
  });
});
