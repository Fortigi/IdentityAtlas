import { describe, it, expect } from 'vitest';
import { getGroupStem } from './stem.js';

describe('getGroupStem', () => {
  it('returns empty for empty input', () => {
    expect(getGroupStem('')).toBe('');
    expect(getGroupStem(null)).toBe('');
    expect(getGroupStem(undefined)).toBe('');
  });

  it('passes through a plain name', () => {
    expect(getGroupStem('Finance')).toBe('finance');
  });

  it('strips a common prefix', () => {
    expect(getGroupStem('SG_Finance')).toBe('finance');
    expect(getGroupStem('DL-Finance')).toBe('finance');
    expect(getGroupStem('M365_Finance')).toBe('finance');
    expect(getGroupStem('GRP-Finance')).toBe('finance');
  });

  it('strips environment suffixes', () => {
    expect(getGroupStem('Finance_P')).toBe('finance');
    expect(getGroupStem('Finance_ACC')).toBe('finance');
    expect(getGroupStem('Finance_TST')).toBe('finance');
    expect(getGroupStem('Finance_PROD')).toBe('finance');
  });

  it('strips role suffixes', () => {
    expect(getGroupStem('Finance_Admins')).toBe('finance');
    expect(getGroupStem('Finance_Users')).toBe('finance');
    expect(getGroupStem('Finance_Beheer')).toBe('finance');
    expect(getGroupStem('Finance_Leden')).toBe('finance');
  });

  it('strips prefix + role suffix', () => {
    // Legacy order runs env-suffix before role-suffix (each once per side),
    // so a prefix/role combination like SG_Finance_Admins fully reduces…
    expect(getGroupStem('SG_Finance_Admins')).toBe('finance');
    // …but when env and role nest (e.g. _P_Admins), the role strip happens
    // last, leaving the env token behind. This is pre-existing behaviour
    // ported from the risk-scoring engine; callers should accept some
    // residual env tokens in cluster stems.
    expect(getGroupStem('SG_Finance_P_Admins')).toBe('finance-p');
    expect(getGroupStem('GRP-DomainAdmins-TST')).toBe('domainadmins');
  });

  it('normalises env-only variants to the same stem', () => {
    expect(getGroupStem('SG_DomainAdmins_P')).toBe(getGroupStem('GRP-DomainAdmins-TST'));
  });

  it('collapses internal separators and lowercases', () => {
    expect(getGroupStem('FinOps Team')).toBe('finops-team');
    expect(getGroupStem('Fin  Ops   Team')).toBe('fin-ops-team');
  });

  it('leaves unknown prefixes alone', () => {
    expect(getGroupStem('MyCustomPrefix_Finance')).toBe('mycustomprefix-finance');
  });
});
