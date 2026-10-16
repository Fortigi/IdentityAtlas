// How much access hangs off a context that groups resources: the stored counts
// the API recalculates after each sync (Contexts.resourceCount and friends).
//
// Shown only when they have been calculated. A context that does not group
// resources never has them, and one that has not been through a sync yet does
// not either — an empty line there would read as "no access", which is a
// finding, when the truth is "not counted".

import { accessCountParts } from './ContextAccessCounts.helpers';

export default function ContextAccessCounts({ attrs }) {
  const parts = accessCountParts(attrs);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1" title="Counted after the last sync, for this context's own resources">
      {parts.join(' · ')}
    </p>
  );
}
