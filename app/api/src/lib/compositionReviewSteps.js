// The steps of a composition review and what a reviewer may say about each
// (migration 120). Pure: no database here.
//
// A review walks through steps and gives each one a verdict. Which steps a
// review has is up to whoever asks for it — today the wizard asks all of them,
// later a campaign may ask only some — so nothing here assumes all three.

export const STEPS = Object.freeze(['ownership', 'lifecycle', 'contents']);
export const VERDICTS = Object.freeze(['good', 'needsChange', 'notUnderstood']);
// The one step whose change can name people.
export const OWNERSHIP = 'ownership';

export const MAX_NOTES = 10_000;
export const MAX_REMARK = 4_000;
export const MAX_PROPOSED_RESPONSIBLE = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (error) => ({ error });

/** The id a person reference names, with its kind: an account, else a person. */
export function personKey(ref) {
  if (ref?.principalId) return `principal:${String(ref.principalId).toLowerCase()}`;
  if (ref?.identityId) return `identity:${String(ref.identityId).toLowerCase()}`;
  return null;
}

// One proposed person: exactly one of principalId / identityId, a uuid. A name
// in the body is ignored — the name stored is the directory's (resolveProposal).
function parsePerson(raw) {
  if (!isObject(raw)) return null;
  const { principalId, identityId } = raw;
  if (principalId && identityId) return null;
  if (typeof principalId === 'string' && UUID.test(principalId)) return { principalId: principalId.toLowerCase() };
  if (typeof identityId === 'string' && UUID.test(identityId)) return { identityId: identityId.toLowerCase() };
  return null;
}

/**
 * The owners as the reviewer says they should be, or { error }. `accountable`
 * is one person or null (nobody); `responsible` a list without repeats.
 */
export function parseProposal(raw) {
  if (!isObject(raw)) return fail('The proposed owners must be an object');
  let accountable = null;
  if (raw.accountable !== null && raw.accountable !== undefined) {
    accountable = parsePerson(raw.accountable);
    if (!accountable) return fail('Choose the Accountable person from the list');
  }
  const list = raw.responsible ?? [];
  if (!Array.isArray(list)) return fail('The proposed Responsible people must be a list');
  if (list.length > MAX_PROPOSED_RESPONSIBLE) return fail(`Propose at most ${MAX_PROPOSED_RESPONSIBLE} Responsible people`);
  const responsible = [];
  const seen = new Set();
  for (const item of list) {
    const person = parsePerson(item);
    if (!person) return fail('Choose the Responsible people from the list');
    const key = personKey(person);
    if (seen.has(key)) continue;
    seen.add(key);
    responsible.push(person);
  }
  return { accountable, responsible };
}

function parseStep(raw) {
  if (!isObject(raw)) return fail('Every step must be an object');
  if (!STEPS.includes(raw.step)) return fail(`Unknown step. Use one of: ${STEPS.join(', ')}`);
  if (!VERDICTS.includes(raw.verdict)) return fail(`Give every step a verdict: ${VERDICTS.join(', ')}`);
  if (raw.remark !== undefined && raw.remark !== null && typeof raw.remark !== 'string') return fail('A remark must be text');
  const remark = typeof raw.remark === 'string' ? raw.remark.trim() : '';
  if (remark.length > MAX_REMARK) return fail(`A remark can be at most ${MAX_REMARK} characters`);
  let proposal = null;
  if (raw.proposal !== undefined && raw.proposal !== null) {
    if (raw.step !== OWNERSHIP || raw.verdict !== 'needsChange') return fail('Only a change to who answers for the role can propose people');
    proposal = parseProposal(raw.proposal);
    if (proposal.error) return proposal;
  }
  // A step that is fine needs no words; they would only contradict the verdict.
  return { step: raw.step, verdict: raw.verdict, remark: raw.verdict === 'good' ? '' : remark, proposal };
}

/**
 * { steps, notes } from a request body, or { error }. Steps come back in the
 * fixed order of STEPS, whatever order they were sent in.
 */
export function parseReviewBody(body) {
  if (body?.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') return fail('notes must be text');
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (notes.length > MAX_NOTES) return fail(`notes can be at most ${MAX_NOTES} characters`);
  if (!Array.isArray(body?.steps) || body.steps.length === 0) return fail('A review judges at least one step');
  const byStep = new Map();
  for (const raw of body.steps) {
    const step = parseStep(raw);
    if (step.error) return step;
    if (byStep.has(step.step)) return fail(`The step ${step.step} is judged twice`);
    byStep.set(step.step, step);
  }
  return { steps: STEPS.filter(s => byStep.has(s)).map(s => byStep.get(s)), notes };
}

/** A step that asks for a change has to say which one: in words or in people. */
export function unexplainedChange(steps) {
  return steps.find(s => s.verdict === 'needsChange' && s.remark === '' && !s.proposal) ?? null;
}

/** What the review found: nothing, or something. Finishing it is not agreeing. */
export function outcomeOf(steps) {
  return steps.every(s => s.verdict === 'good') ? 'noFindings' : 'findings';
}

/** Steps in the fixed order, as stored rows may come in any. */
export function orderSteps(steps) {
  return [...steps].sort((a, b) => STEPS.indexOf(a.step) - STEPS.indexOf(b.step));
}

/** The owners a snapshot shows, in the shape of a proposal (ids only). */
export function ownersOfSnapshot(snapshot) {
  const owners = snapshot?.owners ?? [];
  const ref = (o) => (o.principalId ? { principalId: o.principalId } : { identityId: o.identityId });
  const held = owners.filter(o => personKey(o));
  const accountable = held.find(o => o.role === 'Accountable');
  return {
    accountable: accountable ? ref(accountable) : null,
    responsible: held.filter(o => o.role === 'Responsible').map(ref),
  };
}

/** Does the proposal name exactly the people who answer for the role already? */
export function sameOwners(proposal, current) {
  if (personKey(proposal.accountable) !== personKey(current.accountable)) return false;
  const want = new Set(proposal.responsible.map(personKey));
  const have = new Set(current.responsible.map(personKey));
  return want.size === have.size && [...want].every(k => have.has(k));
}
