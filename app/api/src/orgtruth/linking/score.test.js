import { describe, it, expect } from 'vitest';
import { buildRuleIndex } from './candidates.js';
import {
  scoreEntity, scoreEntities, scoreCandidate, decide, PROPOSE_FLOOR, MAX_CANDIDATES, MAX_CONFIDENCE,
} from './score.js';

// Principals the Person rule is scored against. Discriminating on purpose:
//   u1 / u2 share a surname and initial (the name signal alone cannot tell them apart)
//   u3 is an admin account of u1 (prefix only)
const principals = [
  { id: 'u1', displayName: 'Jane Doe', email: 'jane.doe@contoso.com', employeeId: 'E100', principalType: 'User' },
  { id: 'u2', displayName: 'Jane Doe', email: 'jane.doe2@contoso.com', employeeId: 'E200', principalType: 'User' },
  { id: 'u3', displayName: 'ADM Jane', email: 'adm-jane.d@contoso.com', employeeId: null, principalType: 'User' },
  { id: 'u4', displayName: 'Kim Roe', email: 'kim.roe@northwind.com', employeeId: 'E400', principalType: 'User' },
];

const personRule = (threshold = 50, signals = null) => ({
  entityType: 'Person', targetType: 'Principal', threshold,
  signals: (signals ?? [
    { attribute: 'email', targetField: 'email', type: 'exact', weight: 90 },
    { attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 },
  ]).map((s, i) => ({ name: s.name ?? s.attribute, order: i, ...s })),
});

const person = (displayName, attributes = {}) => ({ entityType: 'Person', displayName, canonicalKey: displayName.toLowerCase(), attributes });
const idx = (rule, rows = principals) => buildRuleIndex(rows, rule);

describe('scoreEntity — the four decisions', () => {
  it('accepted: exact email + full name, capped at 100, with the strongest signal as the matched field', () => {
    const d = scoreEntity(person('Jane Doe', { email: 'JANE.DOE@contoso.com' }), idx(personRule()));
    expect(d.decision).toBe('accepted');
    expect(d.ambiguous).toBe(false);
    expect(d.confidence).toBe(MAX_CONFIDENCE);
    expect(d.candidates).toHaveLength(1);
    expect(d.candidates[0]).toMatchObject({
      targetType: 'Principal', targetId: 'u1', label: 'Jane Doe', confidence: 100,
      signals: ['email', 'displayName'], matchedField: 'email', matchedValue: 'jane.doe@contoso.com',
    });
    expect(d.signals).toEqual(['email', 'displayName']);
    expect(d).toMatchObject({ entityType: 'Person', targetType: 'Principal' });
  });

  it('proposed + ambiguous: a tie at or above the threshold is never guessed', () => {
    // name only (60 each for u1 and u2), threshold 60 → tie at the threshold
    const d = scoreEntity(person('Jane Doe'), idx(personRule(60)));
    expect(d.decision).toBe('proposed');
    expect(d.ambiguous).toBe(true);
    expect(d.confidence).toBe(60);
    expect(d.candidates.map(c => c.targetId)).toEqual(['u1', 'u2']);
  });

  it('proposed, low confidence: one point under the threshold', () => {
    const d = scoreEntity(person('Kim Roe'), idx(personRule(61)));
    expect(d.decision).toBe('proposed');
    expect(d.ambiguous).toBe(false);
    expect(d.confidence).toBe(60);
    expect(d.candidates.map(c => c.targetId)).toEqual(['u4']);
  });

  it('accepted exactly at the threshold', () => {
    const d = scoreEntity(person('Kim Roe'), idx(personRule(60)));
    expect(d.decision).toBe('accepted');
    expect(d.candidates[0].targetId).toBe('u4');
  });

  it('none: no candidate at all', () => {
    const d = scoreEntity(person('Nobody Known', { email: 'nobody@contoso.com' }), idx(personRule()));
    expect(d).toMatchObject({ decision: 'none', ambiguous: false, confidence: 0, candidates: [], signals: [] });
  });

  it('a best score breaks the tie: email lifts u1 above u2 although both match by name', () => {
    const d = scoreEntity(person('Jane Doe', { email: 'jane.doe@contoso.com' }), idx(personRule(100)));
    expect(d.decision).toBe('accepted');
    expect(d.candidates[0].targetId).toBe('u1');
  });

  it('an empty attribute does not fire its signal (name alone decides, tie stays a tie)', () => {
    const d = scoreEntity(person('Jane Doe', { email: '  ' }), idx(personRule()));
    expect(d.decision).toBe('proposed');
    expect(d.ambiguous).toBe(true);
    expect(d.candidates.every(c => c.signals.join() === 'displayName')).toBe(true);
  });

  it('a prefix-only hit finds the admin account at the prefix weight', () => {
    const rule = personRule(80, [{ attribute: 'email', targetField: 'email', type: 'prefix', weight: 80 }]);
    const d = scoreEntity(person('Jane D', { email: 'jane.d@contoso.com' }), idx(rule));
    expect(d.decision).toBe('accepted');
    expect(d.candidates[0]).toMatchObject({ targetId: 'u3', confidence: 80, signals: ['email'], matchedValue: 'adm-jane.d@contoso.com' });
  });

  it('surname + initial gives 75 % and lands in review under a threshold of 50', () => {
    const rule = personRule(50, [{ attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 60 }]);
    const d = scoreEntity(person('K. Roe'), idx(rule));
    expect(d).toMatchObject({ decision: 'proposed', ambiguous: false, confidence: 45 });
    expect(d.candidates.map(x => x.targetId)).toEqual(['u4']);
  });
});

describe('scoreCandidate', () => {
  it('sums matching signals and keeps the first strongest as the matched field on equal weight', () => {
    const rule = personRule(50, [
      { name: 'a', attribute: 'displayName', targetField: 'displayName', type: 'name', weight: 40 },
      { name: 'b', attribute: 'email', targetField: 'email', type: 'exact', weight: 40 },
    ]);
    const c = scoreCandidate(person('Jane Doe', { email: 'jane.doe@contoso.com' }), rule, principals[0]);
    expect(c).toMatchObject({ confidence: 80, signals: ['a', 'b'], matchedField: 'displayName', matchedValue: 'Jane Doe' });
  });
  it('has null label and matched value when the row carries none', () => {
    const rule = personRule(50, [{ attribute: 'email', targetField: 'email', type: 'exact', weight: 40 }]);
    const c = scoreCandidate(person('X'), rule, { id: 'z', email: 'x@y' });
    expect(c).toMatchObject({ label: null, confidence: 0, signals: [], matchedField: null, matchedValue: null });
  });
});

describe('decide', () => {
  const c = (id, confidence) => ({ targetId: id, confidence });

  it('accepts a single best at the threshold', () => {
    expect(decide([c('a', 50), c('b', 49)], 50)).toMatchObject({ decision: 'accepted', confidence: 50, candidates: [c('a', 50)] });
  });
  it('a tie at the top is proposed and ambiguous, keeping at most five, best first', () => {
    const many = [c('g', 30), c('a', 70), c('b', 70), c('c', 60), c('d', 55), c('e', 40), c('f', 35)];
    const d = decide(many, 50);
    expect(d).toMatchObject({ decision: 'proposed', ambiguous: true, confidence: 70 });
    expect(d.candidates.map(x => x.targetId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(MAX_CANDIDATES).toBe(5);
  });
  it('orders equal scores by target id so the outcome is stable', () => {
    expect(decide([c('b', 70), c('a', 70)], 50).candidates.map(x => x.targetId)).toEqual(['a', 'b']);
  });
  it('below the threshold proposes only candidates at or above the floor', () => {
    const d = decide([c('a', 20), c('b', 19)], 50);
    expect(PROPOSE_FLOOR).toBe(20);
    expect(d).toMatchObject({ decision: 'proposed', ambiguous: false, confidence: 20 });
    expect(d.candidates.map(x => x.targetId)).toEqual(['a']);
  });
  it('a low-confidence tie is proposed, not ambiguous', () => {
    expect(decide([c('a', 30), c('b', 30)], 50)).toMatchObject({ decision: 'proposed', ambiguous: false });
  });
  it('under the floor is none, but reports the best score', () => {
    expect(decide([c('a', 19)], 50)).toEqual({ decision: 'none', ambiguous: false, confidence: 19, candidates: [] });
  });
  it('no candidates, or only zero scores, is none', () => {
    expect(decide([], 0)).toMatchObject({ decision: 'none', confidence: 0 });
    expect(decide([c('a', 0)], 0)).toMatchObject({ decision: 'none', confidence: 0 });
  });
  it('a threshold under the floor accepts what it reaches', () => {
    expect(decide([c('a', 10)], 10)).toMatchObject({ decision: 'accepted' });
  });
});

describe('token candidates', () => {
  const groups = [
    { id: 'g1', displayName: 'SG_SAP_PROD_Users' },
    { id: 'g2', displayName: 'SG_SAP_TEST_Users' },
    { id: 'g3', displayName: 'SG_HR_Users' },
  ];
  const rule = {
    entityType: 'Application', targetType: 'Resource', threshold: 50,
    signals: [{ name: 'tok', attribute: 'displayName', targetField: 'displayName', type: 'token', weight: 50, order: 0 }],
  };
  it('needs every org token, so a shared common token alone finds nothing extra', () => {
    const d = scoreEntity({ entityType: 'Application', displayName: 'SAP PROD', attributes: {} }, buildRuleIndex(groups, rule));
    expect(d.decision).toBe('accepted');
    expect(d.candidates.map(x => x.targetId)).toEqual(['g1']);
  });
  it('a token no row has means no candidate', () => {
    const d = scoreEntity({ entityType: 'Application', displayName: 'Users Finance', attributes: {} }, buildRuleIndex(groups, rule));
    expect(d.decision).toBe('none');
  });
  it('several rows holding every token tie', () => {
    const d = scoreEntity({ entityType: 'Application', displayName: 'SAP users', attributes: {} }, buildRuleIndex(groups, rule));
    expect(d).toMatchObject({ decision: 'proposed', ambiguous: true });
  });
});

describe('scoreEntities', () => {
  it('scores only entities whose type has a rule, in input order', () => {
    const indexes = new Map([['Person', idx(personRule())]]);
    const out = scoreEntities([
      person('Kim Roe'),
      { entityType: 'Project', displayName: 'Atlas', attributes: {} },
      person('Jane Doe', { email: 'jane.doe@contoso.com' }),
    ], indexes);
    expect(out.map(d => [d.entity.displayName, d.decision])).toEqual([['Kim Roe', 'accepted'], ['Jane Doe', 'accepted']]);
  });
  it('handles no entities', () => {
    expect(scoreEntities(undefined, new Map())).toEqual([]);
  });
});
