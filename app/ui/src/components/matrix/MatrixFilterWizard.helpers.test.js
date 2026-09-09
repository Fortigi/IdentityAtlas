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

  describe('the Share step (#1166)', () => {
    it('is appended last for a user who may share', () => {
      const { stepKeys, steps } = deriveSteps({}, 'setup', { canShare: true });
      expect(stepKeys).toEqual(['setup', 'subjects', 'resources', 'sort', 'share']);
      expect(steps.at(-1).label).toBe('Share');
    });

    it('stays last when a roll-up removes the Sort step', () => {
      const { stepKeys } = deriveSteps({ rollup: 'department' }, 'setup', { canShare: true });
      expect(stepKeys).toEqual(['setup', 'content', 'subjects', 'resources', 'share']);
    });

    it('is absent without the permission — the default', () => {
      expect(deriveSteps({}, 'setup').stepKeys).not.toContain('share');
      expect(deriveSteps({}, 'setup', { canShare: false }).stepKeys).not.toContain('share');
    });

    it('moves the Apply button onto itself, so Sort is no longer the end', () => {
      // Apply renders on `isLast`; with sharing on, Sort must NOT be last or a
      // sharer would never reach the step.
      expect(deriveSteps({}, 'sort', { canShare: true }).isLast).toBe(false);
      expect(deriveSteps({}, 'share', { canShare: true }).isLast).toBe(true);
      // …and without the permission Sort keeps Apply exactly as before.
      expect(deriveSteps({}, 'sort').isLast).toBe(true);
    });

    it('falls back to a visible step when sharing is revoked mid-wizard', () => {
      const { activeStep, stepKeys } = deriveSteps({}, 'share', { canShare: false });
      expect(stepKeys).not.toContain('share');
      expect(stepKeys).toContain(activeStep);
    });
  });
});
