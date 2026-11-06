// Context interviews — the pure parts of showing a contradiction and deciding it.
//
// The API (GET /api/contexts/:id/claims → contradictions, contexts/interviews/
// contradictions.js) finds them and says which side is which; these functions
// only word the choices and turn one into the claim decisions that make it. A
// contradiction has no record of its own: deciding it IS deciding its claim(s).

export const RULE_TITLES = {
  leftButMember: 'Left, but still listed',
  memberNotListed: 'A member, but not listed',
  accountable: 'Another owner',
  notOwner: 'The Accountable says they are not the owner',
  property: 'Another value',
  claims: 'Two interviews disagree',
};

/** The DOM id of a context's Contradictions panel (the badge jumps to it). */
export const panelId = (contextId) => `contradictions-${contextId}`;

/** The contradictions still waiting for a decision. Pure. */
export const openContradictions = (list) => (list || []).filter(c => c.status === 'open');

/** "1 contradiction" / "3 contradictions". */
export const contradictionCount = (n) => `${n} ${n === 1 ? 'contradiction' : 'contradictions'}`;

const isProposed = (side) => side?.kind === 'claim' && side.claim?.status === 'proposed';
const step = (side, body) => ({ claimId: side.claim.id, claim: side.claim, body });

// Single-claim rules: [interview label, interview hint, source label, offer "both"?, confirm body].
const SINGLE = {
  leftButMember: (con) => ['The interview is right — mark as former',
    `Marks them former here and lists them under Previous members; ${con.other.source?.split(',')[0] || 'the source'} still lists them — remove them there, or re-import without them. Undo is possible.`,
    'The list is right', true, { status: 'confirmed' }],
  memberNotListed: (con) => ['The interview is right',
    `Records it; the member list comes from ${con.other.source?.split(',')[0] || 'the source'} — add them there.`,
    'The list is right', true, { status: 'confirmed' }],
  accountable: (con) => [`The interview is right — make ${con.claim.claim.subjectName} the Accountable`, null,
    `Keep ${con.other.statement.replace(/ is the Accountable$/, '')}`, false, { status: 'confirmed', replace: true }],
  notOwner: (con) => ['The interview is right', 'Records it; change the Accountable in the People block.',
    `Keep ${con.other.statement.replace(/ is the Accountable$/, '')} as the Accountable`, false, { status: 'confirmed' }],
  property: (con) => ['The interview is right — set it', null, `Keep “${con.other.statement}”`, false, { status: 'confirmed' }],
};

/**
 * The choices for an open contradiction: [{ key, label, hint?, needsPeriod?, steps }],
 * each step a claim decision ({ claimId, claim, body }) for the claims still
 * proposed. A "both, at different times" on one claim asks for the period first
 * (needsPeriod: the caller adds periodText to its body). Pure.
 */
export function decisionsFor(con) {
  if (!con || con.status !== 'open') return [];
  if (con.rule === 'claims') {
    const a = con.claim;
    const b = con.other;
    const keep = (yes, no) => [isProposed(yes) && step(yes, { status: 'confirmed' }), isProposed(no) && step(no, { status: 'rejected' })].filter(Boolean);
    return [
      { key: 'first', label: 'The first is right', steps: keep(a, b) },
      { key: 'second', label: 'The second is right', steps: keep(b, a) },
      { key: 'both', label: 'Both true, at different times', steps: [a, b].filter(isProposed).map(s => step(s, { status: 'confirmed' })) },
    ];
  }
  const rule = SINGLE[con.rule];
  if (!rule || !isProposed(con.claim)) return [];
  const [label, hint, sourceLabel, both, confirm] = rule(con);
  const out = [
    { key: 'interview', label, hint, steps: [step(con.claim, confirm)] },
    { key: 'source', label: sourceLabel, steps: [step(con.claim, { status: 'rejected' })] },
  ];
  if (both) out.push({ key: 'both', label: 'Both true, at different times', needsPeriod: true, steps: [step(con.claim, { status: 'edited' })] });
  return out;
}

/** The steps of a choice with the period filled in where it asks for one. Pure. */
export function withPeriod(choice, periodText) {
  if (!choice.needsPeriod) return choice.steps;
  return choice.steps.map(s => ({ ...s, body: { ...s.body, periodText: periodText.trim() } }));
}
