// Context recipe — the definition of a context built with the context assistant.
//
// The local model proposes search terms; the analyst keeps, drops and adds terms and
// includes or excludes individual objects. What they end up with is a recipe:
//
//   { version, name, target, resourceTypes, fields, terms, include, exclude, structure }
//
// It is stored as the parameters of the `context-recipe` plugin, which turns it into a
// context tree with plain SQL — no model — so the tree is refreshed after every crawl
// like any other generated tree. Include and exclude live here, not as member edits,
// because the plugin runner replaces every algorithm-added member on each run.
//
// See docs/architecture/context-assistant.md.

import { ENTITIES } from '../../nlreports/catalog.js';
import { escapeLike } from '../../db/sqlParams.js';

export const MAX_TERMS = 40;
export const MAX_TERM_LENGTH = 60;
export const MAX_PINNED = 2000;
export const MAX_RESOURCE_TYPES = 20;
export const MAX_NAME = 200;

export const MATCH_MODES = ['token', 'wordStart', 'contains'];
export const TERM_STATES = ['accepted', 'rejected'];
export const TERM_ORIGINS = ['model', 'analyst', 'related'];
export const STRUCTURES = ['byTerm', 'flat'];

// Text fields a recipe may search, taken from the report catalog so there is one
// definition of each field's SQL. Only these; never a column name from the request.
const RESOURCE = ENTITIES.resource;
export const SEARCH_FIELDS = ['displayName', 'description', 'mail'];
export const DEFAULT_FIELDS = ['displayName', 'description'];

export function searchFieldSql(field, alias) {
  return RESOURCE.fields[field].sql(alias);
}

export function searchFieldLabel(field) {
  return RESOURCE.fields[field].label;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The text a term is matched against, and the term itself, reduced to lowercase letters
 * and digits separated by single spaces. "SG_INKOOP-Users" → "sg inkoop users". The SQL
 * side (sql.js) produces exactly this form, so a term can be matched with a plain
 * substring test and needs no pattern escaping.
 */
export function normalizeText(s) {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Short terms default to whole-word matching, so "INK" does not find every "link". */
export function defaultMatchFor(normalized) {
  return normalized.replace(/ /g, '').length <= 3 ? 'token' : 'wordStart';
}

/**
 * Does a normalized term match normalized text? `hay` must be padded with a space on
 * both ends (see sql.js), which is what makes token and word-start tests plain lookups.
 */
export function termMatches(paddedHay, normalizedTerm, match) {
  if (match === 'token') return paddedHay.includes(` ${normalizedTerm} `);
  if (match === 'contains') return paddedHay.includes(normalizedTerm);
  return paddedHay.includes(` ${normalizedTerm}`);
}

/**
 * The LIKE pattern equivalent of termMatches, for narrowing rows in SQL.
 *
 * A normalised term holds only letters, digits and single spaces, so it carries no LIKE
 * metacharacter to begin with; it goes through escapeLike() anyway, so the pattern is safe
 * by construction rather than by that argument (SEC-2026-09 L-14, routes/likeAudit.test.js).
 * Postgres treats backslash as the escape character by default, which is what escapeLike
 * emits, so the comparison needs no ESCAPE clause — and could not carry one: the patterns
 * are matched with LIKE ANY(array).
 */
export function likePattern(normalizedTerm, match) {
  const term = escapeLike(normalizedTerm);
  if (match === 'token') return `% ${term} %`;
  if (match === 'contains') return '%' + term + '%';
  return `% ${term}%`;
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function normalizeTerm(raw, errors) {
  const text = typeof raw === 'string' ? raw : raw?.text;
  if (typeof text !== 'string') { errors.push('A term must be text.'); return null; }
  const trimmed = text.trim().slice(0, MAX_TERM_LENGTH);
  const key = normalizeText(trimmed);
  if (key.replace(/ /g, '').length < 2) {
    if (trimmed) errors.push(`"${trimmed}" is too short to search for.`);
    return null;
  }
  const term = {
    text: trimmed,
    key,
    match: pick(raw?.match, MATCH_MODES, defaultMatchFor(key)),
    state: pick(raw?.state, TERM_STATES, 'accepted'),
    origin: pick(raw?.origin, TERM_ORIGINS, 'analyst'),
  };
  if (typeof raw?.why === 'string' && raw.why.trim()) term.why = raw.why.trim().slice(0, 40);
  // A model term that contains the analyst's own words (see contextAssistant/service.js).
  // Kept so evaluate can tell what the model's own additions bring in.
  if (term.origin === 'model' && raw?.own === true) term.own = true;
  return term;
}

function normalizeTerms(list, errors) {
  const seen = new Set();
  const terms = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const term = normalizeTerm(raw, errors);
    if (!term || seen.has(term.key)) continue;
    if (terms.length >= MAX_TERMS) { errors.push(`A context can have at most ${MAX_TERMS} terms.`); break; }
    seen.add(term.key);
    terms.push(term);
  }
  return terms;
}

function normalizeIds(list, label, errors) {
  const ids = [...new Set((Array.isArray(list) ? list : []).filter(id => typeof id === 'string' && UUID_RE.test(id)))];
  if (ids.length > MAX_PINNED) {
    errors.push(`At most ${MAX_PINNED} ${label} objects.`);
    return ids.slice(0, MAX_PINNED);
  }
  return ids;
}

function normalizeStrings(list, max) {
  return [...new Set((Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 100)))].slice(0, max);
}

/**
 * Validate and normalise a recipe from the browser, the model, or stored run parameters.
 * Never throws. `ok` is false when the recipe cannot produce a context at all; `errors`
 * also carries what was dropped along the way, as sentences an analyst can read.
 *
 * @returns {{ ok: boolean, recipe: object, errors: string[] }}
 */
export function validateRecipe(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fields = normalizeStrings(src.fields, SEARCH_FIELDS.length).filter(f => SEARCH_FIELDS.includes(f));
  const recipe = {
    version: 1,
    name: typeof src.name === 'string' ? src.name.trim().slice(0, MAX_NAME) : '',
    target: 'resource',
    resourceTypes: normalizeStrings(src.resourceTypes, MAX_RESOURCE_TYPES),
    fields: fields.length ? fields : [...DEFAULT_FIELDS],
    terms: normalizeTerms(src.terms, errors),
    include: normalizeIds(src.include, 'included', errors),
    exclude: normalizeIds(src.exclude, 'excluded', errors),
    structure: pick(src.structure, STRUCTURES, 'byTerm'),
  };
  if (recipe.resourceTypes.length === 0) recipe.resourceTypes = ['Group'];
  // An object cannot be both: excluding wins, because it is the more deliberate choice.
  const excluded = new Set(recipe.exclude);
  recipe.include = recipe.include.filter(id => !excluded.has(id));

  const accepted = recipe.terms.some(t => t.state === 'accepted');
  if (!accepted && recipe.include.length === 0) errors.push('Keep at least one term, or include at least one object.');
  return { ok: accepted || recipe.include.length > 0, recipe, errors };
}
