import { describe, it, expect } from 'vitest';
import { matchSlot, parseCsvHeader, missingRequiredColumns } from './ConfigWizard.jsx';

describe('matchSlot', () => {
  it('matches an exact filename', () => {
    expect(matchSlot('Users.csv')).toBe('users');
  });

  it('is case-insensitive', () => {
    expect(matchSlot('USERS.CSV')).toBe('users');
  });

  it('tolerates separators (underscores/hyphens) in the uploaded filename', () => {
    expect(matchSlot('resource_relationships.csv')).toBe('resourceRelationships');
    expect(matchSlot('Identity-Members.csv')).toBe('identityMembers');
  });

  it('falls back to a loose substring match against the filename stem', () => {
    expect(matchSlot('MyUsers.csv')).toBe('users');
  });

  it('returns null for an unrecognized filename', () => {
    expect(matchSlot('RandomFile.txt')).toBeNull();
  });
});

describe('parseCsvHeader', () => {
  it('splits on the delimiter and trims', () => {
    expect(parseCsvHeader('ExternalId;DisplayName;Email', ';')).toEqual(['ExternalId', 'DisplayName', 'Email']);
    expect(parseCsvHeader('ExternalId, DisplayName', ',')).toEqual(['ExternalId', 'DisplayName']);
  });

  it('strips a leading BOM and surrounding double-quotes', () => {
    expect(parseCsvHeader('﻿"ExternalId";"DisplayName"', ';')).toEqual(['ExternalId', 'DisplayName']);
  });

  it('returns [] for an empty or missing line', () => {
    expect(parseCsvHeader('', ';')).toEqual([]);
    expect(parseCsvHeader(undefined, ';')).toEqual([]);
  });
});

describe('missingRequiredColumns', () => {
  it('reports required columns absent from the header (case-insensitive)', () => {
    expect(missingRequiredColumns(['externalid', 'displayname'], ['ExternalId', 'DisplayName'])).toEqual([]);
    expect(missingRequiredColumns(['ExternalId'], ['ExternalId', 'DisplayName'])).toEqual(['DisplayName']);
  });

  it('flags a mis-mapped file — e.g. a Users file dropped into the Assignments slot', () => {
    const usersHeader = parseCsvHeader('ExternalId;DisplayName;Email', ';');
    expect(missingRequiredColumns(usersHeader, ['ResourceExternalId', 'UserExternalId']))
      .toEqual(['ResourceExternalId', 'UserExternalId']);
  });

  it('treats an empty/absent header as missing every required column', () => {
    expect(missingRequiredColumns([], ['ExternalId'])).toEqual(['ExternalId']);
    expect(missingRequiredColumns(null, ['ExternalId'])).toEqual(['ExternalId']);
  });

  it('returns [] when there are no required columns', () => {
    expect(missingRequiredColumns(['Whatever'], [])).toEqual([]);
    expect(missingRequiredColumns(['Whatever'], undefined)).toEqual([]);
  });
});
