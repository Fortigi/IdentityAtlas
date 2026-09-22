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

describe('compileSpec — sign-in activity', () => {
  it('computes the per-system measurement moment once, however many sign-in fields use it', () => {
    const { text } = compile({
      entity: 'user',
      conditions: [
        { field: 'daysSinceLastSignIn', op: 'gt', value: 90 },
        { field: 'signInDataCollected', op: 'isNotEmpty', value: null },
      ],
      // Also through a relation column, which compiles in a subquery of its own.
      columns: ['displayName', 'daysSinceLastSignIn', 'manager.signInDataCollected'],
    });
    expect(text.match(/signin_measurement AS \(/g)).toHaveLength(1);
    expect(text.startsWith('WITH signin_measurement AS (')).toBe(true);
    expect(text.match(/FROM signin_measurement sm/g).length).toBeGreaterThanOrEqual(3);
  });

  it('counts "days since" back from when the data was collected, never from today', () => {
    // Anchoring on now() would age every account into staleness the moment a sync
    // is missed — the trap the standard activity reports are built to avoid.
    const { text } = compile({ entity: 'user', conditions: [{ field: 'daysSinceLastSignIn', op: 'gt', value: 30 }] });
    const predicate = text.slice(text.indexOf('WHERE t0'));
    expect(predicate).toMatch(/EXTRACT\(DAY FROM \(SELECT sm\."measuredAt" FROM signin_measurement sm/);
    expect(predicate).not.toMatch(/now\(\)/);
  });

  it('reads last sign-in the way the activity reports do: newest of the three timestamps, aggregate rows only', () => {
    const { text } = compile({ entity: 'account', conditions: [{ field: 'lastSignIn', op: 'isEmpty', value: null }] });
    expect(text).toMatch(/GREATEST\(pa\."lastSignInDateTime", pa\."lastNonInteractiveSignInDateTime", pa\."lastSuccessfulSignInDateTime"\)/);
    expect(text).toMatch(/pa\."resourceId" = '00000000-0000-0000-0000-000000000000'::uuid/);
    // Last sign-in alone needs no measurement moment, so no CTE is added for it.
    expect(text).not.toMatch(/signin_measurement/);
  });

  it('adds no CTE to a report that does not use sign-in data', () => {
    const { text } = compile({ entity: 'user', conditions: [{ field: 'accountEnabled', op: 'eq', value: false }] });
    expect(text.startsWith('SELECT')).toBe(true);
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

// ─── Counting per value, and this deployment's own attributes ────────

const RAW = 'extension_a1b2c3d4e5f60718293a4b5c6d7e8f90_sfDepartmentID';
const LONG = `extension_a1b2c3d4e5f60718293a4b5c6d7e8f90_sfBusinessUnitIdentifier`;
const attr = (key) => ({
  label: key.replace(/^extension_[0-9a-f]{32}_/, ''), type: 'text', extKey: key, discovered: true,
  sql: (t) => `${t}."extendedAttributes"->>'${key}'`,
});
const EXT = { user: { [`ext.${RAW}`]: attr(RAW), [`ext.${LONG}`]: attr(LONG) } };

const compileWith = (raw, extFields) => {
  const { ok, spec, errors } = validateSpec(raw, {}, extFields);
  if (!ok) throw new Error(errors.join('; '));
  return { spec, ...compileSpec(spec, extFields) };
};

describe('compileSpec — grouped reports', () => {
  it('counts records per value instead of listing them', () => {
    const { text, params, columns } = compile({ entity: 'user', groupBy: 'department' });

    expect(text).toContain('SELECT t0."department" AS "department",\n  count(*) AS "count"');
    expect(text).toContain('GROUP BY t0."department"');
    // Biggest group first, with the value as a stable tie-breaker.
    expect(text).toContain('ORDER BY count(*) DESC NULLS LAST, t0."department" ASC NULLS LAST');
    // No record id: a row is a value, not a record, so there is nothing to open.
    expect(text).not.toContain('__id');
    expect(columns).toEqual([
      { key: 'department', alias: 'department', label: 'Department', type: 'text' },
      { key: 'count', alias: 'count', label: 'Count', type: 'number' },
    ]);
    expect(params).toEqual([1001]);
  });

  it('counts only the records the conditions keep', () => {
    const { text, params } = compile({
      entity: 'user', groupBy: 'jobTitle',
      conditions: [{ field: 'accountEnabled', op: 'eq', value: true }],
    });
    expect(text).toMatch(/WHERE .*"accountEnabled" = \$1::boolean/s);
    expect(text).toContain('GROUP BY t0."jobTitle"');
    expect(params).toEqual([true, 1001]);
  });

  it('sorts on the value itself without repeating it as a tie-breaker', () => {
    const { text } = compile({ entity: 'user', groupBy: 'department', sort: { field: 'department', direction: 'asc' } });
    expect(text).toContain('ORDER BY t0."department" ASC NULLS LAST\n');
    expect(text).not.toContain('count(*) ASC');
  });

  it('sorts on the smallest group when asked', () => {
    const { text } = compile({ entity: 'user', groupBy: 'department', sort: { field: 'count', direction: 'asc' } });
    expect(text).toContain('ORDER BY count(*) ASC NULLS LAST, t0."department" ASC NULLS LAST');
  });

  it('groups a resource report inside the entity it belongs to', () => {
    // The group entity carries its own resourceType filter; grouping must not lose it.
    const { text } = compile({ entity: 'group', groupBy: 'visibility' });
    expect(text).toContain(`t0."resourceType" = 'Group'`);
    expect(text).toContain('GROUP BY t0."visibility"');
  });
});

describe('compileSpec — discovered attributes', () => {
  it('reads an attribute straight out of the JSON, as a column and as a filter', () => {
    const { text, params } = compileWith({
      entity: 'user',
      conditions: [{ field: `ext.${RAW}`, op: 'eq', value: 'FIN-01' }],
      columns: ['displayName', `ext.${RAW}`],
    }, EXT);

    expect(text).toContain(`lower(t0."extendedAttributes"->>'${RAW}') = lower($1)`);
    expect(text).toContain(`t0."extendedAttributes"->>'${RAW}' AS "ext.${RAW}"`);
    expect(params).toEqual(['FIN-01', 1001]);
  });

  it('counts users per attribute value', () => {
    const { text, columns } = compileWith({ entity: 'user', groupBy: `ext.${RAW}` }, EXT);
    expect(text).toContain(`t0."extendedAttributes"->>'${RAW}' AS "ext.${RAW}"`);
    expect(text).toContain(`GROUP BY t0."extendedAttributes"->>'${RAW}'`);
    expect(columns[0]).toEqual({ key: `ext.${RAW}`, alias: `ext.${RAW}`, label: 'sfDepartmentID', type: 'text' });
  });

  it('gives a name too long for a Postgres alias a short one, and says which', () => {
    // 63 bytes is the cut-off; past it Postgres truncates the alias silently and
    // the row comes back under a name the caller never asked for.
    const key = `ext.${LONG}`;
    expect(key.length).toBeGreaterThan(63);

    const { text, columns } = compileWith({ entity: 'user', columns: ['displayName', key] }, EXT);
    expect(text).toContain(`t0."extendedAttributes"->>'${LONG}' AS "c1"`);
    expect(text).not.toContain(`AS "${key}"`);
    expect(columns[1]).toMatchObject({ key, alias: 'c1' });
    // The short alias is only for the ones that need it.
    expect(columns[0]).toMatchObject({ key: 'displayName', alias: 'displayName' });

    const grouped = compileWith({ entity: 'user', groupBy: key }, EXT);
    expect(grouped.text).toContain(`AS "c0"`);
    expect(grouped.columns[0]).toMatchObject({ key, alias: 'c0' });
  });
});

describe('explainSpec — what a grouped report returns', () => {
  it('says the rows are counts per value, not records', () => {
    expect(explainSpec({ entity: 'user', conditions: [], columns: [], groupBy: 'department' }).title)
      .toBe('Users counted per department');
  });

  it('keeps saying what is being counted when there are conditions too', () => {
    const spec = {
      entity: 'user', groupBy: 'jobTitle', columns: [],
      conditions: [{ type: 'field', field: 'accountEnabled', op: 'eq', value: false }],
    };
    const { title, lines } = explainSpec(spec);
    expect(title).toBe('Users counted per job title where');
    expect(lines).toEqual([{ depth: 0, text: 'Enabled is No' }]);
  });

  it('uses the attribute label an analyst reads, not the raw JSON key', () => {
    const spec = { entity: 'user', conditions: [], columns: [], groupBy: `ext.${RAW}` };
    expect(explainSpec(spec, EXT).title).toBe('Users counted per sfDepartmentID');

  });
});
