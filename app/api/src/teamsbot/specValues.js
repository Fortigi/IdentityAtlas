// Teams bot (POC) — putting real values where the model wrote a placeholder.
//
// Two things in a question cannot be written by the model as literals: the
// caller's own account id (`@me`, callerSpec.js) and the records a previous
// answer produced (`@previous`, followUp.js). Both are uuids, and a 4B model
// copying a 36-character uuid out of a prompt is a coin flip — a SINGLE wrong
// character yields a definition that validates, runs, returns nothing, and
// looks exactly like a truthful "no results". A sentinel is a handful of
// characters it either wrote or did not, and this pass makes the value correct
// by construction instead of by luck.
//
// One walker serves both, so there is one place where "which key can carry a
// sentinel" is decided. It runs BEFORE validateSpec, which then rejects any
// sentinel that survived — a definition that skipped this pass fails loudly
// rather than silently matching a record literally named "@me".

/**
 * Replace condition values that are exactly a sentinel.
 *
 * Structure-preserving and non-mutating: the input is the model's own output
 * and is also what gets logged, so it is returned unchanged and a copy carries
 * the substitution.
 *
 * Only a condition's `value` is eligible. Everything else is recursed into
 * (conditions, groups, compare references) or copied as is — a sentinel that
 * turned up as a field name or an entity would be a different bug, and
 * substituting it there would hide it.
 *
 * @param {unknown} node  a definition, a condition, or any value inside one
 * @param {Map<string, unknown>} replacements  sentinel → what it stands for
 * @returns {unknown} the same shape with the sentinels substituted
 */
export function substituteValues(node, replacements) {
  if (Array.isArray(node)) return node.map(n => substituteValues(n, replacements));
  if (node === null || typeof node !== 'object') return node;

  const out = {};
  for (const [key, value] of Object.entries(node)) {
    // A Map rather than a plain object on purpose: `replacements` is keyed by
    // strings that came from a model, and `{}.hasOwnProperty` is not a lookup
    // you want a value called "constructor" to reach.
    if (key === 'value' && typeof value === 'string' && replacements.has(value)) {
      out[key] = replacements.get(value);
    } else if (value !== null && typeof value === 'object') {
      out[key] = substituteValues(value, replacements);
    } else {
      out[key] = value;
    }
  }
  return out;
}
