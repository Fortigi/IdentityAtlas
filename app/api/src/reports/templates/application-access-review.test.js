// Unit tests for the access-review report template.
//
// The db mock is SQL-blind, so the recordsets are dispatched on a fragment of
// each statement rather than on call order — the four reads after the first
// run inside one Promise.all, and an order-keyed mock would pass or fail on
// scheduling.
//
// The inputs are chosen to discriminate, not merely to execute: a direct-only
// and an indirect-only entitlement with different numbers so a swapped column
// fails, two contexts whose names sort the other way round from their
// entitlements, and percentages over 8 rows so a rounding change shows.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import report, {
  DEFAULT_FIELDS, DEFAULT_PIVOT_ROWS, MAX_CONTEXTS, MAX_ROWS,
  buildLayout, emptyFieldNotices, fieldParameters, groupOwners, parseList, percentage,
} from './application-access-review.js';
import { resolveFields } from '../accessReviewFields.js';

// ─── staging ──────────────────────────────────────────────────────────────

const CTX_ID = '11111111-1111-1111-1111-111111111111';
const CTX2_ID = '22222222-2222-2222-2222-222222222222';

const context = (over) => ({
  id: CTX_ID,
  displayName: 'Ledger Engineering 0006',
  contextType: 'LogicalApplication',
  description: 'The general ledger.',
  ownerUserId: '10007339',
  ownerName: 'Ada Lovelace',
  extendedAttributes: { cmdbReference: 'CI5505557', connectionType: 'SaaS' },
  ...over,
});

const ent = (id, over = {}) => ({
  id, displayName: `ENT_${id}`, contextId: CTX_ID, resourceType: 'Entitlement',
  systemName: 'IdentityIQ', description: null,
  extendedAttributes: { certfrequency: 'Annually' },
  ...over,
});

// Each read is recognised by a fragment only that statement contains.
function stage({ contexts = [context()], entitlements = [], counts = [], roles = [], owners = [], users = 0 }) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM "Contexts" c')) return { rows: contexts };
    if (sql.includes('"memberType" = \'Resource\'')) return { rows: entitlements };
    if (sql.includes('FILTER (WHERE d.t = \'Direct\')')) return { rows: counts };
    if (sql.includes('\'BusinessRole\'')) return { rows: roles };
    if (sql.includes('"parentResourceId" = ANY')) return { rows: owners };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
  queryOne.mockResolvedValue({ users });
}

const run = (params = {}) => report.run({ contexts: 'Ledger Engineering 0006', ...params }, {});
const noticeText = (result) => result.notices.map(n => n.text).join('\n');
const rowFor = (result, id) => result.rows.find(r => r.entitlement === `ENT_${id}`);
const keys = columns => columns.map(c => c.key);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

// ─── the contract ─────────────────────────────────────────────────────────

describe('access review — template contract', () => {
  it('is a list report over contexts, with columns and pivot axes picked from a field lookup', () => {
    // Renamed for people, not for links: the slug is what saved views and bookmarks address.
    expect(report).toMatchObject({ name: 'application-access-review', displayName: 'Entitlement Pivot', form: 'list' });
    const { required, properties } = report.parametersSchema;
    expect(required).toEqual(['contexts']);
    expect(properties.contexts['x-lookup']).toBe('resource-contexts');
    for (const name of ['fields', 'pivotRows', 'pivotFilters']) {
      expect(properties[name]['x-lookup'], name).toBe('access-review-fields');
      // The attributes on offer follow the contexts picked.
      expect(properties[name]['x-lookupDependsOn'], name).toEqual(['contexts']);
    }
    expect(properties.fields.default).toEqual(DEFAULT_FIELDS);
    expect(properties.pivotRows.default).toEqual(DEFAULT_PIVOT_ROWS);
    expect(properties.pivotFilters.default).toEqual([]);
  });

  it('names no customer attribute — its defaults are facts every deployment has', () => {
    for (const key of [...DEFAULT_FIELDS, ...DEFAULT_PIVOT_ROWS]) expect(key, key).not.toMatch(/\.ext\./);
    expect(resolveFields([...DEFAULT_FIELDS, ...DEFAULT_PIVOT_ROWS]).unknown).toEqual([]);
  });

  it('declares the layout an untouched run produces, pivots over columns it has', () => {
    expect(keys(report.columns)).toEqual([
      'entitlement', ...DEFAULT_FIELDS, 'businessRoles', 'directAssignments', 'viaRoleAssignments',
    ]);
    const columnKeys = new Set(keys(report.columns));
    for (const pivot of report.pivots) {
      for (const key of [...pivot.filters, ...pivot.rows, ...pivot.values]) expect(columnKeys, `${pivot.name}: ${key}`).toContain(key);
    }
  });
});

// ─── the layout ───────────────────────────────────────────────────────────

describe('access review — layout', () => {
  const fieldsFor = list => resolveFields(list).fields;
  const layoutOf = ({ fields = [], pivotRows = [], pivotFilters = [] }) => buildLayout({
    fields: fieldsFor(fields), pivotRows: fieldsFor(pivotRows), pivotFilters: fieldsFor(pivotFilters),
  });

  it('puts the picked fields between the entitlement and its counts, in the order picked', () => {
    const { columns } = layoutOf({ fields: ['entitlement.ext.certfrequency', 'context.name'] });
    expect(keys(columns)).toEqual([
      'entitlement', 'entitlement.ext.certfrequency', 'context.name',
      'businessRoles', 'directAssignments', 'viaRoleAssignments',
    ]);
    expect(columns[1].label).toBe('certfrequency');
  });

  it('makes a pivot field a column even when it was not picked as one, once', () => {
    const { columns } = layoutOf({
      fields: ['context.name'],
      pivotRows: ['context.name', 'entitlement.owner'],
      pivotFilters: ['entitlement.ext.costcentercode'],
    });
    expect(keys(columns)).toEqual([
      'entitlement', 'context.name', 'entitlement.owner', 'entitlement.ext.costcentercode',
      'businessRoles', 'directAssignments', 'viaRoleAssignments',
    ]);
  });

  it('builds the direct pivot from the picked rows, entitlement innermost, filterable on the role count', () => {
    const [direct, viaRole] = layoutOf({
      pivotRows: ['context.owner', 'entitlement.ext.certfrequency'],
      pivotFilters: ['entitlement.ext.requestable'],
    }).pivots;
    expect(direct).toEqual({
      name: 'Direct assignments',
      rows: ['context.owner', 'entitlement.ext.certfrequency', 'entitlement'],
      filters: ['entitlement.ext.requestable', 'viaRoleAssignments'],
      values: ['directAssignments'],
    });
    // The role pivot is broken down by role whatever was picked, and filters on
    // the same fields.
    expect(viaRole).toEqual({
      name: 'Assignments via roles',
      rows: ['businessRoles', 'entitlement'],
      filters: ['entitlement.ext.requestable'],
      values: ['viaRoleAssignments'],
    });
  });

  it('never puts one field on two axes of one pivot', () => {
    // Excel refuses a field that is both a row and a filter of the same pivot.
    const [direct] = layoutOf({ pivotRows: ['context.name'], pivotFilters: ['context.name', 'entitlement.type'] }).pivots;
    expect(direct.rows).toContain('context.name');
    expect(direct.filters).toEqual(['entitlement.type', 'viaRoleAssignments']);
  });
});

// ─── parameters ───────────────────────────────────────────────────────────

describe('access review — field parameters', () => {
  it('falls back to each default when a list was not sent, or sent empty', () => {
    for (const params of [{}, { fields: '', pivotRows: ' , ', pivotFilters: [] }, undefined]) {
      const picks = fieldParameters(params);
      expect(keys(picks.fields)).toEqual(DEFAULT_FIELDS);
      expect(keys(picks.pivotRows)).toEqual(DEFAULT_PIVOT_ROWS);
      expect(picks.pivotFilters).toEqual([]);
      expect(picks.notices).toEqual([]);
    }
  });

  it('uses what was sent, and names a key that is not a field once, wherever it was sent', () => {
    const picks = fieldParameters({
      fields: 'entitlement.ext.costcentercode,bogus',
      pivotRows: 'bogus',
      pivotFilters: ['context.type', 'also.bogus'],
    });
    expect(keys(picks.fields)).toEqual(['entitlement.ext.costcentercode']);
    // Every pivot-row key was unknown, which is not the same as none sent.
    expect(picks.pivotRows).toEqual([]);
    expect(keys(picks.pivotFilters)).toEqual(['context.type']);
    expect(picks.notices).toEqual([{
      severity: 'warning', text: 'Left out "bogus", "also.bogus": not a field this report knows.',
    }]);
  });
});

describe('access review — contexts', () => {
  it('runs nothing and explains itself when no context is named', async () => {
    const result = await report.run({}, {});
    expect(result.rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(noticeText(result)).toMatch(/Pick one or more contexts to review/);
  });

  it('still accepts the parameter under its old name, so a bookmark keeps working', async () => {
    stage({ entitlements: [ent('a')] });
    const result = await report.run({ applications: CTX_ID }, {});
    expect(result.rows).toHaveLength(1);
    expect(query.mock.calls[0][1]).toEqual([[CTX_ID]]);
  });

  it('looks contexts up by lower-cased name or id, among contexts of resources of any type', async () => {
    stage({ entitlements: [ent('a')] });
    await run({ contexts: `Ledger ENGINEERING 0006,${CTX_ID}` });
    const [sql, params] = query.mock.calls[0];
    expect(params).toEqual([['ledger engineering 0006', CTX_ID]]);
    expect(sql).toContain(`c."targetType" = 'Resource'`);
    expect(sql).not.toContain('"contextType" =');
  });

  it('caps the list of contexts, because it is user input reaching a query', async () => {
    stage({ contexts: [] });
    const many = Array.from({ length: MAX_CONTEXTS + 20 }, (_, i) => `ctx-${i}`);
    await run({ contexts: many });
    expect(query.mock.calls[0][1][0]).toHaveLength(MAX_CONTEXTS);
  });

  it('warns about a name that matches no context, and still returns the run\'s columns', async () => {
    stage({ contexts: [] });
    const result = await run({ contexts: 'Ledger Engineering 0006, Typo Ledger', fields: 'entitlement.type' });
    expect(noticeText(result)).toMatch(/No context of resources matches "Ledger Engineering 0006", "Typo Ledger"/);
    expect(result.rows).toEqual([]);
    expect(keys(result.columns)).toContain('entitlement.type');
  });

  it('warns when one name matches several contexts and includes them all', async () => {
    stage({
      contexts: [context(), context({ id: CTX2_ID, contextType: 'Tag' })],
      entitlements: [ent('a'), ent('b', { contextId: CTX2_ID })],
    });
    const result = await run();
    expect(noticeText(result)).toMatch(/1 name\(s\) match more than one context \(ledger engineering 0006\)/);
    expect(result.rows).toHaveLength(2);
  });

  it('reports a context with no resources as empty rather than as a failure', async () => {
    stage({ entitlements: [] });
    const result = await run();
    expect(result.rows).toEqual([]);
    expect(noticeText(result)).toMatch(/"Ledger Engineering 0006" has no resources as members/);
    // No point counting assignments for an empty set.
    expect(queryOne).not.toHaveBeenCalled();
  });
});

// ─── rows ─────────────────────────────────────────────────────────────────

describe('access review — rows', () => {
  it('reads every picked field into its own column, under its key', async () => {
    stage({
      entitlements: [ent('a', { extendedAttributes: { certfrequency: 'Quarterly', costcentercode: 4410 } })],
      owners: [{ id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'grace@example.com' }],
    });
    const result = await run({
      fields: 'context.name,context.owner,context.ext.cmdbReference,entitlement.ext.certfrequency,'
        + 'entitlement.ext.costcentercode,entitlement.owner,entitlement.system',
    });
    expect(rowFor(result, 'a')).toEqual({
      entitlement: 'ENT_a',
      'context.name': 'Ledger Engineering 0006',
      'context.owner': 'Ada Lovelace',
      'context.ext.cmdbReference': 'CI5505557',
      'entitlement.ext.certfrequency': 'Quarterly',
      'entitlement.ext.costcentercode': 4410,
      'entitlement.owner': 'Grace Hopper',
      'entitlement.system': 'IdentityIQ',
      businessRoles: null,
      directAssignments: 0,
      viaRoleAssignments: 0,
      _entity: { kind: 'resource', id: 'a' },
    });
  });

  it('keeps direct and via-role holders in their own columns', async () => {
    stage({
      entitlements: [ent('a'), ent('b'), ent('c')],
      counts: [
        { id: 'a', direct: 3, indirect: 44200 },   // asymmetric on purpose: a
        { id: 'b', direct: 45000, indirect: 0 },   // swapped mapping fails both
      ],
    });
    const result = await run();
    expect(rowFor(result, 'a')).toMatchObject({ directAssignments: 3, viaRoleAssignments: 44200 });
    expect(rowFor(result, 'b')).toMatchObject({ directAssignments: 45000, viaRoleAssignments: 0 });
    // An entitlement nobody holds still appears, with zeroes rather than blanks.
    expect(rowFor(result, 'c')).toMatchObject({ directAssignments: 0, viaRoleAssignments: 0 });
  });

  it('names every role an entitlement belongs to, and leaves the column empty when there is none', async () => {
    stage({
      entitlements: [ent('a'), ent('b')],
      roles: [{ id: 'a', roles: 'Ledger Clerk, Ledger Supervisor' }, { id: 'other', roles: 'X' }],
    });
    const result = await run();
    expect(rowFor(result, 'a').businessRoles).toBe('Ledger Clerk, Ledger Supervisor');
    expect(rowFor(result, 'b').businessRoles).toBeNull();
  });

  it('includes a resource of any type — the type is a column, not a filter', async () => {
    stage({ entitlements: [ent('a', { resourceType: 'Group' }), ent('b', { resourceType: 'AppRole' })] });
    const result = await run({ fields: 'entitlement.type' });
    expect(result.rows.map(r => r['entitlement.type'])).toEqual(['Group', 'AppRole']);
  });

  it('orders by context, then by entitlement — even when the context is not a column', async () => {
    stage({
      contexts: [context(), context({ id: CTX2_ID, displayName: 'Archive' })],
      entitlements: [ent('b'), ent('a'), ent('z', { contextId: CTX2_ID })],
    });
    const result = await run({ contexts: `${CTX_ID},${CTX2_ID}`, fields: 'entitlement.type' });
    expect(result.rows.map(r => r.entitlement)).toEqual(['ENT_z', 'ENT_a', 'ENT_b']);
  });
});

// ─── the run's columns and constants ──────────────────────────────────────

describe('access review — columns of a run', () => {
  it('returns the columns and pivots it was asked for', async () => {
    stage({ entitlements: [ent('a')] });
    const result = await run({ fields: 'entitlement.ext.certfrequency', pivotRows: 'entitlement.ext.certfrequency' });
    expect(keys(result.columns)).toEqual([
      'entitlement', 'entitlement.ext.certfrequency', 'businessRoles', 'directAssignments', 'viaRoleAssignments',
    ]);
    expect(result.pivots[0].rows).toEqual(['entitlement.ext.certfrequency', 'entitlement']);
  });

  it('declares the picked context fields constant for a run over ONE context', async () => {
    // The Excel export states them once on its Summary tab instead of repeating
    // them down 21,000 rows.
    stage({ entitlements: [ent('a')] });
    const result = await run({ fields: 'entitlement.type,context.name,context.ext.cmdbReference' });
    expect(result.constantColumns).toEqual(['context.name', 'context.ext.cmdbReference']);
  });

  it('declares nothing constant when one name resolved to several contexts', async () => {
    // The discriminating case: ONE name matching TWO contexts. A check on the
    // number of names asked for rather than the number resolved would wrongly
    // collapse them into one header block.
    stage({
      contexts: [context(), context({ id: CTX2_ID })],
      entitlements: [ent('a'), ent('b', { contextId: CTX2_ID })],
    });
    expect((await run({ fields: 'context.name' })).constantColumns).toEqual([]);
  });
});

// ─── owners and summaries ─────────────────────────────────────────────────

describe('access review — summaries', () => {
  it('states the four summaries with the numbers the rows actually hold', async () => {
    // 8 entitlements: 2 in a role (25%), 1 owned, so a wrong denominator or a
    // count of links instead of people shows up.
    const entitlements = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(id => ent(id));
    stage({
      entitlements,
      roles: [{ id: 'a', roles: 'R1' }, { id: 'b', roles: 'R1' }],
      owners: [
        { id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'g@example.com' },
        { id: 'a', ownerId: 'p2', ownerName: 'Ada Lovelace', ownerEmail: 'a@example.com' },
        { id: 'c', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'g@example.com' },
      ],
      users: 1234,
    });
    const text = noticeText(await run());
    expect(text).toMatch(/1,234 unique user\(s\) hold at least one assignment in "Ledger Engineering 0006"/);
    expect(text).toMatch(/8 entitlement\(s\) in scope/);
    expect(text).toMatch(/2 distinct entitlement owner\(s\); 6 entitlement\(s\) have no owner/);
    expect(text).toMatch(/25% of entitlements are part of a business role \(2 of 8\)/);
  });

  it('reports Eligible holders separately, and says nothing when there are none', async () => {
    stage({ entitlements: [ent('a')], counts: [{ id: 'a', direct: 2, indirect: 1, eligible: 7 }] });
    const result = await run();
    expect(rowFor(result, 'a')).toMatchObject({ directAssignments: 2, viaRoleAssignments: 1 });
    expect(noticeText(result)).toMatch(/7 holder\(s\) in scope are Eligible/);

    stage({ entitlements: [ent('a')], counts: [{ id: 'a', direct: 2, indirect: 1, eligible: 0 }] });
    expect(noticeText(await run())).not.toMatch(/Eligible/);
  });

  it('says once which picked attribute no row has a value for', async () => {
    stage({ entitlements: [ent('a'), ent('b')] });
    const text = noticeText(await run({
      fields: 'entitlement.ext.certfrequency,entitlement.ext.costcentercode,entitlement.description',
    }));
    expect(text).toMatch(/No row in scope has a value for "costcentercode"\./);
    // A built-in field left empty is not a missing attribute.
    expect(text).not.toMatch(/"Description"/);
  });

  it('describes several contexts by number', async () => {
    stage({
      contexts: [context(), context({ id: CTX2_ID, displayName: 'Archive' })],
      entitlements: [],
    });
    expect(noticeText(await run({ contexts: `${CTX_ID},${CTX2_ID}` }))).toMatch(/^2 contexts has no resources/m);
  });
});

describe('access review — row cap', () => {
  it('caps a run that would return more rows than one response should carry', async () => {
    const entitlements = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ent(String(i)));
    stage({ entitlements });
    const result = await run();
    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
    // Pinned to en-US: a notice that read "50.000" on a Dutch host and
    // "50,000" on an American one would be a host-dependent API response.
    expect(noticeText(result)).toMatch('holds 50,001 entitlements; this run shows the first 50,000');
  });

  it('does not claim truncation for a run that fits', async () => {
    stage({ entitlements: [ent('a')] });
    const result = await run();
    expect(result.truncated).toBe(false);
    expect(noticeText(result)).not.toMatch(/shows the first/);
  });
});

// ─── the pure rules ───────────────────────────────────────────────────────

describe('access review — rules', () => {
  it('re-exports the list parser the parameters go through', () => {
    expect(parseList('a, b ,, c')).toEqual(['a', 'b', 'c']);
  });

  it('rounds a percentage to one decimal and survives an empty denominator', () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(2, 3)).toBe(66.7);
    expect(percentage(1, 8)).toBe(12.5);
    expect(percentage(0, 0)).toBe(0);
  });

  it('flags only attributes, and only those empty on every row', () => {
    const fields = resolveFields(['entitlement.ext.x', 'entitlement.ext.y', 'entitlement.owner']).fields;
    const rows = [
      { 'entitlement.ext.x': null, 'entitlement.ext.y': 0, 'entitlement.owner': null },
      { 'entitlement.ext.x': null, 'entitlement.ext.y': null, 'entitlement.owner': null },
    ];
    expect(emptyFieldNotices(rows, fields)).toEqual([{ severity: 'info', text: 'No row in scope has a value for "x".' }]);
    expect(emptyFieldNotices(rows, fields.slice(1))).toEqual([]);
  });

  it('folds owner links into one entry per entitlement while keeping the people apart', () => {
    const grouped = groupOwners([
      { id: 'e1', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x' },
      { id: 'e1', ownerId: 'p2', ownerName: 'B', ownerEmail: null },
      { id: 'e2', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x' },
    ]);
    expect(grouped.get('e1')).toEqual({ ownerName: 'A, B', ownerEmail: 'a@x', ownerIds: ['p1', 'p2'] });
    expect(grouped.get('e2').ownerIds).toEqual(['p1']);
  });
});
