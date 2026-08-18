// Unit tests for matrix/scopeHistory.js — pure SQL/date logic, no DB needed.

import { describe, it, expect } from 'vitest';
import { generateSampleDates, buildScopeAsofSql } from './scopeHistory.js';
import { createParams } from '../db/sqlParams.js';

const PRINCIPAL_COLS = new Set(['displayName', 'department', 'jobTitle', 'email', 'principalType']);
const RESOURCE_COLS  = new Set(['displayName', 'resourceType', 'systemId']);
const CTX_PRINCIPAL  = 'a0000001-0000-0000-0000-000000000001';
const CONTEXT_TYPES  = new Map([[CTX_PRINCIPAL, 'Principal']]);

// Render through a fresh positional binder; the as-of instant is left as a
// `:ASOF:` marker the caller substitutes per sample date, so it never binds here.
function build(filter, ctx = CONTEXT_TYPES) {
  const { params, bind } = createParams();
  const out = buildScopeAsofSql({
    filter,
    principalColSet: PRINCIPAL_COLS,
    resourceColSet: RESOURCE_COLS,
    contextTypes: ctx,
    bind,
  });
  return { ...out, params };
}

const EMPTY = { rowType: 'principal', subject: { include: [], exclude: [] }, resource: { include: [], exclude: [] } };

describe('generateSampleDates', () => {
  it('returns the requested number of ascending dates ending today', () => {
    const dates = generateSampleDates({ days: 180, points: 13 });
    expect(dates.length).toBe(13);
    // ascending
    for (let i = 1; i < dates.length; i++) expect(dates[i] > dates[i - 1]).toBe(true);
    // last point is today (UTC)
    expect(dates[dates.length - 1]).toBe(new Date().toISOString().slice(0, 10));
  });

  it('spans roughly the requested range', () => {
    const dates = generateSampleDates({ days: 180, points: 13 });
    const first = new Date(dates[0] + 'T00:00:00Z');
    const last = new Date(dates[dates.length - 1] + 'T00:00:00Z');
    const spanDays = (last - first) / 86_400_000;
    expect(spanDays).toBeGreaterThanOrEqual(178);
    expect(spanDays).toBeLessThanOrEqual(182);
  });

  it('clamps points and days to safe bounds', () => {
    expect(generateSampleDates({ days: 99999, points: 9999 }).length).toBeLessThanOrEqual(60);
    expect(generateSampleDates({ days: 0, points: 1 }).length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildScopeAsofSql', () => {
  it('reconstructs from _history with an :ASOF: marker and governed split', () => {
    const { sql, scopeMode } = build(EMPTY);
    expect(sql).toContain(':ASOF:');
    expect(sql).toContain('_history');
    expect(sql).toContain('asof_assign');
    // Governed = covered by a business role: reconstruct Contains relationships
    // + Governed role assignments as-of D, join into a coverage set.
    expect(sql).toContain('asof_contains');
    expect(sql).toContain('coverage');
    expect(sql).toMatch(/Contains/);
    expect(sql).toMatch(/SELECT COUNT\(\*\)::int FROM pairs WHERE governed/);
    expect(scopeMode).toBe('attribute');
  });

  it('excludes group-shaped principals from the subject count', () => {
    const { sql } = build(EMPTY);
    expect(sql).toContain('#microsoft.graph.group');
  });

  it('reconstructs an attribute subject condition against the as-of state', () => {
    const { sql, params, scopeMode } = build({
      ...EMPTY,
      subject: { include: [{ kind: 'attribute', field: 'department', values: ['Finance'] }], exclude: [] },
    });
    expect(sql).toMatch(/sp\.state->>'department'/);
    expect(params).toContain('Finance');
    expect(scopeMode).toBe('attribute'); // attribute conditions are fully reconstructable
  });

  it('flags scopeMode=context-current when a context condition is used', () => {
    const { sql, scopeMode } = build({
      ...EMPTY,
      subject: { include: [{ kind: 'context', contextId: CTX_PRINCIPAL, includeChildren: true }], exclude: [] },
    });
    expect(scopeMode).toBe('context-current');
    expect(sql).toContain('ContextMembers'); // current membership lookup
  });

  it('counts distinct identities for rowType=identity', () => {
    const { sql } = build({ ...EMPTY, rowType: 'identity' });
    expect(sql).toMatch(/COUNT\(DISTINCT im\."identityId"\)/);
    expect(sql).toContain('IdentityMembers');
  });

  it('drops an unknown attribute column with a warning', () => {
    const { warnings } = build({
      ...EMPTY,
      subject: { include: [{ kind: 'attribute', field: 'nope', values: ['x'] }], exclude: [] },
    });
    expect(warnings.some(w => /nope/.test(w))).toBe(true);
  });
});

// ── As-of scope conditions ──────────────────────────────────────────────────
// buildScopeAsofSql reconstructs the matrix scope at a past instant, so the same
// filter has to be re-expressed against a jsonb `state` snapshot rather than live
// tables. That re-expression was almost entirely unmeasured: the tests above use
// one Principal context on the subject block, which is the direct same-kind case,
// so every cross-entity translation, the exclude path, the value normalisation
// and the extendedAttributes path had no test at all.
//
// This is the history view. A wrong answer here is a trend line that shows access
// nobody had, or hides access somebody did — and unlike the live matrix there is
// nothing to compare it against.
describe('as-of scope conditions', () => {
  const CTX_IDENTITY = 'a0000003-0000-0000-0000-000000000003';
  const CTX_SYSTEM   = 'a0000004-0000-0000-0000-000000000004';
  const CTX_RESOURCE = 'a0000002-0000-0000-0000-000000000002';
  const TYPES = new Map([
    [CTX_PRINCIPAL, 'Principal'],
    [CTX_RESOURCE,  'Resource'],
    [CTX_IDENTITY,  'Identity'],
    [CTX_SYSTEM,    'System'],
  ]);

  const ctx = (contextId) => ({ kind: 'context', contextId, includeChildren: false });
  const norm = (sql) => (sql || '').replace(/\s+/g, ' ');

  const withSubject = (include, exclude = []) => build(
    { ...EMPTY, subject: { include, exclude } }, TYPES);
  const withResource = (include, exclude = []) => build(
    { ...EMPTY, resource: { include, exclude } }, TYPES);

  describe('context translation across entity kinds', () => {
    it('matches the reconstructed row id directly for a same-kind context', () => {
      const out = withSubject([ctx(CTX_PRINCIPAL)]);
      expect(norm(out.sql)).toContain(`(sp.state->>'id')::uuid IN (SELECT "memberId" FROM "ContextMembers"`);
      expect(norm(out.sql)).not.toContain('IdentityMembers');
    });

    it('expands an Identity context down to member principals', () => {
      const out = withSubject([ctx(CTX_IDENTITY)]);
      // Selects principalId, matches identityId. Asserting both columns is what
      // pins the direction — "IdentityMembers appears" would hold either way.
      expect(norm(out.sql)).toContain(
        `(sp.state->>'id')::uuid IN (SELECT "principalId" FROM "IdentityMembers" WHERE "identityId" IN`);
    });

    it('matches a System context against the reconstructed systemId, not the row id', () => {
      const out = withResource([ctx(CTX_SYSTEM)]);
      expect(norm(out.sql)).toContain(`(sr.state->>'systemId') IN (SELECT "memberId" FROM "ContextMembers"`);
      expect(norm(out.sql)).not.toContain(`(sr.state->>'id')::uuid IN`);
    });

    it.each([
      ['subject', 'Resource', CTX_RESOURCE],
      ['subject', 'System', CTX_SYSTEM],
      ['resource', 'Principal', CTX_PRINCIPAL],
      ['resource', 'Identity', CTX_IDENTITY],
    ])('drops a %s condition carrying an unusable %s context', (side, _kind, contextId) => {
      // Each unusable pairing, not a sample: both branches above are guarded by
      // two conditions, and only a pairing that satisfies one of them shows the
      // other is doing work.
      const out = side === 'subject' ? withSubject([ctx(contextId)]) : withResource([ctx(contextId)]);
      expect(out.warnings.some((w) => /context condition dropped/.test(w))).toBe(true);
    });

    it('drops a context whose id is not a uuid', () => {
      const out = build({ ...EMPTY, subject: { include: [ctx('not-a-uuid')], exclude: [] } },
                        new Map([['not-a-uuid', 'Principal']]));
      expect(out.warnings.some((w) => /context condition dropped/.test(w))).toBe(true);
    });
  });

  describe('include and exclude', () => {
    const attr = { kind: 'attribute', field: 'department', values: ['Finance'] };

    it('leaves an included condition unwrapped', () => {
      const out = withSubject([attr]);
      expect(norm(out.sql)).toContain(`(sp.state->>'department') IN`);
      expect(out.sql).not.toContain('IS NOT TRUE');
    });

    it('wraps an excluded condition so rows missing the attribute survive', () => {
      // NOT (x IN (…)) is NULL when x is NULL, and NULL is falsy in WHERE — that
      // would silently drop every row with an empty attribute from the history.
      const out = withSubject([], [attr]);
      expect(norm(out.sql)).toContain(`(sp.state->>'department') IN`);
      expect(out.sql).toContain('IS NOT TRUE');
    });

    it('wraps an excluded context condition too', () => {
      const out = withSubject([], [ctx(CTX_PRINCIPAL)]);
      expect(out.sql).toContain('IS NOT TRUE');
    });

    it('keeps include and exclude apart within one block', () => {
      const out = withSubject(
        [{ kind: 'attribute', field: 'department', values: ['Finance'] }],
        [{ kind: 'attribute', field: 'jobTitle', values: ['Intern'] }],
      );
      expect(out.sql.match(/IS NOT TRUE/g)).toHaveLength(1);
      expect(norm(out.sql)).toContain(`(sp.state->>'department') IN`);
      expect(norm(out.sql)).toContain(`((sp.state->>'jobTitle') IN`);
    });

    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['a number', 7],
    ])('ignores %s where a condition object is expected', (_label, cond) => {
      const out = withSubject([cond, { kind: 'attribute', field: 'department', values: ['Finance'] }]);
      // The valid neighbour still lands, so this proves the bad one was skipped
      // rather than the whole block abandoned.
      expect(norm(out.sql)).toContain(`(sp.state->>'department') IN`);
      expect(out.warnings).toHaveLength(0);
    });

    it('warns on a condition of an unrecognised kind', () => {
      const out = withSubject([{ kind: 'sorcery', field: 'department' }]);
      expect(out.warnings.some((w) => /unknown condition kind sorcery/.test(w))).toBe(true);
    });
  });

  describe('attribute values and fields', () => {
    it('drops empty values and stringifies the rest', () => {
      // Deliberately mixed and unequal: three keepers of three different types
      // against three different ways of being empty, so a filter that lets one
      // empty form through, or drops a falsy-but-real value like 0, changes the
      // bound parameters.
      const out = withSubject([{
        kind: 'attribute', field: 'department',
        values: [null, 'Finance', '', 42, undefined, 0],
      }]);
      expect(out.params).toEqual(['Finance', '42', '0']);
    });

    it('returns no clause when every value is empty', () => {
      const out = withSubject([{ kind: 'attribute', field: 'department', values: [null, '', undefined] }]);
      expect(out.warnings.some((w) => /attribute condition dropped/.test(w))).toBe(true);
    });

    it('caps a condition at 200 values', () => {
      const out = withSubject([{
        kind: 'attribute', field: 'department',
        values: Array.from({ length: 250 }, (_, i) => `d${i}`),
      }]);
      expect(out.params).toHaveLength(200);
      expect(out.params[199]).toBe('d199');   // the cap keeps the FIRST 200, not the last
    });

    it('reads an ext.-prefixed field out of the reconstructed extendedAttributes', () => {
      const out = withSubject([{ kind: 'attribute', field: 'ext.costCentre', values: ['CC-1'] }]);
      expect(norm(out.sql)).toContain(`(sp.state->'extendedAttributes'->>'costCentre') IN`);
    });

    it.each([
      ['ext.bad-key', 'an unsafe extendedAttributes key'],
      ['bad-key', 'an unsafe column name'],
      ['notAColumn', 'a column the entity does not have'],
    ])('drops %s (%s)', (field) => {
      // The identifier is interpolated into SQL rather than bound, so the guard
      // is what stops a crafted field name reaching the query text.
      const out = withSubject([{ kind: 'attribute', field, values: ['x'] }]);
      expect(out.warnings.some((w) => /attribute condition dropped/.test(w))).toBe(true);
      expect(norm(out.sql)).not.toContain('bad-key');
    });
  });
});

// ── Query skeleton and guards ───────────────────────────────────────────────
// The reconstruction query is assembled from four named CTEs plus the per-block
// WHERE fragments. None of the wiring was asserted: the CTE names and the tables
// they reconstruct are passed as bare strings, so a swapped pair would rebuild
// principals from the Resources audit trail and still produce runnable SQL.
describe('as-of query skeleton', () => {
  const norm = (sql) => (sql || '').replace(/\s+/g, ' ');

  it('declares each reconstruction CTE once, over the table it belongs to', () => {
    const out = build(EMPTY);
    const names = [...norm(out.sql).matchAll(/(\w+) AS \(/g)].map((m) => m[1]);
    // Order matters: each CTE is referenced by the ones after it.
    expect(names.slice(0, 4)).toEqual(['asof_principals', 'asof_resources', 'asof_assign', 'asof_contains']);
    // ...and each surrogate CTE reconstructs its own table: the audit rows it
    // replays are selected by `_history."tableName"`, and the live rows it unions
    // in come `FROM "<table>"`. Swap the pair and principals get rebuilt from the
    // Resources trail — SQL that still parses and still returns rows.
    expect(norm(out.sql)).toContain(`asof_principals AS ( SELECT x."rowId" AS key`);
    expect(norm(out.sql)).toContain(`asof_resources AS ( SELECT x."rowId" AS key`);
    expect(norm(out.sql)).toMatch(
      /asof_principals AS \(.*?h\."tableName" = 'Principals'.*?FROM "Principals" t.*?asof_resources AS \(/);
    expect(norm(out.sql)).toMatch(
      /asof_resources AS \(.*?h\."tableName" = 'Resources'.*?FROM "Resources" t.*?asof_assign AS \(/);
  });

  it('joins the principal conditions onto the standing group-account exclusion', () => {
    const out = build({ ...EMPTY, subject: {
      include: [{ kind: 'attribute', field: 'department', values: ['Finance'] }], exclude: [] } });
    // Two conditions, so the separator is load-bearing — asserting each one
    // separately would pass even if they were run together into nonsense.
    expect(norm(out.sql)).toContain(
      `WHERE (sp.state->>'principalType' IS NULL OR sp.state->>'principalType' <> '#microsoft.graph.group')`
      + ` AND (sp.state->>'department') IN`);
  });

  it('joins two conditions in one block with AND', () => {
    const out = build({ ...EMPTY, subject: { include: [
      { kind: 'attribute', field: 'department', values: ['Finance'] },
      { kind: 'attribute', field: 'jobTitle', values: ['Analyst'] },
    ], exclude: [] } });
    expect(norm(out.sql)).toContain(
      `(sp.state->>'department') IN ($1) AND (sp.state->>'jobTitle') IN ($2)`);
  });

  it('emits no resource WHERE at all when the resource block is unfiltered', () => {
    const out = build(EMPTY);
    // The resource scope selects from asof_resources with nothing between the
    // alias and the closing paren — pinning the span catches anything injected
    // into that slot, which asserting "no WHERE" would not.
    expect(norm(out.sql)).toContain('FROM asof_resources sr )');
  });

  it('emits the resource WHERE when the resource block is filtered', () => {
    const out = build({ ...EMPTY, resource: {
      include: [{ kind: 'attribute', field: 'resourceType', values: ['vault'] }], exclude: [] } });
    expect(norm(out.sql)).toContain(`FROM asof_resources sr WHERE (sr.state->>'resourceType') IN`);
  });

  it('treats a missing subject or resource block as no conditions', () => {
    // `block?.include` — the caller may omit a side entirely rather than send an
    // empty one, and dropping the optional chaining throws on the whole request.
    const out = build({ rowType: 'principal' });
    expect(out.warnings).toEqual([]);
    expect(norm(out.sql)).toContain('FROM asof_resources sr )');
  });
});

describe('as-of condition guards', () => {
  const norm = (sql) => (sql || '').replace(/\s+/g, ' ');
  const subjectOnly = (cond) => build({ ...EMPTY, subject: { include: [cond], exclude: [] } });

  it.each([
    ['a non-string field', { kind: 'attribute', field: 42, values: ['x'] }],
    ['a non-array values', { kind: 'attribute', field: 'department', values: 'Finance' }],
  ])('drops an attribute condition with %s', (_label, cond) => {
    const out = subjectOnly(cond);
    expect(out.warnings.some((w) => /attribute condition dropped/.test(w))).toBe(true);
    expect(norm(out.sql)).not.toContain(`(sp.state->>'department') IN`);
  });

  it('drops a context whose type is unknown to the caller', () => {
    // A valid uuid that the contextTypes map has never heard of: without the
    // ctxType guard this builds a membership test against an undefined memberType.
    const out = build({ ...EMPTY, subject: {
      include: [{ kind: 'context', contextId: 'a0000009-0000-0000-0000-000000000009' }], exclude: [] } },
      new Map());
    expect(out.warnings.some((w) => /context condition dropped/.test(w))).toBe(true);
  });

  it('ignores a side that is not an array', () => {
    const out = build({ ...EMPTY, subject: { include: 'nonsense', exclude: null } });
    expect(out.warnings).toEqual([]);
  });
});
