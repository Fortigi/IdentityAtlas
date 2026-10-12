// Organisation knowledge extraction — stage 6: what the reviewer should look at.
//
//   ruleFindings({ mentions, resolutions, claims, language })       → finding[]   (pure)
//   modelFindings(found, passages)                                    → finding[]   (pure)
//   directoryFindings({ claims, resolutions, language })              → finding[]   (reads assignments)
//   findingKey(f)                                                     → stable key (re-runs update, never duplicate)
//
// A finding is { kind: 'issue'|'question', category, text, related: { mentions?, claims?, passages? }, origin }.
// None of them is a conclusion about access: "the interview names three board
// members, the group has four" is a question to ask, not excess access.
import { createHash } from 'node:crypto';
import { query } from '../../db/connection.js';

export const MAX_UNCERTAIN_QUESTIONS = 5;

const T = {
  nl: {
    unresolved: (m) => `Wie of wat is "${m.label}"? Er is geen bestaand object met die naam gevonden (mogelijk een spel- of herkenningsfout).`,
    noGroup: (m) => `Welke groep, context of Teams-site hoort bij "${m.label}"? In Identity Atlas is niets met die naam gevonden.`,
    ambiguous: (m, names) => `Welke "${m.label}" wordt bedoeld? Meerdere kandidaten: ${names}.`,
    correction: (c) => `De spreker corrigeert zich over "${c.subject} — ${c.object}"; controleer welke versie klopt.`,
    uncertain: (c) => `Bevestigen: ${c.subject} ${c.predicate} ${c.object}${c.qualifier ? ` (${c.qualifier})` : ''} — de spreker was hier niet zeker.`,
    notMember: (who, group) => `Volgens het interview hoort ${who} bij "${group}", maar ${who} is geen lid van de groep "${group}". Klopt de groep, of ontbreekt het lidmaatschap?`,
    count: (team, said, members) => `Het interview noemt ${said} leden van "${team}"; de gelijknamige groep heeft er ${members}. Wie hoort er (nog) bij?`,
  },
  en: {
    unresolved: (m) => `Who or what is "${m.label}"? No existing object of that name was found (possibly a spelling or recognition error).`,
    noGroup: (m) => `Which group, context or Teams site belongs to "${m.label}"? Nothing of that name was found in Identity Atlas.`,
    ambiguous: (m, names) => `Which "${m.label}" is meant? Several candidates: ${names}.`,
    correction: (c) => `The speaker corrects themselves about "${c.subject} — ${c.object}"; check which version is right.`,
    uncertain: (c) => `Confirm: ${c.subject} ${c.predicate} ${c.object}${c.qualifier ? ` (${c.qualifier})` : ''} — the speaker was not sure here.`,
    notMember: (who, group) => `The interview says ${who} belongs to "${group}", but ${who} is not a member of the group "${group}". Is the group right, or is the membership missing?`,
    count: (team, said, members) => `The interview names ${said} members of "${team}"; the group of that name has ${members}. Who belongs to it (still)?`,
  },
};
const texts = (language) => T[language === 'en' ? 'en' : 'nl'];

const RESOLVABLE = new Set(['person', 'team', 'customer', 'organisation', 'application', 'role']);

export function findingKey(f) {
  return createHash('sha256').update(`${f.kind}|${f.category}|${f.text}`).digest('hex').slice(0, 40);
}

export function ruleFindings({ mentions, resolutions, claims, language }) {
  const t = texts(language);
  const out = [];
  for (const m of mentions) {
    const r = resolutions.get(m.key);
    if (!r || !RESOLVABLE.has(m.type)) continue;
    if (r.status === 'unmatched') {
      const text = m.type === 'team' || m.type === 'role' ? t.noGroup(m) : t.unresolved(m);
      out.push({ kind: 'question', category: m.type === 'team' ? 'no-system-object' : 'unresolved-name', text, related: { mentions: [m.key] }, origin: 'rule' });
    } else if (r.status === 'ambiguous') {
      const top = r.candidates[0].confidence;
      const names = r.candidates.filter(c => c.confidence === top).map(c => c.label).join(', ');
      out.push({ kind: 'question', category: 'ambiguous-name', text: t.ambiguous(m, names), related: { mentions: [m.key] }, origin: 'rule' });
    }
  }
  for (const c of claims.filter(x => x.modality === 'correction')) {
    out.push({ kind: 'issue', category: 'self-correction', text: t.correction(c), related: { claims: [c.key] }, origin: 'rule' });
  }
  for (const c of claims.filter(x => x.modality === 'uncertain').slice(0, MAX_UNCERTAIN_QUESTIONS)) {
    out.push({ kind: 'question', category: 'uncertain-statement', text: t.uncertain(c), related: { claims: [c.key] }, origin: 'rule' });
  }
  return out;
}

export function modelFindings(found, passages) {
  const bySeq = new Map(passages.map(p => [p.seq, p]));
  return found.map(f => ({
    kind: f.kind, category: 'model', text: f.text,
    related: { passages: f.passages.filter(n => bySeq.has(n)) }, origin: 'model',
  }));
}

const topOf = (r, types) => (r && r.status === 'candidates' && types.includes(r.candidates[0]?.targetType) ? r.candidates[0] : null);

// The principals behind a person candidate: the account itself, or an identity's accounts.
const PRINCIPALS_SQL = `
  SELECT $1::uuid AS id WHERE $2 = 'Principal'
  UNION
  SELECT im."principalId" FROM "IdentityMembers" im WHERE $2 = 'Identity' AND im."identityId" = $1::uuid`;
const MEMBER_SQL = `
  SELECT count(*)::int AS n FROM "ResourceAssignments"
   WHERE "resourceId" = $1::uuid AND "principalId" = ANY($2::uuid[])`;
const MEMBER_COUNT_SQL = `
  SELECT count(DISTINCT "principalId")::int AS n FROM "ResourceAssignments" WHERE "resourceId" = $1::uuid`;

/** memberOf statements compared with the directory, through the TOP candidates only. */
export async function directoryFindings({ claims, resolutions, language }) {
  const t = texts(language);
  const out = [];
  const bySubjectCount = new Map();
  for (const c of claims.filter(x => x.predicate === 'memberOf')) {
    const person = topOf(resolutions.get(c.subjectKey), ['Identity', 'Principal']);
    const group = topOf(resolutions.get(c.objectKey), ['Resource']);
    if (!group) continue;
    bySubjectCount.set(group.targetId, { group, count: (bySubjectCount.get(group.targetId)?.count ?? 0) + 1, objectKey: c.objectKey, object: c.object });
    if (!person) continue;
    const principals = (await query(PRINCIPALS_SQL, [person.targetId, person.targetType])).rows.map(r => r.id);
    if (principals.length === 0) continue;
    const n = (await query(MEMBER_SQL, [group.targetId, principals])).rows[0]?.n ?? 0;
    if (n === 0) {
      out.push({ kind: 'question', category: 'directory-gap', text: t.notMember(person.label, group.label), related: { claims: [c.key] }, origin: 'rule' });
    }
  }
  for (const { group, count, objectKey } of bySubjectCount.values()) {
    const members = (await query(MEMBER_COUNT_SQL, [group.targetId])).rows[0]?.n ?? 0;
    if (members !== count) {
      out.push({ kind: 'question', category: 'member-count', text: t.count(group.label, count, members), related: { mentions: [objectKey] }, origin: 'rule' });
    }
  }
  return out;
}
