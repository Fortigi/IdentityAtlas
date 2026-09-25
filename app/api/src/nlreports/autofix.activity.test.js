// Sign-in and guest corrections — the questions that failed live on 24 Sep
// 2026 ("guest accounts that have not signed in for 90 days"), and the
// readings that must NOT be touched.
import { describe, it, expect } from 'vitest';
import { businessRoleTypeWhenAsked, daysIn, guestsWhenAsked, isYesNoAboutPerson, listsEverythingOfPerson, notSignedInFor } from './autofix.activity.js';
import { validateSpec } from './spec.js';

const user = (conditions, extra = {}) => ({ entity: 'user', match: 'all', columns: [], conditions, ...extra });
const guest = { type: 'field', field: 'userType', op: 'eq', value: 'Guest' };
const stale = (n) => ({ type: 'field', field: 'daysSinceLastSignIn', op: 'gt', value: n });

describe('the window a question names', () => {
  it.each([
    ['de laatste 90 dagen', 90], ['for 30 days', 30], ['3 maanden', 90], ['two weeks', 14],
    ['een jaar', 365], ['a quarter', 90], ['half jaar', 183], ['sinds 1 week', 7],
  ])('reads "%s" as %i days', (text, days) => expect(daysIn(text)).toBe(days));

  it('finds nothing in a question without a window', () => {
    expect(daysIn('welke gasten zijn er')).toBeNull();
    expect(daysIn('accounts created in 2024')).toBeNull();
  });
});

describe('"not signed in for N days"', () => {
  it('replaces a reversed window: the model listed who DID sign in', () => {
    const wrong = user([guest, { type: 'field', field: 'lastSignIn', op: 'withinLastDays', value: 90 }]);
    const { spec, notes } = notSignedInFor(wrong, 'Welke gastaccounts hebben de laatste 90 dagen niet ingelogd?');
    expect(spec.conditions).toEqual([guest, stale(90)]);
    expect(notes[0]).toMatch(/not signed in for 90 days/);
  });

  it('replaces every sign-in condition, keeps the rest, and works in English', () => {
    const wrong = user([{ type: 'field', field: 'accountEnabled', op: 'eq', value: true },
      { type: 'field', field: 'lastSignIn', op: 'isEmpty' }, { type: 'field', field: 'signInDataCollected', op: 'isNotEmpty' }]);
    const { spec } = notSignedInFor(wrong, 'Which enabled users have not signed in for the last 30 days?');
    expect(spec.conditions).toEqual([{ type: 'field', field: 'accountEnabled', op: 'eq', value: true }, stale(30)]);
  });

  it('adds the condition when the model left sign-in out entirely', () => {
    const { spec } = notSignedInFor(user([guest]), "guests that haven't logged in for 6 months");
    expect(spec.conditions).toEqual([guest, stale(180)]);
  });

  it('"never signed in" is the empty last sign-in, for systems that report sign-ins', () => {
    const { spec, notes } = notSignedInFor(user([guest, { type: 'field', field: 'daysSinceLastSignIn', op: 'gt', value: 0 }]), 'gasten die nog nooit zijn ingelogd');
    expect(spec.conditions).toEqual([guest,
      { type: 'field', field: 'lastSignIn', op: 'isEmpty' }, { type: 'field', field: 'signInDataCollected', op: 'isNotEmpty' }]);
    expect(notes[0]).toMatch(/never signed in/);
  });

  it('does nothing when the definition already says exactly that', () => {
    const right = user([guest, stale(90)]);
    expect(notSignedInFor(right, 'guests not signed in for 90 days')).toEqual({ spec: right, notes: [] });
  });

  it('leaves a positive sign-in question, a windowless one, and a group report alone', () => {
    const recent = user([{ type: 'field', field: 'lastSignIn', op: 'withinLastDays', value: 7 }]);
    expect(notSignedInFor(recent, 'who signed in during the last 7 days?').spec).toBe(recent);
    const nowindow = user([guest]);
    expect(notSignedInFor(nowindow, 'gasten die niet zijn ingelogd').spec).toBe(nowindow);
    const group = { entity: 'group', match: 'all', conditions: [{ type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [stale(90)] }] };
    expect(notSignedInFor(group, 'groups with members not signed in for 90 days').spec).toBe(group);
  });

  it('produces a definition validation accepts', () => {
    const { spec } = notSignedInFor(user([]), 'users inactive for 90 days');
    expect(validateSpec(spec, {}, []).ok).toBe(true);
  });
});

describe('"guests" on a report of accounts', () => {
  it('adds userType Guest when the definition says nothing about the account type', () => {
    const { spec, notes } = guestsWhenAsked(user([stale(90)]), 'guest accounts that have not signed in for 90 days');
    expect(spec.conditions).toEqual([stale(90), guest]);
    expect(notes).toEqual(['Read "guests" as: accounts of type Guest.']);
  });

  it('works on an empty definition, and in Dutch', () => {
    expect(guestsWhenAsked(user([]), 'geef me alle gasten').spec.conditions).toEqual([guest]);
    expect(guestsWhenAsked(user([]), 'externe gebruikers').spec.conditions).toEqual([guest]);
  });

  it('keeps an "any" definition together under the new condition', () => {
    const a = { type: 'field', field: 'department', op: 'eq', value: 'HR' };
    const b = { type: 'field', field: 'department', op: 'eq', value: 'IT' };
    const { spec } = guestsWhenAsked(user([a, b], { match: 'any' }), 'guests in HR or IT');
    expect(spec.match).toBe('all');
    expect(spec.conditions).toEqual([{ type: 'group', match: 'any', conditions: [a, b] }, guest]);
  });

  it('leaves alone a definition that already says something about the type, and non-account reports', () => {
    const member = user([{ type: 'field', field: 'userType', op: 'neq', value: 'Guest' }]);
    expect(guestsWhenAsked(member, 'accounts that are not guests').spec).toBe(member);
    const already = user([guest]);
    expect(guestsWhenAsked(already, 'guests').spec).toBe(already);
    const group = { entity: 'group', match: 'all', conditions: [] };
    expect(guestsWhenAsked(group, 'groups with guests').spec).toBe(group);
    const plain = user([]);
    expect(guestsWhenAsked(plain, 'all users').spec).toBe(plain);
  });
});

describe('a yes/no question about one person', () => {
  it.each([
    'Heeft Bram de Groot de rol Global Administrator?',
    'does bram have global admin?',
    'Is Anna Visser a member of the finance group',
    'Kan je me vertellen of bram global admin heeft?',
    'Can you check whether anna is in the HR group?',
    'zit kees in de groep ACME - Algemeen - Partners',
  ])('recognises "%s"', (q) => expect(isYesNoAboutPerson(q)).toBe(true));

  it.each([
    'Welke groepen heeft bram?',
    'Which roles does anna have?',
    'is there a list of all guests',
    'Heeft bram alle rechten die anna heeft?',
    'wie heeft global admin',
    'guest accounts that have not signed in for 90 days',
    'Does anyone have global admin? show me who',
  ])('does not mistake "%s" for one', (q) => expect(isYesNoAboutPerson(q)).toBe(false));

  it('knows a definition that only names the person', () => {
    expect(listsEverythingOfPerson(user([{ type: 'field', field: 'displayName', op: 'contains', value: 'bram' }], { columns: ['displayName', 'memberOf.names'] }))).toBe(true);
    expect(listsEverythingOfPerson(user([{ type: 'field', field: 'id', op: 'eq', value: '@me' }]))).toBe(true);
    expect(listsEverythingOfPerson(user([{ type: 'field', field: 'displayName', op: 'contains', value: 'bram' },
      { type: 'relation', relation: 'access', quantifier: 'some', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Global Administrator' }] }]))).toBe(false);
    expect(listsEverythingOfPerson(user([]))).toBe(false);
    // every directory role of one person, the role asked about not named
    const bram = { type: 'field', field: 'displayName', op: 'contains', value: 'bram' };
    expect(listsEverythingOfPerson({ entity: 'resource', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' },
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [bram] }] })).toBe(true);
    expect(listsEverythingOfPerson({ entity: 'resource', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Global Administrator' },
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [bram] }] })).toBe(false);
    expect(listsEverythingOfPerson({ entity: 'resource', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' },
      { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [] }] })).toBe(false);
    expect(listsEverythingOfPerson({ entity: 'resource', match: 'all', conditions: [{ type: 'field', field: 'displayName', op: 'contains', value: 'Global Administrator' }] })).toBe(false);
  });
});

describe('"access packages" on a report of resources', () => {
  const me = { type: 'field', field: 'id', op: 'eq', value: '@me' };
  const members = { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [me] };
  const type = { type: 'field', field: 'resourceType', op: 'eq', value: 'BusinessRole' };

  it('adds the business-role type when the definition names no type: "in welke access packages zit ik"', () => {
    const { spec, notes } = businessRoleTypeWhenAsked({ entity: 'resource', match: 'all', conditions: [members] }, 'In welke access packages zit ik?');
    expect(spec.conditions).toEqual([members, type]);
    expect(notes).toHaveLength(1);
  });

  it('keeps an "any" definition together under the type, and reads the English words too', () => {
    const a = { type: 'field', field: 'displayName', op: 'contains', value: 'HR' };
    const b = { type: 'field', field: 'displayName', op: 'contains', value: 'IT' };
    const { spec } = businessRoleTypeWhenAsked({ entity: 'resource', match: 'any', conditions: [a, b] }, 'business roles for HR or IT');
    expect(spec.match).toBe('all');
    expect(spec.conditions).toEqual([{ type: 'group', match: 'any', conditions: [a, b] }, type]);
  });

  it('leaves alone a definition that names a type, other entities, and questions without the words', () => {
    const typed = { entity: 'resource', match: 'all', conditions: [{ type: 'field', field: 'resourceType', op: 'eq', value: 'EntraDirectoryRole' }] };
    expect(businessRoleTypeWhenAsked(typed, 'access packages that are directory roles').spec).toBe(typed);
    const user = { entity: 'user', match: 'all', conditions: [me] };
    expect(businessRoleTypeWhenAsked(user, 'in which access packages am I').spec).toBe(user);
    const plain = { entity: 'resource', match: 'all', conditions: [members] };
    expect(businessRoleTypeWhenAsked(plain, 'what do I have access to').spec).toBe(plain);
  });
});
