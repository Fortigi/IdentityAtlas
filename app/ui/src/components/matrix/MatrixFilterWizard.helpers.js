// Pure step-list derivation for the Matrix filter wizard.
//
// The wizard's steps are dynamic and keyed. Attribute roll-up inserts a
// "Content" step (resources/roles shape); roles-only drops the Resources
// filter. Any roll-up (attribute or context tree) drops the Sort step. The
// context-tree roll-up has no Content step of its own (it's always
// resources-as-rows). The Content step (resources / +roles / roles-only)
// applies to BOTH attribute and context roll-ups.
//
// A final "Share" step is appended for a user who may share (#1166) — building
// a matrix for somebody else is the same sitting as building it, so the option
// belongs at the end of the wizard rather than only on a toolbar the analyst
// has to remember afterwards. It is purely optional: Apply is available on it
// exactly as it was on the previous last step.

// Which keyed steps this filter shows, plus the derived navigation position.
// `step` is the currently-selected key; when it has become hidden (the user
// toggled roll-up / content, or lost the share permission), `activeStep` falls
// back to the nearest visible one so the body never goes blank.
export function deriveSteps(filter, step, { canShare = false } = {}) {
  const contextRollup = filter.rollupKind === 'context' && !!filter.rollupContextId;
  const attrRollup = !!filter.rollup;
  const rollupOn = attrRollup || contextRollup;
  const rolesOnly = rollupOn && filter.rollupContent === 'roles-only';
  const steps = [
    { key: 'setup',    label: 'Setup' },
    rollupOn ? { key: 'content', label: 'Content' } : null,
    { key: 'subjects', label: 'Subjects' },
    rolesOnly ? null : { key: 'resources', label: 'Resources' },
    rollupOn ? null : { key: 'sort', label: 'Sort' },
    canShare ? { key: 'share', label: 'Share' } : null,
  ].filter(Boolean);
  const stepKeys = steps.map(s => s.key);
  const curPos = Math.max(0, stepKeys.indexOf(step));
  const isLast = curPos === steps.length - 1;
  const activeStep = stepKeys.includes(step) ? step : stepKeys[Math.min(curPos, steps.length - 1)];
  return { steps, stepKeys, curPos, isLast, activeStep, rollupOn };
}

// The filter in the shape the wizard COMMITS — what Apply hands to the matrix.
// It differs from the filter the steps edit: `foldAttributes` decides whether
// an oversized-but-foldable matrix is served as the layered, server-aggregated
// attribute view, and the expand/collapse state starts fresh.
//
// The Share step mints its link from this same shape (#1166), not from the
// raw edit state. A share is a snapshot nobody can adjust afterwards, so a
// snapshot missing `foldAttributes` would ask a recipient's browser for every
// per-subject row of a matrix that only loads aggregated — a link that opens
// to nothing, with no way for them to fix it.
export function commitFilter(filter, foldAttributes) {
  return {
    ...filter,
    foldAttributes,
    rollupExpanded: foldAttributes ? [] : (filter.rollupExpanded || []),
    rollupCollapsed: [],
  };
}
