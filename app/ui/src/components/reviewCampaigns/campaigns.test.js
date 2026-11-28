import { describe, it, expect } from 'vitest';
import {
  ALL_STEPS, DEFAULT_DUE_DAYS, STATUS_INFO, CAMPAIGN_STATUS,
  today, repeatText, scopeText, progressText, emptyForm, toggled, rolesInScope, formProblem, formBody, filterRoles,
  splitRequests, requestsHeadline, requestsByRole,
} from './campaigns';

const NOW = new Date('2026-11-27T22:30:00Z');
const OPTIONS = {
  roles: [
    { id: 'r1', displayName: 'Controller', portfolioId: 'P1', portfolioName: 'Finance roles', hasAccountable: true },
    { id: 'r2', displayName: 'Payroll clerk', portfolioId: 'p1', portfolioName: 'Finance roles', hasAccountable: false },
    { id: 'r3', displayName: 'Developer', portfolioId: 'p2', portfolioName: 'IT roles', hasAccountable: false },
    { id: 'r4', displayName: 'Loose role', portfolioId: null, portfolioName: null, hasAccountable: true },
  ],
  portfolios: [{ id: 'p1', displayName: 'Finance roles', roleCount: 2 }],
};
const form = (over = {}) => ({ ...emptyForm(NOW), name: 'Yearly', ...over });

describe('the words', () => {
  it('has a label for every status a request and a campaign can have', () => {
    expect(Object.keys(STATUS_INFO)).toEqual(['noFindings', 'findings', 'waiting', 'overdue', 'noAccountable']);
    expect(STATUS_INFO.noAccountable.label).toBe('Nobody to ask');
    expect(CAMPAIGN_STATUS).toEqual({ planned: 'Planned', running: 'Running', ended: 'Ended' });
  });

  it('says how often a campaign asks', () => {
    expect(repeatText(null)).toBe('Once');
    expect(repeatText(3)).toBe('Every quarter');
    expect(repeatText(12)).toBe('Every year');
    expect(repeatText(4)).toBe('Every 4 months');
  });

  it('says what a campaign is about', () => {
    expect(scopeText({ portfolioCount: 2, roleCount: 1 })).toBe('2 role portfolios, 1 business role');
    expect(scopeText({ portfolioCount: 1, roleCount: 0 })).toBe('1 role portfolio');
    expect(scopeText({ portfolioCount: 0, roleCount: 3 })).toBe('3 business roles');
    expect(scopeText({})).toBe('Nothing');
  });

  it('counts progress over the roles somebody can be asked about', () => {
    expect(progressText(null)).toBe('Not started');
    expect(progressText({ total: 5, reviewed: 2, noAccountable: 1 })).toBe('2 of 4 reviewed');
    expect(progressText({ total: 3, reviewed: 3, noAccountable: 0 })).toBe('3 of 3 reviewed');
  });
});

describe('the form', () => {
  it('starts with every step, nothing in scope, asking once from today', () => {
    expect(today(NOW)).toBe('2026-11-27');
    expect(emptyForm(NOW)).toEqual({ name: '', steps: ALL_STEPS, portfolioIds: [], roleIds: [], repeat: false, intervalMonths: 12, startsOn: '2026-11-27', dueDays: DEFAULT_DUE_DAYS });
    expect(emptyForm(NOW).steps).not.toBe(ALL_STEPS);
  });

  it('adds what is missing and removes what is there', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggled(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('finds the roles in scope: picked one by one or through a portfolio, each once, whatever the case of an id', () => {
    const scope = rolesInScope(form({ portfolioIds: ['p1'], roleIds: ['r1', 'R4'] }), OPTIONS);
    expect(scope.roles.map(r => r.id)).toEqual(['r1', 'r2', 'r4']);
    expect(scope.withoutAccountable.map(r => r.id)).toEqual(['r2']);
  });

  it('has nothing in scope for an empty form, or before the choices are loaded', () => {
    expect(rolesInScope(form(), OPTIONS)).toEqual({ roles: [], withoutAccountable: [] });
    expect(rolesInScope(form({ roleIds: ['r1'] }), undefined).roles).toEqual([]);
  });

  it('does not take a role without a portfolio for a member of one', () => {
    expect(rolesInScope(form({ portfolioIds: [''] }), OPTIONS).roles).toEqual([]);
  });

  it('names the first thing that is missing', () => {
    const ok = form({ roleIds: ['r1'] });
    expect(formProblem(ok)).toBeNull();
    expect(formProblem({ ...ok, name: '  ' })).toBe('Give the campaign a name');
    expect(formProblem({ ...ok, steps: [] })).toBe('Choose at least one step to review');
    expect(formProblem({ ...ok, roleIds: [] })).toBe('Choose at least one business role or role portfolio');
    expect(formProblem({ ...ok, roleIds: [], portfolioIds: ['p1'] })).toBeNull();
    expect(formProblem({ ...ok, startsOn: '' })).toBe('Choose the day the campaign starts');
    for (const dueDays of [0, 366, '', '1.5', 'soon']) {
      expect(formProblem({ ...ok, dueDays })).toBe('Give people between 1 and 365 days to review');
    }
    expect(formProblem({ ...ok, dueDays: '1' })).toBeNull();
    expect(formProblem({ ...ok, dueDays: 365 })).toBeNull();
  });

  it('sends the steps in their fixed order, the term as a number, and no interval when asking once', () => {
    expect(formBody(form({ name: ' Yearly ', steps: ['contents', 'ownership'], roleIds: ['r1'], portfolioIds: ['p1'], dueDays: '14' }))).toEqual({
      name: 'Yearly', steps: ['ownership', 'contents'], portfolioIds: ['p1'], roleIds: ['r1'], startsOn: '2026-11-27', intervalMonths: null, dueDays: 14,
    });
    expect(formBody(form({ repeat: true, intervalMonths: 3 })).intervalMonths).toBe(3);
  });

  it('filters the roles by name or portfolio, and keeps them all for no search', () => {
    expect(filterRoles(OPTIONS.roles, '')).toBe(OPTIONS.roles);
    expect(filterRoles(OPTIONS.roles, '  ')).toBe(OPTIONS.roles);
    expect(filterRoles(OPTIONS.roles, 'CLERK').map(r => r.id)).toEqual(['r2']);
    expect(filterRoles(OPTIONS.roles, 'it roles').map(r => r.id)).toEqual(['r3']);
    expect(filterRoles(OPTIONS.roles, 'nothing')).toEqual([]);
  });
});

describe('requests', () => {
  it('splits a round into who can be asked and the roles outside the campaign', () => {
    const requests = [{ id: 1, status: 'waiting' }, { id: 2, status: 'noAccountable' }, { id: 3, status: 'findings' }];
    expect(splitRequests(requests)).toEqual({ asked: [requests[0], requests[2]], outside: [requests[1]] });
    expect(splitRequests()).toEqual({ asked: [], outside: [] });
  });

  it('tells an asked person how many wait, how many are late and the first date', () => {
    expect(requestsHeadline([{ dueAt: '2026-12-10', overdue: false }])).toEqual({ what: '1 business role is waiting for your review', late: 0, firstDue: '2026-12-10' });
    expect(requestsHeadline([{ dueAt: '2026-11-01', overdue: true }, { dueAt: '2026-12-10', overdue: false }]))
      .toEqual({ what: '2 business roles are waiting for your review', late: 1, firstDue: '2026-11-01' });
    expect(requestsHeadline([]).firstDue).toBeNull();
  });

  it('shows a role two campaigns ask about once, with the request due soonest', () => {
    const requests = [{ id: 'q1', roleId: 'R1' }, { id: 'q2', roleId: 'r2' }, { id: 'q3', roleId: 'r1' }];
    expect(requestsByRole(requests).map(r => r.id)).toEqual(['q1', 'q2']);
  });
});
