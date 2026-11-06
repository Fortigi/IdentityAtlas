// Mark every reference in a response with whether the owner may open it.
//
// `refs` (./endpoints.js) say where the references sit; `access` is the owner's
// scope service (./ownerAccess.js). Each referenced object gets
// `accessible: true | false` (or the ref's own flag name) — nothing is removed,
// so a group's member list stays complete and the UI shows the members the
// owner may not open as plain text. The ids are classified in one batch per
// kind. The body is changed in place and returned.

import { normaliseKind } from './ownerAccess.js';

// Every object at a dotted path; arrays along the way are walked into.
export function objectsAt(body, path) {
  let nodes = [body];
  for (const seg of path ? path.split('.') : []) {
    nodes = nodes.flatMap(n => (Array.isArray(n) ? n : [n])).map(n => (n && typeof n === 'object' ? n[seg] : undefined));
  }
  return nodes.flatMap(n => (Array.isArray(n) ? n : [n])).filter(n => n !== null && typeof n === 'object');
}

// [{ obj, kind, id, flag }] — one per reference that names an id of a known kind.
export function collectRefs(body, refs) {
  const out = [];
  for (const ref of refs) {
    for (const obj of objectsAt(body, ref.at)) {
      const kind = normaliseKind(ref.kind ?? obj[ref.kindKey]);
      const id = obj[ref.key];
      if (kind && typeof id === 'string' && id) out.push({ obj, kind, id: id.toLowerCase(), flag: ref.flag || 'accessible' });
    }
  }
  return out;
}

export async function annotateReferences(body, refs, access) {
  if (!body || typeof body !== 'object' || !refs?.length) return body;
  const found = collectRefs(body, refs);
  const idsByKind = new Map();
  for (const r of found) {
    if (!idsByKind.has(r.kind)) idsByKind.set(r.kind, new Set());
    idsByKind.get(r.kind).add(r.id);
  }
  const allowedByKind = new Map();
  for (const [kind, ids] of idsByKind) allowedByKind.set(kind, await access.accessibleIds(kind, [...ids]));
  // The first ref naming an id on an object decides that object's flag.
  const decided = new Map(); // object → Set of flags already written
  for (const r of found) {
    const flags = decided.get(r.obj) || new Set();
    if (flags.has(r.flag)) continue;
    r.obj[r.flag] = allowedByKind.get(r.kind).has(r.id);
    flags.add(r.flag);
    decided.set(r.obj, flags);
  }
  return body;
}
