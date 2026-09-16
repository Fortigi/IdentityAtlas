// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useElapsedTimer } from '@ui/hooks/useElapsedTimer';

describe('useElapsedTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays at 0 while inactive', () => {
    const { result } = renderHook(() => useElapsedTimer(false));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current).toBe(0);
  });

  it('ticks up in whole seconds while active', () => {
    const { result } = renderHook(({ active }) => useElapsedTimer(active), {
      initialProps: { active: true },
    });
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(2100));
    expect(result.current).toBe(2);
  });

  it('resets to 0 when the action stops', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsedTimer(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe(1);
    rerender({ active: false });
    expect(result.current).toBe(0);
    // No further ticks once inactive.
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(0);
  });

  it('restarts the counter on a fresh activation', () => {
    const { result, rerender } = renderHook(({ active }) => useElapsedTimer(active), {
      initialProps: { active: true },
    });
    act(() => vi.advanceTimersByTime(1000));
    rerender({ active: false });
    rerender({ active: true });
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(1);
  });
});
