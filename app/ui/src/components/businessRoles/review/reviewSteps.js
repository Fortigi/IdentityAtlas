// ─── A composition review, step by step: the words and the rules ─────────
// Pure helpers for the review wizard and the record of a saved review. The
// steps and verdicts are the API's (lib/compositionReviewSteps.js); which steps
// a review asks comes from the API too, so a later campaign that asks only some
// of them needs nothing changed here.

export const STEP_INFO = {
  ownership: {
    label: 'Who answers for it',
    question: 'Are these the right people to answer for this role?',
    help: 'Accountable answers for who may hold the role and what it contains. Responsible keeps it correct day to day.',
  },
  lifecycle: {
    label: 'Lifecycle',
    question: 'Is this how people should get, keep and lose this role?',
    help: 'Check the rules, who approves a request and who reviews the people who hold it.',
  },
  contents: {
    label: 'Permissions',
    question: 'Are these the right permissions for this role?',
    help: 'Everyone who holds the role gets all of these.',
  },
};

export const VERDICT_INFO = {
  good: { label: 'Good', short: 'Good' },
  needsChange: {
    label: 'Needs a change', short: 'Needs a change',
    remarkLabel: 'What should change?', placeholder: 'Describe the change you propose',
  },
  notUnderstood: {
    label: 'I do not understand what I am reading', short: 'Not understood',
    remarkLabel: 'What is your question?', placeholder: 'Ask what you need to know to judge this (optional)',
  },
};

export const SIGN_STEP = 'sign';
export const HOLDERS_LOST_DAYS = 90;

export const stepLabel = (step) => STEP_INFO[step]?.label ?? step;
export const verdictLabel = (verdict) => VERDICT_INFO[verdict]?.short ?? verdict;

/** The id a person reference names, with its kind: an account, else a person. */
export function personKey(p) {
  if (p?.principalId) return `principal:${String(p.principalId).toLowerCase()}`;
  if (p?.identityId) return `identity:${String(p.identityId).toLowerCase()}`;
  return null;
}

const asPerson = (o) => ({
  ...(o.principalId ? { principalId: o.principalId } : { identityId: o.identityId }),
  displayName: o.displayName ?? null,
});

/** Who answers for the role in a snapshot, as people a proposal can start from. */
export function ownersOf(snapshot) {
  const held = (snapshot?.owners ?? []).filter(o => personKey(o));
  const accountable = held.find(o => o.role === 'Accountable');
  return {
    accountable: accountable ? asPerson(accountable) : null,
    responsible: held.filter(o => o.role === 'Responsible').map(asPerson),
  };
}

/** Does the proposal name exactly the people in `current`? */
export function sameOwners(proposal, current) {
  if (personKey(proposal.accountable) !== personKey(current.accountable)) return false;
  const want = new Set(proposal.responsible.map(personKey));
  const have = new Set(current.responsible.map(personKey));
  return want.size === have.size && [...want].every(k => have.has(k));
}

const nameOf = (p) => p?.displayName || 'someone without a name';

/**
 * A proposal against the owners it was made for, as sentences:
 * "Accountable: Ann instead of Bob", "Add Carla as Responsible". Empty when the
 * proposal changes nothing.
 */
export function ownerChanges(current, proposal) {
  if (!proposal) return [];
  const out = [];
  if (personKey(proposal.accountable) !== personKey(current.accountable)) {
    if (!proposal.accountable) out.push(`Nobody Accountable instead of ${nameOf(current.accountable)}`);
    else if (!current.accountable) out.push(`Make ${nameOf(proposal.accountable)} Accountable`);
    else out.push(`Accountable: ${nameOf(proposal.accountable)} instead of ${nameOf(current.accountable)}`);
  }
  const have = new Set(current.responsible.map(personKey));
  const want = new Set(proposal.responsible.map(personKey));
  for (const p of proposal.responsible) if (!have.has(personKey(p))) out.push(`Add ${nameOf(p)} as Responsible`);
  for (const p of current.responsible) if (!want.has(personKey(p))) out.push(`Remove ${nameOf(p)} as Responsible`);
  return out;
}

/** The wizard's answers before anything is filled in. */
export function emptyAnswers(steps, current) {
  return Object.fromEntries(steps.map(step => [step, {
    verdict: null,
    remark: '',
    ...(step === 'ownership' ? { proposal: ownersOf(current) } : {}),
  }]));
}

const proposes = (step, answer, current) =>
  step === 'ownership' && answer.verdict === 'needsChange' && !!answer.proposal && !sameOwners(answer.proposal, ownersOf(current));

/**
 * Why the reviewer cannot go on from this step yet, or null when they can: no
 * verdict, or a change that says neither what nor who.
 */
export function stepProblem(step, answer, current) {
  if (!answer?.verdict) return 'Choose one of the three';
  if (answer.verdict !== 'needsChange') return null;
  if (answer.remark.trim() !== '' || proposes(step, answer, current)) return null;
  return step === 'ownership' ? 'Choose who it should be, or describe the change' : 'Describe the change you propose';
}

const refOf = (p) => (p.principalId ? { principalId: p.principalId } : { identityId: p.identityId });

/** What the wizard sends: one entry per step, ids only for proposed people. */
export function buildBody(steps, answers, notes, current) {
  return {
    steps: steps.map((step) => {
      const a = answers[step];
      const out = { step, verdict: a.verdict, remark: a.verdict === 'good' ? '' : a.remark.trim() };
      if (proposes(step, a, current)) {
        out.proposal = {
          accountable: a.proposal.accountable ? refOf(a.proposal.accountable) : null,
          responsible: a.proposal.responsible.map(refOf),
        };
      }
      return out;
    }),
    notes: notes.trim(),
  };
}

/** How many steps of a review are not simply good. */
export const findingsCount = (steps = []) => steps.filter(s => s.verdict !== 'good').length;

/** "no findings" / "1 finding" / "2 findings". */
export function outcomeText(steps = []) {
  const n = findingsCount(steps);
  if (n === 0) return 'no findings';
  return `${n} finding${n === 1 ? '' : 's'}`;
}

/**
 * The people who hold the role now and those who lost it in the last `days`
 * days, newest loss first. A row is /api/access-package/:id/assignments's.
 */
export function splitHolders(rows, now = Date.now(), days = HOLDERS_LOST_DAYS) {
  const since = now - days * 86_400_000;
  const current = rows.filter(r => !r.deleted);
  const lost = rows
    .filter(r => r.deleted && r.deletedAt && Date.parse(r.deletedAt) >= since)
    .sort((a, b) => Date.parse(b.deletedAt) - Date.parse(a.deletedAt));
  return { current, lost };
}
