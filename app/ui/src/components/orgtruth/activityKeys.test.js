import { describe, it, expect } from 'vitest';
import {
  keyUrl, roleLabel, currentCandidate, otherCandidates, keyDecisionBody, keyToast, keyError, keyActions,
} from './activityKeys';

const KEY = {
  id: 'k/1', role: 'actor', rawValue: 'Ann Example', rows: 42, status: 'proposed',
  targetType: 'Identity', targetId: 'i1', targetLabel: 'Ann Example (HR)', confidence: 72,
  candidates: [
    { targetType: 'Identity', targetId: 'i1', label: 'Ann Example (HR)', confidence: 72 },
    { targetType: 'Identity', targetId: 'i3', label: 'Anne Example', confidence: 40 },
    { targetType: 'Principal', targetId: 'u2', label: 'ann@contoso.example', confidence: 65 },
    { targetType: 'Principal', targetId: null, label: 'broken' },
  ],
};

describe('activity key helpers', () => {
  it('encodes the id into the decision url', () => {
    expect(keyUrl('k/1')).toBe('/api/org-truth/activity-keys/k%2F1');
  });

  it('calls an actor "Who" and a subject "On what"', () => {
    expect(roleLabel('actor')).toBe('Who');
    expect(roleLabel('subject')).toBe('On what');
  });

  it('takes the current candidate from the key, its label falling back to the id', () => {
    expect(currentCandidate(KEY)).toEqual({ targetType: 'Identity', targetId: 'i1', label: 'Ann Example (HR)', confidence: 72 });
    expect(currentCandidate({ targetType: 'Resource', targetId: 'g1' })).toEqual({ targetType: 'Resource', targetId: 'g1', label: 'g1', confidence: null });
    expect(currentCandidate({ targetId: null })).toBeNull();
  });

  it('offers the other candidates best first, without the current one or one without an id', () => {
    expect(otherCandidates(KEY).map(c => c.targetId)).toEqual(['u2', 'i3']);
    expect(otherCandidates({})).toEqual([]);
  });

  it('builds the accept body with the target and the reject body without one', () => {
    expect(keyDecisionBody('accepted', { targetType: 'Principal', targetId: 'u2', label: 'x' }))
      .toEqual({ status: 'accepted', targetType: 'Principal', targetId: 'u2' });
    expect(keyDecisionBody('rejected')).toEqual({ status: 'rejected' });
  });

  it('says what was decided', () => {
    expect(keyToast('accepted', KEY, { label: 'Anne Example' })).toBe('“Ann Example” is Anne Example');
    expect(keyToast('rejected', KEY)).toBe('Rejected “Ann Example”');
  });

  it('explains a failed decision per status', () => {
    expect(keyError(501, 'x')).toBe('Deciding on activity references is not available yet.');
    expect(keyError(400, 'bad target')).toBe('The decision was not saved: bad target');
    expect(keyError(500, '')).toBe('The decision was not saved (HTTP 500).');
    expect(keyError(0, '')).toBe('The decision was not saved.');
  });

  it('offers accept only for an unaccepted key with a candidate, reject unless rejected, pick when there are others', () => {
    expect(keyActions(KEY, true)).toEqual({ accept: true, reject: true, pick: true });
    expect(keyActions({ ...KEY, status: 'accepted' }, true)).toEqual({ accept: false, reject: true, pick: true });
    expect(keyActions({ ...KEY, status: 'rejected', candidates: [] }, true)).toEqual({ accept: true, reject: false, pick: false });
    expect(keyActions({ ...KEY, targetId: null }, true).accept).toBe(false);
    expect(keyActions(KEY, false)).toEqual({ accept: false, reject: false, pick: false });
  });
});
