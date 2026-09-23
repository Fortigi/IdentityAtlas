// Natural-language reports — mistakes with exactly one sensible reading, put
// right here instead of by a second model round.
//
// On the hardware this runs on the model writes about one token a second, so a
// repair round — the model shown its mistake and asked for the whole definition
// again — costs one to three minutes, and the answer it comes back with is not
// reliably better: asked to fix "Added AND Removed", it dropped Removed and the
// 90-day window with it. Where the mistake has only one sensible correction,
// the correction is applied here, said out loud in the report's assumptions,
// and the model is not asked again.
//
// What is corrected, and why each is safe:
//
//   - two "is" conditions on one field, ANDed → the same two as alternatives.
//     "action is Added AND action is Removed" cannot match; as "either" it is
//     the question that was asked. (contradictions.js is what finds this.)
//   - a count above zero beside "has none of them" → the count goes. "owner
//     count > 0 AND no owner" came from a question about groups WITHOUT owners;
//     the relation is the reading, the count was the slip.
//   - "within the last N days" beside "more than M days ago", M ≥ N → the older
//     bound goes. Both came from one phrase ("in the last 90 days"), and only
//     the recent bound says what it said.
//   - a groupBy when the request never asked for counts → the grouping goes.
//     The model reads "which groups …" as "count per group" once in four hard
//     questions and answers "5" where five names were wanted.
//
// What is NOT corrected: "empty AND not empty", "count is zero AND has one" —
// two readings, so the model is asked. And nothing here looks at the data.

import { ENTITIES } from './catalog.js';
import { countSays } from './contradictions.js';
import { isVocabulary } from './terms.js';

// The words a request uses when it wants counts per value rather than a list.
// Deliberately generous: a grouping the request DID ask for and this rule
// removed would be worse than one it let through.
const COUNT_WORDS = /\b(hoeveel|aantal|aantallen|per|gegroepeerd|groepeer|groeperen|verdeling|verdeeld|telling|tel|uniek|unieke|how many|count|counts|counted|number of|grouped|group by|breakdown|distribution|unique|distinct|tally)\b/i;

/** Does the request ask for counts per value ("how many users per department")? */
export function asksForCounts(question) {
  return COUNT_WORDS.test(String(question ?? ''));
}

/**
 * A groupBy the request never asked for is removed.
 * @returns {{ spec: object, notes: string[] }}
 */
export function dropUnaskedGrouping(spec, question) {
  if (!spec?.groupBy || asksForCounts(question)) return { spec, notes: [] };
  const { groupBy, ...rest } = spec;
  return { spec: rest, notes: [`Listed the records themselves, not a count per ${groupBy}: the request did not ask for counts.`] };
}

const show = (v) => (typeof v === 'string' ? `"${v}"` : String(v));

// First-person words that make a question about the person asking. "me" is
// left out on purpose: "geef me een lijstje" / "give me a list" is not about
// the caller. "I" only as the capital word (the English pronoun).
const SELF_RE = /\b(ik|mijn|mijne|my|mine|myself)\b|\bI\b/;
export const selfWord = (question) => String(question ?? '').match(SELF_RE)?.[0] ?? null;

/**
 * "Groups I have that william does not" written with william on BOTH sides:
 * members some William AND members none William. The model has the shape
 * right and the person on one side wrong, and which side follows the order
 * of the question — the side mentioned first has, the second has not, in
 * both languages ("ik wel … william niet", "I have … william does not",
 * "william has … I don't"). The person asking replaces the duplicate on the
 * side the question mentions them on. Anything less clear-cut (a name that is
 * not in the question, no first-person word) is left to validation, which
 * refuses the contradiction and sends it back with the same explanation.
 * @returns {{ spec: object, notes: string[] }}
 */
export function resolveSelfAgainstPerson(spec, question, me) {
  const text = String(question ?? '');
  const self = text.match(SELF_RE);
  if (!self) return { spec, notes: [] };
  const relations = (spec?.conditions ?? []).filter(c => c.type === 'relation');
  const some = relations.find(c => c.quantifier !== 'none' && (c.conditions ?? []).length);
  const none = relations.find(c => c.quantifier === 'none' && c.relation === some?.relation);
  if (!some || !none || JSON.stringify(some.conditions) !== JSON.stringify(none.conditions)) return { spec, notes: [] };
  const named = some.conditions.find(c => c.field === 'displayName' && typeof c.value === 'string');
  if (!named) return { spec, notes: [] };
  const firstName = named.value.split(/[\s,]+/)[0].toLowerCase();
  const at = text.toLowerCase().indexOf(firstName);
  if (at < 0) return { spec, notes: [] };
  const selfFirst = self.index < at;
  const replaced = selfFirst ? some : none;
  const conditions = spec.conditions.map(c => (c === replaced
    ? { ...c, conditions: [{ type: 'field', field: 'id', op: 'eq', value: me }] }
    : c));
  return {
    spec: { ...spec, conditions },
    notes: [`Read the request as: the person asking ${selfFirst ? 'has' : 'has not'}, ${named.value} ${selfFirst ? 'has not' : 'has'}.`],
  };
}

/**
 * "id is [a, b, c]" — the model reached for eq with the list the follow-up
 * bookkeeping handed it. A list can only mean "one of", so the operator is
 * corrected; validation would otherwise drop the whole condition as a type
 * error and the report would be about everyone.
 * @returns {{ spec: object, notes: string[] }}
 */
export function listEqualsToIn(spec) {
  let changed = 0;
  const fix = (conditions) => (conditions ?? []).map((c) => {
    if (c.type === 'group' || c.type === 'relation') return { ...c, conditions: fix(c.conditions) };
    if (c.type === 'field' && c.op === 'eq' && Array.isArray(c.value)) { changed++; return { ...c, op: 'in' }; }
    return c;
  });
  const conditions = fix(spec?.conditions);
  return changed ? { spec: { ...spec, conditions }, notes: [] } : { spec, notes: [] };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * "id is william". An id is a uuid or a placeholder (@me, @previous); a word
 * there is a name, and a name is a displayName condition — which the person
 * lookup then pins to one record. Asked for "rights I have that william does
 * not", the model wrote the caller's id correctly and then reached for the
 * same field for william.
 * @returns {{ spec: object, notes: string[] }}
 */
export function nameWrittenAsId(spec) {
  let changed = 0;
  const isName = (v) => typeof v === 'string' && !UUID.test(v) && !v.startsWith('@') && /\p{L}/u.test(v);
  const fix = (conditions) => (conditions ?? []).map((c) => {
    if (c.type === 'group' || c.type === 'relation') return { ...c, conditions: fix(c.conditions) };
    if (c.type === 'field' && c.field === 'id' && c.op === 'eq' && isName(c.value)) { changed++; return { ...c, field: 'displayName', op: 'contains' }; }
    return c;
  });
  const conditions = fix(spec?.conditions);
  return changed ? { spec: { ...spec, conditions }, notes: [] } : { spec, notes: [] };
}

const ACCOUNT_KINDS = new Set(['user', 'identity']);
const isSelf = (c, me) => c?.type === 'field' && c.field === 'id' && c.op === 'eq' && c.value === me;

// What a question asks to SEE, by the words it uses, per kind of report. "Wie
// zijn de leden van deze groepen" answered with a list of the groups and no
// member column is a page that does not answer the question; the column is
// added. A column is only ever added, never removed, and only when the
// report's entity has that relation.
const ASKED_COLUMNS = {
  resource: [
    [/\b(leden|lid|members?|wie zit|wie zitten|who is in|who are in)\b/i, 'members.names'],
    [/\b(eigenaar|eigenaren|owners?|owned by)\b/i, 'owners.names'],
    [/\b(access ?packages?|business ?roles?|bedrijfsrol(len)?|toegangspakket(ten)?)\b/i, 'businessRoles.names'],
  ],
  user: [
    // "Van welke groepen ben ik eigenaar" is about the groups OWNED: the owner
    // rule wins, and "groups" then adds nothing.
    [/\b(eigenaar|eigenaren|owns?|owner of)\b/i, 'owns.names', /\b(groepen|groups?|lid van|member of)\b/i],
    [/\b(groepen|groups?|lid van|member of)\b/i, 'memberOf.names'],
    [/\b(access ?packages?|business ?roles?|bedrijfsrol(len)?|toegangspakket(ten)?)\b/i, 'businessRoles.names'],
    [/\b(rechten|rights|permissions|toegang|access)\b/i, 'access.names'],
    [/\b(manager|leidinggevende)\b/i, 'manager.displayName'],
  ],
};

/**
 * Add the column the question asks to see, when the definition lacks it.
 * @returns {{ spec: object, notes: string[] }}
 */
export function addAskedColumns(spec, question) {
  const entity = ENTITIES[spec?.entity];
  const rules = entity ? ASKED_COLUMNS[entity.detailKind] : null;
  if (!rules) return { spec, notes: [] };
  const text = String(question ?? '');
  const have = new Set(spec.columns ?? []);
  // A rule may name a second pattern it overrides: when the first matches,
  // the second is not applied ("groups" in "groups I own").
  const overridden = rules.filter(([re, , over]) => over && re.test(text)).map(([, , over]) => over);
  const wanted = rules
    .filter(([re, column]) => re.test(text) && !overridden.some(o => o.source === re.source) && !have.has(column) && entity.relations?.[column.split('.')[0]])
    .map(([, column]) => column);
  if (!wanted.length) return { spec, notes: [] };
  // A definition with no columns lists the defaults; naming one means naming
  // the name column too, as the prompt tells the model.
  const columns = [...(have.size ? spec.columns : ['displayName']), ...wanted];
  return { spec: { ...spec, columns }, notes: [] };
}

const isBusinessRoleType = (c) => c?.type === 'field' && c.field === 'resourceType' && c.op === 'eq' && String(c.value).toLowerCase() === 'businessrole';

/**
 * "In an access package" written as resourceType = BusinessRole where that
 * field does not exist — on a group's own fields, or inside members (accounts
 * have no resource type). Validation would drop the condition and the report
 * would be about every group; the model has produced this shape three times.
 * Where the entity has a businessRoles relation, that is what was meant.
 * @returns {{ spec: object, notes: string[] }}
 */
export function accessPackageAsRelation(spec) {
  const entity = ENTITIES[spec?.entity];
  if (!entity?.relations?.businessRoles) return { spec, notes: [] };
  const inRole = () => ({ type: 'relation', relation: 'businessRoles', quantifier: 'some', match: 'all', conditions: [] });
  let moved = 0;
  const fix = (conditions, owner) => {
    const out = [];
    let wanted = false;
    for (const c of conditions ?? []) {
      if (isBusinessRoleType(c) && !owner.fields?.resourceType) { wanted = true; continue; }
      if (c.type === 'relation') {
        const target = ENTITIES[owner.relations?.[c.relation]?.target];
        const inner = (c.conditions ?? []).filter(x => !(isBusinessRoleType(x) && target && !target.fields?.resourceType));
        if (inner.length !== (c.conditions ?? []).length) {
          wanted = true;
          if (inner.length) out.push({ ...c, conditions: inner });
          continue;
        }
      }
      out.push(c.type === 'group' ? { ...c, conditions: fix(c.conditions, owner) } : c);
    }
    if (wanted && !out.some(c => c.type === 'relation' && c.relation === 'businessRoles')) { out.push(inRole()); moved++; } else if (wanted) moved++;
    return out;
  };
  const conditions = fix(spec.conditions, entity);
  return moved ? { spec: { ...spec, conditions }, notes: ['Read "access package" / "business role" as: in a business role.'] } : { spec, notes: [] };
}

/** Does the definition say anything about a particular person or record, anywhere? */
function namesSomeone(conditions) {
  return (conditions ?? []).some(c => (c.type === 'field' && (c.field === 'id' || c.field === 'displayName' || c.field === 'email'))
    || c.type === 'compare'
    || ((c.type === 'group' || c.type === 'relation') && namesSomeone(c.conditions)));
}

/**
 * A question about the person asking whose definition names nobody at all.
 *
 * "Van welke groepen ben ik eigenaar?" came back as every account that owns
 * a group; the correction round asked for the caller and the model still
 * left them out. With a first-person word in the question, a known caller,
 * and not one person or record named in the definition, there is one
 * reading, and it is put in without asking: into the first empty relation
 * that reaches accounts ("owners some" becomes "owners some id @me"), else
 * on the report's own id when it is about accounts, else on its members.
 * A definition that names anyone is left to resolveSelfAgainstPerson() and
 * the correction round.
 * @returns {{ spec: object, notes: string[] }}
 */
export function addMissingSelf(spec, question, me) {
  const word = selfWord(question);
  const entity = ENTITIES[spec?.entity];
  if (!word || !entity || namesSomeone(spec.conditions)) return { spec, notes: [] };
  const self = { type: 'field', field: 'id', op: 'eq', value: me };
  const note = `Read "${word}" as you: the report is about your own account.`;
  const conditions = spec.conditions ?? [];
  const emptyToAccounts = conditions.findIndex(c => c.type === 'relation' && !(c.conditions ?? []).length
    && ACCOUNT_KINDS.has(ENTITIES[entity.relations?.[c.relation]?.target]?.detailKind));
  if (emptyToAccounts >= 0) {
    const filled = conditions.map((c, i) => (i === emptyToAccounts ? { ...c, quantifier: 'some', conditions: [self] } : c));
    return { spec: { ...spec, conditions: filled }, notes: [note] };
  }
  if (ACCOUNT_KINDS.has(entity.detailKind)) return { spec: { ...spec, conditions: [...conditions, self] }, notes: [note] };
  if (entity.relations?.members) {
    return { spec: { ...spec, conditions: [...conditions, { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [self] }] }, notes: [note] };
  }
  return { spec, notes: [] };
}

/**
 * The caller written in where the question never said "my".
 *
 * "Have there been any changes to these groups in the last 180 days?" came
 * back with "account is the person asking" added — the caller block invites
 * @me, and the model reaches for it. A caller condition needs a first-person
 * word in THIS question; what carries a chat forward is the previous answer's
 * records, not the caller. The condition goes, and the answer says so.
 * @returns {{ spec: object, notes: string[] }}
 */
export function dropUnaskedSelf(spec, question, me) {
  if (selfWord(question) || !spec?.conditions?.length) return { spec, notes: [] };
  let dropped = 0;
  const fix = (conditions) => (conditions ?? []).flatMap((c) => {
    if (isSelf(c, me)) { dropped++; return []; }
    if (c.type !== 'group' && c.type !== 'relation') return [c];
    const inner = fix(c.conditions);
    if (inner.length === (c.conditions ?? []).length) return [c];
    // A relation emptied by the move ("account some [me]") goes with it.
    return inner.length || c.type === 'group' ? [{ ...c, conditions: inner }] : [];
  });
  const conditions = fix(spec.conditions);
  return dropped
    ? { spec: { ...spec, conditions }, notes: ['Not limited to you: the request did not say "my" or "I".'] }
    : { spec, notes: [] };
}

/**
 * The caller's placeholder where it cannot mean the caller.
 *
 * "id is @me" is the caller's ACCOUNT id. Written inside memberOf — a group
 * whose id is the caller's — or on a group report's own id, it matches
 * nothing, tidily. Asked "which groups am I a member of", the model wrote
 * exactly that. The placeholder is moved to where it means the caller: the
 * report's own id when the report is about accounts or persons, the members
 * relation when it is about groups or resources. A relation left empty by
 * the move goes with it.
 * @returns {{ spec: object, notes: string[] }}
 */
export function relocateSelf(spec, me) {
  const entity = ENTITIES[spec?.entity];
  if (!entity) return { spec, notes: [] };
  const onAccounts = ACCOUNT_KINDS.has(entity.detailKind);
  const misplaced = (c) => {
    if (c.type === 'relation') {
      const target = ENTITIES[entity.relations?.[c.relation]?.target];
      return !!target && !ACCOUNT_KINDS.has(target.detailKind) && (c.conditions ?? []).some(x => isSelf(x, me));
    }
    return !onAccounts && isSelf(c, me);
  };
  if (!(spec.conditions ?? []).some(misplaced)) return { spec, notes: [] };
  const kept = spec.conditions.flatMap((c) => {
    if (!misplaced(c)) return [c];
    if (c.type !== 'relation') return [];
    const rest = c.conditions.filter(x => !isSelf(x, me));
    return rest.length ? [{ ...c, conditions: rest }] : [];
  });
  const self = { type: 'field', field: 'id', op: 'eq', value: me };
  const placed = onAccounts ? self : (entity.relations?.members ? { type: 'relation', relation: 'members', quantifier: 'some', match: 'all', conditions: [self] } : null);
  if (!placed) return { spec, notes: [] };
  return {
    spec: { ...spec, conditions: [...kept, placed] },
    notes: [onAccounts ? 'Read the request as being about your own account.' : 'Read the request as: groups/resources you are a member of.'],
  };
}

/**
 * A comparison whose reference is a KIND of thing, not a named one — "in an
 * access package", "part of a business role" — is the plain relation: has any.
 * Left as a comparison, the name lookup fuzzy-matches "access package" to
 * whichever group has those words in its name and asks the caller to confirm
 * it, which is a question about a record nobody mentioned.
 * @returns {{ spec: object, notes: string[] }}
 */
/**
 * The same condition written twice (or eight times) in one list is one
 * condition. A model that starts repeating itself stops where the grammar's
 * list limit says; what it wrote up to there is still the definition it
 * meant, minus the echoes.
 * @returns {{ spec: object, notes: string[] }}
 */
export function dedupeConditions(spec) {
  let dropped = 0;
  const fix = (conditions) => {
    const seen = new Set();
    const out = [];
    for (const c of conditions ?? []) {
      const key = JSON.stringify(c);
      if (seen.has(key)) { dropped++; continue; }
      seen.add(key);
      out.push(c.type === 'group' || c.type === 'relation' ? { ...c, conditions: fix(c.conditions) } : c);
    }
    return out;
  };
  const conditions = fix(spec?.conditions);
  return dropped ? { spec: { ...spec, conditions }, notes: [`Dropped ${dropped} repeated condition${dropped === 1 ? '' : 's'}.`] } : { spec, notes: [] };
}

export function genericCompareToRelation(spec) {
  const notes = [];
  const fix = (conditions) => (conditions ?? []).map((c) => {
    if (c.type === 'group') return { ...c, conditions: fix(c.conditions) };
    // The vocabulary is kept word by word ("access package" is two of them), so a name is generic when every word of it is.
    const generic = (name) => String(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean).every(w => isVocabulary(w, {}));
    if (c.type !== 'compare' || c.reference?.id || !c.reference?.name || !generic(c.reference.name)) return c;
    notes.push(`Read "${c.reference.name}" as any ${c.reference.name}, not as one named so.`);
    return { type: 'relation', relation: c.relation, quantifier: 'some', match: 'all', conditions: [] };
  });
  const conditions = fix(spec?.conditions);
  return { spec: notes.length ? { ...spec, conditions } : spec, notes };
}
const isField = (c) => c?.type === 'field';

/** Two or more "is" conditions on one field become one "any" group of them. */
function mergeSameFieldEquals(list, notes) {
  const byField = new Map();
  for (const c of list) {
    if (isField(c) && c.op === 'eq') byField.set(c.field, [...(byField.get(c.field) ?? []), c]);
  }
  const out = [];
  const merged = new Set();
  for (const c of list) {
    const group = isField(c) && c.op === 'eq' ? byField.get(c.field) : null;
    if (!group || group.length < 2 || new Set(group.map(g => String(g.value).toLowerCase())).size < 2) { out.push(c); continue; }
    if (merged.has(c.field)) continue;
    merged.add(c.field);
    out.push({ type: 'group', match: 'any', conditions: group });
    notes.push(`Read ${c.field} ${group.map(g => show(g.value)).join(' and ')} as alternatives — either one.`);
  }
  return out;
}

/** A count above zero beside the same relation with quantifier none: the count goes. */
function dropCountsAgainstRelations(list, entity, notes) {
  if (!entity) return list;
  const noneOf = new Set(list.filter(c => c.type === 'relation' && c.quantifier === 'none' && !(c.conditions?.length)).map(c => c.relation));
  return list.filter((c) => {
    const counted = isField(c) ? entity.fields?.[c.field]?.counts : null;
    if (!counted || !noneOf.has(counted) || countSays(c) !== 'some') return true;
    notes.push(`Dropped "${c.field} ${c.op} ${show(c.value)}": the request is about records with no ${counted}.`);
    return false;
  });
}

/** "within the last N days" beside "more than M days ago" with M ≥ N: the older bound goes. */
function dropReversedWindows(list, notes) {
  const recent = new Map(list.filter(c => isField(c) && c.op === 'withinLastDays').map(c => [c.field, Number(c.value)]));
  return list.filter((c) => {
    if (!isField(c) || c.op !== 'olderThanDays' || !recent.has(c.field) || Number(c.value) < recent.get(c.field)) return true;
    notes.push(`Dropped "${c.field} more than ${c.value} days ago": the request asks for the last ${recent.get(c.field)} days.`);
    return false;
  });
}

/**
 * Apply every safe correction to a validated definition.
 *
 * Works on the shape validateSpec() hands back (every condition typed), and
 * returns the same object when nothing was changed, so a caller can tell.
 *
 * @param {object} spec  a normalised definition, possibly one validation rejected
 * @returns {{ spec: object, notes: string[] }}
 */
export function autofixSpec(spec) {
  const notes = [];
  const fix = (conditions, match, entity) => {
    let list = conditions ?? [];
    if (match !== 'any') {
      list = mergeSameFieldEquals(list, notes);
      list = dropCountsAgainstRelations(list, entity, notes);
      list = dropReversedWindows(list, notes);
    }
    return list.map((c) => {
      if (c.type === 'group') return { ...c, conditions: fix(c.conditions, c.match, entity) };
      if (c.type === 'relation') return { ...c, conditions: fix(c.conditions, c.match, ENTITIES[entity?.relations?.[c.relation]?.target]) };
      return c;
    });
  };
  const conditions = fix(spec?.conditions, spec?.match, ENTITIES[spec?.entity]);
  return { spec: notes.length ? { ...spec, conditions } : spec, notes };
}

// The nouns a question uses to say what KIND of record it is about. A
// follow-up without one ("alleen de toevoegingen graag", "only the additions")
// is a refinement of the previous definition, not a new question.
const ENTITY_NOUN = /\b(groep|groepen|groups?|accounts?|gebruikers?|users?|persoon|personen|people|identit(y|ies)|mensen|medewerkers?|wijziging(en)?|changes?|updates?|rol(len)?|roles?|applicaties?|applications?|apps?|rechten|rights|permissions?|packages?|pakket(ten)?|resources?|leden|members?|eigenaren|owners?|managers?|gasten|guests?)\b/i;

/** Does the question say what kind of record it is about? */
export const namesAKind = (question) => ENTITY_NOUN.test(String(question ?? ''));

/** Top-level conditions compared by what they are about: the relation, the field, or "group". */
const conditionKey = (c) => (c.type === 'relation' ? `relation:${c.relation}` : (c.type === 'field' ? `field:${c.field}` : c.type));
const hasAll = (spec, leafSet) => [...leafSet].every(l => leaves(spec).has(l));

/**
 * A refinement of the previous definition keeps what the previous definition
 * had. "Alleen de toevoegingen graag" after a question about William's
 * group changes in 90 days came back with the action filter it asked for —
 * and William replaced by the person asking, and the window gone. Neither
 * change was asked for, so neither stands: a previous condition the question
 * does not mention replaces a swapped counterpart (same relation or field,
 * itself unasked for) or is re-added when it has none. The new conditions the
 * refinement did ask for stay. Applied only when the question names no kind
 * of record and the entity is unchanged: a new question is a new question.
 * @returns {{ spec: object, notes: string[] }}
 */
export function refineFromPrevious(spec, previous, question) {
  if (!previous?.conditions?.length || !spec || spec.entity !== previous.entity || namesAKind(question)) return { spec, notes: [] };
  const unasked = (c) => ![...leaves({ conditions: [c] })].some(l => askedForLeaf(l, question));
  let conditions = [...(spec.conditions ?? [])];
  const restored = [];
  for (const p of previous.conditions) {
    if (hasAll(spec, leaves({ conditions: [p] })) || !unasked(p)) continue;
    const at = conditions.findIndex(c => conditionKey(c) === conditionKey(p) && unasked(c));
    if (at >= 0) conditions[at] = p; else conditions = [...conditions, p];
    restored.push(p);
  }
  if (!restored.length) return { spec, notes: [] };
  return { spec: { ...spec, conditions }, notes: ['Kept the earlier definition, changed only where the request said so.'] };
}

/**
 * Every "field op value" leaf of a definition, so two definitions can be
 * compared for what one dropped. Relations and groups are looked through;
 * the leaf keeps no record of where it sat.
 */
export function leaves(spec) {
  const out = new Set();
  const walk = (conditions) => {
    for (const c of conditions ?? []) {
      if (c.type === 'field') out.add(`${c.field} ${c.op} ${JSON.stringify(c.value ?? null)}`);
      else if (c.type === 'relation') { out.add(`${c.relation} ${c.quantifier}`); walk(c.conditions); } else if (c.type === 'group') walk(c.conditions);
      else if (c.type === 'compare') out.add(`compare ${c.relation} ${c.measure}`);
    }
  };
  walk(spec?.conditions);
  return out;
}

/**
 * Does the question ask for what this leaf says? A leaf is "field op value";
 * the field's words (accountCount → account, count) and the value are looked
 * for in the question. "accountCount gt 0" inside members, for a question
 * about groups and william, matches nothing: the model made it up, and a
 * definition without it is the one asked for. "mfaEnabled eq false" for a
 * question about MFA matches, and losing it would answer a different question.
 */
export function askedForLeaf(leaf, question) {
  const text = String(question ?? '').toLowerCase();
  const [field, , ...rest] = String(leaf).split(' ');
  const words = [
    ...String(field).split(/[.\s]/).flatMap(w => w.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(' ')),
    ...rest.join(' ').replace(/^"|"$/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u),
  ].filter(w => w.length >= 3 || /^\d+$/.test(w)); // a number is a word however short: "30 days"
  return words.some(w => text.includes(w));
}

/**
 * The leaves a correction removed although no error named their field.
 *
 * A repair round is allowed to change what was wrong and nothing else. The
 * model does not honour that reliably — asked to fix one condition it rewrites
 * the definition and loses another — so what it dropped is checked against
 * what it was told, and a correction that lost more is refused.
 *
 * @returns {string[]} the leaves lost, empty when the correction stayed in bounds
 */
export function lostLeaves(before, after, errors) {
  const named = errors.join(' ');
  return [...leaves(before)].filter(leaf => !leaves(after).has(leaf) && !named.includes(`"${leaf.split(' ')[0]}"`));
}
