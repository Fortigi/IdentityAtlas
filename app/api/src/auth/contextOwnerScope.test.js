// The context-owner allow-list (auth/contextOwnerScope.js).
//
// Inputs are chosen so a subtly wrong rule gives a different answer: an id that
// differs from an in-scope one by its last character, the same path with a
// trailing slash or an extra segment, a list where only the LAST value is out of
// scope, and the report alias that the template would read in place of nothing.

import { describe, it, expect } from 'vitest';
import {
  ALLOW, DENY, CONTEXT_OWNER_DENIED, REPORT_EXPORT_PATH, UNIT_REPORT_EXPORT_PATH, SHELL_PATHS,
  contextOwnerVerdict, reportExportVerdict, requestedContexts, memberReferencesVerdict,
} from './contextOwnerScope.js';

const MINE = 'aaaaaaaa-0000-4000-8000-000000000001';
const VARIANT = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER = 'aaaaaaaa-0000-4000-8000-000000000003'; // differs from MINE in one digit
const scope = new Set([MINE, VARIANT]);

const get = (path, query = {}) => contextOwnerVerdict({ method: 'GET', path, query }, scope);

describe('contextOwnerVerdict — the shell', () => {
  it.each([...SHELL_PATHS])('allows GET %s', (path) => {
    expect(get(path)).toBe(ALLOW);
  });

  it('lists exactly the five shell reads', () => {
    expect([...SHELL_PATHS].sort()).toEqual([
      '/api/attribute-labels', '/api/auth-me', '/api/features', '/api/preferences', '/api/version',
    ]);
  });

  it('refuses a write to a shell path (PUT /api/preferences)', () => {
    expect(contextOwnerVerdict({ method: 'PUT', path: '/api/preferences' }, scope)).toBe(DENY);
  });
});

describe('contextOwnerVerdict — one context', () => {
  const shapes = [
    (id) => `/api/contexts/${id}`,
    (id) => `/api/contexts/${id}/members`,
    (id) => `/api/contexts/${id}/roles`,
    (id) => `/api/contexts/${id}/relationships`,
    (id) => `/api/contexts/${id}/claims`,
    (id) => `/api/contexts/${id}/timeline`,
    (id) => `/api/risk-scores/contexts/${id}`,
  ];

  it.each(shapes.map(s => [s(MINE)]))('allows %s for a held context', (path) => {
    expect(get(path)).toBe(ALLOW);
  });

  it.each(shapes.map(s => [s(VARIANT)]))('allows %s for a variant of a held context', (path) => {
    expect(get(path)).toBe(ALLOW);
  });

  it.each(shapes.map(s => [s(OTHER)]))('refuses %s for a context outside the scope', (path) => {
    expect(get(path)).toBe(DENY);
  });

  it.each([
    [`/api/contexts/${MINE}/`, 'trailing slash'],
    [`/api/contexts/${MINE}/roles/suggestion`, 'a deeper path (the best-guess read)'],
    [`/api/contexts/${MINE}/interviews`, 'the interviews, whose transcripts are the analyst\'s'],
    ['/api/contexts/claims/mentions', 'mentions across contexts'],
    [`/api/contexts/${MINE}/members/${OTHER}`, 'a member sub-resource'],
    [`/api/contexts/${MINE}x`, 'an id with a suffix'],
    [`/x/api/contexts/${MINE}`, 'a prefix'],
    [`/api/risk-scores/identities/${MINE}`, 'another entity type'],
    ['/api/contexts', 'the context list'],
    ['/api/contexts/tree', 'the tree'],
  ])('refuses %s (%s)', (path) => {
    expect(get(path)).toBe(DENY);
  });

  it('refuses every write to an in-scope context', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(contextOwnerVerdict({ method, path: `/api/contexts/${MINE}/roles` }, scope)).toBe(DENY);
    }
  });

  it('matches against the lower-cased path it is given, not a re-cased one', () => {
    // guardPath() lower-cases; an upper-case id would never reach here, and the
    // regex must not quietly accept one if it did.
    expect(get(`/api/contexts/${MINE.toUpperCase()}`)).toBe(DENY);
  });
});

describe('contextOwnerVerdict — everything else', () => {
  it.each([
    '/api/matrix', '/api/users', '/api/resources', '/api/identities', '/api/reports',
    '/api/reports/application-access-review/rows', '/api/reports/stale-accounts/export',
    '/api/reports/unit-members/rows', '/api/reports/unit-members/export/', '/api/reports/unit-members',
    '/api/admin/roles', '/api/admin/context-owner-access', '/api/matrix/shares/resolve', '/api/permissions',
  ])('refuses GET %s', (path) => {
    expect(get(path, { contexts: MINE })).toBe(DENY);
  });
});

describe('the references of a member', () => {
  const MEMBER = 'bbbbbbbb-0000-4000-8000-000000000004';
  const refs = (ctx, member = MEMBER) => `/api/contexts/${ctx}/members/${member}/references`;

  it('hands the member check to the caller when the context is in scope', () => {
    expect(get(refs(MINE))).toEqual({ allow: false, member: { contextId: MINE, memberId: MEMBER } });
    expect(get(refs(VARIANT))).toEqual({ allow: false, member: { contextId: VARIANT, memberId: MEMBER } });
  });

  it('refuses outright for a context outside the scope — no member check asked for', () => {
    expect(get(refs(OTHER))).toBe(DENY);
  });

  it('captures the member id exactly — an in-scope CONTEXT id in the member slot is just a member id', () => {
    expect(get(refs(OTHER, MINE))).toBe(DENY);
    expect(get(refs(MINE, OTHER))).toEqual({ allow: false, member: { contextId: MINE, memberId: OTHER } });
  });

  it.each([
    [`${refs(MINE)}/`, 'trailing slash'],
    [`/api/contexts/${MINE}/members/${MEMBER}`, 'the member without /references'],
    [`/api/contexts/${MINE}/members/${MEMBER}/references/x`, 'a deeper path'],
    [`/api/contexts/${MINE}/members/not-a-uuid/references`, 'a member id that is not a uuid'],
    [`/api/contexts/${MINE}/members/${MEMBER.toUpperCase()}/references`, 'an upper-case member id'],
  ])('refuses %s (%s)', (path) => {
    expect(get(path)).toBe(DENY);
  });

  it('refuses anything but GET', () => {
    expect(contextOwnerVerdict({ method: 'DELETE', path: refs(MINE) }, scope)).toBe(DENY);
  });

  it('is null (not its business) for any other path', () => {
    expect(memberReferencesVerdict(`/api/contexts/${MINE}/members`, scope)).toBeNull();
  });
});

describe('reportExportVerdict', () => {
  it('asks for a resolve check when every value is a context in scope', () => {
    expect(reportExportVerdict({ contexts: `${MINE},${VARIANT}` }, scope)).toEqual({ allow: false, resolve: [MINE, VARIANT] });
  });

  it('lower-cases and trims values, the way the report reads them', () => {
    expect(reportExportVerdict({ contexts: [` ${MINE.toUpperCase()} `] }, scope)).toEqual({ allow: false, resolve: [MINE] });
  });

  it('refuses when only the last of several values is out of scope', () => {
    expect(reportExportVerdict({ contexts: [MINE, VARIANT, OTHER] }, scope)).toBe(DENY);
  });

  it('refuses a context name, even one that might resolve to a held context', () => {
    expect(reportExportVerdict({ contexts: 'Finance' }, scope)).toBe(DENY);
  });

  it('refuses the `applications` alias even next to an in-scope `contexts`', () => {
    expect(reportExportVerdict({ contexts: MINE, applications: OTHER }, scope)).toBe(DENY);
    expect(reportExportVerdict({ applications: MINE }, scope)).toBe(DENY);
  });

  it.each([
    [{}, 'no parameter'],
    [{ contexts: '' }, 'an empty value'],
    [{ contexts: ' , ' }, 'only separators'],
    [{ contexts: { 0: MINE } }, 'an object'],
    [{ contexts: [MINE, 7] }, 'a non-string value in the list'],
  ])('refuses %j (%s)', (query) => {
    expect(reportExportVerdict(query, scope)).toBe(DENY);
  });

  it('is what contextOwnerVerdict answers on the export path', () => {
    expect(get(REPORT_EXPORT_PATH, { contexts: VARIANT, format: 'xlsx' })).toEqual({ allow: false, resolve: [VARIANT] });
    expect(get(REPORT_EXPORT_PATH, { contexts: OTHER, format: 'xlsx' })).toBe(DENY);
  });
});

describe('the unit report download', () => {
  it('is on the list as /api/reports/unit-members/export', () => {
    expect(UNIT_REPORT_EXPORT_PATH).toBe('/api/reports/unit-members/export');
  });

  it('asks for a resolve check when every unit named is in scope', () => {
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: `${MINE},${VARIANT}`, format: 'xlsx' })).toEqual({ allow: false, resolve: [MINE, VARIANT] });
  });

  it('refuses a unit out of scope, even the last of several', () => {
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: OTHER, format: 'xlsx' })).toBe(DENY);
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: [MINE, OTHER] })).toBe(DENY);
  });

  it('refuses a unit name, even one that might resolve to a held unit', () => {
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: 'Finance' })).toBe(DENY);
  });

  // The sub-units below an owner's unit need not be theirs: refused in any form,
  // even false, so no value reading of the flag can widen the report.
  it.each([['true'], ['1'], ['false'], [''], [['true']]])('refuses includeSubUnits=%j beside an in-scope unit', (value) => {
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: MINE, includeSubUnits: value })).toBe(DENY);
  });

  it('keeps each report to its own refused parameters', () => {
    // includeSubUnits means nothing to the Entitlement Pivot; applications nothing to the unit report.
    expect(get(REPORT_EXPORT_PATH, { contexts: MINE, includeSubUnits: 'true' })).toEqual({ allow: false, resolve: [MINE] });
    expect(get(UNIT_REPORT_EXPORT_PATH, { contexts: MINE, applications: OTHER })).toEqual({ allow: false, resolve: [MINE] });
  });

  it('refuses anything but GET', () => {
    expect(contextOwnerVerdict({ method: 'POST', path: UNIT_REPORT_EXPORT_PATH, query: { contexts: MINE } }, scope)).toBe(DENY);
  });
});

describe('requestedContexts', () => {
  it('splits a comma list and drops empties', () => {
    expect(requestedContexts('a, B ,,c')).toEqual(['a', 'b', 'c']);
  });
  it('takes a repeated parameter as given', () => {
    expect(requestedContexts(['A', 'b'])).toEqual(['a', 'b']);
  });
  it('returns null for anything that is not a string or a list of strings', () => {
    expect(requestedContexts(undefined)).toBeNull();
    expect(requestedContexts(5)).toBeNull();
    expect(requestedContexts(['a', null])).toBeNull();
  });
});

it('the refusal text names the rule', () => {
  expect(CONTEXT_OWNER_DENIED).toBe('Context owners can only open their own context');
});
