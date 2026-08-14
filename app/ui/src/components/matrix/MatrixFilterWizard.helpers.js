// Pure step-list derivation for the Matrix filter wizard.
//
// The wizard's steps are dynamic and keyed. Attribute roll-up inserts a
// "Content" step (resources/roles shape); roles-only drops the Resources
// filter. Any roll-up (attribute or context tree) drops the Sort step. The
// context-tree roll-up has no Content step of its own (it's always
// resources-as-rows). The Content step (resources / +roles / roles-only)
// applies to BOTH attribute and context roll-ups.

// Which keyed steps this filter shows, plus the derived navigation position.
// `step` is the currently-selected key; when it has become hidden (the user
// toggled roll-up / content), `activeStep` falls back to the nearest visible
// one so the body never goes blank.
export function deriveSteps(filter, step) {
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
  ].filter(Boolean);
  const stepKeys = steps.map(s => s.key);
  const curPos = Math.max(0, stepKeys.indexOf(step));
  const isLast = curPos === steps.length - 1;
  const activeStep = stepKeys.includes(step) ? step : stepKeys[Math.min(curPos, steps.length - 1)];
  return { steps, stepKeys, curPos, isLast, activeStep, rollupOn };
}
