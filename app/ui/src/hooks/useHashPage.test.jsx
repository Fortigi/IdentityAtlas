// @vitest-environment jsdom
// Unit tests for useHashPage — the shared hash-route reader used by both the
// root dispatcher (AppRoot) and the app shell.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHashPage, currentHashPage } from './useHashPage';

function setHash(hash) {
  window.location.hash = hash;
  // jsdom fires hashchange asynchronously; dispatch it so the assertion below
  // observes the update the listener makes rather than racing it.
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

beforeEach(() => { window.location.hash = ''; });
afterEach(() => { window.location.hash = ''; });

describe('currentHashPage', () => {
  it('defaults to the dashboard when there is no hash', () => {
    expect(currentHashPage()).toBe('dashboard');
  });

  it('strips the query string and decodes the page key', () => {
    window.location.hash = '#matrix?filter=%7B%7D&managed=gaps';
    expect(currentHashPage()).toBe('matrix');
    window.location.hash = '#shared:fgs_abc';
    expect(currentHashPage()).toBe('shared:fgs_abc');
    window.location.hash = '#user:a%20b';
    expect(currentHashPage()).toBe('user:a b');
  });
});

describe('useHashPage', () => {
  it('reports the initial page and follows hashchange', () => {
    window.location.hash = '#matrix';
    const { result } = renderHook(() => useHashPage());
    expect(result.current[0]).toBe('matrix');

    act(() => setHash('#shared:fgs_abc'));
    expect(result.current[0]).toBe('shared:fgs_abc');

    act(() => setHash('#dashboard'));
    expect(result.current[0]).toBe('dashboard');
  });

  it('navigate() writes the hash', () => {
    const { result } = renderHook(() => useHashPage());
    act(() => result.current[1]('contexts'));
    expect(window.location.hash).toBe('#contexts');
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = renderHook(() => useHashPage());
    unmount();
    act(() => setHash('#identities'));
    // The unmounted hook's last value must not have moved — a leaked listener
    // would also warn about setting state on an unmounted component.
    expect(result.current[0]).toBe('dashboard');
  });
});
