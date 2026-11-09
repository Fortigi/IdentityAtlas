// Which contexts a context page may link to — its sub-units and its parents.
//
// contextOpener(...) returns `(ctx) => handler | undefined`: the click handler
// that opens that context, or undefined when it is plain text here.
//   - no detail handler                 → nothing is a link;
//   - a read-only view (a shared matrix) → nothing is a link;
//   - a context owner's read-only page   → only a context in their scope;
//   - everywhere else                    → every context.

export function contextOpener({ sharedView = false, ownerScope = null, onOpenDetail } = {}) {
  if (!onOpenDetail || (sharedView && !ownerScope)) return () => undefined;
  return (ctx) => {
    if (sharedView && !ownerScope.has(String(ctx.id).toLowerCase())) return undefined;
    return () => onOpenDetail('context', ctx.id, ctx.displayName);
  };
}
