import { describe, it, expect } from 'vitest';
import { leftFlagText, factTitle, roleHistoryText, roleTitle, factClass, entitlementText } from './memberInterview.helpers';

const SRC = { intervieweeName: 'Piet de Vries', interviewedAt: '2026-10-01' };
const left = (over) => ({ membershipStatus: 'left', status: 'proposed', quote: 'Jan Smit just left the account', ...SRC, ...over });

describe('leftFlagText', () => {
  it('the status, then when: as said, else the period, else when it was said', () => {
    expect(leftFlagText(left({ periodText: 'last month' }))).toBe('Interview: left (last month)');
    expect(leftFlagText(left({ periodTo: '2026-09-30' }))).toBe('Interview: left (until 2026)');
    expect(leftFlagText(left({ membershipStatus: 'former' }))).toBe('Interview: former member (said 2026-10-01)');
  });
});

describe('factTitle', () => {
  it('the quote with its source, or the source alone', () => {
    expect(factTitle(left({}))).toBe('“Jan Smit just left the account” — interview with Piet de Vries, 2026-10-01');
    expect(factTitle(left({ quote: null }))).toBe('interview with Piet de Vries, 2026-10-01');
  });
});

describe('roles', () => {
  const role = {
    value: 'Lead architect', status: 'confirmed', quote: 'I lead it', ...SRC,
    history: [{ value: 'Junior', periodText: 'early years' }, { value: 'Lead architect', periodFrom: '2021-01-01', periodText: 'now' }],
  };

  it('the history oldest first, each with its period', () => {
    expect(roleHistoryText(role)).toBe('Junior (early years) → Lead architect (since 2021 (now))');
    expect(roleHistoryText(null)).toBe('');
  });

  it('the tooltip is the history when there is one, else the quote', () => {
    expect(roleTitle(role)).toBe(roleHistoryText(role));
    expect(roleTitle({ ...role, history: [role.history[1]] })).toBe('“I lead it” — interview with Piet de Vries, 2026-10-01');
  });
});

describe('factClass', () => {
  it('proposed reads dashed and italic; confirmed and edited plain', () => {
    expect(factClass('proposed')).toContain('border-dashed');
    expect(factClass('proposed')).toContain('italic');
    expect(factClass('confirmed')).toBe('');
    expect(factClass('edited')).toBe('');
  });
});

describe('entitlementText', () => {
  it('counts what is still held; none at zero; nothing for an unmatched name', () => {
    expect(entitlementText(1)).toBe('1 entitlement');
    expect(entitlementText(1234)).toBe('1,234 entitlements');
    expect(entitlementText(0)).toBe('none');
    expect(entitlementText(null)).toBeNull();
    expect(entitlementText(undefined)).toBeNull();
  });
});
