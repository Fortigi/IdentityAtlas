// Context recipe — "related words": suggestions from the data, not from the model.
//
// The model cannot know a customer's own names — that HAMIS groups also say "HMS", or
// that DevOps groups here are called "VSTS-…". The data can: words that occur far more
// often in the names of the objects already in the context than in the names of
// everything in scope are likely to be about the same subject.
//
// For every word (resource-cluster's tokenizer, so role/environment/type noise such as
// "admins", "prod" or "sg" never shows up) we count the context's objects whose name
// contains it and all objects in scope whose name contains it, and rank by lift:
//
//   lift = (share of the context's objects with the word) / (share of all objects with it)
//
// Deterministic and data-only: nothing here reaches the model.

import { tokenize, DEFAULT_STOPWORDS } from '../plugins/resource-cluster/tokenize.js';
import { normalizeText, termMatches } from './recipe.js';
import { STATEMENT_TIMEOUT } from './matches.js';

export const MAX_SCOPE_NAMES = 50_000;
export const MAX_SUGGESTIONS = 12;
export const MIN_LIFT = 2;

/** Names of everything in scope, read-only. */
export async function loadScopeNames(recipe, tx) {
  return tx(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
    const { rows } = await client.query(
      `SELECT r."id", r."displayName" FROM "Resources" r
        WHERE r."deletedAt" IS NULL AND r."resourceType" = ANY($1::text[])
        LIMIT ${MAX_SCOPE_NAMES}`,
      [recipe.resourceTypes],
    );
    return rows;
  });
}

// A word some term already finds adds nothing as a suggestion.
function coveredByTerms(word, recipe) {
  return recipe.terms.some(t => termMatches(` ${word} `, t.key, t.match) || normalizeText(t.text) === word);
}

/**
 * @param {{id:string, displayName:string}[]} scopeRows  every object in scope
 * @param {string[]} memberIds                          the objects in the context now
 * @param {object}   recipe                             a validated recipe
 * @returns {{ word: string, inContext: number, outside: number, lift: number }[]}
 */
export function relatedWords(scopeRows, memberIds, recipe) {
  const members = new Set(memberIds);
  if (members.size === 0 || scopeRows.length === 0) return [];
  const counts = new Map(); // word → { inContext, total }
  for (const row of scopeRows) {
    const inContext = members.has(row.id);
    for (const word of tokenize(row.displayName || '', { stopwords: DEFAULT_STOPWORDS })) {
      const c = counts.get(word) || { inContext: 0, total: 0 };
      c.total++;
      if (inContext) c.inContext++;
      counts.set(word, c);
    }
  }
  // A word must recur within the context — once is a coincidence — unless the context
  // itself is tiny.
  const minInContext = members.size >= 4 ? 2 : 1;
  const out = [];
  for (const [word, c] of counts) {
    if (c.inContext < minInContext || coveredByTerms(word, recipe)) continue;
    const lift = (c.inContext / members.size) / (c.total / scopeRows.length);
    if (lift < MIN_LIFT) continue;
    out.push({ word, inContext: c.inContext, outside: c.total - c.inContext, lift: Math.round(lift * 10) / 10 });
  }
  return out
    .sort((a, b) => b.lift - a.lift || b.inContext - a.inContext || a.word.localeCompare(b.word))
    .slice(0, MAX_SUGGESTIONS);
}
