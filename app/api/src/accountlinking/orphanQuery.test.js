// Unit tests for the shared orphan-account definition.
//
// The SQL itself is proven against real Postgres by the reports contract test;
// here we pin the contract both consumers rely on: which principal classes are
// excluded, that the anti-join is what selects orphans, and that a missing or
// unreadable linking config still yields usable rules.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/connection.js');
import { query, queryOne } from '../db/connection.js';
import { DEFAULT_RULES } from './defaultRules.js';
import { NON_HUMAN_PRINCIPAL_TYPES, fetchOrphanPrincipals, loadActiveLinkingRules } from './orphanQuery.js';

beforeEach(() => { query.mockReset(); queryOne.mockReset(); });

describe('fetchOrphanPrincipals', () => {
  it('selects principals with no IdentityMembers row, excluding the non-human types', async () => {
    query.mockResolvedValue({ rows: [] });
    await fetchOrphanPrincipals();

    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN "IdentityMembers"/);
    expect(sql).toMatch(/m\."principalId" IS NULL/);
    // The exclusion is a bound parameter, not an interpolated literal.
    expect(sql).toMatch(/<> ALL\(\$1::text\[\]\)/);
    expect(params).toEqual([NON_HUMAN_PRINCIPAL_TYPES]);
  });

  it('excludes exactly the three non-human principal classes', () => {
    expect(NON_HUMAN_PRINCIPAL_TYPES).toEqual(['ServicePrincipal', 'ManagedIdentity', 'AIAgent']);
  });

  it('joins Systems so each orphan carries its system name', async () => {
    query.mockResolvedValue({
      rows: [{ id: 'p1', displayName: 'Ada', email: 'ada@x', principalType: 'User', systemId: 1, systemName: 'Entra ID' }],
    });
    const rows = await fetchOrphanPrincipals();

    expect(query.mock.calls[0][0]).toMatch(/LEFT JOIN "Systems"/);
    expect(rows[0]).toMatchObject({ id: 'p1', systemName: 'Entra ID' });
  });
});

describe('loadActiveLinkingRules', () => {
  it('merges the stored active rules over the defaults', async () => {
    queryOne.mockResolvedValue({ rules: { accountTypeRules: [{ accountType: 'Bot', priority: 1, patterns: ['^bot-'] }] } });
    const rules = await loadActiveLinkingRules();

    expect(rules.accountTypeRules).toEqual([{ accountType: 'Bot', priority: 1, patterns: ['^bot-'] }]);
    // Untouched default keys survive the merge.
    for (const key of Object.keys(DEFAULT_RULES)) expect(rules).toHaveProperty(key);
    expect(queryOne.mock.calls[0][0]).toMatch(/"AccountLinkingConfig"[\s\S]*"isActive" = true/);
  });

  it('falls back to the defaults when no active config row exists', async () => {
    queryOne.mockResolvedValue(null);
    expect(await loadActiveLinkingRules()).toBe(DEFAULT_RULES);
  });

  it('falls back to the defaults when the config row has no rules payload', async () => {
    queryOne.mockResolvedValue({ rules: null });
    expect(await loadActiveLinkingRules()).toBe(DEFAULT_RULES);
  });

  it('falls back to the defaults when the config table is unreachable', async () => {
    queryOne.mockRejectedValue(new Error('relation "AccountLinkingConfig" does not exist'));
    expect(await loadActiveLinkingRules()).toBe(DEFAULT_RULES);
  });
});
