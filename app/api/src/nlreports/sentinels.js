// Natural-language reports — placeholders the model writes for values it must
// not copy.
//
// Two things in a question cannot be written by the model as literals: the
// caller's own account id (`@me`, caller.js) and the records a previous answer
// produced (`@previous`, the Teams bot's follow-up). Both are uuids, and a 4B
// model copying a 36-character uuid out of a prompt is a coin flip — a SINGLE
// wrong character yields a definition that validates, runs, returns nothing,
// and looks exactly like a truthful "no results". A sentinel is a handful of
// characters it either wrote or did not, and substitution makes the value
// correct by construction instead of by luck.
//
// WHY THIS RUNS INSIDE interpret(), BEFORE VALIDATION. It used to run in the
// Teams bot, after interpret() returned. But interpret() validates the model's
// definition itself, and spec.js rejects a surviving sentinel — so a model that
// did exactly what it was told, and wrote `@me`, was sent back for a repair
// round ("cannot be @me here") that cost a full second model call on this
// hardware, after which it copied the uuid instead. The front end then
// substituted a sentinel that was no longer there. Resolving the placeholders
// here, before the first validation, is what makes the sentinel cheaper than
// the uuid rather than more expensive.
//
// One walker serves every sentinel, so there is one place where "which key can
// carry a placeholder" is decided. spec.js still rejects any sentinel that
// survives — a definition that reached it without substitution fails loudly
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
  if (!replacements || replacements.size === 0) return node;
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

/**
 * Which of the known sentinels a definition actually uses, in the order met.
 *
 * Recorded with every answer: whether the model wrote `@me` when told to is
 * one of the questions an evaluation asks, and it cannot be answered from the
 * substituted definition, where the sentinel is already gone.
 *
 * @param {unknown} node
 * @param {Map<string, unknown>} replacements  the sentinels in force
 * @returns {string[]}
 */
export function sentinelsIn(node, replacements) {
  const found = [];
  if (!replacements || replacements.size === 0) return found;
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n === null || typeof n !== 'object') return;
    for (const [key, value] of Object.entries(n)) {
      if (key === 'value' && typeof value === 'string' && replacements.has(value)) {
        if (!found.includes(value)) found.push(value);
      } else if (value !== null && typeof value === 'object') {
        walk(value);
      }
    }
  };
  walk(node);
  return found;
}
