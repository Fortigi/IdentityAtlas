// The columns an access review can show, and how each one is read.
//
// The review used to name its columns in code — a certification frequency, a
// CMDB reference, an onboarding sector — which were one customer's catalogue
// fields and simply empty everywhere else. Now the columns are a list of FIELD
// KEYS the person running the report picks, and this module is the one place
// that turns a key into a heading and a value. It is shared by the report
// template and by the lookup source that offers the keys, so a field you can
// pick is always a field the report can read.
//
// A field key is one of:
//
//   context.<core>          a fact every context has (name, type, owner, …)
//   context.ext.<key>       anything the context's source stored in extendedAttributes
//   entitlement.<core>      a fact every resource has (type, system, owner, …)
//   entitlement.ext.<key>   anything the resource's source stored in extendedAttributes
//
// "Entitlement" is the review's word for any resource a context holds — a group,
// an app role, an IdentityIQ entitlement. Nothing here filters on resource type.
//
// The extendedAttributes keys are read in JavaScript from rows the report has
// already fetched; a key never reaches SQL, so there is nothing to inject into.

import { stripExtensionPrefix } from '../lib/attributeLabels.js';

// House rule for every array input (app/api/CLAUDE.md -> Input validation).
export const MAX_LIST = 500;

/**
 * A list parameter, however it arrived: `?x=a,b` is one string, `x[]=a&x[]=b`
 * is an array, and the form sends the comma-joined form. Blank entries are
 * dropped rather than matched, and the list is capped — it is user input.
 */
export function parseList(value, max = MAX_LIST) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts.map(v => String(v ?? '').trim()).filter(Boolean).slice(0, max);
}

// An extendedAttributes key we are willing to offer. No comma, because lists
// of field keys travel comma-joined in a query string; no control characters,
// because the key becomes a column heading. Letters in any script are fine — a
// CSV import keeps whatever header the file had.
const EXT_KEY_RE = /^[\p{L}\p{N}_ .:/()-]{1,128}$/u;

export function isOfferableAttributeKey(key) {
  return typeof key === 'string' && EXT_KEY_RE.test(key);
}

// The facts every context and every resource has, whatever system they came
// from. `read` gets everything the report knows about one row.
const CORE_FIELDS = [
  { key: 'context.name', label: 'Context', read: ({ context }) => context?.displayName },
  { key: 'context.type', label: 'Context type', read: ({ context }) => context?.contextType },
  { key: 'context.description', label: 'Context description', read: ({ context }) => context?.description },
  { key: 'context.owner', label: 'Context owner', read: ({ context }) => context?.ownerName ?? context?.ownerUserId },
  { key: 'entitlement.type', label: 'Resource type', read: ({ entitlement }) => entitlement?.resourceType },
  { key: 'entitlement.system', label: 'System', read: ({ entitlement }) => entitlement?.systemName },
  { key: 'entitlement.description', label: 'Description', read: ({ entitlement }) => entitlement?.description },
  { key: 'entitlement.owner', label: 'Entitlement owner', read: ({ owner }) => owner?.ownerName },
  { key: 'entitlement.ownerEmail', label: 'Entitlement owner email', read: ({ owner }) => owner?.ownerEmail },
  { key: 'entitlement.eligibleAssignments', label: 'Users eligible', read: ({ count }) => count?.eligible ?? 0 },
];

const CORE_BY_KEY = new Map(CORE_FIELDS.map(f => [f.key, f]));

/** Every built-in field, in the order a picker offers them. */
export const coreFields = () => CORE_FIELDS.map(({ key, label }) => ({ key, label }));

/**
 * One stored attribute as a cell value. Own properties only: `constructor` is a
 * perfectly legal JSON key, and on a plain object it would otherwise read back
 * as Object's constructor. Numbers and booleans stay typed, so a pivot can sum
 * or group them; an object is shown as its JSON rather than "[object Object]".
 */
export function attributeValue(attrs, key) {
  if (!attrs || typeof attrs !== 'object' || !Object.hasOwn(attrs, key)) return null;
  const value = attrs[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

const EXT_PREFIXES = {
  'context.ext.': { owner: 'context', heading: key => `Context · ${key}` },
  'entitlement.ext.': { owner: 'entitlement', heading: key => key },
};

/**
 * The field a key names — `{ key, label, read }` — or null when the key is not
 * one. An attribute's heading is the readable form of its key (an Entra
 * extension attribute loses its `extension_<appId>_` prefix); a context's
 * attributes say they are the context's, so they cannot be mistaken for the
 * entitlement's when both carry the same name.
 */
export function resolveField(fieldKey) {
  const core = CORE_BY_KEY.get(fieldKey);
  if (core) return core;
  for (const [prefix, { owner, heading }] of Object.entries(EXT_PREFIXES)) {
    if (typeof fieldKey !== 'string' || !fieldKey.startsWith(prefix)) continue;
    const attr = fieldKey.slice(prefix.length);
    if (!isOfferableAttributeKey(attr)) return null;
    return {
      key: fieldKey,
      label: heading(stripExtensionPrefix(attr)),
      attribute: { owner, key: attr },
      read: (row) => attributeValue(row[owner]?.extendedAttributes, attr),
    };
  }
  return null;
}

/**
 * Field keys resolved into fields, de-duplicated and in the order given, plus
 * the keys that name no field — which the report reports rather than drops in
 * silence.
 */
export function resolveFields(keys) {
  const fields = [];
  const unknown = [];
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const field = resolveField(key);
    if (field) fields.push(field);
    else unknown.push(key);
  }
  return { fields, unknown };
}
