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

  // The live scope statistics read vw_UserPermissionAssignmentViaBusinessRole,
  // which since migration 061 has a second arm: holding a business role is
  // itself governed access. The as-of path rebuilds that definition in SQL
  // rather than reading the view, so it needs the same arm — without it the
  // latest timeseries point reported a lower governed count than live
  // scope-stats for the very same instant.
  it('counts a governance resource membership as governed in its own right (061 parity)', () => {
    const { sql } = build(EMPTY);
    const coverage = sql.slice(sql.indexOf('coverage AS ('), sql.indexOf('sp AS ('));

    // Arm 1 stays: coverage via the Contains relationship.
    expect(coverage).toContain('asof_contains');
    // Arm 2: the role's own cell, keyed on the assignment's own resource
    // (ga.rid) rather than a Contains child.
    expect(coverage).toMatch(/UNION/);
    expect(coverage).toMatch(/ga\.rid AS "groupId"/);
    // Both arms gate on the resource being a governance resource.
    expect(coverage.match(/governanceResource/g)).toHaveLength(2);
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
