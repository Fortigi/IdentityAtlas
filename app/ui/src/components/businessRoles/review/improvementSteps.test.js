import { describe, it, expect } from 'vitest';
import {
  DECISIONS, ruleText, suggestionText, decisionsVerdict, improvementsProblem, improvementsBody, judgedImprovements,
} from './improvementSteps';
import { STEP_INFO, emptyAnswers, stepProblem, buildBody } from './reviewSteps';
import { formatUtcDay } from '@ui/utils/formatters';

const exactPermission = {
  key: 'permission:g9', kind: 'addPermission', confidence: 100, exact: true,
  resource: { id: 'g9', displayName: 'SG-Data', resourceType: 'Group', createdDateTime: null },
  recent: false, holders: 12, holdersWithIt: 12, othersWithIt: 0,
};
const nearPermission = {
  ...exactPermission, key: 'permission:g8', confidence: 97, exact: false, recent: true,
  resource: { id: 'g8', displayName: 'SG-New', createdDateTime: '2026-10-15T08:00:00Z' }, holders: 39, holdersWithIt: 38, othersWithIt: 0,
};
const rule = {
  key: 'rule:department=Development', kind: 'automaticRule', confidence: 100, exact: true,
  conditions: [{ attribute: 'department', value: 'Development' }, { attribute: 'jobTitle', value: 'Engineer' }],
  holders: 14, holdersMatched: 14, othersMatched: 0,
};
const found = (suggestions, extra = {}) => ({ suggestions, declinedBefore: 0, holderCount: 12, thresholds: { confidence: 95, holders: 5, recentDays: 90 }, ...extra });

describe('the words', () => {
  it('names the step and the three decisions', () => {
    expect(STEP_INFO.improvements.label).toBe('Improvements');
    expect(DECISIONS).toEqual(['adopt', 'decline', 'notUnderstood']);
  });

  it('reads a rule as its conditions', () => {
    expect(ruleText(rule.conditions)).toBe('department is "Development" and job title is "Engineer"');
    expect(ruleText([{ attribute: 'companyName', value: 'Contoso' }])).toBe('company is "Contoso"');
    expect(ruleText([{ attribute: 'other', value: 'x' }])).toBe('other is "x"');
    expect(ruleText()).toBe('');
  });

  it('explains an exact permission by everyone and nobody else', () => {
    expect(suggestionText(exactPermission)).toEqual({
      title: 'Add SG-Data to the role',
      why: 'All 12 people who hold this role have it themselves, nobody else has it, and no business role contains it.',
    });
  });

  it('explains a near permission with the numbers, the others and when it appeared', () => {
    expect(suggestionText(nearPermission).why).toBe(`38 of the 39 people who hold this role have it, and nobody else. It is new: created on ${formatUtcDay('2026-10-15T08:00:00Z')}.`);
    expect(suggestionText({ ...nearPermission, othersWithIt: 1, resource: { displayName: 'X' } }).why)
      .toBe('38 of the 39 people who hold this role have it, and 1 person who does not hold the role.');
    expect(suggestionText({ ...nearPermission, resource: null }).title).toBe('Add a permission without a name to the role');
  });

  it('explains a rule as handing the role out by itself', () => {
    expect(suggestionText(rule)).toEqual({
      title: 'Hand it out automatically to everyone whose department is "Development" and job title is "Engineer"',
      why: 'This role is handed out by hand. A rule would pick exactly the 14 people who hold it, nobody more.',
    });
    expect(suggestionText({ ...rule, exact: false, holdersMatched: 40, holders: 41, othersMatched: 1 }).why)
      .toBe('This role is handed out by hand. A rule would pick 40 of the 41 people who hold it and 1 person who does not hold it.');
    expect(suggestionText({ ...rule, exact: false, holdersMatched: 40, holders: 41, othersMatched: 0 }).why)
      .toBe('This role is handed out by hand. A rule would pick 40 of the 41 people who hold it.');
  });
});

describe('the rules of the step', () => {
  it('gives the verdict the API gives: adopting first, then a question, else good', () => {
    expect(decisionsVerdict({})).toBe('good');
    expect(decisionsVerdict()).toBe('good');
    expect(decisionsVerdict({ a: 'decline' })).toBe('good');
    expect(decisionsVerdict({ a: 'decline', b: 'notUnderstood' })).toBe('notUnderstood');
    expect(decisionsVerdict({ a: 'notUnderstood', b: 'adopt' })).toBe('needsChange');
  });

  it('waits for role mining, then for a decision on each suggestion', () => {
    expect(improvementsProblem({ decisions: {} }, null)).toBe('Role mining is still looking');
    expect(improvementsProblem({ decisions: {} }, found([]))).toBeNull();
    expect(improvementsProblem({ decisions: {} }, found([exactPermission]))).toBe('Decide on the suggestion');
    expect(improvementsProblem({ decisions: { 'permission:g9': 'adopt' } }, found([exactPermission, rule]))).toBe('Decide on every suggestion');
    expect(improvementsProblem({ decisions: { 'permission:g9': 'adopt', [rule.key]: 'decline' } }, found([exactPermission, rule]))).toBeNull();
    expect(improvementsProblem(undefined, found([exactPermission]))).toBe('Decide on the suggestion');
  });

  it('is asked through stepProblem like the other steps', () => {
    expect(stepProblem('improvements', { decisions: {} }, null, found([]))).toBeNull();
    expect(stepProblem('improvements', { decisions: {} }, null, null)).toBe('Role mining is still looking');
  });

  it('starts with no decisions, beside the other steps', () => {
    expect(emptyAnswers(['contents', 'improvements'], null)).toEqual({
      contents: { verdict: null, remark: '' },
      improvements: { verdict: null, remark: '', decisions: {} },
    });
  });

  it('sends a decision per suggestion shown, in their order, and a remark only with something to say', () => {
    const answer = { decisions: { [rule.key]: 'decline', 'permission:g9': 'adopt', stale: 'adopt' }, remark: '  only for engineers  ' };
    expect(improvementsBody(answer, found([exactPermission, rule]))).toEqual({
      step: 'improvements',
      decisions: [{ key: 'permission:g9', decision: 'adopt' }, { key: rule.key, decision: 'decline' }],
      remark: 'only for engineers',
    });
    expect(improvementsBody({ decisions: { [rule.key]: 'decline' }, remark: 'x' }, found([rule])).remark).toBe('');
    expect(improvementsBody({ decisions: {}, remark: '' }, null)).toEqual({ step: 'improvements', decisions: [], remark: '' });
  });

  it('is built into the body beside the other steps', () => {
    const body = buildBody(['contents', 'improvements'], {
      contents: { verdict: 'good', remark: '' },
      improvements: { decisions: {}, remark: '' },
    }, '', null, found([]));
    expect(body.steps).toEqual([{ step: 'contents', verdict: 'good', remark: '' }, { step: 'improvements', decisions: [], remark: '' }]);
  });

  it('shows before signing what a saved review will show', () => {
    expect(judgedImprovements({ decisions: { 'permission:g9': 'adopt' }, remark: 'yes' }, found([exactPermission], { declinedBefore: 2 }))).toEqual({
      step: 'improvements', verdict: 'needsChange', remark: 'yes',
      proposal: { suggestions: [{ ...exactPermission, decision: 'adopt' }], declinedBefore: 2 },
    });
    expect(judgedImprovements({ decisions: {}, remark: 'x' }, found([]))).toEqual({ step: 'improvements', verdict: 'good', remark: '', proposal: null });
    expect(judgedImprovements({ decisions: {}, remark: '' }, null).proposal).toBeNull();
  });
});
