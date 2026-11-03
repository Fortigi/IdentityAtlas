// Owner access — the one server-side scope for a caller who sees Identity Atlas
// only as the owner of their contexts. Anything that answers on such a caller's
// behalf (the REST middleware today, the MCP server next) imports from here.
// See docs/architecture/context-owner-access.md → "Reusing this scope (MCP)".

export { createOwnerAccess, normaliseKind, clearOwnerAccessCache, CACHE_TTL_MS } from './ownerAccess.js';
export { TEAM, HELD, HOLDER, KINDS, classifyTiers } from './tiers.js';
export { entityEndpointFor, refsFor } from './endpoints.js';
export { annotateReferences } from './annotate.js';
export { MATRIX_DATA_PATH, ownerMatrixVerdict } from './matrixFilter.js';
