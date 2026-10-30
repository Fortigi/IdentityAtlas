import { describe, it, expect } from 'vitest';
import {
  ruleFromView, ruleMatches, effectiveMembers, usesOrgKnowledge, ruleSentence, approverText, ROLE_KINDS, roleProblems, roleNotes,
} from './workbench.rule';
import { matchesFilter, columnByKey, filterSummary } from './workbench.columns';

const link = (kind, name, state = 'confirmed') => ({ kind, name, state, claims: [] });
const person = (key, displayName, jobTitle, direct = true, knowledge = []) => ({ key, displayName, jobTitle, direct, knowledge, accounts: [{}], attributes: {} });
const people = [
  person('a', 'Anna', 'Claims handler', true, [link('activity', 'Handle property claims')]),
  person('b', 'Bram', 'Senior claims handler', false),
  person('s', 'Sophie', 'Team lead Property', true),
  person('l', 'Lisa', 'Claims lawyer', false),
];
const f = (values, contains = [], includeProposed = true) => ({ values: new Set(values), contains, includeProposed });
const handlerOrLead = { jobTitle: f(['Team lead Property'], ['handler']) };

describe('a column filter with "contains"', () => {
  it('matches a ticked value OR a value containing a text, case aside', () => {
    const col = columnByKey.get('jobTitle');
    expect(people.map(p => matchesFilter(p, col, handlerOrLead.jobTitle))).toEqual([true, true, true, false]);
    expect(matchesFilter(people[3], col, f([], ['LAWYER']))).toBe(true);
    expect(filterSummary(handlerOrLead, people)).toEqual([{ key: 'jobTitle', text: 'Job title: contains “handler”, Team lead Property' }]);
  });
});

describe('ruleFromView / ruleMatches', () => {
  it('copies the current scope and filters, so later filtering does not change the rule', () => {
    const view = { includeChildren: true, filters: { jobTitle: f(['x']), duty: null } };
    const rule = ruleFromView(view);
    view.filters.jobTitle.values.add('y');
    expect([...rule.filters.jobTitle.values]).toEqual(['x']);
    expect(Object.keys(rule.filters)).toEqual(['jobTitle']);
    expect(ruleFromView({ filters: {} })).toEqual({ includeChildren: true, filters: {} });
  });

  it('matches everyone in scope without conditions, only the unit itself without sub-units', () => {
    expect(ruleMatches({ includeChildren: true, filters: {} }, people).map(p => p.key)).toEqual(['a', 'b', 's', 'l']);
    expect(ruleMatches({ includeChildren: false, filters: {} }, people).map(p => p.key)).toEqual(['a', 's']);
    expect(ruleMatches({ includeChildren: true, filters: handlerOrLead }, people).map(p => p.key)).toEqual(['a', 'b', 's']);
  });
});

describe('effectiveMembers', () => {
  const base = { members: new Set(['l']), excluded: new Set(['b']), rule: { includeChildren: true, filters: handlerOrLead } };

  it('computes a rule-based role’s members from its rule, plus always include, minus always exclude', () => {
    expect([...effectiveMembers({ ...base, kind: 'rule' }, people)].sort()).toEqual(['a', 'l', 's']);
  });

  it('keeps the members chosen by hand for a requestable role, a role without a rule, and one without a kind', () => {
    expect([...effectiveMembers({ ...base, kind: 'requestable' }, people)]).toEqual(['l']);
    expect([...effectiveMembers({ ...base, kind: 'rule', rule: null }, people)]).toEqual(['l']);
    expect([...effectiveMembers({ ...base, kind: null }, people)]).toEqual(['l']);
  });
});

describe('usesOrgKnowledge', () => {
  it('is true for a condition on activity, expertise or duty, not on source data', () => {
    expect(usesOrgKnowledge({ filters: { activity: f(['x']) } })).toBe(true);
    expect(usesOrgKnowledge({ filters: handlerOrLead })).toBe(false);
    expect(usesOrgKnowledge(null)).toBe(false);
  });
});

describe('ruleSentence', () => {
  const rule = { includeChildren: true, filters: handlerOrLead };

  it('says a rule-based role in one sentence: scope, conditions, joiners and leavers', () => {
    expect(ruleSentence({ kind: 'rule', rule, joinerPolicy: 'auto', leaverPolicy: 'remove' }, 'Property Claims', people))
      .toBe('Everyone in Property Claims and its sub-units whose job title contains “handler” or is Team lead Property — added automatically, removed when they no longer match.');
    const two = { includeChildren: false, filters: { ...handlerOrLead, activity: f(['handle property claims']) } };
    expect(ruleSentence({ kind: 'rule', rule: two, joinerPolicy: 'approval', leaverPolicy: 'keep' }, 'Claims', people))
      .toBe('Everyone in Claims whose job title contains “handler” or is Team lead Property and whose activity is Handle property claims — added after approval, kept when they no longer match.');
    expect(ruleSentence({ kind: 'rule', rule: { includeChildren: true, filters: {} }, joinerPolicy: 'auto', leaverPolicy: 'review' }, 'Claims', people))
      .toBe('Everyone in Claims and its sub-units — added automatically, reviewed when they no longer match.');
  });

  it('says a requestable role: who may request it, who approves, what happens when they leave', () => {
    expect(ruleSentence({ kind: 'requestable', rule: { includeChildren: true, filters: {} }, approver: { kind: 'accountable' }, leaverPolicy: 'review' }, 'Property Claims', people, 'Sophie Willems'))
      .toBe("Requestable by everyone in Property Claims and its sub-units, approved by the unit's Accountable (Sophie Willems); when they leave the unit: reviewed.");
    expect(ruleSentence({ kind: 'requestable', rule: null, approver: null, leaverPolicy: 'remove' }, 'X', people))
      .toBe('Requestable by anyone, approved by an approver not chosen yet; when they leave the unit: removed.');
  });

  it('says nothing for a role without a kind, or a rule-based role without a rule', () => {
    expect(ruleSentence({ kind: null, rule }, 'X', people)).toBeNull();
    expect(ruleSentence({ kind: 'rule', rule: null }, 'X', people)).toBeNull();
  });
});

describe('approverText and the kinds', () => {
  it('names the approver', () => {
    expect(approverText({ kind: 'accountable' }, null)).toBe("the unit's Accountable");
    expect(approverText({ kind: 'owner' })).toBe("the role's owner");
    expect(approverText({ kind: 'person', name: 'Max Jacobs' })).toBe('Max Jacobs');
    expect(approverText({ kind: 'person' })).toBe('a named person');
  });

  it('maps each kind to the assignment origin', () => {
    expect(ROLE_KINDS.map(k => [k.key, k.origin])).toEqual([['rule', 'Automatic'], ['requestable', 'Requested']]);
  });
});

describe('roleProblems / roleNotes', () => {
  const ok = { name: 'Claims Lawyer', kind: 'requestable', entitlements: new Set(['r1']), rule: null };

  it('asks for a name, a kind and an entitlement — nothing more', () => {
    expect(roleProblems(ok)).toEqual([]);
    expect(roleProblems({ name: '  ', kind: null, entitlements: new Set() })).toEqual([
      'Give the role a name.',
      'Choose how it is assigned (rule-based or requestable).',
      'Add at least one entitlement (select cells or a column header, then Add to candidate).',
    ]);
  });

  it('notes, without blocking, a rule-based role whose members are chosen by hand', () => {
    expect(roleNotes({ ...ok, kind: 'rule' })).toEqual(['It will be saved with members chosen by hand — it has no assignment rule yet.']);
    expect(roleNotes({ ...ok, kind: 'rule', rule: { filters: {} } })).toEqual([]);
    expect(roleNotes(ok)).toEqual([]);
    expect(roleProblems({ ...ok, kind: 'rule' })).toEqual([]);
  });
});
