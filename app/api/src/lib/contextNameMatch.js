// Matching a NAME to a context — by its display name or by one of its aliases.
//
//   aliasesOf(extendedAttributes)          → the context's other names (string[])
//   mergeAliases(current, alias)           → the aliases with `alias` added, once
//   buildContextNameMatcher(contexts)      → (value) => match | { ambiguous } | null
//
// A context can be known by more than one name: "Harbour Authority, or just HA".
// Such a name lives in extendedAttributes.aliases (an array of strings; a
// confirmed alias claim of an interview adds to it — contexts/interviews/
// decide.js — and the page shows it as "Also known as").
//
// Anything that places a NAME onto a context should try the aliases too. The
// matcher decides in this order, the first step that finds something wins:
//   1. a context's display name, normalised (lib/nameMatch.js normalizeName) —
//      the one context with it → { id, kind: 'name' }; two → { ambiguous }
//   2. an alias, normalised the same way — one context → { id, kind: 'alias',
//      matchedName }; two contexts with that alias → { ambiguous }
//   3. a near miss of a display name (nameMatch's Jaro-Winkler step) →
//      { id, kind: 'fuzzy', … }. Aliases get no near miss: they are short
//      ("HA"), and a near miss of a short name is a guess.
//
// Callers today: none in this branch match context names. The activity upload
// (feature/context-activity) places activity rows onto contexts by name and
// should adopt this matcher there; the list upload matches contexts by key, not
// by name, and the report-script lookup is client-side.

import { buildNameMatcher, normalizeName } from './nameMatch.js';

export const MAX_ALIASES = 50;

/** The aliases stored on a context: an array of non-empty strings (a single string is read as one). */
export function aliasesOf(extendedAttributes) {
  let ext = extendedAttributes;
  if (typeof ext === 'string') { try { ext = JSON.parse(ext); } catch { return []; } }
  const raw = ext?.aliases;
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : []);
  return list.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim());
}

/** `current` (an aliases value as stored) with `alias` added unless a spelling of it is already there. Pure. */
export function mergeAliases(current, alias) {
  const list = aliasesOf({ aliases: current });
  const name = String(alias ?? '').replace(/\s+/g, ' ').trim();
  const norm = normalizeName(name);
  if (!norm || list.some(a => normalizeName(a) === norm)) return list;
  return [...list, name].slice(0, MAX_ALIASES);
}

/**
 * @param {Array<{id: *, displayName: string, extendedAttributes?: object|string}>} contexts
 */
export function buildContextNameMatcher(contexts) {
  const named = new Set();
  const byAlias = new Map();
  for (const c of contexts) {
    const n = normalizeName(c.displayName);
    if (n) named.add(n);
    for (const alias of aliasesOf(c.extendedAttributes)) {
      const a = normalizeName(alias);
      if (!a) continue;
      if (!byAlias.has(a)) byAlias.set(a, { ids: new Set(), name: alias });
      byAlias.get(a).ids.add(c.id);
    }
  }
  const byName = buildNameMatcher(contexts.map(c => ({ id: c.id, name: c.displayName })));
  return (value) => {
    const norm = normalizeName(value);
    if (!norm) return null;
    if (named.has(norm)) return byName(value);
    const alias = byAlias.get(norm);
    if (alias) return alias.ids.size === 1 ? { id: [...alias.ids][0], kind: 'alias', matchedName: alias.name } : { ambiguous: true };
    return byName(value);
  };
}
