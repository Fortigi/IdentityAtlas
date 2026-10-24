import { describe, it, expect } from 'vitest';
import { humanizeField, fieldLabel, formatMatchedOn, isExtendedSearchActive, MIN_EXTENDED_SEARCH_LENGTH } from './matchedOn';

describe('humanizeField', () => {
  it.each([
    ['mobilePhone', 'Mobile phone'],
    ['employeeId', 'Employee id'],
    ['onPremisesSamAccountName', 'On premises sam account name'],
    ['mail', 'Mail'],
    ['businessPhones2', 'Business phones2'],
  ])('%s → %s', (key, label) => {
    expect(humanizeField(key)).toBe(label);
  });

  it('leaves a key the source wrote with spaces, underscores or acronyms alone', () => {
    expect(humanizeField('CMDB Reference')).toBe('CMDB Reference');
    expect(humanizeField('SAP_ID')).toBe('SAP_ID');
    expect(humanizeField('extension_abc_sfTeamID')).toBe('extension_abc_sfTeamID');
    expect(humanizeField('ciID')).toBe('ciID');
  });
});

describe('fieldLabel', () => {
  it('a page label wins over everything', () => {
    expect(fieldLabel('email', { email: 'UPN' })).toBe('UPN');
    expect(fieldLabel('linkedAccount', { linkedAccount: 'Account' })).toBe('Account');
  });

  it('names an identity found through its accounts', () => {
    expect(fieldLabel('linkedAccount')).toBe('a linked account');
  });

  it('reads a dotted extendedAttributes path segment by segment', () => {
    expect(fieldLabel('employeeOrgData.costCenter')).toBe('Employee org data › Cost center');
  });
});

describe('formatMatchedOn', () => {
  it('joins every field', () => {
    expect(formatMatchedOn(['displayName', 'CMDB Reference'], { displayName: 'Name' })).toBe('Name, CMDB Reference');
  });

  it('is empty without fields', () => {
    expect(formatMatchedOn([])).toBe('');
    expect(formatMatchedOn(undefined)).toBe('');
    expect(formatMatchedOn('mobilePhone')).toBe('');
  });
});

describe('isExtendedSearchActive', () => {
  it(`needs the switch on AND at least ${MIN_EXTENDED_SEARCH_LENGTH} characters, like the API`, () => {
    expect(isExtendedSearchActive(true, 'abc')).toBe(true);
    expect(isExtendedSearchActive(true, ' ab ')).toBe(false);
    expect(isExtendedSearchActive(false, 'abcdef')).toBe(false);
    expect(isExtendedSearchActive(true, undefined)).toBe(false);
  });
});
