// Lookup-source contract.
//
// A lookup source answers one question: "what can I pick here, and what is it
// called?" It exists so a parameter that means AN ENTITY — a logical
// application, a system, a business role — can be offered as a list instead of
// typed from memory, and so the thing that gets stored is the entity's id
// rather than a name that might match three of them.
//
// The shape deliberately mirrors the report-template contract
// (reports/types.js): name / displayName / a function the engine calls. Adding
// a source is a file plus one line in sources/index.js; the route, the
// registry and the form never name one.
//
// A source returns OPTIONS, not rows. Normalising in the source rather than in
// the client is what lets one generic control render every source: the client
// knows `value` / `label` / `hint` and nothing about contexts, systems or
// business roles.

/**
 * @typedef {Object} LookupOption
 * @property {string} value  The stable id a parameter stores. Pinning this is
 *                           the point: a name can match several entities, an id
 *                           cannot.
 * @property {string} label  What a person recognises it by.
 * @property {string} [hint] A second line that tells two same-named entities
 *                           apart — a size, a system, a scope.
 */

/**
 * @typedef {Object} LookupSource
 * @property {string} name         Stable slug, unique in the registry; the URL
 *                                  path parameter and the `x-lookup` value.
 * @property {string} displayName  What the source is, for a human.
 * @property {Function} search     ({ q, limit }) => Promise<LookupOption[]>.
 *                                  An empty `q` means "the first `limit`
 *                                  options", so focusing an empty box offers
 *                                  something rather than nothing.
 * @property {Function} [resolve]  ({ ids }) => Promise<LookupOption[]>. Turns
 *                                  stored ids back into labels, so a report
 *                                  opened from a bookmarked URL shows names
 *                                  rather than the raw ids it was given.
 */

export {};
