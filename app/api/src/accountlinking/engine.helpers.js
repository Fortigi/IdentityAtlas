// Identity Atlas — Account Linking engine, pure helpers.
//
// Dependency-light, DB-free helpers factored out of engine.js so the linking
// engine's top-level functions stay small and flat. Everything here is pure
// (no DB, no side effects) and unit-tested directly in engine.helpers.test.js.

import {
  normalizeName,
  emailLocalPart,
  stripKnownPrefixes,
  parseName,
} from './classifier.js';

/** Normalise any scalar to a trimmed, lower-cased comparison token. */
export const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

/** givenName + surname joined and normalised (optionally stripping suffixes). */
export const fullName = (o, suffixes = []) =>
  normalizeName([o.givenName, o.surname].filter(Boolean).join(' '), suffixes);

/** Parse a principal/identity row into a comparable person name. */
export const personName = (o) => parseName(o.displayName, o.givenName, o.surname);

export function prefixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'prefix')?.stripPrefixes || [];
}
export function suffixesFrom(rules) {
  return (rules.signals || []).find(s => s.type === 'fuzzy')?.stripSuffixes || [];
}
export function nameSignalNames(rules) {
  return new Set((rules.signals || []).filter(s => s.type === 'name').map(s => s.name));
}

/**
 * Index identities so buildLinks only scores plausible candidates per orphan.
 * @returns {{ byEmployeeId: Map, byEmailLocal: Map, byName: Map, byNameKey: Map }}
 */
export function indexIdentities(identities) {
  const byEmployeeId = new Map();
  const byEmailLocal = new Map();
  const byName = new Map();
  const byNameKey = new Map();
  const push = (map, key, v) => { if (!key) return; (map.get(key) || map.set(key, []).get(key)).push(v); };
  for (const idy of identities) {
    push(byEmployeeId, norm(idy.employeeId), idy);
    push(byEmailLocal, emailLocalPart(idy.email), idy);
    push(byName, normalizeName(idy.displayName) || fullName(idy), idy);
    push(byNameKey, personName(idy).key, idy);
  }
  return { byEmployeeId, byEmailLocal, byName, byNameKey };
}

/**
 * All identities plausibly matching an orphan, deduped by identity id.
 * @returns {Map<string, object>}
 */
export function collectCandidates(orphan, indexes, { prefixes, suffixes }) {
  const { byEmployeeId, byEmailLocal, byName, byNameKey } = indexes;
  const candidates = new Map();
  const addAll = (arr) => { for (const idy of (arr || [])) candidates.set(idy.id, idy); };
  addAll(byEmployeeId.get(norm(orphan.employeeId)));
  addAll(byEmailLocal.get(emailLocalPart(orphan.email)));
  addAll(byEmailLocal.get(stripKnownPrefixes(emailLocalPart(orphan.email), prefixes)));
  addAll(byName.get(normalizeName(orphan.displayName, suffixes) || fullName(orphan, suffixes)));
  addAll(byNameKey.get(personName(orphan).key));
  return candidates;
}

/**
 * Per-identity rollup of newly-built links: best confidence + union of signals.
 * @returns {Map<string, { conf: number, signals: Set<string> }>}
 */
export function aggregateByIdentity(links) {
  const byIdentity = new Map();
  for (const l of links) {
    const g = byIdentity.get(l.identityId) || { conf: 0, signals: new Set() };
    g.conf = Math.max(g.conf, l.confidence);
    for (const s of l.signals) g.signals.add(s);
    byIdentity.set(l.identityId, g);
  }
  return byIdentity;
}
