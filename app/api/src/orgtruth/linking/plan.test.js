import { describe, it, expect } from 'vitest';
import { planLinkWrites } from './plan.js';

const cand = (targetId, confidence, extra = {}) => ({
  targetType: 'Principal', targetId, label: targetId, confidence,
  signals: ['email'], matchedField: 'email', matchedValue: `${targetId}@contoso.com`, ...extra,
});

// A decision as score.js returns it (the fields plan.js reads).
const decision = (entityId, decision, candidates, { ambiguous = false, all = candidates, via, value } = {}) => ({
  entity: { id: entityId }, entityType: 'Person', targetType: 'Principal', via, value, decision, ambiguous, candidates, allCandidates: all,
});

const link = (id, entityId, targetId, status, analystOverride = null) => ({
  id, orgEntityId: entityId, targetType: 'Principal', targetId, status, analystOverride,
});

const plan = (decisions, existing = [], threshold = 50) =>
  planLinkWrites({ decisions, existing, thresholdFor: () => threshold, runId: 'run-2' });

describe('planLinkWrites — fresh entities', () => {
  it('accepted writes the best candidate as accepted with its provenance', () => {
    const p = plan([decision('e1', 'accepted', [cand('u1', 90, { signals: ['email', 'name'] })])]);
    expect(p.upserts).toEqual([{
      orgEntityId: 'e1', targetType: 'Principal', targetId: 'u1', confidence: 90,
      signals: 'email,name', matchedField: 'email', matchedValue: 'u1@contoso.com', via: null, orgValue: null, status: 'accepted', runId: 'run-2',
    }]);
    expect(p.counts).toEqual({ linked: 1, proposed: 0, ambiguous: 0, none: 0, rejected: 0 });
  });

  it('records the attribute and value a decision came through; several decisions of one entity each write', () => {
    const p = plan([
      decision('e1', 'accepted', [cand('u1', 100)], { via: 'eigenaar', value: 'Ann Example' }),
      decision('e1', 'accepted', [cand('u2', 100)], { via: 'team', value: 'Bob Example' }),
      decision('e1', 'accepted', [cand('u3', 100)], { via: 'team', value: 'Cas Example' }),
    ]);
    expect(p.upserts.map(u => [u.targetId, u.via, u.orgValue])).toEqual([['u1', 'eigenaar', 'Ann Example'], ['u2', 'team', 'Bob Example'], ['u3', 'team', 'Cas Example']]);
    expect(p.counts.linked).toBe(3);
  });

  it('a comma inside a signal name cannot split it in the stored list', () => {
    const p = plan([decision('e1', 'accepted', [cand('u1', 90, { signals: ['mail, work', ' name'] })])]);
    expect(p.upserts[0].signals).toBe('mail  work,name');
  });

  it('proposed writes one proposed row per kept candidate, ambiguous and low counted apart', () => {
    const p = plan([
      decision('e1', 'proposed', [cand('u1', 70), cand('u2', 70)], { ambiguous: true }),
      decision('e2', 'proposed', [cand('u3', 30)]),
      decision('e3', 'none', []),
    ]);
    expect(p.upserts.map(u => [u.orgEntityId, u.targetId, u.status])).toEqual([
      ['e1', 'u1', 'proposed'], ['e1', 'u2', 'proposed'], ['e2', 'u3', 'proposed'],
    ]);
    expect(p.counts).toEqual({ linked: 0, proposed: 1, ambiguous: 1, none: 1, rejected: 0 });
  });
});

describe('planLinkWrites — re-run against stored links', () => {
  it('an entity the analyst confirmed is left alone and counts as linked', () => {
    const p = plan(
      [decision('e1', 'accepted', [cand('u9', 100)])],
      [link('l1', 'e1', 'u1', 'accepted', 'confirmed'), link('l2', 'e1', 'u2', 'proposed')],
    );
    expect(p.upserts).toEqual([]);
    expect(p.rejectIds).toEqual([]);
    expect(p.counts.linked).toBe(1);
  });

  it('a link moved by the analyst pins the entity the same way', () => {
    const p = plan([decision('e1', 'none', [])], [link('l1', 'e1', 'u5', 'accepted', 'moved')]);
    expect(p.upserts).toEqual([]);
    expect(p.counts).toMatchObject({ linked: 1, none: 0 });
  });

  it('a pinned link that recorded its attribute and value pins only that decision, not the entity\'s others', () => {
    const pinned = { ...link('l1', 'e1', 'u1', 'accepted', 'confirmed'), via: 'team', orgValue: 'Ann Example' };
    const p = plan([
      decision('e1', 'accepted', [cand('u9', 100)], { via: 'team', value: 'Ann Example' }),   // the analyst chose u1 for Ann: engine's u9 is not written
      decision('e1', 'accepted', [cand('u2', 100)], { via: 'team', value: 'Bob Example' }),   // Bob is still linked
      decision('e1', 'accepted', [cand('u3', 100)], { via: 'eigenaar', value: 'Ann Example' }), // same name through another attribute: still linked
    ], [pinned]);
    expect(p.upserts.map(u => u.targetId)).toEqual(['u2', 'u3']);
    expect(p.counts.linked).toBe(3);
    expect(p.rejectIds).toEqual([]);
  });

  it('a confirmed override whose status is no longer accepted does not pin', () => {
    const p = plan([decision('e1', 'accepted', [cand('u2', 90)])], [link('l1', 'e1', 'u1', 'rejected', 'confirmed')]);
    expect(p.upserts.map(u => u.targetId)).toEqual(['u2']);
    expect(p.rejectIds).toEqual([]); // overridden rows are never touched
  });

  it('a target the analyst rejected is dropped and the decision is taken again', () => {
    // u1 (90) was rejected by the analyst; u2 (60) is what is left → accepted at threshold 50
    const all = [cand('u1', 90), cand('u2', 60)];
    const p = plan([decision('e1', 'accepted', [all[0]], { all })], [link('l1', 'e1', 'u1', 'rejected', 'rejected')]);
    expect(p.upserts.map(u => [u.targetId, u.status, u.confidence])).toEqual([['u2', 'accepted', 60]]);
    expect(p.counts.linked).toBe(1);
  });

  it('dropping a rejected target can leave a tie, which is proposed', () => {
    const all = [cand('u1', 90), cand('u2', 60), cand('u3', 60)];
    const p = plan([decision('e1', 'accepted', [all[0]], { all })], [link('l1', 'e1', 'u1', 'rejected', 'rejected')]);
    expect(p.upserts.map(u => [u.targetId, u.status])).toEqual([['u2', 'proposed'], ['u3', 'proposed']]);
    expect(p.counts.ambiguous).toBe(1);
  });

  it('rejects stored links whose candidate no longer scores, but not ones written again or already rejected', () => {
    const p = plan(
      [decision('e1', 'accepted', [cand('u2', 95)])],
      [link('l1', 'e1', 'u1', 'accepted'), link('l2', 'e1', 'u2', 'proposed'), link('l3', 'e1', 'u3', 'rejected')],
    );
    expect(p.upserts.map(u => u.targetId)).toEqual(['u2']);
    expect(p.rejectIds).toEqual(['l1']);
    expect(p.counts.rejected).toBe(1);
  });

  it('an entity that now matches nothing has all its unprotected links rejected', () => {
    const p = plan([decision('e1', 'none', [])], [link('l1', 'e1', 'u1', 'proposed'), link('l2', 'e1', 'u2', 'proposed')]);
    expect(p.rejectIds).toEqual(['l1', 'l2']);
    expect(p.counts).toMatchObject({ none: 1, rejected: 2 });
  });

  it('links of another entity are not touched', () => {
    const p = plan([decision('e1', 'none', [])], [link('l9', 'e2', 'u1', 'accepted')]);
    expect(p.rejectIds).toEqual([]);
  });

  it('a link with the same target id under another target type is a different link', () => {
    const other = { ...link('l1', 'e1', 'u1', 'accepted'), targetType: 'Identity' };
    const p = plan([decision('e1', 'accepted', [cand('u1', 90)])], [other]);
    expect(p.rejectIds).toEqual(['l1']);
  });
});
