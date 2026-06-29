// Decide whether a root context should be shown given the target-type filters.
// `targetTypes` (a non-empty array) takes precedence over single `targetType`.
// When neither is supplied, nothing is filtered out. Kept in a non-component
// module so ContextPicker.jsx only exports its component (Vite fast-refresh).
export function matchesTargetTypes(ctx, { targetTypes = null, targetType = null } = {}) {
  if (Array.isArray(targetTypes) && targetTypes.length) {
    return targetTypes.includes(ctx.targetType);
  }
  if (targetType) {
    return ctx.targetType === targetType;
  }
  return true;
}
