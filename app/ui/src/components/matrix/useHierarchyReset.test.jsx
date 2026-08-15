// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHierarchyReset } from './useHierarchyReset';

describe('useHierarchyReset', () => {
  it('does not reset on first render or while the hierarchy id is unchanged', () => {
    const reset = vi.fn();
    const { rerender } = renderHook(({ id }) => useHierarchyReset(id, reset), { initialProps: { id: 'h1' } });
    rerender({ id: 'h1' });
    expect(reset).not.toHaveBeenCalled();
  });

  it('runs reset only when the hierarchy transitions to none', () => {
    const reset = vi.fn();
    const { rerender } = renderHook(({ id }) => useHierarchyReset(id, reset), { initialProps: { id: 'h1' } });
    rerender({ id: 'h2' }); // changed to another hierarchy — no reset
    expect(reset).not.toHaveBeenCalled();
    rerender({ id: null }); // changed to none — reset fires
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
