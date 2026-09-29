// Unit tests for the application-access-review report template.
//
// The db mock is SQL-blind, so the recordsets are dispatched on a fragment of
// each statement rather than on call order — the four reads run inside one
// Promise.all and an order-keyed mock would pass or fail on scheduling.
//
// The inputs are chosen to discriminate, not merely to execute: every section
// case is paired with the mutation that would break it (a requestable
// entitlement that is ALSO in a role, a "0" string that truthiness calls yes, a
// direct-only and an indirect-only entitlement with different numbers so a
// swapped column fails, percentages over 8 rows so a rounding change shows).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import report, {
  FREQUENCY_NOT_SET, MAX_APPLICATIONS, MAX_ROWS,
  SECTION_IN_ROLE, SECTION_NOT_REQUESTABLE, SECTION_REQUESTABLE,
  certificationFrequency, editDistance, groupOwners, isRequestable, nearDuplicateFrequencies,
  parseList, percentage, pickAttribute, sectionFor,
} from './application-access-review.js';

// ─── staging ──────────────────────────────────────────────────────────────

const APP_ID = '11111111-1111-1111-1111-111111111111';

const app = (over) => ({
  id: APP_ID,
  displayName: 'Ledger Engineering 0006',
  description: 'The general ledger.',
  ownerUserId: '10007339',
  ownerName: 'Ada Lovelace',
  ownerEmail: 'ada@example.com',
  extendedAttributes: {
    abbreviation: 'LE00006', cmdbReference: 'CI5505557',
    connectionType: 'SaaS', onboardingArea: 'Sector H', applicationOwner: '10007339',
  },
  ...over,
});

const ent = (id, over = {}) => ({
  id, displayName: `ENT_${id}`, appId: APP_ID,
  extendedAttributes: { requestable: 1, certfrequency: 'Annually', ...over },
});

// Each read is recognised by a fragment only that statement contains.
function stage({ apps = [app()], entitlements = [], counts = [], roles = [], owners = [], users = 0 }) {
  query.mockImplementation(async (sql) => {
    if (sql.includes('"contextType" = \'LogicalApplication\'')) return { rows: apps };
    if (sql.includes('"memberType" = \'Resource\'')) return { rows: entitlements };
    if (sql.includes('FILTER (WHERE d.t = \'Direct\')')) return { rows: counts };
    if (sql.includes('\'BusinessRole\'')) return { rows: roles };
    if (sql.includes('"parentResourceId" = ANY')) return { rows: owners };
    throw new Error(`unstaged query: ${sql.slice(0, 80)}`);
  });
  queryOne.mockResolvedValue({ users });
}

const run = (params = { applications: 'Ledger Engineering 0006' }) => report.run(params, {});
const noticeText = (result) => result.notices.map(n => n.text).join('\n');
const rowFor = (result, id) => result.rows.find(r => r.entitlement === `ENT_${id}`);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
});

// ─── the contract ─────────────────────────────────────────────────────────

describe('application-access-review — template contract', () => {
  it('is a list report parameterised by application, with the reviewable facts as columns', () => {
    expect(report).toMatchObject({ name: 'application-access-review', form: 'list' });
    expect(report.parametersSchema.required).toEqual(['applications']);
    expect(report.parametersSchema.properties.applications.type).toBe('array');
    // The five facts the owner decides on, plus the split that drives the
    // decision. A column dropped here is a column dropped from the export.
    expect(report.columns.map(c => c.key)).toEqual(expect.arrayContaining([
      'entitlement', 'section', 'requestable', 'certificationFrequency',
      'entitlementOwner', 'entitlementOwnerEmail', 'businessRoles',
      'directAssignments', 'viaRoleAssignments',
      'application', 'applicationDescription', 'applicationOwner',
      'abbreviation', 'cmdbReference', 'connectionType', 'onboardingSector', 'applicationManager',
    ]));
  });
});

// ─── the three sections ───────────────────────────────────────────────────

describe('application-access-review — sections', () => {
  it('puts each entitlement in exactly one of the three sections, role membership winning', async () => {
    stage({
      entitlements: [
        ent('a'),                                       // requestable, no role
        ent('b', { requestable: 0 }),                   // not requestable, no role
        ent('c'),                                       // requestable AND in a role
        ent('d', { requestable: 0 }),                   // not requestable AND in a role
      ],
      roles: [{ id: 'c', roles: 'Ledger Clerk' }, { id: 'd', roles: 'Ledger Clerk' }],
    });
    const result = await run();

    expect(rowFor(result, 'a').section).toBe(SECTION_REQUESTABLE);
    expect(rowFor(result, 'b').section).toBe(SECTION_NOT_REQUESTABLE);
    // The discriminating pair: 'c' is requestable, so a rule that checked
    // requestable first would put it in section 1.
    expect(rowFor(result, 'c').section).toBe(SECTION_IN_ROLE);
    expect(rowFor(result, 'c').requestable).toBe('Yes');
    expect(rowFor(result, 'd').section).toBe(SECTION_IN_ROLE);
  });

  it('orders the rows action-list first, then information, then role-managed', async () => {
    stage({
      entitlements: [ent('a'), ent('b', { requestable: 0 }), ent('c')],
      roles: [{ id: 'c', roles: 'Ledger Clerk' }],
    });
    const result = await run();
    expect(result.rows.map(r => r.section)).toEqual(
      [SECTION_REQUESTABLE, SECTION_NOT_REQUESTABLE, SECTION_IN_ROLE]);
  });

  it('names every role an entitlement belongs to, not just the first', async () => {
    stage({
      entitlements: [ent('a')],
      roles: [{ id: 'a', roles: 'Ledger Clerk, Ledger Supervisor' }],
    });
    const result = await run();
    expect(rowFor(result, 'a').businessRoles).toBe('Ledger Clerk, Ledger Supervisor');
    expect(rowFor(result, 'a').section).toBe(SECTION_IN_ROLE);
  });

  it('leaves the role column empty for an entitlement no role contains', async () => {
    stage({ entitlements: [ent('a')], roles: [{ id: 'other', roles: 'Ledger Clerk' }] });
    expect(rowFor(await run(), 'a').businessRoles).toBeNull();
  });
});

// ─── assignment counts ────────────────────────────────────────────────────

describe('application-access-review — assignment counts', () => {
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

  it('reports Eligible holders separately instead of folding them into either column', async () => {
    stage({
      entitlements: [ent('a')],
      counts: [{ id: 'a', direct: 2, indirect: 1, eligible: 7 }],
    });
    const result = await run();
    expect(rowFor(result, 'a')).toMatchObject({ directAssignments: 2, viaRoleAssignments: 1 });
    expect(noticeText(result)).toMatch(/7 holder\(s\) in scope are Eligible/);
  });

  it('says nothing about Eligible when there are none', async () => {
    stage({ entitlements: [ent('a')], counts: [{ id: 'a', direct: 2, indirect: 1, eligible: 0 }] });
    expect(noticeText(await run())).not.toMatch(/Eligible/);
  });
});

// ─── owners ───────────────────────────────────────────────────────────────

describe('application-access-review — entitlement owners', () => {
  it('shows the owner as a person, and leaves the columns empty when there is none', async () => {
    stage({
      entitlements: [ent('a'), ent('b')],
      owners: [{ id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'grace@example.com' }],
    });
    const result = await run();
    expect(rowFor(result, 'a')).toMatchObject({
      entitlementOwner: 'Grace Hopper', entitlementOwnerEmail: 'grace@example.com',
    });
    // "No owner" is the common case, so the row must still be complete.
    expect(rowFor(result, 'b')).toMatchObject({
      entitlementOwner: null, entitlementOwnerEmail: null, section: SECTION_REQUESTABLE,
    });
  });

  it('counts owners as people, not as ownership links', async () => {
    stage({
      entitlements: [ent('a'), ent('b'), ent('c')],
      owners: [
        { id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'grace@example.com' },
        { id: 'a', ownerId: 'p2', ownerName: 'Ada Lovelace', ownerEmail: 'ada@example.com' },
        { id: 'b', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'grace@example.com' },
      ],
    });
    const result = await run();
    // Three ownership links, two people, one entitlement with no owner at all.
    expect(noticeText(result)).toMatch(/2 distinct entitlement owner\(s\); 1 entitlement\(s\) have no owner/);
    expect(rowFor(result, 'a').entitlementOwner).toBe('Grace Hopper, Ada Lovelace');
  });
});

// ─── certification frequency ──────────────────────────────────────────────

describe('application-access-review — certification frequency', () => {
  it('shows a missing frequency as a value rather than a blank', async () => {
    stage({
      entitlements: [
        ent('a', { certfrequency: null }),
        ent('b', { certfrequency: '  ' }),
        ent('c', { certfrequency: undefined }),
        ent('d', { certfrequency: 'Quarterly' }),
      ],
    });
    const result = await run();
    for (const id of ['a', 'b', 'c']) {
      expect(rowFor(result, id).certificationFrequency).toBe(FREQUENCY_NOT_SET);
    }
    expect(rowFor(result, 'd').certificationFrequency).toBe('Quarterly');
  });

  it('shows dirty values exactly as stored and reports the near-duplicates', async () => {
    stage({
      entitlements: [
        ent('a', { certfrequency: 'Quarterly' }),
        ent('b', { certfrequency: 'Quaterly' }),
        ent('c', { certfrequency: 'Monthly' }),
        ent('d', { certfrequency: 'No certification' }),
      ],
    });
    const result = await run();
    // Not normalised: the owner who typed the misspelling has to see it.
    expect(rowFor(result, 'b').certificationFrequency).toBe('Quaterly');
    const text = noticeText(result);
    expect(text).toMatch(/near-duplicate spellings: "Quarterly" \/ "Quaterly"/);
    // …and Monthly vs No certification are NOT flagged as duplicates.
    expect(text).not.toMatch(/Monthly" \//);
  });

  it('raises no data-quality warning when the vocabulary is clean', async () => {
    stage({
      entitlements: [ent('a', { certfrequency: 'Monthly' }), ent('b', { certfrequency: 'Annually' })],
    });
    expect(noticeText(await run())).not.toMatch(/near-duplicate/);
  });
});

// ─── application context ──────────────────────────────────────────────────

describe('application-access-review — application context', () => {
  it('carries the application facts onto every row, so the export stands alone', async () => {
    stage({ entitlements: [ent('a')] });
    expect(rowFor(await run(), 'a')).toMatchObject({
      application: 'Ledger Engineering 0006',
      applicationDescription: 'The general ledger.',
      applicationOwner: 'Ada Lovelace',
      abbreviation: 'LE00006',
      cmdbReference: 'CI5505557',
      connectionType: 'SaaS',
      onboardingSector: 'Sector H',
      applicationManager: '10007339',
    });
  });

  it('falls back to the stored owner id when no account matches it', async () => {
    stage({ apps: [app({ ownerName: null, ownerEmail: null })], entitlements: [ent('a')] });
    expect(rowFor(await run(), 'a').applicationOwner).toBe('10007339');
  });

  it('reads the deployment-specific catalogue fields under either spelling', async () => {
    stage({
      apps: [app({ extendedAttributes: { onboardingSector: 'Sector A', cmdbreference: 'CI1', applicationManager: 'Ada' } })],
      entitlements: [ent('a')],
    });
    expect(rowFor(await run(), 'a')).toMatchObject({
      onboardingSector: 'Sector A', cmdbReference: 'CI1', applicationManager: 'Ada', abbreviation: null,
    });
  });
});

// ─── the summaries ────────────────────────────────────────────────────────

describe('application-access-review — summaries', () => {
  it('states all five summaries with the numbers the rows actually hold', async () => {
    // 8 entitlements: 2 in a role (25%), frequencies 4 Not set (50%),
    // 3 Annually (37.5%), 1 Monthly (12.5%) — chosen so a wrong denominator
    // or a dropped decimal shows up.
    const entitlements = [
      ent('a'), ent('b'), ent('c', { certfrequency: null }), ent('d', { certfrequency: null }),
      ent('e', { certfrequency: null }), ent('f', { certfrequency: null }),
      ent('g', { certfrequency: 'Monthly' }), ent('h'),
    ];
    stage({
      entitlements,
      roles: [{ id: 'a', roles: 'R1' }, { id: 'b', roles: 'R1' }],
      owners: [{ id: 'a', ownerId: 'p1', ownerName: 'Grace Hopper', ownerEmail: 'g@example.com' }],
      users: 1234,
    });
    const text = noticeText(await run());

    expect(text).toMatch(/1,234 unique user\(s\) hold at least one assignment in "Ledger Engineering 0006"/);
    expect(text).toMatch(/8 entitlement\(s\) in scope/);
    expect(text).toMatch(/1 distinct entitlement owner\(s\); 7 entitlement\(s\) have no owner/);
    expect(text).toMatch(/25% of entitlements are part of a business role \(2 of 8\)/);
    expect(text).toMatch(/Certification frequency: Not set 50%, Annually 37\.5%, Monthly 12\.5%/);
  });

  it('reports an application with no entitlements as empty rather than as a failure', async () => {
    stage({ entitlements: [] });
    const result = await run();
    expect(result.rows).toEqual([]);
    expect(noticeText(result)).toMatch(/has no entitlements loaded/);
    // No point counting assignments for an empty set.
    expect(queryOne).not.toHaveBeenCalled();
  });
});

// ─── parameters ───────────────────────────────────────────────────────────

describe('application-access-review — parameters', () => {
  it('runs nothing and explains itself when no application is named', async () => {
    const result = await report.run({}, {});
    expect(result.rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(noticeText(result)).toMatch(/Name one or more logical applications/);
  });

  it('warns about a name that matches no application', async () => {
    stage({ apps: [] });
    const result = await run({ applications: 'Ledger Engineering 0006, Typo Ledger' });
    expect(noticeText(result)).toMatch(/No logical application matches "Ledger Engineering 0006", "Typo Ledger"/);
    expect(result.rows).toEqual([]);
  });

  it('warns when one name matches several applications and includes them all', async () => {
    const second = '22222222-2222-2222-2222-222222222222';
    stage({
      apps: [app(), app({ id: second })],
      entitlements: [ent('a'), { ...ent('b'), appId: second }],
    });
    const result = await run();
    expect(noticeText(result)).toMatch(/match more than one logical application/);
    expect(result.rows).toHaveLength(2);
  });

  it('matches an application by id as well as by name', async () => {
    stage({ entitlements: [ent('a')] });
    const result = await run({ applications: APP_ID });
    expect(noticeText(result)).not.toMatch(/No logical application matches/);
    expect(result.rows).toHaveLength(1);
  });

  it('caps a run that would return more rows than one response should carry', async () => {
    const entitlements = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ent(String(i)));
    stage({ entitlements });
    const result = await run();
    expect(result.rows).toHaveLength(MAX_ROWS);
    expect(result.truncated).toBe(true);
    // Pinned to en-US: a notice that read "50.000" on a Dutch host and
    // "50,000" on an American one would be a host-dependent API response.
    expect(noticeText(result)).toMatch(`shows the first ${MAX_ROWS.toLocaleString('en-US')}`);
    expect(noticeText(result)).toMatch('shows the first 50,000');
  });

  it('does not claim truncation for a run that fits', async () => {
    stage({ entitlements: [ent('a')] });
    const result = await run();
    expect(result.truncated).toBe(false);
    expect(noticeText(result)).not.toMatch(/shows the first/);
  });
});

// ─── the pure rules ───────────────────────────────────────────────────────

describe('application-access-review — rules', () => {
  it('parses a list from either a comma string or an array, dropping blanks', () => {
    expect(parseList('a, b ,, c')).toEqual(['a', 'b', 'c']);
    expect(parseList(['a', ' b '])).toEqual(['a', 'b']);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList('')).toEqual([]);
  });

  it('caps the list, because the parameter is user input reaching a query', () => {
    const many = Array.from({ length: MAX_APPLICATIONS + 50 }, (_, i) => `app-${i}`);
    expect(parseList(many)).toHaveLength(MAX_APPLICATIONS);
    expect(parseList(many.join(','))).toHaveLength(MAX_APPLICATIONS);
    // The cap truncates, it does not empty — the first 500 are still answered.
    expect(parseList(many)[0]).toBe('app-0');
  });

  it('reads requestable out of every shape a source writes it in', () => {
    for (const yes of [true, 1, '1', 'true', 'Y', 'yes', ' TRUE ']) {
      expect(isRequestable(yes), String(yes)).toBe(true);
    }
    // '0' and 'false' are truthy strings: a bare `!!value` would pass them.
    for (const no of [false, 0, '0', 'false', '', null, undefined, 'maybe']) {
      expect(isRequestable(no), String(no)).toBe(false);
    }
  });

  it('never rewrites a stored frequency', () => {
    expect(certificationFrequency(' Quaterly ')).toBe('Quaterly');
    expect(certificationFrequency('No')).toBe('No');
    expect(certificationFrequency('')).toBe(FREQUENCY_NOT_SET);
    expect(certificationFrequency(null)).toBe(FREQUENCY_NOT_SET);
  });

  it('measures edit distance', () => {
    expect(editDistance('quarterly', 'quaterly')).toBe(1);
    expect(editDistance('annual', 'annually')).toBe(2);
    expect(editDistance('monthly', 'annually')).toBeGreaterThan(2);
    expect(editDistance('same', 'same')).toBe(0);
  });

  it('pairs only the spellings that are the same word twice', () => {
    expect(nearDuplicateFrequencies(['Quarterly', 'Quaterly', 'Monthly'])).toEqual(['"Quarterly" / "Quaterly"']);
    expect(nearDuplicateFrequencies(['Annually', 'annually'])).toEqual(['"Annually" / "annually"']);
    expect(nearDuplicateFrequencies(['Monthly', 'Annually', 'No certification'])).toEqual([]);
    // The report's own word for "unset" is not a stored spelling.
    expect(nearDuplicateFrequencies([FREQUENCY_NOT_SET, 'Not Applicable'])).toEqual([]);
  });

  it('rounds a percentage to one decimal and survives an empty denominator', () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(2, 3)).toBe(66.7);
    expect(percentage(1, 8)).toBe(12.5);
    expect(percentage(0, 0)).toBe(0);
  });

  it('picks the first catalogue spelling that carries a value', () => {
    expect(pickAttribute({ b: 'x' }, ['a', 'b'])).toBe('x');
    expect(pickAttribute({ a: '  ', b: 'x' }, ['a', 'b'])).toBe('x');
    expect(pickAttribute({ a: 0 }, ['a'])).toBe('0');
    expect(pickAttribute(null, ['a'])).toBeNull();
    expect(pickAttribute({}, ['a'])).toBeNull();
  });

  it('decides the section from role membership first', () => {
    expect(sectionFor({ roles: 'R1', requestable: true })).toBe(SECTION_IN_ROLE);
    expect(sectionFor({ roles: 'R1', requestable: false })).toBe(SECTION_IN_ROLE);
    expect(sectionFor({ roles: null, requestable: true })).toBe(SECTION_REQUESTABLE);
    expect(sectionFor({ roles: null, requestable: false })).toBe(SECTION_NOT_REQUESTABLE);
  });

  it('folds owner links into one entry per entitlement while keeping the people apart', () => {
    const grouped = groupOwners([
      { id: 'e1', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x' },
      { id: 'e1', ownerId: 'p2', ownerName: 'B', ownerEmail: null },
      { id: 'e2', ownerId: 'p1', ownerName: 'A', ownerEmail: 'a@x' },
    ]);
    expect(grouped.get('e1')).toEqual({ ownerName: 'A, B', ownerEmail: 'a@x', ownerIds: ['p1', 'p2'] });
    expect(grouped.get('e2').ownerIds).toEqual(['p1']);
    expect([...new Set([...grouped.values()].flatMap(o => o.ownerIds))]).toEqual(['p1', 'p2']);
  });
});
