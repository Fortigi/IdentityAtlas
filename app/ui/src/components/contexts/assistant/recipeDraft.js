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

/**
 * Put an object in, keep it out, or return it to what the terms decide.
 * @param {'include'|'exclude'|'auto'} choice
 */
export function setObjectChoice(recipe, id, choice) {
  const include = recipe.include.filter(x => x !== id);
  const exclude = recipe.exclude.filter(x => x !== id);
  if (choice === 'include') include.push(id);
  if (choice === 'exclude') exclude.push(id);
  return { ...recipe, include, exclude };
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
  if (termCounts(recipe).kept === 0 && recipe.include.length === 0) return 'Keep at least one term, or include an object by hand.';
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

/** What to do with a match row, given its status. */
export function rowAction(status) {
  switch (status) {
    case 'member':    return { label: 'Exclude', choice: 'exclude' };
    case 'included':  return { label: 'Remove', choice: 'auto' };
    case 'excluded':  return { label: 'Put back', choice: 'auto' };
    default:          return { label: 'Include', choice: 'include' };
  }
}
