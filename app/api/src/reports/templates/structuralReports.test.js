// The five structural audit templates.
//
// These need no activity data — they read facts the model already stores — so
// what is worth testing is the DEFINITION each encodes: which population it
// narrows to, which soft-deleted rows it excludes, and how it derives the
// judgement columns a reviewer acts on. The mocked db is SQL-blind, so the
// assertions are on the emitted predicates and the mapped rows.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import disabledWithAccess from './disabled-accounts-with-access.js';
import missingManagers from './missing-managers.js';
import privileged from './privileged-accounts.js';
import accessOutsideRoles from './access-outside-roles.js';
import emptyGroups from './empty-groups.js';

const sqlOf = (i = 0) => String(query.mock.calls[i][0]);

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe.each([
  ['disabled-accounts-with-access', disabledWithAccess],
  ['missing-managers', missingManagers],
  ['privileged-accounts', privileged],
  ['access-outside-roles', accessOutsideRoles],
  ['empty-groups', emptyGroups],
])('%s — shared template contract', (name, report) => {
  it('is a registered-shape list report with no required parameters', () => {
    expect(report).toMatchObject({ name, form: 'list' });
    expect(report.parametersSchema).toEqual({ type: 'object', required: [], properties: {} });
    expect(report.columns.length).toBeGreaterThan(0);
    expect(report.description.length).toBeGreaterThan(40);
  });

  it('returns no rows, and does not throw, on an empty database', async () => {
    const { rows } = await report.run({}, {});
    expect(rows).toEqual([]);
  });

  it('runs without a logger', async () => {
    await expect(report.run({}, undefined)).resolves.toBeTruthy();
  });
});

describe('disabled-accounts-with-access', () => {
  it('narrows to disabled accounts that still hold a live assignment', async () => {
    await disabledWithAccess.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain('p."accountEnabled" IS FALSE');
    // An INNER JOIN on assignments is what makes "with access" part of the
    // definition rather than a column you have to read.
    expect(sql).toMatch(/JOIN "ResourceAssignments" ra\s+ON ra\."principalId" = p\.id AND ra\."deletedAt" IS NULL/);
    expect(sql).toContain('p."deletedAt" IS NULL');
  });

  it('counts the assignments per account and sorts the worst first', async () => {
    await disabledWithAccess.run({}, {});
    expect(sqlOf()).toContain('COUNT(ra.*)::int AS "assignmentCount"');
    expect(sqlOf()).toContain('ORDER BY COUNT(ra.*) DESC');
  });

  it('maps every declared column and links the row to its account', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'p1', displayName: 'Alex Former', email: 'alex@example.com',
      principalType: 'User', systemName: 'Entra ID', assignmentCount: 2,
    }] });

    const { rows } = await disabledWithAccess.run({}, {});
    expect(rows[0]).toMatchObject({ displayName: 'Alex Former', assignmentCount: 2 });
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'p1' });
    for (const col of disabledWithAccess.columns) expect(rows[0]).toHaveProperty(col.key);
  });
});

describe('missing-managers', () => {
  it('excludes guests from the account half', async () => {
    await missingManagers.run({}, {});
    // An external collaborator has no manager in this tenant by design;
    // listing every one of them would bury the real finding.
    expect(sqlOf(0)).toContain(`COALESCE(p."extendedAttributes"->>'userType', 'Member') <> 'Guest'`);
    expect(sqlOf(0)).toContain('p."accountEnabled" IS TRUE');
    expect(sqlOf(0)).toContain(`p."principalType" = 'User'`);
  });

  it('asks the identity half about managerIdentityId, not managerId', async () => {
    await missingManagers.run({}, {});
    expect(sqlOf(1)).toContain('"Identities"');
    expect(sqlOf(1)).toContain('i."managerIdentityId" IS NULL');
  });

  it('labels each half and links it to its own kind of detail tab', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'p1', displayName: 'Anna Bakker', email: 'a@x.com', department: 'Sales', jobTitle: 'CEO' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'i1', displayName: 'Anna Bakker', email: 'a@x.com', department: 'Sales', jobTitle: 'CEO' }] });

    const { rows } = await missingManagers.run({}, {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ rowType: 'Account', _entity: { kind: 'user', id: 'p1' } });
    expect(rows[1]).toMatchObject({ rowType: 'Identity', _entity: { kind: 'identity', id: 'i1' } });
  });

  it('logs both halves separately', async () => {
    const log = vi.fn();
    await missingManagers.run({}, { log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/0 account\(s\)/));
  });
});

describe('privileged-accounts', () => {
  const row = (over) => ({
    id: 'p1', displayName: 'Bob Chen', email: 'bob@x.com',
    roleName: 'Global Administrator', assignmentType: 'Direct',
    identityName: 'Bob Chen', adminAccountCount: 1, ...over,
  });

  it('reads directory-role holders, keeping active and eligible apart', async () => {
    await privileged.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`r."resourceType" = 'EntraDirectoryRole'`);
    expect(sql).toContain(`ra."assignmentType" IN ('Direct', 'Eligible')`);
    // Collapsing them would hide standing privilege behind just-in-time.
    expect(sql).toContain('aa."assignmentType"');
  });

  it('counts an identity’s admin accounts from directory-role holders only', async () => {
    await privileged.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain('identity_admins AS');
    expect(sql).toContain('COUNT(DISTINCT im."principalId")::int AS "adminAccountCount"');
  });

  it('picks one identity per account, preferring the primary link', async () => {
    // IdentityMembers allows an account in two identities; without this the
    // report would duplicate the row and double-count the role.
    await privileged.run({}, {});
    expect(sqlOf()).toContain('ORDER BY im."isPrimary" DESC NULLS LAST');
    expect(sqlOf()).toContain('LIMIT 1');
  });

  it('flags an account belonging to no identity as a possible shared admin account', async () => {
    query.mockResolvedValue({ rows: [row({ identityName: null, adminAccountCount: 0 })] });
    const { rows } = await privileged.run({}, {});
    expect(rows[0].crossCheck).toBe('Not linked to an identity — possible shared admin account');
  });

  it('flags one person holding several admin accounts, with the count', async () => {
    query.mockResolvedValue({ rows: [row({ adminAccountCount: 2 })] });
    const { rows } = await privileged.run({}, {});
    expect(rows[0].crossCheck).toBe('Identity holds 2 admin accounts');
  });

  it('says nothing for the ordinary case — one identity, one admin account', async () => {
    query.mockResolvedValue({ rows: [row()] });
    const { rows } = await privileged.run({}, {});
    expect(rows[0].crossCheck).toBe('');
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'p1' });
  });
});

describe('access-outside-roles', () => {
  it('matches ungoverned Direct grants on resources a business role also grants', async () => {
    await accessOutsideRoles.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`ra."assignmentType" = 'Direct'`);
    expect(sql).toContain('ra."governed" IS NOT TRUE');
    expect(sql).toContain(`rr."relationshipType" = 'Contains'`);
    expect(sql).toContain(`br."resourceType" = 'BusinessRole'`);
  });

  it('collapses several granting roles into one row rather than repeating the account', async () => {
    await accessOutsideRoles.run({}, {});
    expect(sqlOf()).toContain('string_agg(DISTINCT br."displayName"');
  });

  it('maps the row, naming the roles that already grant the resource', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'p1', displayName: 'Lars Muller', email: 'lars@x.com',
      resourceName: 'SG-Servicedesk-Tools', resourceType: 'Group',
      businessRoles: 'BR-Service-Desk',
    }] });

    const { rows } = await accessOutsideRoles.run({}, {});
    expect(rows[0]).toMatchObject({ resourceName: 'SG-Servicedesk-Tools', businessRoles: 'BR-Service-Desk' });
    expect(rows[0]._entity).toEqual({ kind: 'user', id: 'p1' });
    expect(rows[0].notices).toBeUndefined();
  });

  it('explains an empty result when there are no business roles at all', async () => {
    // Otherwise "0 rows" reads as "no ungoverned access", which is the opposite
    // of the truth in a tenant with no governance data.
    queryOne.mockResolvedValue({ count: 0 });
    const { rows, notices } = await accessOutsideRoles.run({}, {});
    expect(rows).toEqual([]);
    expect(notices[0]).toMatchObject({ severity: 'info' });
    expect(notices[0].text).toMatch(/No business roles are loaded/);
  });

  it('stays quiet about governance when roles exist and simply nothing was found', async () => {
    queryOne.mockResolvedValue({ count: 7 });
    expect((await accessOutsideRoles.run({}, {})).notices).toEqual([]);
  });

  it('does not ask about business roles at all when it found rows', async () => {
    query.mockResolvedValue({ rows: [{ id: 'p1', displayName: 'X' }] });
    const { notices } = await accessOutsideRoles.run({}, {});
    expect(queryOne).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('survives the business-role count query returning nothing', async () => {
    queryOne.mockResolvedValue(null);
    const { notices } = await accessOutsideRoles.run({}, {});
    expect(notices[0].text).toMatch(/No business roles are loaded/);
  });
});

describe('empty-groups', () => {
  it('lists groups with no live assignment of any kind', async () => {
    await emptyGroups.run({}, {});
    const sql = sqlOf();
    expect(sql).toContain(`r."resourceType" = 'Group'`);
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM "ResourceAssignments" ra');
    expect(sql).toContain('r."deletedAt" IS NULL');
  });

  it('says that an owned-but-memberless group is still listed', async () => {
    // Ownership is a separate resource in this model, so the reading has to be
    // stated or the result looks like a bug.
    expect(emptyGroups.description).toMatch(/owners but no members is still listed/i);
  });

  it('links to the group detail tab and reduces the creation date to a day', async () => {
    query.mockResolvedValue({ rows: [{
      id: 'r1', displayName: 'SG-Project-Atlas', description: 'Never populated.',
      createdDateTime: new Date('2026-02-03T11:22:33.000Z'), systemName: 'Entra ID',
    }] });

    const { rows } = await emptyGroups.run({}, {});
    expect(rows[0]).toMatchObject({ displayName: 'SG-Project-Atlas', createdOn: '2026-02-03' });
    expect(rows[0]._entity).toEqual({ kind: 'group', id: 'r1' });
  });

  it('renders a missing creation date as null rather than dropping the group', async () => {
    query.mockResolvedValue({ rows: [{ id: 'r1', displayName: 'SG-X', createdDateTime: null }] });
    const { rows } = await emptyGroups.run({}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].createdOn).toBeNull();
  });
});
