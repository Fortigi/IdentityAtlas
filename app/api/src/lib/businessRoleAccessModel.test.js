import { describe, it, expect } from 'vitest';
import { deriveAccessModel, ACCESS_MODEL_AGGREGATES } from './businessRoleAccessModel.js';

const NO = { inRule: false, inRequest: false, inAssigned: false, outRule: false, outReview: false, outExpiry: false, outManual: false };

describe('deriveAccessModel', () => {
  it.each([[null], [undefined], [{ policyCount: 0, inRule: true, outRule: true }]])('is Unknown both ways without policies (%j)', (row) => {
    expect(deriveAccessModel(row)).toEqual({ waysIn: ['Unknown'], waysOut: ['Unknown'] });
  });

  it.each([
    ['inRule', 'Rule'], ['inRequest', 'Request'], ['inAssigned', 'Assigned'],
  ])('%s alone gives the way in %s', (flag, way) => {
    expect(deriveAccessModel({ ...NO, policyCount: 1, [flag]: true }).waysIn).toEqual([way]);
  });

  it.each([
    ['outRule', 'Rule'], ['outReview', 'Review'], ['outExpiry', 'Expiry'], ['outManual', 'Manual'],
  ])('%s alone gives the way out %s', (flag, way) => {
    expect(deriveAccessModel({ ...NO, policyCount: 1, [flag]: true }).waysOut).toEqual([way]);
  });

  it('keeps every way when a role is requested and assigned, and lost by rule or review', () => {
    const model = deriveAccessModel({ ...NO, policyCount: 2, inRequest: true, inAssigned: true, outRule: true, outReview: true });
    expect(model).toEqual({ waysIn: ['Request', 'Assigned'], waysOut: ['Rule', 'Review'] });
  });

  it('separates a removal rule from a rule that hands the role out', () => {
    const model = deriveAccessModel({ ...NO, policyCount: 1, inRequest: true, outRule: true });
    expect(model.waysIn).toEqual(['Request']);
    expect(model.waysOut).toEqual(['Rule']);
  });

  it('says Unknown for a way in when policies state none', () => {
    expect(deriveAccessModel({ ...NO, policyCount: 1 }).waysIn).toEqual(['Unknown']);
  });

  it('has no way out when the policies state that nothing removes access', () => {
    expect(deriveAccessModel({ ...NO, policyCount: 1, inRequest: true }).waysOut).toEqual([]);
  });

  it('counts one stated "no" as stated', () => {
    expect(deriveAccessModel({ policyCount: 1, inRule: true, outReview: false }).waysOut).toEqual([]);
  });

  it('says Unknown for the way out when no policy states anything about it', () => {
    expect(deriveAccessModel({ policyCount: 1, inRule: true, outRule: null, outReview: null, outExpiry: null, outManual: null }).waysOut)
      .toEqual(['Unknown']);
  });

  it('does not read a truthy non-boolean as a way', () => {
    expect(deriveAccessModel({ ...NO, policyCount: 1, inRule: 'false' }).waysIn).toEqual(['Unknown']);
  });
});

describe('ACCESS_MODEL_AGGREGATES', () => {
  it.each([
    ['hasAutoAddRule', 'inRule'], ['allowsRequest', 'inRequest'], ['allowsDirectAssignment', 'inAssigned'],
    ['hasAutoRemoveRule', 'outRule'], ['hasAccessReview', 'outReview'], ['hasExpiration', 'outExpiry'], ['allowsRemovalRequest', 'outManual'],
  ])('maps %s to %s without turning NULL into false', (column, alias) => {
    expect(ACCESS_MODEL_AGGREGATES).toMatch(new RegExp(`BOOL_OR\\("${column}"\\)\\s+AS "${alias}"`));
    expect(ACCESS_MODEL_AGGREGATES).not.toMatch(/COALESCE/);
  });
});
