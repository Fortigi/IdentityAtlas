// Pure helpers for ContextAccessCounts.jsx, kept out of the component file so React Fast
// Refresh can hot-swap it (react-refresh/only-export-components).

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
