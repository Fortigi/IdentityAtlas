// Unit tests for the unit report's claim cells — the wording of one person of
// the People overview. The reads and the rows are covered through the template
// (templates/unit-members.test.js); these pin the branches a whole run rarely
// reaches. Invented people throughout.

import { describe, it, expect } from 'vitest';
import {
  STATUS_WORDS, basisClaim, claimCells, groupByContext, roleText, sourceText, statusText, summaryEntries, unitSummary,
} from './unitClaims.js';

const person = over => ({
  status: 'current', claims: [], decision: null, role: null, left: null, rejoined: null, ...over,
});
const fact = (claimId, status = 'confirmed', value = 'Architect') => ({ claimId, status, value });

describe('sourceText', () => {
  it('names an interview, a file and notes in their own words, an unknown kind as an interview', () => {
    const base = { intervieweeName: 'Ilse Interviewer', interviewedAt: '2026-10-01', fileName: 'team.xlsx' };
    expect(sourceText({ ...base, sourceKind: 'interview' })).toBe('interview with Ilse Interviewer, 2026-10-01');
    expect(sourceText({ ...base })).toBe('interview with Ilse Interviewer, 2026-10-01');
    expect(sourceText({ ...base, sourceKind: 'file' })).toBe('file team.xlsx, 2026-10-01');
    expect(sourceText({ ...base, sourceKind: 'text' })).toBe('notes added by Ilse Interviewer, 2026-10-01');
  });
});

describe('statusText', () => {
  it('is empty for a person nobody said anything about, and the overview\'s word otherwise', () => {
    expect(statusText(person())).toBeNull();
    expect(statusText(person({ status: 'leftDecided', decision: { by: 'a' } }))).toBe('Left (decided)');
    expect(Object.keys(STATUS_WORDS)).toEqual(['current', 'cameBack', 'notConfirmed', 'leftDecided', 'left']);
  });

  it('marks a status "(proposed)" only when an unreviewed claim decides it', () => {
    const proposed = { id: 'p', status: 'proposed' };
    const confirmed = { id: 'c', status: 'confirmed' };
    expect(statusText(person({ status: 'notConfirmed', claims: [proposed] }))).toBe('Not confirmed (proposed)');
    expect(statusText(person({ status: 'notConfirmed', claims: [proposed, confirmed] }))).toBe('Not confirmed');
    expect(statusText(person({ status: 'left', claims: [proposed], left: fact('p', 'proposed') }))).toBe('Left (proposed)');
    // A decision made it so: the decision is the review.
    expect(statusText(person({ status: 'left', claims: [proposed], left: fact('p', 'proposed'), decision: { by: 'a' } }))).toBe('Left');
    expect(statusText(person({ status: 'cameBack', claims: [proposed], rejoined: fact('p', 'proposed') }))).toBe('Came back (proposed)');
    expect(statusText(person({ status: 'cameBack', claims: [confirmed], rejoined: fact('c') }))).toBe('Came back');
    // Current comes from the list, whatever the claims' state.
    expect(statusText(person({ status: 'current', claims: [proposed] }))).toBe('Current');
  });
});

describe('roleText', () => {
  it('words the role, marks a proposed one, and adds the earlier stint of someone who came back', () => {
    expect(roleText(person())).toBeNull();
    expect(roleText(person({ role: fact('r') }))).toBe('Architect');
    expect(roleText(person({ role: fact('r', 'edited') }))).toBe('Architect');
    expect(roleText(person({ role: fact('r', 'proposed') }))).toBe('Architect (proposed)');
    const rejoined = { earlier: [{ value: 'junior' }, { value: 'medior' }] };
    expect(roleText(person({ status: 'cameBack', rejoined }))).toBe('earlier: Junior → Medior');
    expect(roleText(person({ status: 'cameBack', role: fact('r'), rejoined }))).toBe('Architect · earlier: Junior → Medior');
    // Only someone who came back has an earlier stint.
    expect(roleText(person({ status: 'current', role: fact('r'), rejoined }))).toBe('Architect');
    expect(roleText(person({ status: 'cameBack', role: fact('r'), rejoined: null }))).toBe('Architect');
  });
});

describe('basisClaim and claimCells', () => {
  const claims = [{ id: 'one', sourceKind: 'file', fileName: 'a.csv', interviewedAt: '2026-01-01' }, { id: 'two' }, { id: 'three' }];

  it('names the role\'s claim first, then the one about leaving, then coming back, then the first', () => {
    expect(basisClaim(person({ claims, role: fact('two'), left: fact('three') })).id).toBe('two');
    expect(basisClaim(person({ claims, left: fact('three'), rejoined: fact('two') })).id).toBe('three');
    expect(basisClaim(person({ claims, rejoined: fact('two') })).id).toBe('two');
    expect(basisClaim(person({ claims })).id).toBe('one');
    expect(basisClaim(person({ claims, role: fact('gone') })).id).toBe('one');
    expect(basisClaim(person())).toBeNull();
  });

  it('gives three empty cells without a person, and the three words with one', () => {
    expect(claimCells(null)).toEqual({ claimStatus: null, claimRole: null, claimSource: null });
    expect(claimCells(person({ claims, role: fact('one', 'proposed') }))).toEqual({
      claimStatus: 'Current', claimRole: 'Architect (proposed)', claimSource: 'file a.csv, 2026-01-01',
    });
    expect(claimCells(person({ decision: { by: 'a' }, status: 'leftDecided' }))).toEqual({
      claimStatus: 'Left (decided)', claimRole: null, claimSource: null,
    });
  });
});

describe('groupByContext', () => {
  it('groups the claims per context, then per person', () => {
    const rows = [
      { id: '1', contextId: 'u1', principalId: 'p1', holderId: 'p1' },
      { id: '2', contextId: 'u2', principalId: 'p1', holderId: 'p1' },
      { id: '3', contextId: 'u1', principalId: 'p1', holderId: 'p1' },
      { id: '4', contextId: 'u1', subjectName: 'Gerrit Nobody', holderId: null },
    ];
    const grouped = groupByContext(rows, 'principalId');
    expect([...grouped.keys()]).toEqual(['u1', 'u2']);
    expect(grouped.get('u1').get('principalId:p1').claims.map(c => c.id)).toEqual(['1', '3']);
    expect(grouped.get('u2').get('principalId:p1').claims.map(c => c.id)).toEqual(['2']);
    expect(grouped.get('u1').size).toBe(2);
  });
});

describe('unitSummary and summaryEntries', () => {
  it('counts the unit\'s own listed members, the not confirmed, the former and the proposed claims', () => {
    const members = [
      { contextId: 'u1' }, { contextId: 'u1' }, { contextId: 'u1', markedFormer: true }, { contextId: 'u2' },
    ];
    const known = [{ status: 'notConfirmed' }, { status: 'left' }, { status: 'leftDecided' }, { status: 'current' }, { status: 'cameBack' }];
    const claimRows = [
      { contextId: 'u1', status: 'proposed' }, { contextId: 'u1', status: 'confirmed' }, { contextId: 'u2', status: 'proposed' },
    ];
    const summary = unitSummary({ id: 'u1' }, members, known, claimRows);
    expect(summary).toEqual({ current: 3, former: 2, proposed: 1 });
    expect(summaryEntries(summary, { withProposed: true }).map(e => [e.label, e.value]).slice(1)).toEqual([
      ['Current members', 3], ['Former people', 2], ['Claims proposed (not reviewed)', 1],
    ]);
    expect(summaryEntries(summary, { withProposed: false }).map(e => e.label)).toEqual(['Org claim columns', 'Current members', 'Former people']);
  });
});
