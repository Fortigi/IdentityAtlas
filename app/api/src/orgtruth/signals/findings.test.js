import { describe, it, expect } from 'vitest';
import { computeFindings, monthsBetween, inactiveMark } from './findings.js';
import { familyIndex } from '../activity/family.js';

const SETTINGS = { inactiveAfterMonths: 6, statusAttribute: 'archief', inactiveValues: ['true', 'Ja'] };

describe('monthsBetween', () => {
  it('counts calendar months, across a year end', () => {
    expect(monthsBetween('2026-09-01', '2026-03-31')).toBe(6);
    expect(monthsBetween('2026-01-15', '2025-12-31')).toBe(1);
    expect(monthsBetween('2026-09-01', '2026-09-30')).toBe(0);
  });

  it('null without both dates', () => {
    expect(monthsBetween(null, '2026-01-01')).toBeNull();
    expect(monthsBetween('2026-01-01', null)).toBeNull();
  });
});

describe('inactiveMark', () => {
  it('matches trimmed and case-insensitively, in a list too, and returns the raw value', () => {
    expect(inactiveMark({ archief: ' TRUE ' }, SETTINGS)).toBe(' TRUE ');
    expect(inactiveMark({ archief: 'ja' }, SETTINGS)).toBe('ja');
    expect(inactiveMark({ archief: ['nee', 'Ja'] }, SETTINGS)).toEqual(['nee', 'Ja']);
    expect(inactiveMark({ archief: true }, SETTINGS)).toBe(true);
  });

  it('undefined for another value, a missing attribute, or no status attribute configured', () => {
    expect(inactiveMark({ archief: 'false' }, SETTINGS)).toBeUndefined();
    expect(inactiveMark({ archief: [null] }, SETTINGS)).toBeUndefined();
    expect(inactiveMark({}, SETTINGS)).toBeUndefined();
    expect(inactiveMark(null, SETTINGS)).toBeUndefined();
    expect(inactiveMark({ archief: 'true' }, { ...SETTINGS, statusAttribute: null })).toBeUndefined();
  });
});

describe('computeFindings', () => {
  // Ann: identity iA, accounts a1 (listed owner of Contoso) and a2. Bob b1, Cas c1, Dee d1.
  const family = familyIndex([{ principalId: 'a1', identityId: 'iA' }, { principalId: 'a2', identityId: 'iA' }]);
  const labels = new Map([['Principal:a1', { label: 'Ann Example' }], ['Principal:b1', { label: 'Bob Example' }], ['Principal:d1', { label: 'Dee Example' }]]);
  const entities = [
    { id: 'contoso', displayName: 'Contoso', attributes: { archief: 'false' } },
    { id: 'northwind', displayName: 'Northwind', attributes: { archief: 'true' } },
    { id: 'fabrikam', displayName: 'Fabrikam', attributes: {} },
    { id: 'tailspin', displayName: 'Tailspin', attributes: {} },
    { id: 'litware', displayName: 'Litware', attributes: { archief: 'Ja' } },
  ];
  const act = (subjectId, actorType, actorId, lastOn, total = 1) => ({ subjectId, actorType, actorId, lastOn, total, rowCount: 1 });
  const activity = [
    act('contoso', 'Identity', 'iA', '2026-09-01', 12),      // Ann via her identity: owner, active
    act('contoso', null, null, '2026-07-01'),                // unresolved: counts for Contoso only
    act('northwind', 'Principal', 'b1', '2026-04-01', 5),    // 5 months before asOf: active; Bob no member
    act('northwind', 'Principal', 'b1', '2026-02-01', 2),
    act('tailspin', 'Principal', 'd1', '2026-03-01', 3),     // exactly 6 months: inactive
  ];
  const members = [
    { orgEntityId: 'contoso', via: 'eigenaar', targetType: 'Principal', targetId: 'a1' },
    { orgEntityId: 'contoso', via: 'team', targetType: 'Principal', targetId: 'b1' },
    { orgEntityId: 'contoso', via: 'team', targetType: 'Principal', targetId: 'b1' },   // listed twice: once
    { orgEntityId: 'northwind', via: 'eigenaar', targetType: 'Principal', targetId: 'c1' }, // marked inactive: skipped
    { orgEntityId: 'tailspin', via: 'team', targetType: 'Principal', targetId: 'd1' },
  ];
  const { asOf, findings } = computeFindings({ entities, activity, members, family, labels, settings: SETTINGS });

  it('asOf is the latest activity date in the data, not today', () => {
    expect(asOf).toBe('2026-09-01');
  });

  it('inactive: never active first, then oldest; exactly N months is inactive; marked-inactive lists are left out', () => {
    expect(findings.inactive).toEqual([
      { entityId: 'fabrikam', label: 'Fabrikam', lastActivityOn: null, monthsSince: null },
      { entityId: 'tailspin', label: 'Tailspin', lastActivityOn: '2026-03-01', monthsSince: 6 },
    ]);
  });

  it('marked inactive but active within the period', () => {
    expect(findings.markedInactiveButActive).toEqual([{ entityId: 'northwind', label: 'Northwind', statusValue: 'true', lastActivityOn: '2026-04-01' }]);
  });

  it('active without membership: a resolved person, total over all their rows; an identity of a listed account is a member', () => {
    expect(findings.activeWithoutMembership).toEqual([
      { entityId: 'northwind', label: 'Northwind', actor: { targetType: 'Principal', targetId: 'b1', label: 'Bob Example' }, total: 7, lastOn: '2026-04-01' },
    ]);
  });

  it('member without activity: never (null) or not within the period, once per person and role; marked-inactive lists skipped', () => {
    expect(findings.memberWithoutActivity).toEqual([
      { entityId: 'contoso', label: 'Contoso', member: { targetType: 'Principal', targetId: 'b1', label: 'Bob Example' }, role: 'team', lastOn: null },
      { entityId: 'tailspin', label: 'Tailspin', member: { targetType: 'Principal', targetId: 'd1', label: 'Dee Example' }, role: 'team', lastOn: '2026-03-01' },
    ]);
  });

  it('a longer period makes the March activity count as active', () => {
    const r = computeFindings({ entities, activity, members, family, labels, settings: { ...SETTINGS, inactiveAfterMonths: 7 } });
    expect(r.findings.inactive.map(f => f.entityId)).toEqual(['fabrikam']);
    expect(r.findings.memberWithoutActivity.map(f => f.entityId)).toEqual(['contoso']);
  });

  it('without a status attribute nothing is marked: an inactive archived list shows up as inactive', () => {
    const r = computeFindings({ entities, activity, members, family, labels, settings: { ...SETTINGS, statusAttribute: null } });
    expect(r.findings.inactive.map(f => f.entityId)).toEqual(['fabrikam', 'litware', 'tailspin']);
    expect(r.findings.markedInactiveButActive).toEqual([]);
  });

  it('no activity at all: asOf null, every list inactive (never)', () => {
    const r = computeFindings({ entities: entities.slice(0, 1), activity: [], members: [], family, labels, settings: SETTINGS });
    expect(r).toEqual({ asOf: null, findings: {
      inactive: [{ entityId: 'contoso', label: 'Contoso', lastActivityOn: null, monthsSince: null }],
      markedInactiveButActive: [], activeWithoutMembership: [], memberWithoutActivity: [],
    } });
  });
});
