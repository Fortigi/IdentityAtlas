// The Entitlement Pivot run on a unit of ACCOUNTS: the entitlements its members
// hold, counted among those members only.
//
// Run through the template rather than the reads alone, because what matters is
// that the run picks these reads for a Principal context and files each unit's
// counts under that unit. The discriminating input: ONE resource held in TWO
// units with different counts — a count map keyed by resource id alone (the
// resource-context rule) would show the same number on both rows.
//
// The db mock is SQL-blind, so reads are recognised by a fragment only that
// statement contains. Whether the SQL selects the right rows (a non-member's
// resource left out, a deleted assignment ignored) is proven against a real
// schema in contract-tests/applicationAccessReview.contract.test.js.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import report, { readsFor, preferResourceContexts } from './templates/application-access-review.js';
import { memberCountKey } from './heldEntitlements.js';

const UNIT = '33333333-3333-3333-3333-333333333333';
const UNIT2 = '44444444-4444-4444-4444-444444444444';

const unit = (over) => ({
  id: UNIT, displayName: 'Finance accounts', targetType: 'Principal', contextType: 'Department',
  description: null, ownerUserId: null, ownerName: null, extendedAttributes: {}, ...over,
});
const held = (id, contextId = UNIT) => ({
  id, displayName: `ENT_${id}`, contextId, resourceType: 'Group', systemName: 'Entra', description: null,
  extendedAttributes: {},
});

const HELD_SQL = 'SELECT DISTINCT cm."contextId", ra."resourceId"';
const COUNTS_SQL = 'GROUP BY d."contextId", d.id';

function stage({ contexts = [unit()], entitlements = [], counts = [], owners = [], users = 0 }) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('FROM "ContextRoles"')) return { rows: [] };
    if (sql.includes('FROM "Contexts" c')) return { rows: contexts };
    // Counts first: its inner select starts the way the entitlement read does.
    if (sql.includes(COUNTS_SQL)) return { rows: counts };
    if (sql.includes(HELD_SQL)) return { rows: entitlements };
    if (sql.includes('"memberType" = \'Resource\'')) return { rows: [] };
    if (sql.includes('"childResourceId" = ANY')) return { rows: [] };
    if (sql.includes('"parentResourceId" = ANY')) return { rows: owners };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
  queryOne.mockResolvedValue({ users });
}

const sqlOf = (fragment, not) => query.mock.calls.find(([sql]) => sql.includes(fragment) && !(not && sql.includes(not)));
const noticeText = result => result.notices.map(n => n.text).join('\n');
const FIELDS = 'context.name,entitlement.owner';

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

describe('Entitlement Pivot on a unit of accounts', () => {
  it('lists the entitlements the unit\'s direct members hold, with the owner and the members\' counts', async () => {
    stage({
      entitlements: [held('a'), held('b')],
      counts: [
        { contextId: UNIT, id: 'a', direct: 3, indirect: 0, eligible: 0 },
        { contextId: UNIT, id: 'b', direct: 0, indirect: 5, eligible: 0 },
      ],
      owners: [{ id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'g@example.com' }],
      users: 6,
    });
    const result = await report.run({ contexts: UNIT, fields: FIELDS }, {});

    expect(result.rows.map(r => [r.entitlement, r['entitlement.owner'], r.directAssignments, r.viaRoleAssignments]))
      .toEqual([['ENT_a', 'Grace Hopper', 3, 0], ['ENT_b', null, 0, 5]]);
    expect(noticeText(result)).toMatch(/^6 unique user\(s\) hold at least one assignment in "Finance accounts"/m);

    // The entitlement set comes from the members' live assignments, not from
    // resource members of the context — and only the unit's own members.
    const [heldSql, heldParams] = sqlOf(HELD_SQL, COUNTS_SQL);
    expect(heldSql).toContain(`cm."memberType" = 'Principal'`);
    expect(heldSql).toContain('ra."principalId" = cm."memberId" AND ra."deletedAt" IS NULL');
    expect(heldSql).not.toContain(`"memberType" = 'Resource'`);
    // Business roles are intent, already shown as "Granted by role(s)".
    expect(heldSql).toMatch(/r\."resourceType" NOT IN \('BusinessRole'\)/);
    expect(heldParams).toEqual([[UNIT]]);
    // The counts and the user total are scoped to the same members.
    expect(sqlOf(COUNTS_SQL)[1]).toEqual([[UNIT], ['a', 'b']]);
    const [userSql, userParams] = queryOne.mock.calls[0];
    expect(userSql).toContain(`cm."memberType" = 'Principal'`);
    expect(userParams).toEqual([[UNIT], ['a', 'b']]);
  });

  it('counts each unit\'s own members when one entitlement is held in two units', async () => {
    stage({
      contexts: [unit(), unit({ id: UNIT2, displayName: 'Audit accounts' })],
      entitlements: [held('a'), held('a', UNIT2)],
      counts: [
        { contextId: UNIT, id: 'a', direct: 4, indirect: 1 },
        { contextId: UNIT2, id: 'a', direct: 1, indirect: 0 },
      ],
    });
    const result = await report.run({ contexts: `${UNIT},${UNIT2}`, fields: FIELDS }, {});
    expect(result.rows.map(r => [r['context.name'], r.directAssignments, r.viaRoleAssignments])).toEqual([
      ['Audit accounts', 1, 0],
      ['Finance accounts', 4, 1],
    ]);
    // The entitlement is asked about once, not once per unit.
    expect(sqlOf(COUNTS_SQL)[1][1]).toEqual(['a']);
  });

  it('reports a unit whose members hold nothing as empty, and counts nothing', async () => {
    stage({ entitlements: [] });
    const result = await report.run({ contexts: UNIT }, {});
    expect(result.rows).toEqual([]);
    expect(noticeText(result)).toMatch('"Finance accounts" has no members holding an entitlement.');
    expect(noticeText(result)).not.toMatch(/no resources as members/);
    expect(queryOne).not.toHaveBeenCalled();
  });

  it('refuses a run mixing a unit of accounts with a context of resources, before reading anything', async () => {
    stage({ contexts: [unit(), unit({ id: UNIT2, displayName: 'SAP', targetType: 'Resource' })] });
    const result = await report.run({ contexts: `${UNIT},${UNIT2}` }, {});
    expect(result.rows).toEqual([]);
    expect(result.notices).toContainEqual(expect.objectContaining({
      severity: 'warning', text: expect.stringMatching(/^Pick contexts of one kind/),
    }));
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('a name shared by an application and a unit of accounts', () => {
  const app = (over) => unit({ id: UNIT2, displayName: 'SAP', targetType: 'Resource', contextType: 'LogicalApplication', ...over });

  it('runs on the application, not refused as a mix, and says the unit was set aside', async () => {
    stage({ contexts: [unit({ displayName: 'SAP' }), app()] });
    const result = await report.run({ contexts: 'sap' }, {});
    const text = noticeText(result);
    expect(text).not.toMatch(/Pick contexts of one kind/);
    // The resource reads ran: the empty text is the resource context's.
    expect(text).toMatch('"SAP" has no resources as members');
    expect(text).not.toMatch(/no members holding/);
    expect(text).toMatch(/^"SAP" names both an application .* this report uses the resources\./m);
    expect(sqlOf(HELD_SQL)).toBeUndefined();
  });

  it('keeps a unit of accounts asked for by its id, even when an application shares its name', () => {
    const contexts = [unit({ displayName: 'SAP' }), app()];
    expect(preferResourceContexts([UNIT.toUpperCase(), 'SAP'], contexts))
      .toEqual({ contexts, preferred: [] });
  });

  it('drops only the shadowed unit; another unit and a name with no application stay', () => {
    const other = unit({ id: '55555555-5555-5555-5555-555555555555', displayName: 'Finance accounts' });
    const shadowed = unit({ displayName: 'Sap' });
    const out = preferResourceContexts(['sap', 'finance accounts'], [shadowed, app(), other]);
    expect(out.contexts.map(c => c.id)).toEqual([UNIT2, other.id]);
    expect(out.preferred).toEqual(['Sap']);
    // A run over the remaining two is still a mix, and still refused.
    expect(readsFor(out.contexts)).toBeNull();
  });

  it('changes nothing when every match is of one kind', () => {
    const contexts = [unit(), unit({ id: UNIT2, displayName: 'Audit accounts' })];
    expect(preferResourceContexts(['finance accounts', 'audit accounts'], contexts)).toEqual({ contexts, preferred: [] });
  });
});

describe('readsFor', () => {
  const kind = targetType => ({ targetType });

  it('reads members\' entitlements for accounts units and the members themselves for resource contexts', () => {
    const members = readsFor([kind('Principal'), kind('Principal')]);
    const resources = readsFor([kind('Resource')]);
    expect(members).not.toBe(resources);
    expect(members.countKey({ id: 'r', contextId: 'c' })).toBe(memberCountKey('c', 'r'));
    expect(resources.countKey({ id: 'r', contextId: 'c' })).toBe('r');
  });

  it('has no reads for a mix of kinds', () => {
    expect(readsFor([kind('Resource'), kind('Principal')])).toBeNull();
  });

  it('files a count under unit and resource together', () => {
    expect(memberCountKey('u1', 'r1')).toBe('u1|r1');
    expect(memberCountKey('u1', 'r1')).not.toBe(memberCountKey('u2', 'r1'));
  });
});
