// Organisation truth — the signal settings per collection type
// (GET/PUT /api/org-truth/signals/settings), kept like the canvas layout in the
// generic WorkerConfig key/value table under 'orgTruth.signals':
//
//   { [collectionType]: { inactiveAfterMonths: 6, statusAttribute: 'archief' | null, inactiveValues: ['true'] } }
//
//   inactiveAfterMonths  a collection entity with no activity for this many
//                        months (or none at all) is inactive — 1 to 120
//   statusAttribute      the entity attribute that marks it inactive in the list
//                        itself (an "archived" column), or null for none
//   inactiveValues       the values of that attribute that mean inactive,
//                        compared trimmed and case-insensitively
//
// A type without stored settings reads with DEFAULTS. PUT merges per type: the
// types in the body replace their stored settings, a type set to null goes back
// to the defaults, other stored types are kept.
import { query } from '../../db/connection.js';

export const SIGNALS_KEY = 'orgTruth.signals';
export const DEFAULTS = Object.freeze({ inactiveAfterMonths: 6, statusAttribute: null, inactiveValues: Object.freeze(['true']) });
export const MAX_TYPES = 200;
export const MAX_TYPE_LENGTH = 200;
export const MAX_MONTHS = 120;
export const MAX_ATTRIBUTE_LENGTH = 100;
export const MAX_VALUES = 50;
export const MAX_VALUE_LENGTH = 200;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

export const defaultsFor = () => ({ ...DEFAULTS, inactiveValues: [...DEFAULTS.inactiveValues] });

function monthsError(v) {
  return Number.isInteger(v) && v >= 1 && v <= MAX_MONTHS ? null : `inactiveAfterMonths must be a whole number from 1 to ${MAX_MONTHS}.`;
}

function attributeError(v) {
  return v === null || isText(v, MAX_ATTRIBUTE_LENGTH) ? null : `statusAttribute must be null or 1 to ${MAX_ATTRIBUTE_LENGTH} characters.`;
}

function valuesError(v) {
  if (!Array.isArray(v) || v.length > MAX_VALUES) return `inactiveValues must be a list of at most ${MAX_VALUES} values.`;
  return v.every(x => isText(x, MAX_VALUE_LENGTH)) ? null : `inactiveValues must be non-empty text of at most ${MAX_VALUE_LENGTH} characters.`;
}

// One type's settings: missing fields take the default. Returns { errors } or { value }.
export function parseTypeSettings(type, raw) {
  if (!isPlainObject(raw)) return { errors: [`Settings for "${type}" must be an object.`] };
  const value = { ...defaultsFor(), ...raw };
  const errors = [monthsError(value.inactiveAfterMonths), attributeError(value.statusAttribute), valuesError(value.inactiveValues)]
    .filter(Boolean).map(e => `"${type}": ${e}`);
  if (errors.length > 0) return { errors };
  const statusAttribute = value.statusAttribute === null ? null : value.statusAttribute.trim();
  return { value: { inactiveAfterMonths: value.inactiveAfterMonths, statusAttribute, inactiveValues: [...new Set(value.inactiveValues.map(v => v.trim()))] } };
}

/** Body of a PUT → { errors } or { value: { [type]: settings | null } }. */
export function parseSettings(body) {
  if (!isPlainObject(body)) return { errors: ['The settings must be an object keyed by collection type.'] };
  const entries = Object.entries(body);
  if (entries.length > MAX_TYPES) return { errors: [`At most ${MAX_TYPES} collection types.`] };
  const errors = [];
  const value = {};
  for (const [type, raw] of entries) {
    if (!isText(type, MAX_TYPE_LENGTH)) { errors.push(`A collection type must be 1 to ${MAX_TYPE_LENGTH} characters.`); continue; }
    if (raw === null) { value[type] = null; continue; }
    const parsed = parseTypeSettings(type, raw);
    if (parsed.errors) errors.push(...parsed.errors); else value[type] = parsed.value;
  }
  return errors.length > 0 ? { errors } : { value };
}

// A stored document that no longer parses (hand-edited) keeps its valid types only.
export function fromStored(configValue) {
  let stored;
  try { stored = JSON.parse(configValue); } catch { return {}; }
  if (!isPlainObject(stored)) return {};
  const out = {};
  for (const [type, raw] of Object.entries(stored)) {
    const parsed = isText(type, MAX_TYPE_LENGTH) ? parseTypeSettings(type, raw) : { errors: ['bad type'] };
    if (parsed.value) out[type] = parsed.value;
  }
  return out;
}

export async function readSettings() {
  const r = await query(`SELECT "configValue" FROM "WorkerConfig" WHERE "configKey" = $1`, [SIGNALS_KEY]);
  return r.rows[0] ? fromStored(r.rows[0].configValue) : {};
}

/** The settings one type is evaluated with. */
export async function settingsFor(type) {
  return (await readSettings())[type] ?? defaultsFor();
}

/** Merge `changes` ({ [type]: settings | null }) into the stored document; returns the result. */
export async function writeSettings(changes) {
  const merged = await readSettings();
  for (const [type, value] of Object.entries(changes)) {
    if (value === null) delete merged[type]; else merged[type] = value;
  }
  await query(
    `INSERT INTO "WorkerConfig" ("configKey", "configValue", "updatedAt") VALUES ($1, $2, now() AT TIME ZONE 'utc')
     ON CONFLICT ("configKey") DO UPDATE SET "configValue" = EXCLUDED."configValue", "updatedAt" = EXCLUDED."updatedAt"`,
    [SIGNALS_KEY, JSON.stringify(merged)],
  );
  return merged;
}
