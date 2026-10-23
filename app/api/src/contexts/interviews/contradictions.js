// Context interviews — which claims contradict a fact, or each other.
//
//   findContradictions({ claims, context, members, accountable }) → [contradiction]   (pure)
//   loadContradictions(db, contextId, claims)                     → [contradiction]   (two statements)
//
// A claim that adds something nobody contradicts is just more knowledge and keeps
// the ordinary review. A claim that DISAGREES with something we hold is shown as
// a pair — the claim and what it contradicts, each with its source — and asks for
// a decision. Fixed rules, set-based (the context's claims, one statement for the
// context and its source, one for the members the claims name):
//
//   leftButMember    an interview says a person left (membership former / left, or
//                    a role claim that says so — leftSignal.js) while the context's
//                    member list (its source: a sync, an upload, a plugin, or kept by
//                    hand) still lists them. Not when they came back (rejoinOf).
//   memberNotListed  an interview says a person is in it (current / joined /
//                    rejoined) while the member list does not list them
//   accountable      a role claim suggests X as Accountable while Y is (synced owner,
//                    plugin, an analyst)
//   notOwner         the current Accountable says they are not the owner (what the
//                    People block called "In doubt")
//   property         a property claim gives an attribute another value than the
//                    context holds (case, accents and spacing aside)
//   claims           two claims disagree: present vs gone about one person, two values
//                    for one property, two different people named as the owner
//
// Aliases never contradict: a context may have any number of names, and a name
// that is another context's is dropped at extraction already (aliasHints.js).
//
// A contradiction is DECIDED by deciding its claim(s) — no table of its own: the
// claim's status, decidedBy and decidedAt are the record (and _history keeps the
// change). `resolution`:
//   interview  the claim was confirmed: the interview is right (a member who left
//              stays listed — members come from their source — and the row says
//              "Interview: left"; fixing the source is the source owner's job)
//   source     the claim was rejected: the list / the holder / the value is right
//   both       true at different times: the claim was confirmed with a period
//              (edited), or both claims of a pair were confirmed
//   first / second   of a pair, the one kept (the other rejected); neither: both rejected
// A rule that no longer holds once decided (an Accountable replaced, a property
// set) simply stops matching; the decision is on the timeline as an ordinary one.

import { normalizeName } from '../../lib/nameMatch.js';
import { leftSignal } from './leftSignal.js';
import { personKey, rejoinOf } from './memberFacts.js';

const PRESENT = new Set(['current', 'joined', 'rejoined']);
const CONFIRMED = new Set(['confirmed', 'edited']);
const MEMBER_ID = { Principal: 'principalId', Identity: 'identityId' };

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const stamp = (c) => String(c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt ?? '');
const newerFirst = (a, b) => cmp(b.interviewedAt ?? '', a.interviewedAt ?? '') || cmp(stamp(b), stamp(a));
const newest = (list) => [...list].sort(newerFirst)[0] ?? null;
const live = (c) => c.status !== 'rejected';
const hasPeriod = (c) => !!(c.periodFrom || c.periodTo || c.periodText);
const day = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const sameValue = (a, b) => normalizeName(a).replace(/\s+/g, '') === normalizeName(b).replace(/\s+/g, '');
const who = (c) => c.subjectDisplayName || c.subjectName || 'someone';

/** The claim as one side of a contradiction: what it says, with its source. */
function claimSide(c, statement) {
  return {
    kind: 'claim', statement,
    claim: {
      id: c.id, interviewId: c.interviewId, claimKind: c.claimKind, attribute: c.attribute ?? null, value: c.value, status: c.status,
      subjectName: who(c), quote: c.quote ?? null, intervieweeName: c.intervieweeName, interviewedAt: c.interviewedAt,
      periodFrom: c.periodFrom ?? null, periodTo: c.periodTo ?? null, periodText: c.periodText ?? null,
      decidedBy: c.decidedBy ?? null, decidedAt: c.decidedAt ?? null,
    },
  };
}

const factSide = (statement, source) => ({ kind: 'fact', statement, source });

/** What the member list is called: its source system, "The member list" when kept by hand here. */
export function memberListName(context) {
  if (context.variant === 'manual') return 'The member list';
  return context.systemName || (context.variant === 'generated' ? 'The rule that derives it' : 'The source');
}

/** Where the member list comes from, with when: "Klanten (upload), last synced 2026-10-23". */
export function memberListSource(context, member) {
  const name = memberListName(context);
  if (context.variant === 'manual') return member?.addedAt ? `${name}, added ${day(member.addedAt)}` : name;
  const when = context.lastSyncAt ? `last synced ${day(context.lastSyncAt)}` : (member?.addedAt ? `listed since ${day(member.addedAt)}` : null);
  return when ? `${name}, ${when}` : name;
}

// The state of a single-claim contradiction, from its claim.
function single(c, extra) {
  let status = 'open';
  let resolution = null;
  if (c.status === 'rejected') { status = 'decided'; resolution = 'source'; }
  else if (CONFIRMED.has(c.status)) { status = 'decided'; resolution = c.status === 'edited' && hasPeriod(c) ? 'both' : 'interview'; }
  return { id: `${extra.rule}:${c.id}`, claimIds: [c.id], status, resolution, decidedAt: c.decidedAt ?? null, decidedBy: c.decidedBy ?? null, ...extra };
}

// The state of a two-claim contradiction, from both.
function pair(a, b, extra) {
  let status = 'open';
  let resolution = null;
  if (a.status === 'rejected' && b.status === 'rejected') { status = 'decided'; resolution = 'neither'; }
  else if (a.status === 'rejected') { status = 'decided'; resolution = 'second'; }
  else if (b.status === 'rejected') { status = 'decided'; resolution = 'first'; }
  else if (CONFIRMED.has(a.status) && CONFIRMED.has(b.status)) { status = 'decided'; resolution = 'both'; }
  const later = [a.decidedAt, b.decidedAt].filter(Boolean).sort().pop() ?? null;
  return { id: `${extra.rule}:${a.id}+${b.id}`, claimIds: [a.id, b.id], status, resolution, decidedAt: status === 'decided' ? later : null, decidedBy: (a.decidedBy || b.decidedBy) ?? null, ...extra };
}

function groupBy(rows, keyOf) {
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
}

const isPersonClaim = (c) => c.claimKind === 'membership' || c.claimKind === 'role' || c.claimKind === 'roleHistory';
const goneWords = (c) => (c.claimKind === 'membership' && c.attribute === 'former' ? 'is a former member' : 'left');
const presentWords = (c) => ({ current: 'is a member', joined: 'joined', rejoined: 'is back (rejoined)' }[c.attribute]);

// Membership against the member list, one person at a time.
function memberRules(personClaims, ctx) {
  const out = [];
  const col = MEMBER_ID[ctx.context.targetType];
  const first = personClaims[0];
  const id = col ? first[col] : null;
  if (!id) return out;
  const liveClaims = personClaims.filter(live);
  const member = ctx.members.get(id);
  const gone = newest(personClaims.filter(leftSignal));
  const present = newest(personClaims.filter(c => c.claimKind === 'membership' && PRESENT.has(c.attribute)));
  const latest = newest([gone, present].filter(Boolean).filter(live)) ?? newest([gone, present].filter(Boolean));
  const source = memberListSource(ctx.context, member);
  // Left and came back: in the list is right.
  if (member && gone && latest === gone && !rejoinOf(liveClaims)) {
    out.push(single(gone, {
      rule: 'leftButMember',
      claim: claimSide(gone, `Interview: ${who(gone)} ${goneWords(gone)}`),
      other: factSide(`${memberListName(ctx.context)} still lists ${who(gone)} as a member`, source),
    }));
  }
  if (!member && present && latest === present) {
    out.push(single(present, {
      rule: 'memberNotListed',
      claim: claimSide(present, `Interview: ${who(present)} ${presentWords(present)}`),
      other: factSide(`${memberListName(ctx.context)} does not list ${who(present)}`, source),
    }));
  }
  return out;
}

// Two claims about one person that disagree on being in it.
// Both confirmed, an earlier 'left' and a later present claim ARE the return
// (memberFacts rejoinOf): the pair then reads as decided 'both'. A return said in
// words elsewhere explains the pair away.
function membershipPair(personClaims) {
  const gone = newest(personClaims.filter(c => c.claimKind === 'membership' && !PRESENT.has(c.attribute) && leftSignal(c)));
  const present = newest(personClaims.filter(c => c.claimKind === 'membership' && PRESENT.has(c.attribute)));
  // 'rejoined' says they were gone before: no disagreement with a 'left'.
  if (!gone || !present || present.attribute === 'rejoined') return [];
  const back = rejoinOf(personClaims.filter(live));
  if (back && back.claimId !== present.id) return [];
  const [a, b] = [present, gone].sort(newerFirst).reverse();
  const words = (c) => (c === gone ? goneWords(c) : presentWords(c));
  return [pair(a, b, {
    rule: 'claims',
    claim: claimSide(a, `Interview: ${who(a)} ${words(a)}`),
    other: claimSide(b, `Interview: ${who(b)} ${words(b)}`),
  })];
}

const roleHolderSource = (acc) => ({ sync: 'from the source', algorithm: 'set by a rule', analyst: 'set by an analyst' }[acc.addedBy] || 'set');
const samePerson = (c, h) => (c.principalId && c.principalId === h.principalId) || (c.identityId && c.identityId === h.identityId);

function accountableRules(claims, accountable) {
  if (!accountable || !(accountable.principalId || accountable.identityId)) return [];
  const out = [];
  const holder = accountable.displayName || 'someone';
  const fact = factSide(`${holder} is the Accountable`, `${holder}, ${roleHolderSource(accountable)}`);
  for (const c of claims.filter(x => x.claimKind === 'role' && x.roleSuggestion === 'Accountable' && (x.principalId || x.identityId))) {
    if (samePerson(c, accountable)) continue;
    out.push(single(c, { rule: 'accountable', claim: claimSide(c, `Interview: ${who(c)} is the owner`), other: fact }));
  }
  for (const c of claims.filter(x => x.claimKind === 'role' && x.attribute === 'notOwner' && samePerson(x, accountable))) {
    out.push(single(c, { rule: 'notOwner', claim: claimSide(c, `Interview: ${who(c)} says they are not the owner`), other: fact }));
  }
  return out;
}

// Two different people named as the owner while there is no Accountable yet (with
// one, each such claim is an 'accountable' contradiction of its own).
function ownerPairs(claims, accountable) {
  if (accountable && (accountable.principalId || accountable.identityId)) return [];
  const owners = claims.filter(c => c.claimKind === 'role' && c.attribute === 'owner');
  const byPerson = [...groupBy(owners, personKey).values()].map(newest);
  if (byPerson.length < 2) return [];
  const [a, b] = byPerson.sort(newerFirst);
  return [pair(a, b, { rule: 'claims', claim: claimSide(a, `Interview: ${who(a)} is the owner`), other: claimSide(b, `Interview: ${who(b)} is the owner`) })];
}

function propertyRules(claims, context) {
  const out = [];
  const ext = context.extendedAttributes && typeof context.extendedAttributes === 'object' ? context.extendedAttributes : {};
  const props = claims.filter(c => c.claimKind === 'property' && c.attribute);
  const source = context.systemName || 'the context';
  for (const c of props) {
    const current = ext[c.attribute];
    if (current == null || typeof current === 'object' || sameValue(current, c.value)) continue;
    out.push(single(c, {
      rule: 'property',
      claim: claimSide(c, `Interview: ${c.attribute} is ${c.value}`),
      other: factSide(`${c.attribute} is ${current}`, source),
    }));
  }
  for (const list of groupBy(props, c => c.attribute.toLowerCase()).values()) {
    const distinct = [];
    for (const c of [...list].sort(newerFirst)) if (!distinct.some(d => sameValue(d.value, c.value))) distinct.push(c);
    if (distinct.length < 2) continue;
    const [a, b] = distinct;
    out.push(pair(a, b, { rule: 'claims', claim: claimSide(a, `Interview: ${a.attribute} is ${a.value}`), other: claimSide(b, `Interview: ${b.attribute} is ${b.value}`) }));
  }
  return out;
}

/**
 * Every contradiction among a context's claims (any status: an open one has a
 * proposed claim; a decided one says how). `context`: { targetType, variant,
 * systemName, lastSyncAt, extendedAttributes }; `members`: Map(memberId →
 * { addedBy, addedAt }) of the people the claims name who ARE direct members;
 * `accountable`: the current Accountable (store.currentAccountable) or null. Pure.
 */
export function findContradictions({ claims = [], context, members = new Map(), accountable = null }) {
  const out = [];
  const ctx = { context, members };
  for (const personClaims of groupBy(claims.filter(isPersonClaim), personKey).values()) {
    out.push(...memberRules(personClaims, ctx), ...membershipPair(personClaims));
  }
  out.push(...accountableRules(claims, accountable), ...ownerPairs(claims, accountable), ...propertyRules(claims, context));
  return out.sort((a, b) => cmp(a.status, b.status) === 0 ? cmp(a.id, b.id) : (a.status === 'open' ? -1 : 1));
}

// The context, its source system, and which of the named people are direct members.
export const CONTRADICTION_CONTEXT_SQL = `
    SELECT ctx."targetType", ctx.variant, ctx."extendedAttributes", s."displayName" AS "systemName", s."lastSyncDateTime" AS "lastSyncAt"
      FROM "Contexts" ctx
      LEFT JOIN "Systems" s ON s.id = ctx."scopeSystemId"
     WHERE ctx.id = $1`;
export const CONTRADICTION_MEMBERS_SQL = `
    SELECT cm."memberId", cm."addedBy", cm."addedAt"
      FROM "ContextMembers" cm
     WHERE cm."contextId" = $1 AND cm."memberId" = ANY($2::uuid[])`;

/** The contradictions among `claims` (already read, with their statuses) and the context's facts. */
export async function loadContradictions(db, contextId, claims, accountable) {
  if (claims.length === 0) return [];
  const context = (await db.query(CONTRADICTION_CONTEXT_SQL, [contextId])).rows[0];
  if (!context) return [];
  const col = MEMBER_ID[context.targetType];
  const ids = col ? [...new Set(claims.map(c => c[col]).filter(Boolean))] : [];
  const rows = ids.length ? (await db.query(CONTRADICTION_MEMBERS_SQL, [contextId, ids])).rows : [];
  const members = new Map(rows.map(r => [r.memberId, { addedBy: r.addedBy, addedAt: r.addedAt }]));
  return findContradictions({ claims, context, members, accountable });
}
