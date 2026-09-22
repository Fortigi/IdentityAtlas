import { describe, it, expect } from 'vitest';
import { compileSpec, linkKind, LINKS_SUFFIX } from './compile.js';
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
  // ── the ids behind a name list ────────────────────────────────
  //
  // A name-list column ("Owner of" = "ASML, AlisQI, Bestuur, …") used to throw
  // every id away, which made the names unlinkable and left a follow-up
  // question about "these groups" with nothing to point at.

  it('selects the id behind every name in a name-list column', () => {
    const { text, columns } = compile({
      entity: 'account', conditions: [], columns: ['displayName', 'owns.names'],
    });

    expect(text).toContain(`AS "owns.names${LINKS_SUFFIX}"`);
    expect(text).toContain('jsonb_build_object');
    // Both halves of the pair, or the names come back unusable.
    expect(text).toMatch(/'id',\s*\w+\."id"/);
    expect(text).toMatch(/'name',\s*\w+\."name"/);
    // The companion carries the kind of page each id opens.
    expect(columns.find(col => col.key === 'owns.names').linkKind).toBe('resource');
  });

  it('leaves the visible name-list value exactly as it was', () => {
    // The whole design rests on this: the pairs ride ALONGSIDE the string, so
    // exports, the report table and every other reader are untouched. If this
    // fails, the change stopped being additive.
    const { text } = compile({ entity: 'account', conditions: [], columns: ['owns.names'] });
    expect(text).toContain(`string_agg(DISTINCT `);
    expect(text).toMatch(/string_agg\(DISTINCT \w+\."displayName", ', ' ORDER BY \w+\."displayName"\)/);
  });

  it('orders the pairs by name, like the string beside them', () => {
    // Two lists that disagree on order are worse than no list: the third link
    // would open the fourth group's page.
    const { text } = compile({ entity: 'account', conditions: [], columns: ['owns.names'] });
    expect(text).toMatch(/jsonb_agg\(.*ORDER BY \w+\."name"\)/);
  });

  it('de-duplicates by id AND name, so two groups sharing a name both survive', () => {
    // DISTINCT sits in an inner SELECT over the pair, not over the name — a
    // tenant with two groups called "General" must get two links.
    const { text } = compile({ entity: 'account', conditions: [], columns: ['owns.names'] });
    expect(text).toMatch(/SELECT DISTINCT \w+\."id" AS "id", \w+\."displayName" AS "name"/);
  });

  it('adds no companion column to anything that is not a name list', () => {
    const { text, columns } = compile({
      entity: 'account', conditions: [], columns: ['displayName', 'owns.count', 'manager.displayName'],
    });
    expect(text).not.toContain(LINKS_SUFFIX);
    expect(columns.every(col => col.linkKind === null)).toBe(true);
  });

  it('knows which detail page each name list opens', () => {
    // resource.members lists accounts, account.owns lists resources — the kind
    // comes from the relation's TARGET, not from the report's own entity.
    expect(linkKind('resource', { kind: 'manyNames', relation: 'members' })).toBe('user');
    expect(linkKind('account', { kind: 'manyNames', relation: 'owns' })).toBe('resource');
    expect(linkKind('account', { kind: 'manyCount', relation: 'owns' })).toBe(null);
    expect(linkKind('account', { kind: 'field', field: 'displayName' })).toBe(null);
  });

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
