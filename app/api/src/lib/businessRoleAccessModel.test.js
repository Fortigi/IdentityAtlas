import { describe, it, expect } from 'vitest';
import { deriveAccessModel, deriveHowHeld, ACCESS_MODEL_AGGREGATES } from './businessRoleAccessModel.js';

describe('deriveHowHeld', () => {
  it('reads the way in from the policy behind the assignment', () => {
    expect(deriveHowHeld({ via: [{ inRule: true }], origin: 'Automatic' })).toEqual(['Rule']);
  });

  it('lists every way when someone holds the role through two policies', () => {
    expect(deriveHowHeld({ via: [{ inRequest: true }, { inAssigned: true }] })).toEqual(['Request', 'Assigned']);
  });

  it('uses the origin to pick the way when one policy allows two', () => {
    expect(deriveHowHeld({ via: [{ inRule: true, inRequest: true }], origin: 'Requested' })).toEqual(['Request']);
  });

  it('keeps both ways when the origin does not settle it', () => {
    expect(deriveHowHeld({ via: [{ inRequest: true, inAssigned: true }], origin: 'Automatic' })).toEqual(['Request', 'Assigned']);
    expect(deriveHowHeld({ via: [{ inRule: true, inRequest: true }] })).toEqual(['Rule', 'Request']);
  });

  it('does not narrow by origin across two policies', () => {
    expect(deriveHowHeld({ via: [{ inRule: true }, { inRequest: true }], origin: 'Automatic' })).toEqual(['Rule', 'Request']);
  });

  it.each([['Automatic', 'Rule'], ['Requested', 'Request']])('falls back to the origin %s without a policy', (origin, way) => {
    expect(deriveHowHeld({ via: null, origin })).toEqual([way]);
  });

  it('falls back to the origin when the policy states no way in', () => {
    expect(deriveHowHeld({ via: [{ inRule: false }], origin: 'Requested' })).toEqual(['Request']);
  });

  it.each([[{}], [undefined], [{ via: [], origin: 'Discovered' }]])('is Unknown for %j', (row) => {
    expect(deriveHowHeld(row)).toEqual(['Unknown']);
  });
});

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
