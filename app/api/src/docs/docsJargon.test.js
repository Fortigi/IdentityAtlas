// What counts as retired vocabulary. Each banned spelling is paired with the
// nearest thing that must NOT match, because a pattern that is too greedy is as
// useless as one that never fires: it trains people to regenerate the baseline.

import { describe, it, expect } from 'vitest';
import { EXEMPT, TERMS, countTerms, exemptionFor, measureJargon, replacementFor } from './docsJargon.js';

describe('countTerms', () => {
  it('counts SOLL and IST as whole, upper-case words', () => {
    expect(countTerms('The SOLL view shows SOLL, the IST view the rest.')).toEqual({ SOLL: 2, IST: 1 });
  });

  it('does not find IST or SOLL inside other words, or in lower case', () => {
    // exIST / lIST / consIST / ISTIO / soll: none is the German jargon.
    expect(countTerms('exIST lIST consIST ISTIO ASSIST ist soll SOLLEN')).toEqual({});
  });

  it('finds the terms next to punctuation', () => {
    expect(countTerms('(IST/SOLL) "IST".')).toEqual({ SOLL: 1, IST: 2 });
  });

  it('counts a term inside a code fence exactly like one in prose', () => {
    const inProse = "Filter on assignmentType='Governed'.";
    const inFence = "```sql\nWHERE assignmentType='Governed'\n```";
    expect(countTerms(inProse)).toEqual({ "assignmentType 'Governed'": 1 });
    expect(countTerms(inFence)).toEqual({ "assignmentType 'Governed'": 1 });
  });

  it.each([
    ["assignmentType='Governed'"],
    ['assignmentType=Governed'],
    ['assignmentType = "Governed"'],
    ['"assignmentType": "Governed"'],
    ['`assignmentType` `Governed`'],
  ])('recognises the retired Governed type written as %s', text => {
    expect(countTerms(text)).toEqual({ "assignmentType 'Governed'": 1 });
  });

  it('keeps the governed FLAG and ordinary uses of the words legal', () => {
    expect(countTerms("governed=true; assignmentType='Direct'; a Governed assignment; the Owner of a group; assignmentType is governed by the source")).toEqual({});
  });

  it('tells the Owner type from the Governed type', () => {
    expect(countTerms("assignmentType='Owner' or assignmentType='Governed' or assignmentType='Owner'"))
      .toEqual({ "assignmentType 'Governed'": 1, "assignmentType 'Owner'": 2 });
  });

  it('does not read assignmentType Ownership-something as the Owner type', () => {
    expect(countTerms("assignmentType='OwnerOf'")).toEqual({});
  });

  it.each([
    ['OrgUnit'], ['OrgUnits'], ['org unit'], ['Org Units'], ['org-unit'], ['the `OrgUnits` table'],
  ])('finds the org-unit spelling %s', text => {
    expect(countTerms(text)).toEqual({ 'Org Unit': 1 });
  });

  it('leaves the orgUnitId column and other words alone', () => {
    expect(countTerms('orgUnitId, OrgUnitContext, organisational unit, org  chart')).toEqual({});
  });

  it('bans the singular OAuth2Grant type but not the SyncOAuth2Grants phase', () => {
    expect(countTerms('OAuth2Grant')).toEqual({ OAuth2Grant: 1 });
    expect(countTerms('SyncOAuth2Grants, OAuth2Grants, oauth2PermissionGrants')).toEqual({});
  });

  it('finds the other retired assignment types and the cmdlet', () => {
    expect(countTerms('AppRoleViaGroup, DirectoryRoleEligible; run Start-FGSync'))
      .toEqual({ AppRoleViaGroup: 1, DirectoryRoleEligible: 1, 'Start-FGSync': 1 });
  });

  it('does not ban the current resource types that share a stem', () => {
    expect(countTerms('AppRole, EntraDirectoryRole, DirectoryRole, Eligible')).toEqual({});
  });

  it('gives the same count on a second call (the patterns are global)', () => {
    // A /g regex used with .test() carries lastIndex between calls and skips
    // every other hit; counting twice catches that.
    expect(countTerms('SOLL SOLL')).toEqual({ SOLL: 2 });
    expect(countTerms('SOLL SOLL')).toEqual({ SOLL: 2 });
  });
});

describe('exemptionFor', () => {
  const exempt = { 'a/': true, 'b/page.md': ['SOLL'], 'c.md': true };

  it('exempts a listed page', () => {
    expect(exemptionFor('c.md', exempt)).toBe(true);
  });

  it('exempts every page under a folder, but not a sibling with the same prefix', () => {
    expect(exemptionFor('a/deep/x.md', exempt)).toBe(true);
    expect(exemptionFor('ab/x.md', exempt)).toEqual([]);
  });

  it('returns the term list of a partly exempt page', () => {
    expect(exemptionFor('b/page.md', exempt)).toEqual(['SOLL']);
  });

  it('exempts nothing on an unlisted page', () => {
    expect(exemptionFor('b/other.md', exempt)).toEqual([]);
  });
});

describe('measureJargon', () => {
  const pages = {
    'clean.md': 'Governed and non-governed access.',
    'dirty.md': 'SOLL and IST and SOLL',
    'security/audit.md': 'The report said SOLL.',
    'glossary.md': 'You may hear SOLL vs IST. Omada has org units.',
  };
  const exempt = { 'security/': true, 'glossary.md': ['SOLL', 'IST'] };
  const measure = () => measureJargon(Object.keys(pages), p => pages[p], exempt);

  it('lists only pages with hits, with a count per term', () => {
    expect(measure()['dirty.md']).toEqual({ SOLL: 2, IST: 1 });
    expect(measure()).not.toHaveProperty('clean.md');
  });

  it('skips a fully exempt page', () => {
    expect(measure()).not.toHaveProperty('security/audit.md');
  });

  it('skips only the exempt terms on a partly exempt page', () => {
    expect(measure()['glossary.md']).toEqual({ 'Org Unit': 1 });
  });
});

describe('the term list', () => {
  it('offers a replacement for every term', () => {
    for (const { term, use } of TERMS) expect(use, term).toMatch(/\S/);
    expect(replacementFor('SOLL')).toBe('governed');
    expect(replacementFor('not a term')).toBeUndefined();
  });

  it('exempts the assessments and the glossary note, as documented', () => {
    expect(exemptionFor('security/assessment.md')).toBe(true);
    expect(exemptionFor('ux/assessment.md')).toBe(true);
    expect(exemptionFor('start/glossary.md')).toEqual(['SOLL', 'IST']);
    expect(exemptionFor('concepts/governance-model.md')).toEqual([]);
    expect(Object.keys(EXEMPT)).toContain('architecture/design-archive.md');
  });
});
