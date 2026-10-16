import { describe, it, expect } from 'vitest';
import { toLinkCandidates, moveOptions, movePromptMessage, pickMoveOption } from './reviewRows';

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

  it('reads a nested { link, target } row like a flat one, with signals, status and override', () => {
    const [c] = toLinkCandidates([{ link: { id: 'l8', confidence: '61', signals: 'email,name', status: 'proposed', analystOverride: 'rejected' },
      target: { targetType: 'Principal', id: 't-l8', label: 'Alice C' } }]);
    expect(c).toEqual({
      linkId: 'l8', targetType: 'Principal', targetId: 't-l8', label: 'Alice C', confidence: 61, signals: ['email', 'name'],
      status: 'proposed', override: 'rejected', matchedField: null, matchedValue: null,
    });
    expect(toLinkCandidates([{ id: 'z' }])[0]).toMatchObject({ label: '(unknown)', targetType: null, targetId: null, confidence: null, status: null, override: null });
  });

  it('puts a zero confidence above a missing one, and ties by label', () => {
    const c = toLinkCandidates([
      { id: 'l1', label: 'zed', confidence: null },
      { id: 'l2', label: 'amy', confidence: 0 },
      { id: 'l3', label: 'bob', confidence: 61 },
      { id: 'l4', label: 'abe', confidence: 61 },
    ]);
    expect(c.map(x => x.linkId)).toEqual(['l4', 'l3', 'l2', 'l1']);
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
