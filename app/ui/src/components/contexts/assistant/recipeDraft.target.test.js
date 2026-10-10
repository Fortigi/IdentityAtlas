// A context of users: the recipe fields a users draft carries, where each hand-picked id
// lands, and — the rule that matters most — that a resource draft is sent exactly as it was
// before users recipes existed.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ASSIGNMENT_TYPES, EMPTY_RECIPE, handPicked, lookupUrl, memberCountOf, memberUnit, orgRowAction, recipeTarget, saveBlocker,
  setObjectChoice, setOrgChoice, setPrincipalChoice, setTarget, toggleAssignmentType, viaText,
} from './recipeDraft';

const draft = (over = {}) => ({ ...EMPTY_RECIPE, terms: [{ text: 'contoso', key: 'contoso', state: 'accepted' }], ...over });

describe('recipeTarget', () => {
  it('reads only an explicit principal target as users; absent or resource is resources', () => {
    expect(recipeTarget({ target: 'principal' })).toBe('principal');
    expect(recipeTarget({ target: 'resource' })).toBe('resource');
    expect(recipeTarget({})).toBe('resource');
    expect(recipeTarget(null)).toBe('resource');
  });
});

describe('setTarget', () => {
  it('a users draft gets the target, Direct+Indirect access and empty hand-picked lists — and no orgTypes, so every collection type counts', () => {
    const users = setTarget(draft(), 'principal');
    expect(users).toEqual({
      ...draft(),
      target: 'principal',
      access: { assignmentTypes: ['Direct', 'Indirect'] },
      orgInclude: [], orgExclude: [], principalInclude: [], principalExclude: [],
    });
    expect('orgTypes' in users).toBe(false);
  });

  it('keeps what a saved users recipe already had', () => {
    const saved = draft({
      target: 'principal', access: { assignmentTypes: ['Eligible'] }, orgTypes: ['Klant'],
      orgInclude: ['o1'], orgExclude: ['o2'], principalInclude: ['u1'], principalExclude: ['u2'],
    });
    expect(setTarget(saved, 'principal')).toEqual(saved);
  });

  it('an empty access list falls back to the default rather than reaching nobody', () => {
    expect(setTarget(draft({ access: { assignmentTypes: [] } }), 'principal').access.assignmentTypes).toEqual(DEFAULT_ASSIGNMENT_TYPES);
  });

  it('switching back to resources strips every users field, byte for byte the draft it started as', () => {
    const start = draft({ include: ['g1'], exclude: ['g2'] });
    const round = setTarget(setOrgChoice(setTarget(start, 'principal'), 'o1', 'include'), 'resource');
    expect(JSON.stringify(round)).toBe(JSON.stringify(start));
  });

  it('leaves a resource draft untouched (same object) when it is already one', () => {
    const start = draft();
    expect(setTarget(start, 'resource')).toBe(start);
    // A single stray users field is still stripped.
    expect(setTarget({ ...start, orgTypes: ['Klant'] }, 'resource')).toEqual(start);
  });
});

describe('hand-picked lists', () => {
  const users = () => setTarget(draft(), 'principal');

  it('an organisation entity lands in orgInclude / orgExclude and nowhere else', () => {
    const inc = setOrgChoice(users(), 'o1', 'include');
    expect([inc.orgInclude, inc.orgExclude, inc.include, inc.principalInclude]).toEqual([['o1'], [], [], []]);
    const exc = setOrgChoice(inc, 'o1', 'exclude');
    expect([exc.orgInclude, exc.orgExclude]).toEqual([[], ['o1']]);
    expect(setOrgChoice(exc, 'o1', 'auto')).toMatchObject({ orgInclude: [], orgExclude: [] });
  });

  it('a user lands in principalInclude / principalExclude and nowhere else', () => {
    const exc = setPrincipalChoice(users(), 'u1', 'exclude');
    expect([exc.principalInclude, exc.principalExclude, exc.exclude, exc.orgExclude]).toEqual([[], ['u1'], [], []]);
    const inc = setPrincipalChoice(exc, 'u1', 'include');
    expect([inc.principalInclude, inc.principalExclude]).toEqual([['u1'], []]);
  });

  it('a resource still lands in include / exclude, on either target', () => {
    expect(setObjectChoice(users(), 'g1', 'exclude')).toMatchObject({ include: [], exclude: ['g1'], orgExclude: [], principalExclude: [] });
  });

  it('works on a list the draft does not carry yet', () => {
    expect(setPrincipalChoice(draft(), 'u1', 'include').principalInclude).toEqual(['u1']);
  });
});

describe('toggleAssignmentType', () => {
  const users = () => setTarget(draft(), 'principal');

  it('Eligible is added only when asked, and the order stays Direct, Indirect, Eligible', () => {
    expect(users().access.assignmentTypes).not.toContain('Eligible');
    const noDirect = toggleAssignmentType(users(), 'Direct');
    expect(noDirect.access.assignmentTypes).toEqual(['Indirect']);
    expect(toggleAssignmentType(toggleAssignmentType(noDirect, 'Eligible'), 'Direct').access.assignmentTypes)
      .toEqual(['Direct', 'Indirect', 'Eligible']);
  });

  it('never leaves the list empty', () => {
    const one = toggleAssignmentType(users(), 'Direct');
    expect(toggleAssignmentType(one, 'Indirect')).toBe(one);
  });

  it('starts from the default when the draft has no access yet', () => {
    expect(toggleAssignmentType(draft(), 'Eligible').access.assignmentTypes).toEqual(['Direct', 'Indirect', 'Eligible']);
  });
});

describe('counting', () => {
  const evaluation = { memberCount: 3, principals: { total: 41 } };

  it('memberCountOf counts resources for a resource draft and users for a users draft', () => {
    expect(memberCountOf(draft(), evaluation)).toBe(3);
    expect(memberCountOf(setTarget(draft(), 'principal'), evaluation)).toBe(41);
    expect(memberCountOf(setTarget(draft(), 'principal'), { memberCount: 3 })).toBe(0);
    expect(memberCountOf(draft(), null)).toBe(0);
  });

  it('memberUnit names what the header counts', () => {
    expect(memberUnit(draft())).toBe('objects');
    expect(memberUnit(setTarget(draft(), 'principal'))).toBe('users');
  });

  it('handPicked counts org entities and users only on a users draft', () => {
    const stray = draft({ include: ['g1'], orgInclude: ['o1'], principalInclude: ['u1', 'u2'] });
    expect(handPicked(stray)).toBe(1);
    expect(handPicked({ ...stray, target: 'principal' })).toBe(4);
  });

  it('a users draft with no terms can be saved on one organisation entity or one user picked by hand', () => {
    const bare = setTarget(draft({ name: 'Contoso users', terms: [] }), 'principal');
    expect(saveBlocker(bare, 5)).toBe('Keep at least one term, or include an object by hand.');
    expect(saveBlocker(setOrgChoice(bare, 'o1', 'include'), 5)).toBeNull();
    expect(saveBlocker(setPrincipalChoice(bare, 'u1', 'include'), 5)).toBeNull();
    // ...but a resource draft does not count a stray users list.
    expect(saveBlocker(draft({ name: 'x', terms: [], principalInclude: ['u1'] }), 5)).toBe('Keep at least one term, or include an object by hand.');
  });
});

describe('wording and requests', () => {
  it('viaText says how a user is reached', () => {
    expect(viaText({ kind: 'access', label: 'GRP-Contoso-Admins', assignmentType: 'Direct' })).toBe('member of GRP-Contoso-Admins');
    expect(viaText({ kind: 'access', label: 'GRP-Contoso-Admins', assignmentType: 'Indirect' })).toBe('member of GRP-Contoso-Admins · indirect');
    expect(viaText({ kind: 'access', label: 'Contoso Reader', assignmentType: 'Eligible' })).toBe('eligible for Contoso Reader');
    expect(viaText({ kind: 'org', entityType: 'Klant', label: 'Contoso' })).toBe('Klant Contoso');
    expect(viaText({ kind: 'org', entityType: 'Klant', label: 'Contoso', link: 'team' })).toBe('Klant Contoso · team');
  });

  it('orgRowAction offers exclude for a match, remove for one added by hand, put back for one excluded', () => {
    expect(orgRowAction('matched')).toEqual({ label: 'Exclude', choice: 'exclude' });
    expect(orgRowAction('included')).toEqual({ label: 'Remove', choice: 'auto' });
    expect(orgRowAction('excluded')).toEqual({ label: 'Put back', choice: 'auto' });
  });

  it('lookupUrl asks for users with kind=principal and for resources exactly as before', () => {
    expect(lookupUrl(' Ann Example ', 'principal')).toBe('/api/context-assistant/lookup?kind=principal&q=Ann%20Example');
    expect(lookupUrl(' ariba ')).toBe('/api/context-assistant/lookup?q=ariba');
    expect(lookupUrl(undefined)).toBe('/api/context-assistant/lookup?q=');
  });
});
