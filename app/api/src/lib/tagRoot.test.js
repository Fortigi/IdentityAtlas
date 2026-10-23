// The tag-root marker and its two SQL predicates are shared by bootstrap, the
// tags routes and the curated import; pin that they agree with each other and
// with migration 092's own exclusion.

import { describe, it, expect } from 'vitest';
import { TAG_ROOT_MARKER, IS_TAG_ROOT_SQL, NOT_TAG_ROOT_SQL } from './tagRoot.js';

describe('tagRoot', () => {
  it('the marker is the one the predicates test for', () => {
    expect(TAG_ROOT_MARKER).toEqual({ tagRoot: true });
    expect(IS_TAG_ROOT_SQL).toBe(`"extendedAttributes"->>'tagRoot' = 'true'`);
    // A tag without the key (NULL) is not the root either.
    expect(NOT_TAG_ROOT_SQL).toBe(`COALESCE("extendedAttributes"->>'tagRoot', 'false') <> 'true'`);
  });
});
