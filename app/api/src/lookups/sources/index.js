// The built-in lookup sources.
//
// This is the ONE line a source costs on top of its own file: import it here
// and put it in the array. Nothing else — not the registry, not the route, not
// the parameter form — knows a source by name.

import accessReviewFields from './access-review-fields.js';
import resourceContexts from './resource-contexts.js';

/** @type {import('../types.js').LookupSource[]} */
export const BUILT_IN_LOOKUPS = [
  accessReviewFields,
  resourceContexts,
];
