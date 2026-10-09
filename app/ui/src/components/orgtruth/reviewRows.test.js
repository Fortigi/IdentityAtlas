import { describe, it, expect } from 'vitest';
import { groupReviewRows, toLinkCandidates, moveOptions, movePromptMessage, pickMoveOption } from './reviewRows';

const ALICE = { id: 'e1', entityType: 'Person', displayName: 'Alice Contoso' };
const PROJ = { id: 'e2', entityType: 'Project', displayName: 'Northwind Portal' };

function row(entity, linkId, confidence, label, extra = {}) {
  return {
    link: { id: linkId, confidence, status: 'proposed', signals: 'email,name', ...extra },
    entity,
    target: { targetType: 'Principal', id: `t-${linkId}`, label },
    candidates: [],
  };
}

describe('groupReviewRows', () => {
  it('groups per entity in API order and sorts candidates by confidence desc', () => {
    const groups = groupReviewRows([
      row(ALICE, 'l1', 40, 'alice.c'),
      row(PROJ, 'l3', 55, 'GRP-Portal'),
      row(ALICE, 'l2', 72, 'alice.contoso'),
    ]);
    expect(groups.map(g => g.entity.id)).toEqual(['e1', 'e2']);
    expect(groups[0].candidates.map(c => c.linkId)).toEqual(['l2', 'l1']);
    expect(groups[0].candidates[0]).toMatchObject({
      targetType: 'Principal', targetId: 't-l2', label: 'alice.contoso', confidence: 72, signals: ['email', 'name'], status: 'proposed',
    });
  });

  it('merges sibling candidates (flat or nested) and de-duplicates by link id', () => {
    const r = row(ALICE, 'l1', 40, 'alice.c');
    r.candidates = [
      { id: 'l1', targetType: 'Principal', targetId: 't-l1', label: 'dup', confidence: 40 },
      { id: 'l9', targetType: 'Principal', targetId: 't-l9', label: 'a.contoso', confidence: 61, signals: ['prefix'] },
      { link: { id: 'l8', confidence: 61 }, target: { targetType: 'Principal', id: 't-l8', label: 'Alice C' } },
    ];
    const [g] = groupReviewRows([r]);
    // l1 keeps the row's own label (first seen wins); the 61 tie sorts by label.
    expect(g.candidates.map(c => [c.linkId, c.label])).toEqual([['l9', 'a.contoso'], ['l8', 'Alice C'], ['l1', 'alice.c']]);
    expect(g.candidates[0].signals).toEqual(['prefix']);
  });

  it('skips rows without an entity and tolerates nulls', () => {
    expect(groupReviewRows([{ link: { id: 'x' } }, null])).toEqual([]);
    expect(groupReviewRows(undefined)).toEqual([]);
  });

  it('puts a candidate without confidence last and keeps the override', () => {
    const [g] = groupReviewRows([
      row(ALICE, 'l1', null, 'zed'),
      row(ALICE, 'l2', 0, 'amy', { analystOverride: 'rejected' }),
    ]);
    expect(g.candidates.map(c => c.linkId)).toEqual(['l2', 'l1']);
    expect(g.candidates[0].override).toBe('rejected');
    expect(g.candidates[1].confidence).toBeNull();
  });
});

describe('toLinkCandidates', () => {
  it('normalises the detail page links, best first, dropping rows without id', () => {
    const c = toLinkCandidates([
      { id: 'a', targetType: 'Resource', targetId: 'g1', label: 'GRP-A', confidence: 50, matchedField: 'displayName', matchedValue: 'GRP-A' },
      { id: 'b', targetType: 'Principal', targetId: 'u1', confidence: 95 },
      { targetType: 'Principal', targetId: 'u2' },
    ]);
    expect(c.map(x => x.linkId)).toEqual(['b', 'a']);
    expect(c[0].label).toBe('u1');
    expect(c[1]).toMatchObject({ matchedField: 'displayName', matchedValue: 'GRP-A' });
    expect(toLinkCandidates(null)).toEqual([]);
  });
});

describe('move helpers', () => {
  const cands = [
    { linkId: 'l1', targetType: 'Principal', targetId: 'u1', label: 'Alice', confidence: 80 },
    { linkId: 'l2', targetType: 'Principal', targetId: 'u2', label: 'Alicia', confidence: 60 },
    { linkId: 'l3', targetType: 'Resource', targetId: 'g1', label: 'GRP', confidence: 70 },
    { linkId: 'l4', targetType: 'Principal', targetId: null, label: 'nobody', confidence: 10 },
  ];

  it('offers the other candidates of the same target type that have a target', () => {
    expect(moveOptions(cands, 'l1').map(c => c.linkId)).toEqual(['l2']);
    expect(moveOptions(cands, 'l3')).toEqual([]);
    expect(moveOptions(cands, 'missing').map(c => c.linkId)).toEqual(['l1', 'l2', 'l3']);
    expect(moveOptions(null, 'l1')).toEqual([]);
  });

  it('numbers the options in the prompt', () => {
    expect(movePromptMessage([cands[1], { ...cands[0], confidence: null }]))
      .toBe('Move this link to which candidate? Type its number or its name.\n1. Alicia (60%)\n2. Alice');
  });

  it('picks by 1-based number or by name, case-insensitive', () => {
    const opts = [cands[0], cands[1]];
    expect(pickMoveOption('2', opts)).toBe(cands[1]);
    expect(pickMoveOption(' 1 ', opts)).toBe(cands[0]);
    expect(pickMoveOption('alicia', opts)).toBe(cands[1]);
    expect(pickMoveOption('3', opts)).toBeNull();
    expect(pickMoveOption('0', opts)).toBeNull();
    expect(pickMoveOption('Ali', opts)).toBeNull();
    expect(pickMoveOption('', opts)).toBeNull();
    expect(pickMoveOption(null, opts)).toBeNull();
  });
});
