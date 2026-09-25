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
  // ── "is one of" ───────────────────────────────────────────────
  //
  // Exists for follow-up questions: "of THESE groups, which are in an access
  // package" has to name the records a previous answer produced.

  it('compiles a list to one parameter, not one placeholder per value', () => {
    // A list built per question would otherwise change the SQL TEXT on every
    // call, which defeats statement caching and makes the compiled query
    // impossible to compare between two runs.
    const { text, params } = compile({
      entity: 'resource', conditions: [{ field: 'id', op: 'in', value: ['g1', 'g2', 'g3'] }],
    });
    expect(text).toContain('= ANY($1)');
    expect(params[0]).toEqual(['g1', 'g2', 'g3']);
    expect(text).not.toContain('$2,');
  });

  it('matches case-insensitively, exactly as "is" does on one value', () => {
    // A list must select the same rows the same values would one at a time.
    const one = compile({ entity: 'resource', conditions: [{ field: 'displayName', op: 'eq', value: 'Finance' }] });
    const many = compile({ entity: 'resource', conditions: [{ field: 'displayName', op: 'in', value: ['Finance'] }] });
    expect(one.text).toContain('lower(');
    expect(many.text).toContain('lower(');
    expect(many.params[0]).toEqual(['finance']);
  });

  it('keeps a list value out of the SQL text, like every other value', () => {
    const { text, params } = compile({
      entity: 'resource',
      conditions: [{ field: 'displayName', op: 'in', value: [`x'); DROP TABLE "Principals"; --`] }],
    });
    expect(text).not.toContain('DROP');
    expect(params[0]).toEqual([`x'); drop table "principals"; --`]);
  });

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
    expect(columns.every(col => !('linkKind' in col) && !('linksAlias' in col))).toBe(true);
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

describe('the change entity', () => {
  // Every other entity answers "what is true now". This one answers "what
  // became true, and when" — the question the catalog could not express at all.
  const values = { changeAction: ['Added', 'Removed'], assignmentType: ['Direct', 'Indirect', 'Eligible'] };
  const compileChange = (raw) => {
    const { ok, spec, errors } = validateSpec(raw, values);
    if (!ok) throw new Error(errors.join('; '));
    return { spec, ...compileSpec(spec) };
  };

  it('reads the view, not the audit table', () => {
    // The "a removal is an UPDATE that stamps deletedAt" rule lives in the
    // view (migration 070) so there is one place it can be got wrong.
    const { text } = compileChange({ entity: 'change', conditions: [] });
    expect(text).toContain('FROM "AssignmentChanges"');
    expect(text).not.toContain('_history');
  });

  it('puts the newest change first, without being asked', () => {
    // Alphabetical order on a list of events is useless — the newest one is
    // the entire point of asking what changed.
    const { text } = compileChange({ entity: 'change', conditions: [] });
    expect(text).toMatch(/ORDER BY \w+\."changedAt" DESC/);
  });

  it('still lets the request choose its own order', () => {
    const { text } = compileChange({
      entity: 'change', conditions: [], sort: { field: 'changedAt', direction: 'asc' },
    });
    expect(text).toMatch(/ORDER BY \w+\."changedAt" ASC/);
  });

  it('leaves every other entity ordered by name', () => {
    // defaultSort is opt-in per entity; nothing else declares one.
    const { text } = compile({ entity: 'group', conditions: [] });
    expect(text).toMatch(/ORDER BY \w+\."displayName" ASC/);
  });

  it('compiles "changes in the last 30 days for my people"', () => {
    // The manager is reached in ONE hop on purpose: a relation condition
    // cannot nest another relation, so change → account → manager is not
    // expressible and the view carries managerId as a column.
    const { text, params } = compileChange({
      entity: 'change',
      conditions: [
        { type: 'field', field: 'changedAt', op: 'withinLastDays', value: 30 },
        { type: 'relation', relation: 'manager', quantifier: 'some',
          conditions: [{ field: 'id', op: 'eq', value: 'me-id' }] },
      ],
      columns: ['changedAt', 'action', 'account.displayName', 'resource.displayName'],
    });
    expect(text).toContain('make_interval');
    expect(text).toMatch(/EXISTS \(SELECT 1 FROM "Principals" \w+ WHERE \w+\."id" = \w+\."managerId"/);
    expect(params).toContain('me-id');
  });

  it('knows Added and Removed without asking the data for them', () => {
    // Read from the view's own CASE, not from a DISTINCT over the rows: a
    // deployment that has had no removals yet would otherwise leave "Removed"
    // an unknown value, and a question about removals would be rejected.
    const { spec } = compileChange({
      entity: 'change', conditions: [{ field: 'action', op: 'eq', value: 'removed' }],
    });
    expect(spec.conditions[0].value).toBe('Removed');
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

describe('compileSpec — the business roles an account has', () => {
  // "Add the business role column" was the first thing asked of a user report that
  // the catalog could not express: business roles were reachable only from a
  // resource (which package contains this group?), never from the account that
  // holds one, so every answer came back as "there is no such field".
  const withBusinessRoles = () => compile({
    entity: 'user',
    conditions: [{ relation: 'businessRoles', quantifier: 'some', conditions: [{ field: 'displayName', op: 'contains', value: 'Finance' }] }],
    columns: ['displayName', 'businessRoles.names'],
  });

  const namesColumn = (text) => {
    const upToAlias = text.slice(0, text.indexOf('AS "businessRoles.names"'));
    return upToAlias.slice(upToAlias.lastIndexOf('(SELECT string_agg'));
  };

  it('reads the assignments of the account, restricted to BusinessRole resources', () => {
    const column = namesColumn(withBusinessRoles().text);
    expect(column).toContain('"ResourceAssignments"');
    expect(column).toMatch(/"principalId" = t0\."id"/);
    expect(column).toContain(`"resourceType" = 'BusinessRole'`);
    // Eligible means "could activate it", not "is in it" — as for group membership.
    expect(column).toContain(`"assignmentType" IN ('Direct','Indirect')`);
  });

  it('never reaches a business role through a group that package contains', () => {
    // From a resource, businessRoles walks ResourceRelationships upward (Contains).
    // From an account it must not: being in a group some access package happens to
    // contain is not being assigned that access package.
    const { text } = withBusinessRoles();
    expect(text).not.toContain('ResourceRelationships');
    expect(text).not.toContain(`'Contains'`);
  });

  it('is narrower than access, which still holds every kind of resource', () => {
    // .count rather than .names: a name-list column is selected twice (the
    // readable string and the companion carrying its ids), which would double a
    // count that is about the relation's WHERE, not about how often it is read.
    const { text } = compile({ entity: 'user', columns: ['displayName', 'access.count', 'businessRoles.count'] });
    expect(text.match(/"resourceType" = 'BusinessRole'/g)).toHaveLength(1);
    expect(text).toContain(`"resourceType" NOT IN ('GroupOwnership','ApplicationOwnership','ServicePrincipalOwnership')`);
  });
});
