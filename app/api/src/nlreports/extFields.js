// Natural-language reports — the `extendedAttributes` keys of THIS deployment as
// report fields.
//
// The catalog in catalog.js is the vocabulary every install shares. It cannot
// contain `sfDepartmentID`, `fgGroupDN_OuPath` or whatever else a crawler stamps
// into `extendedAttributes`, because those differ per tenant — and an analyst who
// asks "how many users per business unit" is asking about exactly those. So they
// are discovered per request and merged in as fields named `ext.<rawKey>`.
//
// Three rules, and each of them is a rule the rest of the app already follows:
//
//   1. WHICH keys — db/columnCache.js `discoverExtendedAttrKeys`, the same
//      discovery (and the same 300-key cap, SEC-2026-09 L-16) that decides what
//      the list pages let you filter on. An attribute you can filter on in a list
//      is therefore one you can report on.
//   2. WHAT they are called — lib/attributeLabels.js, so the analyst reads
//      `sfDepartmentID` and not `extension_a1b2…_sfDepartmentID`.
//   3. WHAT IS STORED — the raw key, always. A label is a display concern and can
//      change when a second system introduces a colliding key; a saved report that
//      stored the label would then quietly point somewhere else.
//
// These fields never enter the system prompt: that prompt is byte-identical for
// every deployment of a release and its cache is prepared at build time (see
// prompt.js). Only the handful of attributes a question actually names are handed
// to the model, per request, by matchQuestionAttributes().

import { discoverExtendedAttrKeys } from '../db/columnCache.js';
import { getAttributeLabels } from '../lib/attributeLabels.js';
import { staticExtKeys } from './catalog.js';

export const EXT_PREFIX = 'ext.';

// Mirrors db/columnCache.js's own filter. Everything here is interpolated into
// SQL, so it is checked again on this side of the call.
const SAFE_KEY = /^[A-Za-z0-9_]+$/;

// Which table each entity reads, and the attribute-label target for it.
const TARGETS = [
  { table: 'Principals', target: 'principal', entities: ['user', 'account'] },
  { table: 'Resources', target: 'resource', entities: ['group', 'resource'] },
  { table: 'Identities', target: 'identity', entities: ['identity'] },
];

// Same 5-minute TTL as the column cache and the label cache, so a fresh crawl's
// attributes appear on the same timescale everywhere in the app.
const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, fields: null };

export function clearExtFieldsCache() {
  cache = { at: 0, fields: null };
}

/**
 * The discovered fields for one entity.
 *
 * Always `text`: `->>` returns text for every scalar jsonb type, and a key that
 * holds a number in one row can hold a string in the next. Text operators
 * (contains, starts with, is empty) are also what these attributes are used for —
 * they are identifiers and codes, not quantities.
 *
 * @param {string} entityName
 * @param {string[]} keys    raw extendedAttributes keys, most frequent first
 * @param {Record<string,string>} labels  rawKey → display label
 */
export function extFieldsFor(entityName, keys, labels = {}) {
  const covered = staticExtKeys(entityName);
  // A plain object is safe here: every property name starts with "ext." and the
  // rest is [A-Za-z0-9_], so no key can be "__proto__" or "constructor".
  const fields = {};
  for (const key of keys) {
    // `typeof` first: SAFE_KEY.test(undefined) tests the STRING "undefined" and
    // passes, which would put a field called `ext.undefined` in the catalog.
    if (typeof key !== 'string' || !SAFE_KEY.test(key) || covered.has(key)) continue;

    fields[EXT_PREFIX + key] = {
      label: Object.hasOwn(labels, key) ? labels[key] : key,
      type: 'text',
      sql: (t) => `${t}."extendedAttributes"->>'${key}'`,
      extKey: key,
      discovered: true,
    };
  }
  return fields;
}

/**
 * Every entity's discovered fields, keyed by entity name. Cached.
 * @returns {Promise<Record<string, Record<string, object>>>}
 */
export async function loadExtFields() {
  if (cache.fields && Date.now() - cache.at < TTL_MS) return cache.fields;
  const fields = {};
  for (const { table, target, entities } of TARGETS) {
    const keys = await discoverExtendedAttrKeys(table);
    // Labels are cosmetic: without them the raw key is shown, which is ugly but
    // correct. A label lookup that fails must not cost the analyst the field.
    const labels = await getAttributeLabels(target).catch(() => ({}));
    for (const entity of entities) fields[entity] = extFieldsFor(entity, keys, labels);
  }
  cache = { at: Date.now(), fields };
  return fields;
}

// ─── Telling the model about them ───────────────────────────────────
//
// The model is shown an attribute ONLY when the question names it. Two reasons:
// a deployment can have 300 of them (they would not fit in the 8k context beside
// the prompt), and every name added to the reply grammar is a name a small model
// can wander into. This mirrors terms.js: look it up in code, hand the model one
// line, keep the system prompt untouched.

const MAX_ATTRIBUTE_MATCHES = 4;
const WORD = /[A-Za-z0-9_]+/g;

/** rawKey/label (lowercased) → { key, label, entities } across every entity. */
function attributeIndex(extFields) {
  const index = new Map();
  for (const [entity, fields] of Object.entries(extFields || {})) {
    for (const [key, field] of Object.entries(fields)) {
      const entry = index.get(key) || { key, label: field.label, entities: [] };
      entry.entities.push(entity);
      index.set(key, entry);
      // Both spellings point at the same entry: analysts write the label, an
      // earlier report definition may carry the raw key.
      for (const alias of [field.label.toLowerCase(), field.extKey.toLowerCase()]) {
        if (!index.has(alias)) index.set(alias, entry);
      }
    }
  }
  return index;
}

/**
 * The discovered attributes a question names.
 * @returns {{key: string, label: string, entities: string[]}[]}
 */
export function matchQuestionAttributes(question, extFields) {
  const index = attributeIndex(extFields);
  if (index.size === 0) return [];
  const text = String(question || '').toLowerCase();
  const found = new Map();
  for (const word of text.match(WORD) || []) {
    // "the sfDepartmentIDs of everyone" names the same attribute as the singular.
    const entry = index.get(word) ?? (word.endsWith('s') ? index.get(word.slice(0, -1)) : undefined);
    if (entry) found.set(entry.key, entry);
  }

  // A label the crawler stamped can contain a space or a dash ("Cost Center"),
  // which the word scan above would never produce as one token. Tested with its
  // own anchored regex: WORD is global, and `.test` on a global regex carries
  // lastIndex from the previous call — it would answer differently every time.
  for (const [alias, entry] of index) {
    if (!SAFE_KEY.test(alias) && alias.length >= 3 && text.includes(alias)) found.set(entry.key, entry);
  }

  return [...found.values()].slice(0, MAX_ATTRIBUTE_MATCHES);
}

/** The per-question prompt block naming those attributes, or ''. */
export function attributesBlock(matches) {
  if (!matches.length) return '';
  const lines = matches.map(m => `- "${m.label}" is the field ${m.key} (on ${m.entities.join(' and ')})`);
  return 'Attributes from this deployment\'s own data that this request names. ' +
    'Use the field name exactly as written, including the "ext." prefix:\n' + lines.join('\n');
}

/** The extra field names the reply grammar must allow for this question. */
export const attributeFieldNames = (matches) => matches.map(m => m.key);
