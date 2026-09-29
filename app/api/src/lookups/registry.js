// Lookup-source registry, mirroring the report-template registry.
//
// Sources are in-tree code modules, never user input, so there is no dynamic
// import from a request: the built-ins are imported statically by
// sources/index.js and seeded here at module load. `registerLookup` exists so a
// test (or a future in-tree module) can add a source without touching the
// route — which is the property the seam test asserts.

import { BUILT_IN_LOOKUPS } from './sources/index.js';

/** @type {Map<string, import('./types.js').LookupSource>} */
const SOURCES = new Map(BUILT_IN_LOOKUPS.map(s => [s.name, s]));

const REQUIRED_FIELDS = ['name', 'displayName', 'search'];

/**
 * Add a source to the registry.
 * @param {import('./types.js').LookupSource} source
 * @returns {() => void} unregister callback
 */
export function registerLookup(source) {
  const missing = REQUIRED_FIELDS.filter(f => !source?.[f]);
  if (missing.length) throw new Error(`Invalid lookup source: missing ${missing.join(', ')}`);
  SOURCES.set(source.name, source);
  return () => { SOURCES.delete(source.name); };
}

/** The source with this name, or null when it isn't registered. */
export function getLookup(name) {
  return SOURCES.get(name) || null;
}

/** Every registered source, ordered by display name. */
export function listLookups() {
  return [...SOURCES.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}
