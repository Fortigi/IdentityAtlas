import { describe, it, expect } from 'vitest';
import {
  STEPS, VERDICTS, MAX_NOTES, MAX_REMARK, MAX_PROPOSED_RESPONSIBLE,
  parseReviewBody, parseProposal, personKey, unexplainedChange, outcomeOf, orderSteps, ownersOfSnapshot, sameOwners,
} from './compositionReviewSteps.js';

const ANN = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB = 'bbbbbbbb-0000-4000-8000-000000000002';
const CARLA = 'cccccccc-0000-4000-8000-000000000003';
const good = (step) => ({ step, verdict: 'good' });

describe('the vocabulary', () => {
  it('is three steps and three verdicts, in the order a reviewer meets them', () => {
    expect(STEPS).toEqual(['ownership', 'lifecycle', 'contents']);
    expect(VERDICTS).toEqual(['good', 'needsChange', 'notUnderstood']);
  });
});

describe('parseReviewBody', () => {
  it('keeps each step with its verdict, in the fixed order whatever order it came in', () => {
    const out = parseReviewBody({ steps: [good('contents'), good('ownership'), good('lifecycle')], notes: '  thanks  ' });
    expect(out).toEqual({
      notes: 'thanks',
      steps: STEPS.map(step => ({ step, verdict: 'good', remark: '', proposal: null })),
    });
  });

  it('takes a review of only some steps, as a campaign may ask', () => {
    expect(parseReviewBody({ steps: [good('contents')] }).steps.map(s => s.step)).toEqual(['contents']);
  });

  it('keeps the trimmed remark of a change and of a question', () => {
    const out = parseReviewBody({ steps: [
      { step: 'lifecycle', verdict: 'needsChange', remark: '  The approver left the company.  ' },
      { step: 'contents', verdict: 'notUnderstood', remark: ' What is SG-FIN-X? ' },
    ] });
    expect(out.steps).toEqual([
      { step: 'lifecycle', verdict: 'needsChange', remark: 'The approver left the company.', proposal: null },
      { step: 'contents', verdict: 'notUnderstood', remark: 'What is SG-FIN-X?', proposal: null },
    ]);
  });

  it('drops a remark on a step that is good: it could only contradict the verdict', () => {
    expect(parseReviewBody({ steps: [{ step: 'contents', verdict: 'good', remark: 'but remove SG-HR' }] }).steps[0].remark).toBe('');
  });

  it('refuses a review without steps', () => {
    for (const body of [undefined, {}, { steps: [] }, { steps: 'contents' }, { notes: 'looks fine' }]) {
      expect(parseReviewBody(body)).toEqual({ error: 'A review judges at least one step' });
    }
  });

  it('refuses an unknown step, a missing verdict, and a step judged twice', () => {
    expect(parseReviewBody({ steps: [{ step: 'holders', verdict: 'good' }] }).error).toMatch(/^Unknown step/);
    expect(parseReviewBody({ steps: [{ step: 'contents' }] }).error).toMatch(/^Give every step a verdict/);
    expect(parseReviewBody({ steps: [{ step: 'contents', verdict: 'fine' }] }).error).toMatch(/^Give every step a verdict/);
    expect(parseReviewBody({ steps: [good('contents'), { step: 'contents', verdict: 'needsChange', remark: 'x' }] })).toEqual({ error: 'The step contents is judged twice' });
    expect(parseReviewBody({ steps: ['contents'] })).toEqual({ error: 'Every step must be an object' });
  });

  it('refuses the wrong shapes and what is too long', () => {
    expect(parseReviewBody({ steps: [good('contents')], notes: 5 })).toEqual({ error: 'notes must be text' });
    expect(parseReviewBody({ steps: [{ step: 'contents', verdict: 'needsChange', remark: 7 }] })).toEqual({ error: 'A remark must be text' });
    expect(parseReviewBody({ steps: [good('contents')], notes: 'a'.repeat(MAX_NOTES) }).notes).toHaveLength(MAX_NOTES);
    expect(parseReviewBody({ steps: [good('contents')], notes: 'a'.repeat(MAX_NOTES + 1) })).toEqual({ error: `notes can be at most ${MAX_NOTES} characters` });
    const remark = (n) => parseReviewBody({ steps: [{ step: 'contents', verdict: 'needsChange', remark: 'a'.repeat(n) }] });
    expect(remark(MAX_REMARK).steps[0].remark).toHaveLength(MAX_REMARK);
    expect(remark(MAX_REMARK + 1)).toEqual({ error: `A remark can be at most ${MAX_REMARK} characters` });
  });

  it('takes proposed owners only on a change to the ownership step', () => {
    const proposal = { accountable: { principalId: ANN }, responsible: [] };
    expect(parseReviewBody({ steps: [{ step: 'ownership', verdict: 'needsChange', proposal }] }).steps[0].proposal).toEqual({ accountable: { principalId: ANN }, responsible: [] });
    const refused = { error: 'Only a change to who answers for the role can propose people' };
    expect(parseReviewBody({ steps: [{ step: 'contents', verdict: 'needsChange', remark: 'x', proposal }] })).toEqual(refused);
    expect(parseReviewBody({ steps: [{ step: 'ownership', verdict: 'good', proposal }] })).toEqual(refused);
    expect(parseReviewBody({ steps: [{ step: 'ownership', verdict: 'notUnderstood', proposal }] })).toEqual(refused);
  });

  it('passes a broken proposal on as the error', () => {
    expect(parseReviewBody({ steps: [{ step: 'ownership', verdict: 'needsChange', proposal: { accountable: 'Ann' } }] })).toEqual({ error: 'Choose the Accountable person from the list' });
  });
});

describe('parseProposal', () => {
  it('keeps ids only, lower-cased, and never a name from the request', () => {
    expect(parseProposal({
      accountable: { principalId: ANN.toUpperCase(), displayName: 'Mallory' },
      responsible: [{ identityId: BOB, displayName: 'x' }, { principalId: CARLA }],
    })).toEqual({ accountable: { principalId: ANN }, responsible: [{ identityId: BOB }, { principalId: CARLA }] });
  });

  it('reads no Accountable as nobody, and no list as an empty one', () => {
    expect(parseProposal({})).toEqual({ accountable: null, responsible: [] });
    expect(parseProposal({ accountable: null, responsible: [] })).toEqual({ accountable: null, responsible: [] });
  });

  it('lists a person once', () => {
    expect(parseProposal({ responsible: [{ principalId: BOB }, { principalId: BOB.toUpperCase() }] }).responsible).toEqual([{ principalId: BOB }]);
  });

  it('refuses anything that is not a pick from the list', () => {
    expect(parseProposal('Ann')).toEqual({ error: 'The proposed owners must be an object' });
    expect(parseProposal([])).toEqual({ error: 'The proposed owners must be an object' });
    const noAccountable = { error: 'Choose the Accountable person from the list' };
    expect(parseProposal({ accountable: { principalId: 'ann' } })).toEqual(noAccountable);
    expect(parseProposal({ accountable: { displayName: 'Ann' } })).toEqual(noAccountable);
    expect(parseProposal({ accountable: { principalId: ANN, identityId: BOB } })).toEqual(noAccountable);
    expect(parseProposal({ accountable: { identityId: 12 } })).toEqual(noAccountable);
    expect(parseProposal({ responsible: { principalId: BOB } })).toEqual({ error: 'The proposed Responsible people must be a list' });
    expect(parseProposal({ responsible: [{ principalId: BOB }, 'Carla'] })).toEqual({ error: 'Choose the Responsible people from the list' });
  });

  it('allows the limit of Responsible people and no more', () => {
    const people = (n) => Array.from({ length: n }, (_, i) => ({ principalId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    expect(parseProposal({ responsible: people(MAX_PROPOSED_RESPONSIBLE) }).responsible).toHaveLength(MAX_PROPOSED_RESPONSIBLE);
    expect(parseProposal({ responsible: people(MAX_PROPOSED_RESPONSIBLE + 1) })).toEqual({ error: `Propose at most ${MAX_PROPOSED_RESPONSIBLE} Responsible people` });
  });
});

describe('personKey', () => {
  it('tells an account from a person with the same id, whatever the case', () => {
    expect(personKey({ principalId: ANN.toUpperCase() })).toBe(`principal:${ANN}`);
    expect(personKey({ identityId: ANN })).toBe(`identity:${ANN}`);
    expect(personKey({ principalId: ANN, identityId: BOB })).toBe(`principal:${ANN}`);
  });

  it('is null for nobody', () => {
    expect(personKey(null)).toBeNull();
    expect(personKey({ displayName: 'Ann' })).toBeNull();
  });
});

describe('unexplainedChange', () => {
  it('finds the change that says neither what nor who', () => {
    const silent = { step: 'lifecycle', verdict: 'needsChange', remark: '', proposal: null };
    expect(unexplainedChange([{ step: 'ownership', verdict: 'good', remark: '', proposal: null }, silent])).toBe(silent);
  });

  it('is content with words, with people, and with a question left open', () => {
    expect(unexplainedChange([
      { step: 'ownership', verdict: 'needsChange', remark: '', proposal: { accountable: null, responsible: [] } },
      { step: 'lifecycle', verdict: 'needsChange', remark: 'too wide', proposal: null },
      { step: 'contents', verdict: 'notUnderstood', remark: '', proposal: null },
    ])).toBeNull();
  });
});

describe('outcomeOf', () => {
  it('finds nothing only when every step is good', () => {
    expect(outcomeOf([{ verdict: 'good' }, { verdict: 'good' }])).toBe('noFindings');
    expect(outcomeOf([{ verdict: 'good' }, { verdict: 'needsChange' }])).toBe('findings');
    expect(outcomeOf([{ verdict: 'notUnderstood' }])).toBe('findings');
  });
});

describe('orderSteps', () => {
  it('puts stored steps in the fixed order without touching the list it was given', () => {
    const stored = [{ step: 'contents' }, { step: 'ownership' }, { step: 'lifecycle' }];
    expect(orderSteps(stored).map(s => s.step)).toEqual(STEPS);
    expect(stored[0].step).toBe('contents');
  });
});

describe('ownersOfSnapshot and sameOwners', () => {
  const snapshot = { owners: [
    { role: 'Accountable', principalId: ANN, identityId: null, displayName: 'Ann' },
    { role: 'Responsible', principalId: null, identityId: BOB, displayName: 'Bob' },
    { role: 'Responsible', principalId: CARLA, identityId: null, displayName: 'Carla' },
    { role: 'Responsible', principalId: null, identityId: null, displayName: 'Nameless' },
  ] };

  it('reads who answers for the role as ids, leaving out a holder without one', () => {
    expect(ownersOfSnapshot(snapshot)).toEqual({ accountable: { principalId: ANN }, responsible: [{ identityId: BOB }, { principalId: CARLA }] });
    expect(ownersOfSnapshot(undefined)).toEqual({ accountable: null, responsible: [] });
    expect(ownersOfSnapshot({ owners: [{ role: 'Responsible', principalId: CARLA }] }).accountable).toBeNull();
  });

  it('calls a proposal the same when it names the same people, in any order', () => {
    const current = ownersOfSnapshot(snapshot);
    expect(sameOwners({ accountable: { principalId: ANN }, responsible: [{ principalId: CARLA }, { identityId: BOB }] }, current)).toBe(true);
  });

  it('sees another Accountable, nobody Accountable, and one Responsible more, fewer or swapped', () => {
    const current = ownersOfSnapshot(snapshot);
    const responsible = current.responsible;
    expect(sameOwners({ accountable: { principalId: CARLA }, responsible }, current)).toBe(false);
    expect(sameOwners({ accountable: null, responsible }, current)).toBe(false);
    expect(sameOwners({ accountable: { identityId: ANN }, responsible }, current)).toBe(false);
    expect(sameOwners({ accountable: current.accountable, responsible: [...responsible, { principalId: ANN }] }, current)).toBe(false);
    expect(sameOwners({ accountable: current.accountable, responsible: [responsible[0]] }, current)).toBe(false);
    expect(sameOwners({ accountable: current.accountable, responsible: [responsible[0], { principalId: ANN }] }, current)).toBe(false);
  });
});
