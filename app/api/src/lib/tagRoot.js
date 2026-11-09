// The tag root — the synthetic "Tags" node every tag of one targetType hangs
// under — is itself a Tag context (contextType = 'Tag') marked with
// extendedAttributes.tagRoot = true, since phase B of the context templates
// removed the dedicated root types (docs/architecture/context-templates-phase-b.md).
//
// Every query that lists, reads or deletes tags must leave the root out, and
// bootstrap must find it by the marker. One predicate for all of them, so the
// three sites (bootstrap, tags routes, curated import) cannot drift apart.

export const TAG_ROOT_MARKER = { tagRoot: true };

// Unaliased predicates for queries that read "Contexts" without a table alias.
export const IS_TAG_ROOT_SQL  = `"extendedAttributes"->>'tagRoot' = 'true'`;
export const NOT_TAG_ROOT_SQL = `COALESCE("extendedAttributes"->>'tagRoot', 'false') <> 'true'`;
