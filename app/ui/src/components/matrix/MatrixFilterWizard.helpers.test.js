import { describe, it, expect } from 'vitest';
import { deriveSteps } from './MatrixFilterWizard.helpers';

describe('deriveSteps', () => {
  it('lists Setup → Subjects → Resources → Sort with no roll-up', () => {
    const { steps, stepKeys, rollupOn } = deriveSteps({}, 'setup');
    expect(stepKeys).toEqual(['setup', 'subjects', 'resources', 'sort']);
    expect(rollupOn).toBe(false);
    expect(steps.find(s => s.key === 'content')).toBeUndefined();
  });

  it('inserts the Content step and drops Sort for an attribute roll-up', () => {
    const { stepKeys, rollupOn } = deriveSteps({ rollup: 'department' }, 'setup');
    expect(stepKeys).toEqual(['setup', 'content', 'subjects', 'resources']);
    expect(rollupOn).toBe(true);
  });

  it('treats a context-tree roll-up as roll-up (Content in, Sort out)', () => {
    const { stepKeys, rollupOn } = deriveSteps(
      { rollupKind: 'context', rollupContextId: 'ctx-1' }, 'setup');
    expect(stepKeys).toEqual(['setup', 'content', 'subjects', 'resources']);
    expect(rollupOn).toBe(true);
  });

  it('ignores a context roll-up with no context id', () => {
    const { stepKeys, rollupOn } = deriveSteps(
      { rollupKind: 'context', rollupContextId: '' }, 'setup');
    expect(rollupOn).toBe(false);
    expect(stepKeys).toContain('sort');
  });

  it('drops the Resources step for a roles-only roll-up', () => {
    const { stepKeys } = deriveSteps(
      { rollup: 'department', rollupContent: 'roles-only' }, 'setup');
    expect(stepKeys).toEqual(['setup', 'content', 'subjects']);
  });

  it('reports the navigation position and last-step flag', () => {
    const first = deriveSteps({}, 'setup');
    expect(first.curPos).toBe(0);
    expect(first.isLast).toBe(false);
    const last = deriveSteps({}, 'sort');
    expect(last.curPos).toBe(3);
    expect(last.isLast).toBe(true);
  });

  it('falls back to the nearest visible step when the current step is hidden', () => {
    // 'sort' is not a visible step once a roll-up is on — fall back, don't blank.
    const { activeStep, stepKeys } = deriveSteps({ rollup: 'department' }, 'sort');
    expect(stepKeys).not.toContain('sort');
    expect(stepKeys).toContain(activeStep);
  });

  it('keeps the selected step active when it is still visible', () => {
    expect(deriveSteps({}, 'resources').activeStep).toBe('resources');
  });
});
