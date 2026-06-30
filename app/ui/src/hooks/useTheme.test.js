// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, act } from '@ui/test-utils/renderWithProviders';
import { useTheme } from './useTheme';

// jsdom here has no origin (no window.localStorage) and does not implement
// matchMedia, so both are stubbed.
function makeLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// Controllable matchMedia: tests flip the OS preference and fire the listeners.
function makeMatchMedia(initialMatches = false) {
  let matches = initialMatches;
  const listeners = new Set();
  const mql = {
    get matches() { return matches; },
    addEventListener: (_e, h) => listeners.add(h),
    removeEventListener: (_e, h) => listeners.delete(h),
  };
  const fn = vi.fn(() => mql);
  fn.setMatches = (v) => { matches = v; listeners.forEach((h) => h({ matches: v })); };
  return fn;
}

function setup({ storage = {}, osDark = false } = {}) {
  vi.stubGlobal('localStorage', makeLocalStorage(storage));
  const mm = makeMatchMedia(osDark);
  vi.stubGlobal('matchMedia', mm);
  return mm;
}

describe('useTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.classList.remove('dark');
  });

  it('defaults to light mode with an empty store', () => {
    setup();
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(localStorage.getItem('themeMode')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('migrates the legacy darkMode boolean key to themeMode', () => {
    setup({ storage: { darkMode: 'true' } });
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('dark');
    expect(localStorage.getItem('themeMode')).toBe('dark');
    expect(localStorage.getItem('darkMode')).toBeNull();
  });

  it('applies the dark class when mode is dark', () => {
    setup({ storage: { themeMode: 'dark' } });
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('follows the OS preference in auto mode', () => {
    setup({ storage: { themeMode: 'auto' }, osDark: true });
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('auto');
    expect(result.current.isDark).toBe(true);
  });

  it('reacts to an OS preference change while in auto mode', () => {
    const mm = setup({ storage: { themeMode: 'auto' }, osDark: false });
    const { result } = renderHook(() => useTheme());
    expect(result.current.isDark).toBe(false);

    act(() => mm.setMatches(true)); // OS flips to dark
    expect(result.current.isDark).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('cycles light → auto → dark → light and persists each mode', () => {
    setup();
    const { result } = renderHook(() => useTheme());
    expect(result.current.mode).toBe('light');

    act(() => result.current.cycleTheme());
    expect(result.current.mode).toBe('auto');
    expect(localStorage.getItem('themeMode')).toBe('auto');

    act(() => result.current.cycleTheme());
    expect(result.current.mode).toBe('dark');

    act(() => result.current.cycleTheme());
    expect(result.current.mode).toBe('light');
  });
});
