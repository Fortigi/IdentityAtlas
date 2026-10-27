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
  it('shows the grant with a glyph and words, and names the business roles behind it', () => {
    expect(cellLook({ cell: { type: 'Direct', viaRoles: ['br'] } })).toMatchObject({ glyph: '■', title: 'Direct · through 1 business role' });
    expect(cellLook({ cell: { type: 'Indirect', viaRoles: ['a', 'b'] } }).title).toBe('Indirect (through a group) · through 2 business roles');
    expect(cellLook({ cell: { type: 'Owner' } })).toMatchObject({ glyph: '•', title: 'Held' });
    expect(cellLook({ cell: null })).toBeNull();
  });

  it('shows a mark by its letter, and the impact when the overlay is on', () => {
    expect(cellLook({ cell: { type: 'Direct' }, mark: 'other' })).toMatchObject({ glyph: 'O', title: 'Direct — marked: Other context' });
    expect(cellLook({ cell: { type: 'Eligible' }, impact: 'covered', overlay: true }).title).toBe('Covered — observed, and the candidate would explain it (Eligible)');
    expect(cellLook({ cell: null, impact: 'gain', overlay: true })).toMatchObject({ glyph: '+' });
    expect(cellLook({ cell: { type: 'Direct' }, impact: null, overlay: true })).toMatchObject({ glyph: '■' });
  });
});

describe('draftReducer', () => {
  it('ignores an unknown action, and edits one candidate field', () => {
    const s = { candidate: { name: '' } };
    expect(draftReducer(s, { type: 'nope' })).toBe(s);
    expect(draftReducer(s, { type: 'edit', field: 'name', value: 'X' }).candidate.name).toBe('X');
  });
});
