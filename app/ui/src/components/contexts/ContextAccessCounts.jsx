// How much access hangs off a context that groups resources: the stored counts
// the API recalculates after each sync (Contexts.resourceCount and friends).
//
// Shown only when they have been calculated. A context that does not group
// resources never has them, and one that has not been through a sync yet does
// not either — an empty line there would read as "no access", which is a
// finding, when the truth is "not counted".

const number = (n) => Number(n).toLocaleString('en-US');
const plural = (n, one, many) => `${number(n)} ${Number(n) === 1 ? one : many}`;

/** The parts of the line, in reading order, or [] when nothing was calculated. */
export function accessCountParts(attrs) {
  if (attrs?.resourceCount === null || attrs?.resourceCount === undefined) return [];
  const direct = attrs.directAssignmentCount ?? 0;
  const indirect = attrs.indirectAssignmentCount ?? 0;
  const eligible = attrs.eligibleAssignmentCount ?? 0;

  const parts = [
    plural(attrs.resourceCount, 'resource', 'resources'),
    `${plural(direct + indirect, 'assignment', 'assignments')} (${number(direct)} direct, ${number(indirect)} via a role)`,
    plural(attrs.holderCount ?? 0, 'holder', 'holders'),
  ];
  if (eligible > 0) parts.push(`${number(eligible)} eligible`);
  return parts;
}

export default function ContextAccessCounts({ attrs }) {
  const parts = accessCountParts(attrs);
  if (parts.length === 0) return null;
  return (
    <p className="text-xs text-gray-600 dark:text-gray-400 mt-1" title="Counted after the last sync, for this context's own resources">
      {parts.join(' · ')}
    </p>
  );
}
