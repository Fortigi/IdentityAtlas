import { describe, it, expect } from 'vitest';
import { hiddenDetailKeys, detailEntries, detailLabel } from './ContextDetails.helpers';

const keys = (entries) => entries.map(([k]) => k);

const SYNCED = {
  id: 'c1', displayName: 'Contoso', description: 'd', variant: 'synced', targetType: 'Identity',
  contextType: 'Department', contextCategory: 'OrganizationalUnit', scopeSystemName: 'HR', scopeSystemId: 's1',
  parentContextId: 'p', parentDisplayName: 'Root', ownerUserId: 'u', ownerPrincipalId: 'p1', ownerDisplayName: 'Ann',
  sourceAlgorithmName: 'x', sourceRunId: 'r', ValidFrom: '2026', externalId: 'OU=Contoso', lastSyncedAt: '2026-10-01',
  userRenamed: false, userReparented: true, createdByUser: 'system-bootstrap',
};

describe('detailEntries — every attribute once', () => {
  it('a business reader gets only what the page does not say otherwise, no classification or bookkeeping', () => {
    expect(keys(detailEntries(SYNCED))).toEqual(['externalId', 'lastSyncedAt']);
  });

  it('an analyst also gets the raw classification and the bookkeeping flags, in stored order', () => {
    expect(keys(detailEntries(SYNCED, { analyst: true }))).toEqual([
      'variant', 'targetType', 'contextType', 'contextCategory', 'scopeSystemName',
      'sourceAlgorithmName', 'externalId', 'lastSyncedAt', 'userRenamed', 'userReparented', 'createdByUser',
    ]);
  });

  it('drops empty values and expands extendedAttributes after the core attributes, marked as extended', () => {
    const entries = detailEntries({ externalId: '', note: null, region: 'EU', extendedAttributes: { costCenter: 'CC-1', blank: '' } });
    expect(entries).toEqual([['region', 'EU'], ['costCenter', 'CC-1', { extended: true }]]);
  });

  it('ignores an extendedAttributes value that is not an object', () => {
    expect(keys(detailEntries({ extendedAttributes: 'raw', region: 'EU' }))).toEqual(['region']);
  });

  it('returns nothing for no context', () => {
    expect(detailEntries(null)).toEqual([]);
  });
});

describe('hiddenDetailKeys — what this page shows elsewhere', () => {
  it('hides the access counts only once the header prints them', () => {
    const counted = { resourceCount: 3, directAssignmentCount: 1, holderCount: 2 };
    expect(hiddenDetailKeys(counted).has('resourceCount')).toBe(true);
    expect(hiddenDetailKeys(counted).has('holderCount')).toBe(true);
    expect(hiddenDetailKeys({ directAssignmentCount: 1 }).has('directAssignmentCount')).toBe(false);
  });

  it('hides both member counts where the profile prints them', () => {
    const profiled = hiddenDetailKeys({ totalMemberCount: 12, directMemberCount: 4 }, { hasProfile: true, analyst: true });
    expect([profiled.has('totalMemberCount'), profiled.has('directMemberCount')]).toEqual([true, true]);
  });

  it('without a profile keeps the total for everyone and the direct count for the analyst only', () => {
    const analyst = hiddenDetailKeys({}, { analyst: true });
    expect([analyst.has('totalMemberCount'), analyst.has('directMemberCount')]).toEqual([false, false]);
    const reader = hiddenDetailKeys({});
    expect([reader.has('totalMemberCount'), reader.has('directMemberCount')]).toEqual([false, true]);
  });
});

describe('detailLabel', () => {
  it('says "Last updated" for the calculation stamp and splits other names', () => {
    expect(detailLabel('lastCalculatedAt')).toBe('Last updated');
    expect(detailLabel('externalId')).toBe('External Id');
  });
});
