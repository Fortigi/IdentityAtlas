import { formatUtcDay } from '@ui/utils/formatters';

// ─── The improvements step: role mining's suggestions, in words ──────────
// Pure helpers for the wizard's improvements step and for the record of a
// saved review. The suggestions are the API's
// (GET /api/access-package/:id/composition-reviews/improvements,
// lib/roleImprovements.js): it shows only what it is at least 95% sure of, so
// an empty list is an answer too.

export const IMPROVEMENTS = 'improvements';

export const DECISION_INFO = {
  adopt: { label: 'Propose this', short: 'Proposed' },
  decline: { label: 'Not for this role', short: 'Declined' },
  notUnderstood: { label: 'I do not understand this', short: 'Not understood' },
};
export const DECISIONS = Object.keys(DECISION_INFO);

const ATTRIBUTE_LABEL = { department: 'department', jobTitle: 'job title', companyName: 'company' };
const people = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
const doNot = (n) => (n === 1 ? 'does not' : 'do not');

/** 'department is "Development" and job title is "Engineer"'. */
export function ruleText(conditions = []) {
  return conditions.map(c => `${ATTRIBUTE_LABEL[c.attribute] ?? c.attribute} is "${c.value}"`).join(' and ');
}

function permissionWhy(s) {
  if (s.exact) return `All ${people(s.holders)} who hold this role have it themselves, nobody else has it, and no business role contains it.`;
  const others = s.othersWithIt > 0 ? `, and ${people(s.othersWithIt)} who ${doNot(s.othersWithIt)} hold the role` : ', and nobody else';
  const isNew = s.resource?.createdDateTime ? ` It is new: created on ${formatUtcDay(s.resource.createdDateTime)}.` : '';
  return `${s.holdersWithIt} of the ${people(s.holders)} who hold this role have it${others}.${isNew}`;
}

function ruleWhy(s) {
  if (s.exact) return `This role is handed out by hand. A rule would pick exactly the ${people(s.holders)} who hold it, nobody more.`;
  const others = s.othersMatched > 0 ? ` and ${people(s.othersMatched)} who ${doNot(s.othersMatched)} hold it` : '';
  return `This role is handed out by hand. A rule would pick ${s.holdersMatched} of the ${people(s.holders)} who hold it${others}.`;
}

/** { title, why } of one suggestion. */
export function suggestionText(s) {
  if (s.kind === 'automaticRule') {
    return { title: `Hand it out automatically to everyone whose ${ruleText(s.conditions)}`, why: ruleWhy(s) };
  }
  return { title: `Add ${s.resource?.displayName || 'a permission without a name'} to the role`, why: permissionWhy(s) };
}

/** The verdict the decisions give, as the API works it out. */
export function decisionsVerdict(decisions = {}) {
  const chosen = Object.values(decisions);
  if (chosen.includes('adopt')) return 'needsChange';
  if (chosen.includes('notUnderstood')) return 'notUnderstood';
  return 'good';
}

/** Why the reviewer cannot go on yet, or null. */
export function improvementsProblem(answer, found) {
  if (!found) return 'Role mining is still looking';
  const open = found.suggestions.filter(s => !answer?.decisions?.[s.key]);
  if (open.length === 0) return null;
  return found.suggestions.length === 1 ? 'Decide on the suggestion' : 'Decide on every suggestion';
}

/** The step as the API wants it: a decision per suggestion it showed. */
export function improvementsBody(answer, found) {
  const decisions = (found?.suggestions ?? []).map(s => ({ key: s.key, decision: answer.decisions[s.key] }));
  const verdict = decisionsVerdict(answer.decisions);
  return { step: IMPROVEMENTS, decisions, remark: verdict === 'good' ? '' : answer.remark.trim() };
}

/** The step as a saved review shows it, for the last screen before signing. */
export function judgedImprovements(answer, found) {
  const suggestions = (found?.suggestions ?? []).map(s => ({ ...s, decision: answer.decisions[s.key] }));
  const verdict = decisionsVerdict(answer.decisions);
  return {
    step: IMPROVEMENTS,
    verdict,
    remark: verdict === 'good' ? '' : answer.remark,
    proposal: suggestions.length > 0 ? { suggestions, declinedBefore: found?.declinedBefore ?? 0 } : null,
  };
}
