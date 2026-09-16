// Pure step-list derivation and size rules for the Matrix filter wizard.
//
// Also home to the constants the wizard and its steps share, so no file owns a
// copy of another's threshold.
//
// Four steps, each answering one question (#1202 — "a matrix is a document"):
//
//   subjects   — who is in it?           (User accounts / Identities + conditions)
//   resources  — what access?            (Resources / +business roles + conditions)
//   layout     — how does it read?       (group & sort, roll-up, what it opens with)
//   save       — keep it?                (name, description, share with)
//
// Only one step is ever hidden: a roll-up that shows business roles only has no
// resource side to filter, so `resources` drops out. Save is ALWAYS present —
// saving needs no share permission; the step gates just its "Share with"
// section on that.

// Above this many assignments, 'auto' fold-on-load defaults to folded so the
// first render stays fast. Read by the wizard (to decide what Apply commits)
// and by the Sort section (to label the 'auto' checkbox with what it will do).
export const FOLD_AUTO_THRESHOLD = 5000;

export const WARN_ASSIGNMENTS  =  5_000;
export const BLOCK_ASSIGNMENTS = 25_000;

export const STEP_KEYS = ['subjects', 'resources', 'layout', 'save'];

// Keys the wizard used before the four-step layout. Callers (a deep link, the
// strip's "Share" action) may still ask for them.
const STEP_ALIASES = { setup: 'subjects', content: 'layout', sort: 'layout', share: 'save' };

// The step the wizard opens on for a requested key: a current key as-is, a
// legacy key via its alias, anything else the first step.
export function resolveInitialStep(key) {
  const resolved = STEP_ALIASES[key] || key;
  return STEP_KEYS.includes(resolved) ? resolved : 'subjects';
}

// Is any roll-up (attribute or context tree) switched on?
export function isRollupOn(filter) {
  return !!filter?.rollup || (filter?.rollupKind === 'context' && !!filter?.rollupContextId);
}

// Which keyed steps this filter shows, plus the derived navigation position.
// `step` is the currently-selected key; when it has become hidden (the user
// switched to a roles-only roll-up), `activeStep` falls back to the nearest
// visible one so the body never goes blank.
export function deriveSteps(filter, step) {
  const rollupOn = isRollupOn(filter);
  const rolesOnly = rollupOn && filter.rollupContent === 'roles-only';
  const steps = [
    { key: 'subjects',  label: 'Subjects' },
    rolesOnly ? null : { key: 'resources', label: 'Resources' },
    { key: 'layout',    label: 'Layout' },
    { key: 'save',      label: 'Save & share' },
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
// Saving and sharing store this same shape (#1166), not the raw edit state. A
// share is a snapshot nobody can adjust afterwards, so a snapshot missing
// `foldAttributes` would ask a recipient's browser for every per-subject row of
// a matrix that only loads aggregated — a link that opens to nothing, with no
// way for them to fix it.
export function commitFilter(filter, foldAttributes) {
  return {
    ...filter,
    foldAttributes,
    rollupExpanded: foldAttributes ? [] : (filter.rollupExpanded || []),
    rollupCollapsed: [],
  };
}

// ─── Size rules ─────────────────────────────────────────────────────

function willLoadFolded(filter, assignmentCount) {
  const fol = filter?.foldOnLoad ?? 'auto';
  if (fol === true) return true;
  if (fol === false) return false;
  return (assignmentCount || 0) >= FOLD_AUTO_THRESHOLD;
}

const sortsOnAttributes = (filter) => (filter?.sortAttributes?.length || 0) > 0;

// An oversized FLAT matrix can still load efficiently IF it will open folded on
// attributes: we then serve it as a server-aggregated layered view (counts +
// expand-in-place) instead of shipping every per-subject row. (Small matrices
// keep the detailed per-subject grid; an oversized *unfolded* matrix can't.)
export function servesViaAttrCut(filter, anyRollup, assignmentCount) {
  if (anyRollup || filter?.sortHierarchy) return false;
  if ((assignmentCount || 0) <= BLOCK_ASSIGNMENTS) return false;
  return sortsOnAttributes(filter) && willLoadFolded(filter, assignmentCount);
}

// Server-aggregated views return a compact payload, so they load at any size:
// attribute roll-up, context roll-up, Manager-Hierarchy sort, and an oversized
// attribute fold served via the layered attribute cut.
export function isServerAggregated(filter, anyRollup, assignmentCount) {
  return anyRollup || !!filter?.sortHierarchy || servesViaAttrCut(filter, anyRollup, assignmentCount);
}

// Hard-block only an oversized FLAT matrix that won't fold — folding the columns
// is what lets us aggregate it on the server; an unfolded oversized grid would
// have to ship every per-subject row, which can't be loaded.
export function matrixIsBlocked(filter, anyRollup, assignmentCount) {
  if (anyRollup || filter?.sortHierarchy) return false;
  if ((assignmentCount || 0) <= BLOCK_ASSIGNMENTS) return false;
  return !(sortsOnAttributes(filter) && willLoadFolded(filter, assignmentCount));
}

// ─── Axis wording ───────────────────────────────────────────────────

// Which axis the subjects and the resources sit on, in the words the Subjects
// and Resources steps open with. The default matrix puts resources on the rows
// and subjects on the columns; the rotated one swaps them — so a fixed "Rows
// are" on the Subjects step would be wrong for the default.
export function axisHeadings(orientation) {
  const rotated = orientation === 'rows-as-subjects';
  return {
    subjects:  rotated ? 'Rows are' : 'Columns are',
    resources: rotated ? 'Columns are' : 'Rows are',
  };
}

// ─── Roll-up ────────────────────────────────────────────────────────

// The roll-up choice the Layout step shows. A context roll-up that has no
// context picked yet still reads as "By context" — the analyst chose it and is
// about to pick one.
export function rollupModeOf(filter) {
  if (filter?.rollupKind === 'context') return 'context';
  return filter?.rollup ? 'attribute' : 'off';
}

// The filter with its roll-up switched to `mode` ('off' | 'attribute' |
// 'context'). Choosing "By attribute" starts on `attribute` (the first sensible
// one) so the matrix is never left "rolled up by nothing". Every switch starts
// the drill state afresh, and switching a roll-up ON drops the Manager-Hierarchy
// column sort — the API serves that sort as a context roll-up of its own, so the
// two cannot both apply.
export function applyRollupMode(filter, mode, attribute = null) {
  const reset = { rollupPath: [], rollupExpanded: [], rollupCollapsed: [] };
  if (mode === 'attribute') {
    return { ...filter, ...reset, rollupKind: 'attribute', rollup: filter.rollup || attribute, rollupContextId: null, sortHierarchy: null };
  }
  if (mode === 'context') {
    return { ...filter, ...reset, rollupKind: 'context', rollup: null, sortHierarchy: null };
  }
  return { ...filter, ...reset, rollupKind: 'attribute', rollup: null, rollupContextId: null };
}

// Every context id the filter refers to — condition chips and the roll-up
// context — so their names can be resolved once instead of showing UUIDs.
export function referencedContextIds(filter) {
  const ids = new Set();
  for (const block of [filter?.subject, filter?.resource]) {
    for (const cond of [...(block?.include || []), ...(block?.exclude || [])]) {
      if (cond?.kind === 'context' && cond.contextId) ids.add(cond.contextId);
    }
  }
  if (filter?.rollupKind === 'context' && filter.rollupContextId) ids.add(filter.rollupContextId);
  return [...ids];
}
