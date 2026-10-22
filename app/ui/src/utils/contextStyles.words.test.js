import { describe, it, expect } from 'vitest';
import {
  memberKindLabel, memberKindNoun, contextTypeLabel, ruleSourcePhrase,
  sourceDescription, contextSubtitle,
} from './contextStyles';

describe('memberKindNoun — the kind of member in running text', () => {
  it('gives singular for one and plural otherwise, per kind', () => {
    expect(['Identity', 'Principal', 'Resource', 'System'].map(t => memberKindNoun(t, 1)))
      .toEqual(['person', 'account', 'resource', 'system']);
    expect(['Identity', 'Principal', 'Resource', 'System'].map(t => memberKindNoun(t, 3)))
      .toEqual(['people', 'accounts', 'resources', 'systems']);
    expect(memberKindNoun('Identity', 0)).toBe('people');
    expect(memberKindNoun('Identity')).toBe('people');
  });

  it('never builds a plural from the code ("identitys")', () => {
    for (const t of ['Identity', 'Principal']) {
      expect(memberKindNoun(t)).not.toBe(`${t.toLowerCase()}s`);
      expect(memberKindLabel(t).toLowerCase()).not.toBe(`${t.toLowerCase()}s`);
    }
  });

  it('falls back to member / members for an unknown kind', () => {
    expect(memberKindNoun('Gadget', 1)).toBe('member');
    expect(memberKindNoun(undefined)).toBe('members');
  });
});

describe('contextTypeLabel — the stored code in words', () => {
  it('maps the known codes whatever their casing', () => {
    expect(contextTypeLabel('MANAGERHIERARCHY')).toBe('Manager hierarchy');
    expect(contextTypeLabel('ManagerHierarchy')).toBe('Manager hierarchy');
    expect(contextTypeLabel('ADMINISTRATIVEUNIT')).toBe('Administrative unit');
    expect(contextTypeLabel('OrphanedAccounts')).toBe('Orphaned accounts');
    expect(contextTypeLabel('DEPARTMENT')).toBe('Department');
    expect(contextTypeLabel('cost_center')).toBe('Cost center');
  });

  it('splits an unknown code into Title Case words', () => {
    expect(contextTypeLabel('RiskyAppConsent')).toBe('Risky App Consent');
    expect(contextTypeLabel('entra_group-category')).toBe('Entra Group Category');
    expect(contextTypeLabel('HRDivision')).toBe('Hr Division');
    expect(contextTypeLabel('cluster')).toBe('Cluster');
  });

  it('says nothing for a missing code or one that names no kind of unit', () => {
    expect(contextTypeLabel(null)).toBe('');
    expect(contextTypeLabel('')).toBe('');
    expect(contextTypeLabel('Manual')).toBe('');
  });
});

describe('the source of a context in words', () => {
  const HR = { variant: 'synced', contextType: 'Department', scopeSystemName: 'Fortigi Demo HR' };
  const DEPT = { variant: 'generated', contextType: 'Department', sourceAlgorithmName: 'department-from-principal', scopeSystemName: 'Fortigi Demo EntraID' };
  const MGR = { variant: 'generated', contextType: 'ManagerHierarchy', sourceAlgorithmName: 'manager-hierarchy', scopeSystemName: 'Fortigi Demo EntraID' };
  // As the API sends it: the rule's display name next to its key.
  const DEPT_NAMED = { ...DEPT, sourceAlgorithmDisplayName: 'Department from Principal' };

  it('builds the subtitle sentence per source', () => {
    expect(contextSubtitle(HR)).toBe('Department · imported from Fortigi Demo HR');
    expect(contextSubtitle(DEPT_NAMED)).toBe('Department · derived by the Department from Principal rule');
    // Without a display name the rule is described by what it reads.
    expect(contextSubtitle(DEPT)).toBe('Department · derived from the department field on each account');
    expect(contextSubtitle({ ...MGR, contextType: 'Team' })).toBe('Team · derived from who reports to whom in Fortigi Demo EntraID');
    expect(contextSubtitle({ variant: 'manual', contextType: 'Department', createdByUser: 'system-bootstrap' }))
      .toBe('Department · created in Identity Atlas');
  });

  it('starts with a capital when there is no type, and is empty when nothing is known', () => {
    expect(contextSubtitle({ variant: 'manual', contextType: 'Manual' })).toBe('Created in Identity Atlas');
    expect(contextSubtitle({ variant: 'synced' })).toBe('Imported from a connected system');
    expect(contextSubtitle({})).toBe('');
    expect(sourceDescription(undefined)).toBe('');
  });

  it('names a rule without a phrase by its name, and never says plugin', () => {
    const km = { variant: 'generated', sourceAlgorithmName: 'kmeans', sourceAlgorithmDisplayName: 'K-Means Clustering', scopeSystemName: 'X' };
    expect(ruleSourcePhrase(km)).toBe('the rule "K-Means Clustering"');
    expect(ruleSourcePhrase({ sourceAlgorithmName: 'kmeans' })).toBe('the rule "kmeans"');
    expect(ruleSourcePhrase({})).toBe('a rule');
    // A system is only added where the rule's sentence wants it.
    expect(ruleSourcePhrase({ sourceAlgorithmName: 'manager-hierarchy' })).toBe('who reports to whom');
    expect(ruleSourcePhrase(DEPT)).toBe('the department field on each account');
    for (const a of [HR, DEPT, MGR]) expect(contextSubtitle(a)).not.toMatch(/plugin|crawl|analyst|variant|principal/i);
    // A rule with a display name is named by it, in rule wording, never "plugin".
    expect(contextSubtitle(km)).toBe('Derived by the K-Means Clustering rule');
    expect(contextSubtitle(DEPT_NAMED)).not.toMatch(/plugin/i);
  });
});
