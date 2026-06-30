// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import usePersistedState from '@ui/hooks/usePersistedState';

describe('usePersistedState', () => {
  beforeEach(() => sessionStorage.clear());

  it('uses the initial value when nothing is stored', () => {
    const { result } = renderHook(() => usePersistedState('k.a', 'init'));
    expect(result.current[0]).toBe('init');
  });

  it('hydrates from sessionStorage on mount', () => {
    sessionStorage.setItem('k.b', JSON.stringify('stored'));
    const { result } = renderHook(() => usePersistedState('k.b', 'init'));
    expect(result.current[0]).toBe('stored');
  });

  it('writes updates back to sessionStorage', () => {
    const { result } = renderHook(() => usePersistedState('k.c', ''));
    act(() => result.current[1]('typed'));
    expect(result.current[0]).toBe('typed');
    expect(JSON.parse(sessionStorage.getItem('k.c'))).toBe('typed');
  });

  it('restores state across an unmount/remount (the #192 scenario)', () => {
    const first = renderHook(() => usePersistedState('k.d', []));
    act(() => first.result.current[1]([{ field: 'department', value: 'Sales' }]));
    first.unmount();

    const second = renderHook(() => usePersistedState('k.d', []));
    expect(second.result.current[0]).toEqual([{ field: 'department', value: 'Sales' }]);
  });

  it('keeps different keys isolated', () => {
    const a = renderHook(() => usePersistedState('k.e1', 'a'));
    const b = renderHook(() => usePersistedState('k.e2', 'b'));
    act(() => a.result.current[1]('changed'));
    expect(b.result.current[0]).toBe('b');
  });

  it('falls back to the initial value when stored JSON is corrupt', () => {
    sessionStorage.setItem('k.f', '{not json');
    const { result } = renderHook(() => usePersistedState('k.f', 'safe'));
    expect(result.current[0]).toBe('safe');
  });

  it('behaves like plain useState (no persistence) when key is falsy', () => {
    const { result } = renderHook(() => usePersistedState(null, 'x'));
    act(() => result.current[1]('y'));
    expect(result.current[0]).toBe('y');
    expect(sessionStorage.getItem('null')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
});
