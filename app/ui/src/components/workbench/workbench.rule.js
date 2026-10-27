// Authorization workbench — a proposed role's assignment rule. Pure.
//
// The rule says who should hold the role, the way an IGA assignment policy does
// (Entra access-package auto-assignment policy, Omada assignment policy — the
// governance model's AssignmentPolicies; see docs/architecture/m1-discovery-and-design.md):
//
//   scope       the people of the unit — with its sub-units, or only its own
//   conditions  the workbench's column filters: AND across columns, ANY ticked value
//               (or a "contains" text) within a column; none = everyone in scope
//   exceptions  always include / always exclude these people
//   joiners     someone who starts matching: added automatically, or after approval
//   leavers     someone who stops matching: removed automatically, reviewed, or kept
//
// A role without a rule keeps its members chosen by hand. With one, its members
// are computed from the people loaded now ("matches now"); the rule would also
// apply to people who join the unit later. Nothing is enforced anywhere.

import { applyFilters, columnByKey, distinctValues } from './workbench.columns';

export const JOINER_POLICIES = Object.freeze([
  { key: 'auto', label: 'Add automatically', sentence: 'added automatically' },
  { key: 'approval', label: 'Ask for approval', sentence: 'added after approval' },
]);
export const LEAVER_POLICIES = Object.freeze([
  { key: 'remove', label: 'Remove automatically', sentence: 'removed when they no longer match' },
  { key: 'review', label: 'Ask for review', sentence: 'reviewed when they no longer match' },
  { key: 'keep', label: 'Keep', sentence: 'kept when they no longer match' },
]);
export const DEFAULT_POLICY = Object.freeze({ joinerPolicy: 'auto', leaverPolicy: 'remove' });

// The two kinds of proposed role, and the assignment `origin` each leads to
// (CLAUDE.md "Assignment origin"): Automatic for a rule, Requested for a request.
export const ROLE_KINDS = Object.freeze([
  { key: 'rule', label: 'Rule-based', title: 'Rule-based — assigned automatically', origin: 'Automatic', short: 'rule-based',
    help: 'Who matches the rule holds it: added and removed as people join, move and leave.' },
  { key: 'requestable', label: 'Requestable', title: 'Requestable — people request it and someone approves', origin: 'Requested', short: 'requestable',
    help: 'Nobody gets it automatically: people who may request it ask, and an approver decides.' },
]);

const copyFilter = (f) => ({ values: new Set(f.values), includeProposed: f.includeProposed !== false, contains: [...(f.contains || [])] });

/** A rule from the workbench's current scope and filters (a copy: later filtering does not change it). Pure. */
export function ruleFromView({ includeChildren, filters }) {
  const conditions = Object.fromEntries(Object.entries(filters || {}).filter(([, f]) => f).map(([k, f]) => [k, copyFilter(f)]));
  return { includeChildren: includeChildren !== false, filters: conditions };
}

/** The people the rule matches among these: in scope (the unit itself, or with its sub-units) and passing every condition. Pure. */
export function ruleMatches(rule, people) {
  const inScope = rule.includeChildren ? people : people.filter(p => p.direct);
  return applyFilters(inScope, rule.filters);
}

/**
 * Who holds a proposed role: for a rule-based one, its rule's matches plus
 * "always include", minus "always exclude"; otherwise (requestable, no rule yet,
 * kind not chosen) its members chosen by hand — a requestable role's rule says who
 * may request it, not who holds it. Pure.
 */
export function effectiveMembers(draft, people) {
  if (draft.kind !== 'rule' || !draft.rule) return draft.members;
  const out = new Set(ruleMatches(draft.rule, people).map(p => p.key));
  for (const k of draft.members) out.add(k);
  for (const k of draft.excluded || []) out.delete(k);
  return out;
}

/** Does the rule rest on what Identity Atlas knows of people's work (activity, expertise, duty) rather than source data? Pure. */
export function usesOrgKnowledge(rule) {
  return Object.keys(rule?.filters || {}).some(k => columnByKey.get(k)?.type === 'knowledge');
}

const quote = (s) => `“${s}”`;

// One condition in words: "whose job title contains “handler” or is Team lead Property".
function conditionText(key, filter, people) {
  const column = columnByKey.get(key);
  const labels = distinctValues(people, column, filter.includeProposed !== false)
    .filter(v => filter.values.has(v.value)).map(v => (v.value === '__blank' ? 'not known' : v.label));
  const parts = [...(filter.contains || []).map(t => `contains ${quote(t)}`), ...labels.map(l => `is ${l}`)];
  const name = column.label.toLowerCase();
  return parts.length ? `whose ${name} ${parts.join(' or ')}` : `whose ${name} is nothing`;
}

const policySentence = (list, key) => (list.find(p => p.key === key) ?? list[0]).sentence;

// Who approves a request, in words.
export function approverText(approver, accountable) {
  if (!approver) return 'an approver not chosen yet';
  if (approver.kind === 'accountable') return accountable ? `the unit's Accountable (${accountable})` : "the unit's Accountable";
  if (approver.kind === 'owner') return "the role's owner";
  return approver.name || 'a named person';
}

/**
 * A proposed role's rule as one sentence. Rule-based: "Everyone in Property
 * Claims and its sub-units whose job title contains “handler” or is Team lead
 * Property — added automatically, removed when they no longer match."
 * Requestable: "Requestable by everyone in Property Claims, approved by the
 * unit's Accountable (Sophie Willems); when they leave: reviewed." Null when the
 * kind is not chosen, or a rule-based role has no rule yet. Pure.
 */
export function ruleSentence(draft, unitName, people, accountable = null) {
  const rule = draft.rule;
  const scope = (who) => `${who} in ${unitName}${rule.includeChildren ? ' and its sub-units' : ''}`;
  const conditions = rule ? Object.entries(rule.filters).map(([k, f]) => conditionText(k, f, people)) : [];
  const condition = conditions.length ? ` ${conditions.join(' and ')}` : '';
  if (draft.kind === 'requestable') {
    const who = rule ? `${scope('everyone')}${condition}` : 'anyone';
    return `Requestable by ${who}, approved by ${approverText(draft.approver, accountable)}; when they leave the unit: ${policySentence(LEAVER_POLICIES, draft.leaverPolicy).replace(' when they no longer match', '')}.`;
  }
  if (draft.kind !== 'rule' || !rule) return null;
  return `${scope('Everyone')}${condition} — ${policySentence(JOINER_POLICIES, draft.joinerPolicy)}, ${policySentence(LEAVER_POLICIES, draft.leaverPolicy)}.`;
}
/**
 * What a proposed role still needs before it can be saved as a role: a name, its
 * kind, and at least one entitlement. Pure.
 */
export function roleProblems(candidate) {
  const out = [];
  if (!candidate.name?.trim()) out.push('Give the role a name.');
  if (!candidate.kind) out.push('Choose how it is assigned (rule-based or requestable).');
  if (!candidate.entitlements?.size) out.push('Add at least one entitlement (select cells or a column header, then Add to candidate).');
  return out;
}

/** What is worth knowing but does not stop a save: a rule-based role without a rule. Pure. */
export function roleNotes(candidate) {
  return candidate.kind === 'rule' && !candidate.rule ? ['Members chosen by hand — no rule yet.'] : [];
}
