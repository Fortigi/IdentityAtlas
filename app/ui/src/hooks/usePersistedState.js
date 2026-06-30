import { useState, useEffect } from 'react';

/**
 * Drop-in replacement for useState whose value is mirrored to sessionStorage
 * under `key`, so it survives the component unmounting and remounting within
 * the same browser session.
 *
 * This is what keeps a list page's search/filter state alive when the user
 * opens a result (which unmounts the list to show the detail) and then comes
 * back to the list — see useEntityPage.
 *
 * Values are JSON-serialised, so this only fits serialisable state (strings,
 * numbers, booleans, plain objects/arrays). Don't use it for Sets, Maps, or
 * anything carrying functions. A falsy `key` disables persistence and the hook
 * behaves like a plain useState.
 *
 * @template T
 * @param {string|null|undefined} key - sessionStorage key (null/'' disables persistence)
 * @param {T} initialValue - value used when nothing is stored yet
 * @returns {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 */
export default function usePersistedState(key, initialValue) {
  const [value, setValue] = useState(() => {
    if (!key) return initialValue;
    try {
      const raw = sessionStorage.getItem(key);
      return raw == null ? initialValue : JSON.parse(raw);
    } catch {
      // Corrupt JSON or storage disabled — fall back to the default.
      return initialValue;
    }
  });

  // Persist on every change. Writing to storage is a side effect (not a
  // setState), so this does not trip react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!key) return;
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage unavailable — persistence is best-effort.
    }
  }, [key, value]);

  return [value, setValue];
}
