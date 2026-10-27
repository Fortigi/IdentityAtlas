import { describe, it, expect } from 'vitest';
import { evidenceLine, knownNames, knowledgeGaps } from './workbench.labels';
import { cellLook } from './workbench.cells';
import { draftReducer } from './useWorkbench';

const src = { kind: 'interview', name: 'Marieke', fileName: 'i.txt', date: '2026-10-20' };

describe('evidenceLine', () => {
  it('says who proposed or decided it, the source and the unit', () => {
    expect(evidenceLine({ status: 'proposed', proposedBy: 'model', source: src, contextName: 'Claims' }))
      .toBe('Proposed by the model · interview with Marieke, 2026-10-20 · about Claims');
    expect(evidenceLine({ status: 'proposed', proposedBy: 'analyst', source: { kind: 'text', name: 'Ann', date: '2026-10-01' } }))
      .toBe('Proposed by an analyst · notes by Ann, 2026-10-01');
    expect(evidenceLine({ status: 'confirmed', decidedBy: 'ann@x', source: { kind: 'file', fileName: 'team.xlsx' } }))
      .toBe('Confirmed by ann@x · team.xlsx');
    expect(evidenceLine({ status: 'rejected', source: {} })).toBe('Rejected · a file');
    expect(evidenceLine({ status: 'edited', decidedBy: null })).toBe('Confirmed · a file');
  });
});

describe('knownNames / knowledgeGaps', () => {
  const people = [
    { knowledge: [{ kind: 'activity', name: 'B', state: 'confirmed' }, { kind: 'activity', name: 'A', state: 'proposed' }, { kind: 'duty', name: 'X', state: 'rejected' }] },
    { knowledge: [{ kind: 'duty', name: 'OR', state: 'disputed' }, { kind: 'activity', name: 'B', state: 'rejected' }] },
    {},
  ];

  it('lists the names in use per kind, sorted, without rejected ones', () => {
    expect(knownNames(people)).toEqual({ activity: ['A', 'B'], expertise: [], duty: ['OR'] });
  });

  it('counts people without an activity (a rejected one does not count) and the open links', () => {
    expect(knowledgeGaps(people)).toEqual({ noActivity: 2, proposed: 1, disputed: 1 });
    expect(knowledgeGaps(undefined)).toEqual({ noActivity: 0, proposed: 0, disputed: 0 });
  });
});

describe('cellLook', () => {
  it('shows the grant as the matrix badge, in words, with the business roles behind it', () => {
    expect(cellLook({ cell: { type: 'Direct', viaRoles: ['br'] } })).toEqual({ badge: 'Direct', sign: null, dim: false, title: 'Direct · through 1 business role' });
    expect(cellLook({ cell: { type: 'Indirect', viaRoles: ['a', 'b'] } }).title).toBe('Indirect (through a group) · through 2 business roles');
    expect(cellLook({ cell: { type: 'Owner' } })).toMatchObject({ badge: 'Owner', title: 'Held' });
    expect(cellLook({ cell: null })).toBeNull();
  });

  it('puts the analyst’s mark on top of the badge, and the impact instead when the overlay is on', () => {
    const marked = cellLook({ cell: { type: 'Direct' }, mark: 'other' });
    expect(marked).toMatchObject({ badge: 'Direct', title: 'Other context (marked) — Direct' });
    expect(marked.sign.glyph).toBe('O');
    const covered = cellLook({ cell: { type: 'Eligible' }, mark: 'other', impact: 'covered', overlay: true });
    expect(covered).toMatchObject({ badge: 'Eligible', title: 'Covered — observed, and the candidate would explain it — Eligible' });
    expect(covered.sign.glyph).toBe('✓');
    const gain = cellLook({ cell: null, impact: 'gain', overlay: true });
    expect(gain).toMatchObject({ badge: null, title: 'Potential gain — not observed, the candidate would add it — Not held' });
    expect(gain.sign.glyph).toBe('+');
  });

  it('fades the badge of someone outside the candidate, with no sign, and shows no impact without one', () => {
    expect(cellLook({ cell: { type: 'Direct' }, impact: 'held', overlay: true })).toMatchObject({ badge: 'Direct', sign: null, dim: true });
    expect(cellLook({ cell: { type: 'Direct' }, impact: null, overlay: true })).toMatchObject({ sign: null, dim: false, title: 'Direct' });
  });
});
describe('draftReducer', () => {
  it('ignores an unknown action, and edits one candidate field', () => {
    const s = { candidate: { name: '' } };
    expect(draftReducer(s, { type: 'nope' })).toBe(s);
    expect(draftReducer(s, { type: 'edit', field: 'name', value: 'X' }).candidate.name).toBe('X');
  });
});
