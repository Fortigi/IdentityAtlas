import { describe, it, expect } from 'vitest';
import { evidenceLine, knownNames, knowledgeGaps } from './workbench.labels';
import { draftReducer, activeDraft } from './useWorkbench';

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

describe('draftReducer — the proposed roles', () => {
  const run = (...actions) => actions.reduce(draftReducer, { selection: new Set(), anchor: null, marks: new Map(), drafts: [], activeId: null, viewRoleId: null, nextId: 1 });
  const shape = (s) => s.drafts.map(d => ({ id: d.id, name: d.name, base: d.baseBusinessRoleId, members: [...d.members], entitlements: [...d.entitlements] }));

  it('ignores an unknown action', () => {
    const s = run();
    expect(draftReducer(s, { type: 'nope' })).toBe(s);
  });

  it('makes a proposed role the first time something is added, and edits the active one', () => {
    const s = run({ type: 'addMembers', people: ['a'] }, { type: 'edit', field: 'name', value: 'Motor' });
    expect(shape(s)).toEqual([{ id: 'draft:1', name: 'Motor', base: null, members: ['a'], entitlements: [] }]);
    expect(activeDraft(s).id).toBe('draft:1');
    expect(activeDraft(run()).id).toBeNull();
  });

  it('keeps several proposed roles, each edited when it is the active one', () => {
    const role = { id: 'br', displayName: 'Handler', contains: ['r1'] };
    const s = run(
      { type: 'addMembers', people: ['a'] },
      { type: 'newCandidate' }, { type: 'addMembers', people: ['b'] },
      { type: 'fromRole', role, cellsByResource: new Map([['br', [{ person: 'c' }]]]) },
      { type: 'selectDraft', id: 'draft:1' }, { type: 'removeMember', person: 'a' },
    );
    expect(shape(s)).toEqual([
      { id: 'draft:1', name: 'Candidate 1', base: null, members: [], entitlements: [] },
      { id: 'draft:2', name: 'Candidate 2', base: null, members: ['b'], entitlements: [] },
      { id: 'draft:3', name: 'Handler', base: 'br', members: ['c'], entitlements: ['r1'] },
    ]);
    expect(s.activeId).toBe('draft:1');
  });

  it('removes a proposed role; the last remaining one becomes active, none when it was the only one', () => {
    const two = run({ type: 'newCandidate' }, { type: 'newCandidate' }, { type: 'selectDraft', id: 'draft:1' });
    expect(run().drafts).toEqual([]);
    const afterActive = draftReducer(two, { type: 'removeDraft', id: 'draft:1' });
    expect([afterActive.drafts.map(d => d.id), afterActive.activeId]).toEqual([['draft:2'], 'draft:2']);
    const afterOther = draftReducer(two, { type: 'removeDraft', id: 'draft:2' });
    expect(afterOther.activeId).toBe('draft:1');
    expect(draftReducer(afterActive, { type: 'removeDraft', id: 'draft:2' }).activeId).toBeNull();
  });

  it('opens an existing role read-only, and editing the active role closes it', () => {
    const s = run({ type: 'newCandidate' }, { type: 'viewRole', id: 'br' });
    expect(s.viewRoleId).toBe('br');
    expect(draftReducer(s, { type: 'closeRole' }).viewRoleId).toBeNull();
    expect(draftReducer(s, { type: 'addMembers', people: ['x'] }).viewRoleId).toBeNull();
    expect(draftReducer(s, { type: 'selectDraft', id: 'draft:1' }).viewRoleId).toBeNull();
  });

  it('adds only the entitlements of a selection to a rule-based role with a rule — its members follow the rule', () => {
    const cells = new Map([['i:a|r1', {}], ['i:b|r2', {}]]);
    const select = { type: 'select', keys: ['i:a|r1', 'i:b|r2'] };
    const ruled = run({ type: 'newCandidate' }, { type: 'setKind', kind: 'rule' }, { type: 'setRule', rule: { includeChildren: true, filters: {} } }, select, { type: 'addSelection', cellIndex: cells });
    expect(shape(ruled)[0]).toMatchObject({ members: [], entitlements: ['r1', 'r2'] });
    const byHand = run({ type: 'newCandidate' }, { type: 'setKind', kind: 'rule' }, select, { type: 'addSelection', cellIndex: cells });
    expect(shape(byHand)[0]).toMatchObject({ members: ['i:a', 'i:b'], entitlements: ['r1', 'r2'] });
  });

  it('starts the next role: a new one with its kind still to choose, the selection cleared', () => {
    const s = run({ type: 'newCandidate' }, { type: 'setKind', kind: 'rule' }, { type: 'select', keys: ['i:a|r1'] }, { type: 'startNext' });
    expect(s.drafts.map(d => [d.id, d.kind])).toEqual([['draft:1', 'rule'], ['draft:2', null]]);
    expect([s.activeId, s.selection.size]).toEqual(['draft:2', 0]);
  });

  it('resets everything', () => {
    expect(run({ type: 'newCandidate' }, { type: 'reset' })).toMatchObject({ drafts: [], activeId: null, nextId: 1 });
  });
});