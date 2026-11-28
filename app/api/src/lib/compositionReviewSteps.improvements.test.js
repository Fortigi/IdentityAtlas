import { describe, it, expect } from 'vitest';
import {
  DECISIONS, MAX_DECISIONS, MAX_REMARK, IMPROVEMENTS, parseReviewBody, parseDecisions, decisionsVerdict, unexplainedChange,
} from './compositionReviewSteps.js';

const improvements = (decisions, extra = {}) => ({ step: IMPROVEMENTS, decisions, ...extra });
const parsedStep = (raw) => {
  const out = parseReviewBody({ steps: [raw] });
  return out.error ? out : out.steps[0];
};

describe('the decisions on role-mining suggestions', () => {
  it('are adopt, decline and "I do not understand"', () => {
    expect(DECISIONS).toEqual(['adopt', 'decline', 'notUnderstood']);
  });

  it('give the step its verdict: adopting anything is a change, before a question, before nothing', () => {
    expect(decisionsVerdict([])).toBe('good');
    expect(decisionsVerdict([{ decision: 'decline' }, { decision: 'decline' }])).toBe('good');
    expect(decisionsVerdict([{ decision: 'decline' }, { decision: 'notUnderstood' }])).toBe('notUnderstood');
    expect(decisionsVerdict([{ decision: 'notUnderstood' }, { decision: 'adopt' }])).toBe('needsChange');
  });

  it('keep key and decision only, each suggestion once', () => {
    expect(parseDecisions([{ key: 'permission:a', decision: 'adopt', confidence: 100 }])).toEqual([{ key: 'permission:a', decision: 'adopt' }]);
    expect(parseDecisions(undefined)).toEqual([]);
    expect(parseDecisions([{ key: 'k', decision: 'adopt' }, { key: 'k', decision: 'decline' }]).error).toMatch(/twice/);
  });

  it('refuse what is not a list, a nameless decision and an unknown one', () => {
    expect(parseDecisions('adopt').error).toMatch(/must be a list/);
    expect(parseDecisions([{ decision: 'adopt' }]).error).toMatch(/names the suggestion/);
    expect(parseDecisions([{ key: '', decision: 'adopt' }]).error).toMatch(/names the suggestion/);
    expect(parseDecisions([{ key: 'x'.repeat(501), decision: 'adopt' }]).error).toMatch(/names the suggestion/);
    expect(parseDecisions([{ key: 'x'.repeat(500), decision: 'adopt' }])).toHaveLength(1);
    expect(parseDecisions([{ key: 'k', decision: 'maybe' }]).error).toMatch(/Decide on every suggestion/);
    expect(parseDecisions([null]).error).toMatch(/names the suggestion/);
  });

  it('take at most MAX_DECISIONS', () => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, decision: 'decline' }));
    expect(parseDecisions(many(MAX_DECISIONS))).toHaveLength(MAX_DECISIONS);
    expect(parseDecisions(many(MAX_DECISIONS + 1)).error).toMatch(/at most/);
  });
});

describe('parseReviewBody, the improvements step', () => {
  it('needs no verdict from the request: the decisions give it', () => {
    expect(parsedStep(improvements([{ key: 'k', decision: 'adopt' }], { verdict: 'good' }))).toEqual({
      step: 'improvements', verdict: 'needsChange', remark: '', proposal: null, decisions: [{ key: 'k', decision: 'adopt' }],
    });
  });

  it('is good with nothing to decide on, and drops a remark then', () => {
    expect(parsedStep(improvements([], { remark: 'fine' }))).toMatchObject({ verdict: 'good', remark: '', decisions: [] });
  });

  it('keeps the trimmed question of a reviewer who does not understand a suggestion', () => {
    expect(parsedStep(improvements([{ key: 'k', decision: 'notUnderstood' }], { remark: '  What is SG-Data?  ' })))
      .toMatchObject({ verdict: 'notUnderstood', remark: 'What is SG-Data?' });
  });

  it('never takes suggestions from the request', () => {
    expect(parsedStep(improvements([], { proposal: { suggestions: [] } })).error).toMatch(/not from the request/);
  });

  it('refuses a remark that is not text or too long, and bad decisions', () => {
    expect(parsedStep(improvements([{ key: 'k', decision: 'notUnderstood' }], { remark: 5 })).error).toMatch(/must be text/);
    expect(parsedStep(improvements([{ key: 'k', decision: 'notUnderstood' }], { remark: 'x'.repeat(MAX_REMARK + 1) })).error).toMatch(/at most/);
    expect(parsedStep(improvements('nope')).error).toMatch(/must be a list/);
  });

  it('comes after the contents step, whatever order it was sent in', () => {
    const out = parseReviewBody({ steps: [improvements([]), { step: 'contents', verdict: 'good' }] });
    expect(out.steps.map(s => s.step)).toEqual(['contents', 'improvements']);
  });

  it('an adopted suggestion explains the change by itself once the server has added it', () => {
    const step = parsedStep(improvements([{ key: 'k', decision: 'adopt' }]));
    expect(unexplainedChange([step])).toBe(step);
    expect(unexplainedChange([{ ...step, proposal: { suggestions: [] } }])).toBeNull();
  });
});
