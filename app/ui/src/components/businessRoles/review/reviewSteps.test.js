import { describe, it, expect } from 'vitest';
import {
  STEP_INFO, VERDICT_INFO, HOLDERS_LOST_DAYS,
  stepLabel, verdictLabel, personKey, ownersOf, sameOwners, ownerChanges, emptyAnswers, stepProblem, buildBody,
  findingsCount, outcomeText, splitHolders,
} from './reviewSteps';

const ANN = { principalId: 'p-ann', displayName: 'Ann' };
const BOB = { principalId: 'p-bob', displayName: 'Bob' };
const CARLA = { identityId: 'i-carla', displayName: 'Carla' };
const snapshot = { owners: [
  { role: 'Accountable', ...ANN, identityId: null, derivedFrom: null },
  { role: 'Responsible', ...BOB, identityId: null },
  { role: 'Responsible', principalId: null, ...CARLA },
  { role: 'Responsible', principalId: null, identityId: null, displayName: 'Nameless' },
] };
const current = { accountable: ANN, responsible: [BOB, CARLA] };

describe('the words', () => {
  it('has a label, a question and help for each step, and a field only where a verdict asks for words', () => {
    for (const step of ['ownership', 'lifecycle', 'contents']) {
      expect(STEP_INFO[step].label).toBeTruthy();
      expect(STEP_INFO[step].question).toMatch(/\?$/);
      expect(STEP_INFO[step].help).toBeTruthy();
    }
    expect(VERDICT_INFO.good.remarkLabel).toBeUndefined();
    expect(VERDICT_INFO.needsChange.remarkLabel).toBe('What should change?');
    expect(VERDICT_INFO.notUnderstood.remarkLabel).toBe('What is your question?');
  });

  it('falls back to the raw value for a step or verdict it does not know', () => {
    expect(stepLabel('contents')).toBe('Permissions');
    expect(stepLabel('holders')).toBe('holders');
    expect(verdictLabel('notUnderstood')).toBe('Not understood');
    expect(verdictLabel('later')).toBe('later');
  });
});

describe('personKey', () => {
  it('tells an account from a person, whatever the case, and is null for nobody', () => {
    expect(personKey({ principalId: 'ABC' })).toBe('principal:abc');
    expect(personKey({ identityId: 'ABC' })).toBe('identity:abc');
    expect(personKey({ principalId: 'a', identityId: 'b' })).toBe('principal:a');
    expect(personKey(null)).toBeNull();
    expect(personKey({ displayName: 'Ann' })).toBeNull();
  });
});

describe('ownersOf', () => {
  it('reads the owners of a snapshot as people, leaving out a holder without an id', () => {
    expect(ownersOf(snapshot)).toEqual(current);
  });

  it('is nobody for a missing snapshot, and keeps a person without a name', () => {
    expect(ownersOf(null)).toEqual({ accountable: null, responsible: [] });
    expect(ownersOf({ owners: [{ role: 'Responsible', principalId: 'x' }] })).toEqual({ accountable: null, responsible: [{ principalId: 'x', displayName: null }] });
  });
});

describe('sameOwners', () => {
  it('is true for the same people in another order', () => {
    expect(sameOwners({ accountable: ANN, responsible: [CARLA, BOB] }, current)).toBe(true);
  });

  it('sees another or no Accountable, and a Responsible more, fewer or swapped', () => {
    expect(sameOwners({ accountable: BOB, responsible: current.responsible }, current)).toBe(false);
    expect(sameOwners({ accountable: null, responsible: current.responsible }, current)).toBe(false);
    expect(sameOwners({ accountable: ANN, responsible: [BOB] }, current)).toBe(false);
    expect(sameOwners({ accountable: ANN, responsible: [BOB, CARLA, ANN] }, current)).toBe(false);
    expect(sameOwners({ accountable: ANN, responsible: [BOB, ANN] }, current)).toBe(false);
  });
});

describe('ownerChanges', () => {
  it('says nothing for no proposal or one that changes nothing', () => {
    expect(ownerChanges(current, null)).toEqual([]);
    expect(ownerChanges(current, { accountable: ANN, responsible: [CARLA, BOB] })).toEqual([]);
  });

  it('names a replaced Accountable, and people added and removed as Responsible', () => {
    const dave = { principalId: 'p-dave', displayName: 'Dave' };
    expect(ownerChanges(current, { accountable: BOB, responsible: [BOB, dave] })).toEqual([
      'Accountable: Bob instead of Ann',
      'Add Dave as Responsible',
      'Remove Carla as Responsible',
    ]);
  });

  it('says so when it proposes nobody, or somebody where there was nobody', () => {
    expect(ownerChanges(current, { accountable: null, responsible: current.responsible })).toEqual(['Nobody Accountable instead of Ann']);
    expect(ownerChanges({ accountable: null, responsible: [] }, { accountable: ANN, responsible: [] })).toEqual(['Make Ann Accountable']);
  });

  it('still names someone the directory has no name for', () => {
    expect(ownerChanges({ accountable: null, responsible: [] }, { accountable: null, responsible: [{ principalId: 'x', displayName: null }] }))
      .toEqual(['Add someone without a name as Responsible']);
  });
});

describe('emptyAnswers', () => {
  it('starts every step without a verdict, and the ownership step from the people who answer for the role now', () => {
    expect(emptyAnswers(['ownership', 'contents'], snapshot)).toEqual({
      ownership: { verdict: null, remark: '', proposal: current },
      contents: { verdict: null, remark: '' },
    });
  });
});

describe('stepProblem', () => {
  const answer = (verdict, remark = '', proposal = current) => ({ verdict, remark, proposal });

  it('wants a verdict first', () => {
    expect(stepProblem('contents', { verdict: null, remark: '' }, snapshot)).toBe('Choose one of the three');
    expect(stepProblem('contents', undefined, snapshot)).toBe('Choose one of the three');
  });

  it('lets good and a question without words through', () => {
    expect(stepProblem('contents', answer('good'), snapshot)).toBeNull();
    expect(stepProblem('contents', answer('notUnderstood'), snapshot)).toBeNull();
  });

  it('wants a change described, and spaces are not a description', () => {
    expect(stepProblem('lifecycle', answer('needsChange', '   '), snapshot)).toBe('Describe the change you propose');
    expect(stepProblem('lifecycle', answer('needsChange', 'too wide'), snapshot)).toBeNull();
  });

  it('takes other people as the change on the ownership step, but not the same people', () => {
    expect(stepProblem('ownership', answer('needsChange'), snapshot)).toBe('Choose who it should be, or describe the change');
    expect(stepProblem('ownership', answer('needsChange', '', { accountable: BOB, responsible: [] }), snapshot)).toBeNull();
    expect(stepProblem('ownership', answer('needsChange', 'Ann is leaving'), snapshot)).toBeNull();
    // People picked on another step change nothing there.
    expect(stepProblem('contents', answer('needsChange', '', { accountable: BOB, responsible: [] }), snapshot)).toBe('Describe the change you propose');
  });
});

describe('buildBody', () => {
  it('sends each step with its verdict and trimmed words, and the trimmed notes', () => {
    const answers = {
      lifecycle: { verdict: 'needsChange', remark: '  The approver left.  ' },
      contents: { verdict: 'notUnderstood', remark: '' },
    };
    expect(buildBody(['lifecycle', 'contents'], answers, '  thanks ', snapshot)).toEqual({
      steps: [
        { step: 'lifecycle', verdict: 'needsChange', remark: 'The approver left.' },
        { step: 'contents', verdict: 'notUnderstood', remark: '' },
      ],
      notes: 'thanks',
    });
  });

  it('drops the words of a step that turned good after all', () => {
    expect(buildBody(['contents'], { contents: { verdict: 'good', remark: 'typed before changing my mind' } }, '', snapshot).steps)
      .toEqual([{ step: 'contents', verdict: 'good', remark: '' }]);
  });

  it('sends proposed people as ids only, and only when they differ from who it is now', () => {
    const proposal = { accountable: CARLA, responsible: [BOB] };
    const body = buildBody(['ownership'], { ownership: { verdict: 'needsChange', remark: '', proposal } }, '', snapshot);
    expect(body.steps[0].proposal).toEqual({ accountable: { identityId: 'i-carla' }, responsible: [{ principalId: 'p-bob' }] });
    const same = buildBody(['ownership'], { ownership: { verdict: 'needsChange', remark: 'x', proposal: current } }, '', snapshot);
    expect(same.steps[0]).toEqual({ step: 'ownership', verdict: 'needsChange', remark: 'x' });
  });

  it('sends nobody Accountable as null, and no proposal with another verdict', () => {
    const proposal = { accountable: null, responsible: [] };
    expect(buildBody(['ownership'], { ownership: { verdict: 'needsChange', remark: '', proposal } }, '', snapshot).steps[0].proposal)
      .toEqual({ accountable: null, responsible: [] });
    expect(buildBody(['ownership'], { ownership: { verdict: 'notUnderstood', remark: '', proposal } }, '', snapshot).steps[0])
      .toEqual({ step: 'ownership', verdict: 'notUnderstood', remark: '' });
  });
});

describe('findingsCount and outcomeText', () => {
  it('counts every step that is not simply good', () => {
    expect(findingsCount([{ verdict: 'good' }, { verdict: 'needsChange' }, { verdict: 'notUnderstood' }])).toBe(2);
    expect(findingsCount()).toBe(0);
  });

  it('words none, one and several', () => {
    expect(outcomeText([{ verdict: 'good' }])).toBe('no findings');
    expect(outcomeText([{ verdict: 'needsChange' }])).toBe('1 finding');
    expect(outcomeText([{ verdict: 'needsChange' }, { verdict: 'notUnderstood' }])).toBe('2 findings');
    expect(outcomeText()).toBe('no findings');
  });
});

describe('splitHolders', () => {
  const NOW = Date.parse('2026-11-27T12:00:00Z');
  const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString();

  it('separates who has the role from who lost it, newest loss first', () => {
    const rows = [
      { principalId: 'a' },
      { principalId: 'b', deleted: true, deletedAt: daysAgo(30) },
      { principalId: 'c', deleted: true, deletedAt: daysAgo(2) },
      { principalId: 'd', deleted: false },
    ];
    const out = splitHolders(rows, NOW);
    expect(out.current.map(r => r.principalId)).toEqual(['a', 'd']);
    expect(out.lost.map(r => r.principalId)).toEqual(['c', 'b']);
  });

  it('keeps a loss on the edge of the window and leaves out an older or undated one', () => {
    const rows = [
      { principalId: 'edge', deleted: true, deletedAt: daysAgo(HOLDERS_LOST_DAYS) },
      { principalId: 'old', deleted: true, deletedAt: daysAgo(HOLDERS_LOST_DAYS + 1) },
      { principalId: 'undated', deleted: true, deletedAt: null },
    ];
    expect(splitHolders(rows, NOW).lost.map(r => r.principalId)).toEqual(['edge']);
    expect(splitHolders(rows, NOW).current).toEqual([]);
    expect(splitHolders(rows, NOW, 200).lost.map(r => r.principalId)).toEqual(['edge', 'old']);
  });
});
