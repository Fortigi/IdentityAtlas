import { describe, it, expect } from 'vitest';
import {
  deriveSteps, commitFilter, resolveInitialStep, isRollupOn, axisHeadings,
  rollupModeOf, applyRollupMode, referencedContextIds,
  servesViaAttrCut, isServerAggregated, matrixIsBlocked, BLOCK_ASSIGNMENTS, FOLD_AUTO_THRESHOLD,
} from './MatrixFilterWizard.helpers';

describe('deriveSteps', () => {
  it('lists Subjects → Resources → Layout → Save & share with no roll-up', () => {
    const { steps, stepKeys, rollupOn } = deriveSteps({}, 'subjects');
    expect(stepKeys).toEqual(['subjects', 'resources', 'layout', 'save']);
    expect(steps.map(s => s.label)).toEqual(['Subjects', 'Resources', 'Layout', 'Save & share']);
    expect(rollupOn).toBe(false);
  });

  it('keeps all four steps for an attribute roll-up — roll-up lives inside Layout now', () => {
    const { stepKeys, rollupOn } = deriveSteps({ rollup: 'department' }, 'subjects');
    expect(stepKeys).toEqual(['subjects', 'resources', 'layout', 'save']);
    expect(rollupOn).toBe(true);
  });

  it('treats a context-tree roll-up as roll-up only once a context is picked', () => {
    expect(deriveSteps({ rollupKind: 'context', rollupContextId: 'ctx-1' }, 'subjects').rollupOn).toBe(true);
    expect(deriveSteps({ rollupKind: 'context', rollupContextId: '' }, 'subjects').rollupOn).toBe(false);
  });

  it('drops the Resources step for a roles-only roll-up, and only for a roll-up', () => {
    expect(deriveSteps({ rollup: 'department', rollupContent: 'roles-only' }, 'subjects').stepKeys)
      .toEqual(['subjects', 'layout', 'save']);
    expect(deriveSteps({ rollupKind: 'context', rollupContextId: 'ctx-1', rollupContent: 'roles-only' }, 'subjects').stepKeys)
      .toEqual(['subjects', 'layout', 'save']);
    // A leftover roles-only content with the roll-up OFF must not hide resources.
    expect(deriveSteps({ rollup: null, rollupContent: 'roles-only' }, 'subjects').stepKeys)
      .toContain('resources');
  });

  it('always ends on Save & share — saving needs no share permission', () => {
    expect(deriveSteps({}, 'save').isLast).toBe(true);
    expect(deriveSteps({}, 'layout').isLast).toBe(false);
    expect(deriveSteps({ rollup: 'd', rollupContent: 'roles-only' }, 'save').stepKeys.at(-1)).toBe('save');
  });

  it('reports the navigation position', () => {
    expect(deriveSteps({}, 'subjects').curPos).toBe(0);
    expect(deriveSteps({}, 'layout').curPos).toBe(2);
    expect(deriveSteps({ rollup: 'd', rollupContent: 'roles-only' }, 'layout').curPos).toBe(1);
  });

  it('falls back to a visible step when the current one is hidden', () => {
    const { activeStep, stepKeys } = deriveSteps({ rollup: 'department', rollupContent: 'roles-only' }, 'resources');
    expect(stepKeys).not.toContain('resources');
    expect(activeStep).toBe('subjects');
  });

  it('keeps the selected step active when it is still visible', () => {
    expect(deriveSteps({}, 'resources').activeStep).toBe('resources');
  });
});

describe('resolveInitialStep', () => {
  it('opens on a current step key as asked', () => {
    for (const key of ['subjects', 'resources', 'layout', 'save']) expect(resolveInitialStep(key)).toBe(key);
  });

  it('maps every legacy key onto the step that now holds it', () => {
    expect(resolveInitialStep('setup')).toBe('subjects');
    expect(resolveInitialStep('content')).toBe('layout');
    expect(resolveInitialStep('sort')).toBe('layout');
    expect(resolveInitialStep('share')).toBe('save');
  });

  it('opens on Subjects for nothing, or for a key it does not know', () => {
    expect(resolveInitialStep(undefined)).toBe('subjects');
    expect(resolveInitialStep('orientation')).toBe('subjects');
    // An inherited object key must not resolve through the alias table.
    expect(resolveInitialStep('toString')).toBe('subjects');
  });
});

describe('isRollupOn', () => {
  it('is on for an attribute, or a context with an id, and off otherwise', () => {
    expect(isRollupOn({ rollup: 'department' })).toBe(true);
    expect(isRollupOn({ rollupKind: 'context', rollupContextId: 'c' })).toBe(true);
    expect(isRollupOn({ rollupKind: 'attribute', rollupContextId: 'c' })).toBe(false);
    expect(isRollupOn(null)).toBe(false);
  });
});

describe('axisHeadings', () => {
  it('puts subjects on the columns of the default matrix and on the rows of the rotated one', () => {
    expect(axisHeadings('rows-as-resources')).toEqual({ subjects: 'Columns are', resources: 'Rows are' });
    expect(axisHeadings('rows-as-subjects')).toEqual({ subjects: 'Rows are', resources: 'Columns are' });
    expect(axisHeadings(undefined).subjects).toBe('Columns are');
  });
});

describe('rollupModeOf', () => {
  it('reads context before attribute, and off when neither is set', () => {
    expect(rollupModeOf({ rollupKind: 'context', rollup: 'department' })).toBe('context');
    expect(rollupModeOf({ rollupKind: 'context', rollupContextId: null })).toBe('context');
    expect(rollupModeOf({ rollupKind: 'attribute', rollup: 'department' })).toBe('attribute');
    expect(rollupModeOf({ rollupKind: 'attribute', rollup: null })).toBe('off');
    expect(rollupModeOf(undefined)).toBe('off');
  });
});

describe('applyRollupMode', () => {
  const drilled = {
    rowType: 'identity', rollup: null, rollupKind: 'attribute', rollupContextId: null,
    rollupPath: ['a'], rollupExpanded: ['b'], rollupCollapsed: ['c'],
    sortHierarchy: { contextId: 'h-1' }, sortAttributes: [{ attribute: 'city', dir: 'asc' }],
  };

  it('By attribute starts on the offered attribute, drops the hierarchy sort and the drill state', () => {
    const out = applyRollupMode(drilled, 'attribute', 'department');
    expect(out).toMatchObject({ rollupKind: 'attribute', rollup: 'department', rollupContextId: null, sortHierarchy: null });
    expect(out).toMatchObject({ rollupPath: [], rollupExpanded: [], rollupCollapsed: [] });
    // Everything else is left alone.
    expect(out.rowType).toBe('identity');
    expect(out.sortAttributes).toEqual([{ attribute: 'city', dir: 'asc' }]);
  });

  it('By attribute keeps an attribute already chosen', () => {
    expect(applyRollupMode({ ...drilled, rollup: 'jobTitle' }, 'attribute', 'department').rollup).toBe('jobTitle');
  });

  it('By context clears the attribute and the hierarchy sort, keeping a context already picked', () => {
    const out = applyRollupMode({ ...drilled, rollup: 'department', rollupContextId: 'ctx-9' }, 'context');
    expect(out).toMatchObject({ rollupKind: 'context', rollup: null, rollupContextId: 'ctx-9', sortHierarchy: null, rollupPath: [] });
  });

  it('Off clears both roll-ups but keeps the column sort the analyst had', () => {
    const out = applyRollupMode({ ...drilled, rollup: 'department', rollupKind: 'context', rollupContextId: 'ctx-9' }, 'off');
    expect(out).toMatchObject({ rollupKind: 'attribute', rollup: null, rollupContextId: null, rollupExpanded: [] });
    expect(out.sortHierarchy).toEqual({ contextId: 'h-1' });
  });

  it('does not mutate the filter it was given', () => {
    const input = structuredClone(drilled);
    applyRollupMode(input, 'attribute', 'department');
    expect(input).toEqual(drilled);
  });
});

describe('referencedContextIds', () => {
  it('collects context conditions from both sides and the context roll-up, once each', () => {
    const ids = referencedContextIds({
      subject:  { include: [{ kind: 'context', contextId: 's1' }, { kind: 'attribute', field: 'x' }], exclude: [{ kind: 'context', contextId: 's2' }] },
      resource: { include: [{ kind: 'context', contextId: 's1' }], exclude: [] },
      rollupKind: 'context', rollupContextId: 'r1',
    });
    expect(ids).toEqual(['s1', 's2', 'r1']);
  });

  it('ignores a roll-up context id unless the roll-up is by context', () => {
    expect(referencedContextIds({ rollupKind: 'attribute', rollupContextId: 'r1' })).toEqual([]);
    expect(referencedContextIds({ subject: { include: [{ kind: 'context' }] } })).toEqual([]);
  });
});

describe('size rules', () => {
  const OVER = BLOCK_ASSIGNMENTS + 1;
  const folded = { sortAttributes: [{ attribute: 'department' }], foldOnLoad: true };

  it('blocks only an oversized flat matrix that will not fold', () => {
    expect(matrixIsBlocked({ sortAttributes: [], foldOnLoad: true }, false, OVER)).toBe(true);
    expect(matrixIsBlocked({ ...folded, foldOnLoad: false }, false, OVER)).toBe(true);
    expect(matrixIsBlocked(folded, false, OVER)).toBe(false);
    // Exactly at the limit still loads.
    expect(matrixIsBlocked({ sortAttributes: [] }, false, BLOCK_ASSIGNMENTS)).toBe(false);
    // Aggregated views are never blocked.
    expect(matrixIsBlocked({ sortAttributes: [] }, true, OVER)).toBe(false);
    expect(matrixIsBlocked({ sortAttributes: [], sortHierarchy: { contextId: 'h' } }, false, OVER)).toBe(false);
  });

  it("serves an oversized folding matrix via the attribute cut, with 'auto' folding past the threshold", () => {
    expect(servesViaAttrCut(folded, false, OVER)).toBe(true);
    expect(servesViaAttrCut({ ...folded, foldOnLoad: 'auto' }, false, OVER)).toBe(OVER >= FOLD_AUTO_THRESHOLD);
    expect(servesViaAttrCut(folded, false, BLOCK_ASSIGNMENTS)).toBe(false);
    expect(servesViaAttrCut(folded, true, OVER)).toBe(false);
  });

  it('counts roll-ups, hierarchy sorts and the attribute cut as server-aggregated', () => {
    expect(isServerAggregated({}, true, 10)).toBe(true);
    expect(isServerAggregated({ sortHierarchy: { contextId: 'h' } }, false, 10)).toBe(true);
    expect(isServerAggregated(folded, false, OVER)).toBe(true);
    expect(isServerAggregated(folded, false, 10)).toBe(false);
  });
});

describe('commitFilter', () => {
  it('stamps foldAttributes and clears the expand state when folding', () => {
    const out = commitFilter(
      { rowType: 'principal', sortAttributes: [{ attribute: 'department', dir: 'asc' }], rollupExpanded: ['Sales'], rollupCollapsed: ['HR'] },
      true,
    );
    expect(out.foldAttributes).toBe(true);
    expect(out.rollupExpanded).toEqual([]);
    expect(out.rollupCollapsed).toEqual([]);
    // Everything the steps edited survives untouched.
    expect(out.rowType).toBe('principal');
    expect(out.sortAttributes).toEqual([{ attribute: 'department', dir: 'asc' }]);
  });

  it('keeps an existing expand state when not folding', () => {
    const out = commitFilter({ rollupExpanded: ['Sales'], rollupCollapsed: ['HR'] }, false);
    expect(out.foldAttributes).toBe(false);
    expect(out.rollupExpanded).toEqual(['Sales']);
    expect(out.rollupCollapsed).toEqual([]);
  });

  it('defaults a missing expand state to empty rather than undefined', () => {
    // A filter loaded from an older saved matrix has neither key; the matrix
    // reads them as arrays, so the committed shape must supply them.
    const out = commitFilter({ rowType: 'identity' }, false);
    expect(out.rollupExpanded).toEqual([]);
    expect(out.rollupCollapsed).toEqual([]);
  });

  it('does not mutate the filter it was given', () => {
    const input = { rollupExpanded: ['Sales'] };
    commitFilter(input, true);
    expect(input).toEqual({ rollupExpanded: ['Sales'] });
  });
});
