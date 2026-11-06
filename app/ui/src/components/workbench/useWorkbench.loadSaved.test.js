import { describe, it, expect } from 'vitest';
import { draftReducer } from './useWorkbench';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const draft = (id, name) => ({ id, name, description: '', baseBusinessRoleId: null, members: new Set(), entitlements: new Set() });

const state = () => ({
  selection: new Set(['i:a|r1']), anchor: 'i:a|r1', marks: new Map([['i:a|r1', 'other']]),
  drafts: [draft('draft:1', 'A'), draft('draft:2', 'B')], activeId: 'draft:2', viewRoleId: 'br', nextId: 3,
});

describe('loadSaved', () => {
  it('after a save: the same proposed role stays open (by place), the selection stays, the ids are the saved ones', () => {
    const next = draftReducer(state(), { type: 'loadSaved', keep: true, marks: new Map(), drafts: [draft(S1, 'A'), draft(S2, 'B')] });
    expect(next.activeId).toBe(S2);
    expect(next.drafts.map(d => d.id)).toEqual([S1, S2]);
    expect(next.selection).toEqual(new Set(['i:a|r1']));
    expect(next.anchor).toBe('i:a|r1');
    expect(next.nextId).toBe(3);
    expect(next.viewRoleId).toBeNull();
    expect(next.marks).toEqual(new Map());
  });

  it('on opening one: its first proposed role is open, the selection is cleared, new names count on from its roles', () => {
    const next = draftReducer(state(), { type: 'loadSaved', keep: false, marks: new Map([['p:x|r2', 'investigate']]), drafts: [draft(S1, 'Saved')] });
    expect(next.activeId).toBe(S1);
    expect(next.selection).toEqual(new Set());
    expect(next.anchor).toBeNull();
    expect(next.nextId).toBe(2);
    expect(next.marks.get('p:x|r2')).toBe('investigate');
  });

  it('opening one without proposed roles leaves none open', () => {
    expect(draftReducer(state(), { type: 'loadSaved', keep: false, marks: new Map(), drafts: [] }).activeId).toBeNull();
    const none = { ...state(), activeId: null };
    expect(draftReducer(none, { type: 'loadSaved', keep: true, marks: new Map(), drafts: [draft(S1, 'A')] }).activeId).toBeNull();
  });
});
