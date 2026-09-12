// Unit tests for the orphaned-accounts report template.
//
// Runs the real query helper + real classifier against a mocked db, so the
// whole chain the template owns — SQL parameters, account-type classification,
// row shape — executes. Whether the SQL is valid is the contract test's job.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../db/connection.js');
import { query, queryOne } from '../../db/connection.js';
import { NON_HUMAN_PRINCIPAL_TYPES } from '../../accountlinking/orphanQuery.js';
import report from './orphaned-accounts.js';

const principal = (over) => ({
  id: 'p1', displayName: 'Ada Lovelace', email: 'ada@example.com',
  principalType: 'User', extendedAttributes: {}, systemId: 1, systemName: 'Entra ID',
  ...over,
});

beforeEach(() => {
  query.mockReset();
  queryOne.mockReset();
  queryOne.mockResolvedValue(null); // no stored linking config → DEFAULT_RULES
});

describe('orphaned-accounts report template', () => {
  it('declares a list form with the five account columns', () => {
    expect(report).toMatchObject({ name: 'orphaned-accounts', form: 'list' });
    expect(report.columns.map(c => c.key)).toEqual(
      ['displayName', 'email', 'principalType', 'accountType', 'systemName']);
    expect(report.parametersSchema).toEqual({ type: 'object', required: [], properties: {} });
  });

  it("says in its description that nothing is linked before linking has run", () => {
    // AC 4: with no IdentityMembers at all every account is an orphan by
    // definition — the description must say so, or the result reads as a bug.
    expect(report.description).toMatch(/until account linking has run/i);
  });

  it('maps each orphan to the declared columns and links it to its user detail tab', async () => {
    query.mockResolvedValue({ rows: [principal()] });

    const { rows } = await report.run({}, {});

    expect(rows).toEqual([{
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      principalType: 'User',
      accountType: 'Secondary',
      systemName: 'Entra ID',
      _entity: { kind: 'user', id: 'p1' },
    }]);
    // Every declared column key is present on the row.
    for (const col of report.columns) expect(rows[0]).toHaveProperty(col.key);
  });

  it('excludes the non-human principal classes at the query, not in JS', async () => {
    query.mockResolvedValue({ rows: [] });
    await report.run({}, {});
    expect(query.mock.calls[0][1]).toEqual([NON_HUMAN_PRINCIPAL_TYPES]);
  });

  it('classifies each account with the active linking rules', async () => {
    queryOne.mockResolvedValue({
      rules: { accountTypeRules: [{ accountType: 'Admin', priority: 1, patterns: ['^adm-'] }] },
    });
    query.mockResolvedValue({
      rows: [
        principal({ id: 'p1', displayName: 'Ada (adm)', email: 'adm-ada@example.com' }),
        principal({ id: 'p2', displayName: 'Info Mailbox', email: 'info@example.com' }),
        principal({ id: 'p3', displayName: 'Guest Gail', email: 'gail@example.com', extendedAttributes: { userType: 'Guest' } }),
      ],
    });

    const { rows } = await report.run({}, {});
    expect(rows.map(r => r.accountType)).toEqual(['Admin', 'Secondary', 'Guest']);
  });

  it('returns no rows when every account is linked', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await report.run({}, {})).toEqual({ rows: [] });
  });

  it('renders missing account attributes as nulls rather than dropping the row', async () => {
    query.mockResolvedValue({ rows: [principal({ email: null, principalType: null, systemName: null })] });

    const { rows } = await report.run({}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: null, principalType: null, systemName: null });
  });

  it('logs the row count when a logger is supplied, and runs fine without one', async () => {
    query.mockResolvedValue({ rows: [principal(), principal({ id: 'p2' })] });

    const log = vi.fn();
    await report.run({}, { log });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/2 orphan account\(s\)/));

    await expect(report.run({}, undefined)).resolves.toBeTruthy();
  });
});
