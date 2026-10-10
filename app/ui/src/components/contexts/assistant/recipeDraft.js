// The context recipe being built in the context builder, and every edit an analyst can
// make to it — pure functions, so the builder's behaviour is testable without rendering.
//
// The server is the authority on a recipe (app/api/src/contexts/recipe/recipe.js
// validates and normalises it on every evaluate and save); these helpers only keep the
// draft tidy enough that what the analyst sees matches what the server will do.

export const EMPTY_RECIPE = Object.freeze({
  name: '',
  resourceTypes: ['Group'],
  fields: ['displayName', 'description'],
  terms: [],
  include: [],
  exclude: [],
  structure: 'byTerm',
});

export const MATCH_LABELS = {
  wordStart: 'word starts with',
  token: 'whole word',
  contains: 'anywhere',
};

/** Same reduction as the server's normalizeText: lowercase letters and digits, single spaces. */
export function termKey(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const withKey = (term) => ({ ...term, key: term.key || termKey(term.text) });

/** Add terms that are not in the draft yet (by key); earlier terms keep their state. */
export function mergeTerms(recipe, terms) {
  const present = new Set(recipe.terms.map(t => t.key || termKey(t.text)));
  const added = [];
  for (const term of terms || []) {
    const t = withKey(term);
    if (!t.key || present.has(t.key)) continue;
    present.add(t.key);
    added.push(t);
  }
  return added.length ? { ...recipe, terms: [...recipe.terms, ...added] } : recipe;
}

/** A term the analyst typed or picked from related words. Short terms match whole words only, as on the server. */
export function addTerm(recipe, text, origin = 'analyst') {
  const trimmed = String(text ?? '').trim();
  const key = termKey(trimmed);
  if (key.replace(/ /g, '').length < 2) return recipe;
  const match = key.replace(/ /g, '').length <= 3 ? 'token' : 'wordStart';
  return mergeTerms(recipe, [{ text: trimmed, key, match, state: 'accepted', origin }]);
}

const updateTerm = (recipe, key, change) => ({
  ...recipe,
  terms: recipe.terms.map(t => (t.key === key ? { ...t, ...change(t) } : t)),
});

export function toggleTerm(recipe, key) {
  return updateTerm(recipe, key, t => ({ state: t.state === 'accepted' ? 'rejected' : 'accepted' }));
}

export function setTermMatch(recipe, key, match) {
  return MATCH_LABELS[match] ? updateTerm(recipe, key, () => ({ match })) : recipe;
}

export function removeTerm(recipe, key) {
  return { ...recipe, terms: recipe.terms.filter(t => t.key !== key) };
}

/** Put an id in one hand-picked list, keep it out with the other, or drop it from both. */
function setChoice(recipe, includeKey, excludeKey, id, choice) {
  const include = (recipe[includeKey] || []).filter(x => x !== id);
  const exclude = (recipe[excludeKey] || []).filter(x => x !== id);
  if (choice === 'include') include.push(id);
  if (choice === 'exclude') exclude.push(id);
  return { ...recipe, [includeKey]: include, [excludeKey]: exclude };
}

/**
 * Put an object (a resource) in, keep it out, or return it to what the terms decide.
 * @param {'include'|'exclude'|'auto'} choice
 */
export function setObjectChoice(recipe, id, choice) {
  return setChoice(recipe, 'include', 'exclude', id, choice);
}

/** Same, for an organisation entity of a users recipe. */
export function setOrgChoice(recipe, id, choice) {
  return setChoice(recipe, 'orgInclude', 'orgExclude', id, choice);
}

/** Same, for one user of a users recipe. */
export function setPrincipalChoice(recipe, id, choice) {
  return setChoice(recipe, 'principalInclude', 'principalExclude', id, choice);
}

// ── Target: a context of resources, or of the users who have access ───────────

export const TARGET_LABELS = { resource: 'Resources', principal: 'Users with access' };
export const ASSIGNMENT_TYPES = ['Direct', 'Indirect', 'Eligible'];
export const DEFAULT_ASSIGNMENT_TYPES = ['Direct', 'Indirect'];
const PRINCIPAL_FIELDS = ['target', 'access', 'orgTypes', 'orgInclude', 'orgExclude', 'principalInclude', 'principalExclude'];

/** A recipe without a target is a resource recipe, as the server reads it. */
export function recipeTarget(recipe) {
  return recipe?.target === 'principal' ? 'principal' : 'resource';
}

/**
 * Switch the draft between the two targets. A resource draft carries none of the users
 * fields, so it is sent exactly as before users recipes existed; a users draft keeps
 * whatever it already had (an edited saved recipe) and fills in the defaults.
 */
export function setTarget(recipe, target) {
  if (target !== 'principal') {
    if (!PRINCIPAL_FIELDS.some(f => f in recipe)) return recipe;
    const next = { ...recipe };
    for (const f of PRINCIPAL_FIELDS) delete next[f];
    return next;
  }
  return {
    ...recipe,
    target: 'principal',
    access: { assignmentTypes: recipe.access?.assignmentTypes?.length ? recipe.access.assignmentTypes : DEFAULT_ASSIGNMENT_TYPES },
    orgInclude: recipe.orgInclude || [],
    orgExclude: recipe.orgExclude || [],
    principalInclude: recipe.principalInclude || [],
    principalExclude: recipe.principalExclude || [],
  };
}

/** Which kinds of assignment give a user access, in a fixed order; never leaves the list empty. */
export function toggleAssignmentType(recipe, type) {
  const current = recipe.access?.assignmentTypes || DEFAULT_ASSIGNMENT_TYPES;
  const next = current.includes(type)
    ? current.filter(t => t !== type)
    : ASSIGNMENT_TYPES.filter(t => t === type || current.includes(t));
  return next.length ? { ...recipe, access: { ...recipe.access, assignmentTypes: next } } : recipe;
}

/** What the context will hold: resources, or for a users recipe the users reached. */
export function memberCountOf(recipe, evaluation) {
  return recipeTarget(recipe) === 'principal' ? evaluation?.principals?.total ?? 0 : evaluation?.memberCount ?? 0;
}

/** What the header counts the members as. */
export function memberUnit(recipe) {
  return recipeTarget(recipe) === 'principal' ? 'users' : 'objects';
}

/** How many ids are picked by hand to put members in without a term. */
export function handPicked(recipe) {
  const lists = recipeTarget(recipe) === 'principal' ? ['include', 'orgInclude', 'principalInclude'] : ['include'];
  return lists.reduce((n, l) => n + (recipe[l]?.length || 0), 0);
}

/** One "via" chip of a user: why that user is in the context. */
export function viaText(via) {
  if (via.kind === 'org') return `${via.entityType} ${via.label}${via.link ? ` · ${via.link}` : ''}`;
  if (via.assignmentType === 'Eligible') return `eligible for ${via.label}`;
  return `member of ${via.label}${via.assignmentType === 'Indirect' ? ' · indirect' : ''}`;
}

/** The assistant's lookup; a resource lookup goes without a kind, as it always did. */
export function lookupUrl(text, kind) {
  const q = `q=${encodeURIComponent(String(text ?? '').trim())}`;
  return kind ? `/api/context-assistant/lookup?kind=${encodeURIComponent(kind)}&${q}` : `/api/context-assistant/lookup?${q}`;
}

/** An organisation entity's state, read as a match row's status (so it offers the same actions). */
export function orgRowAction(state) {
  return rowAction(state === 'matched' ? 'member' : state);
}

/** Add or remove one value of a list setting (resourceTypes, fields); never leaves it empty. */
export function toggleListValue(recipe, list, value) {
  const current = recipe[list] || [];
  const next = current.includes(value) ? current.filter(v => v !== value) : [...current, value];
  return next.length ? { ...recipe, [list]: next } : recipe;
}

export function termCounts(recipe) {
  const kept = recipe.terms.filter(t => t.state === 'accepted').length;
  return { kept, dropped: recipe.terms.length - kept };
}

/** Can the draft be saved as a context? Returns the reason it cannot, or null. */
export function saveBlocker(recipe, memberCount) {
  if (!recipe.name.trim()) return 'Give the context a name.';
  if (termCounts(recipe).kept === 0 && handPicked(recipe) === 0) return 'Keep at least one term, or include an object by hand.';
  if (memberCount === 0) return 'Nothing matches yet.';
  return null;
}

/**
 * A tree built with the context assistant is edited by reopening its recipe in the
 * builder — from its root, which is where the recipe lives.
 */
export function isRecipeRoot(attrs) {
  return attrs?.sourceAlgorithmName === 'context-recipe' && !attrs.parentContextId;
}

/** "in 6 of the context · 2 elsewhere" — what adding a related word would do. */
export function relatedWordText(w) {
  const outside = w.outside ? ` · ${w.outside} elsewhere` : ' · nowhere else';
  return `in ${w.inContext} of the context${outside}`;
}

/** What the assistant says about the terms it proposed: which are ticked, and why the rest are not. */
export function termsReplyText(terms) {
  if (!terms?.length) return 'I have no new terms to add.';
  const ticked = terms.filter(t => t.state === 'accepted').length;
  const suggested = terms.length - ticked;
  if (!suggested) return `I proposed ${terms.length} search terms, all containing your own words. Check what each one finds below.`;
  const own = ticked ? `${ticked} contain your own words and are ticked; ` : 'None contain your own words; ';
  return `I proposed ${terms.length} search terms. ${own}the other ${suggested} are suggestions and start unticked — tick the ones that fit, looking at what each one finds.`;
}

export const WIDEN_MIN = 10;
export const WIDEN_RATIO = 2;

/**
 * Warn when the terms the model added bring in far more than everything else does — the
 * sign of a model "explaining" a name it does not know (HAMIS → health care).
 * @returns {{ added: number, rest: number } | null}
 */
export function widenWarning(evaluation) {
  const added = evaluation?.addedByModel ?? 0;
  const rest = (evaluation?.memberCount ?? 0) - added;
  return added >= WIDEN_MIN && added > WIDEN_RATIO * rest ? { added, rest } : null;
}

/** What to do with a match row, given its status. */
export function rowAction(status) {
  switch (status) {
    case 'member':    return { label: 'Exclude', choice: 'exclude' };
    case 'included':  return { label: 'Remove', choice: 'auto' };
    case 'excluded':  return { label: 'Put back', choice: 'auto' };
    default:          return { label: 'Include', choice: 'include' };
  }
}
