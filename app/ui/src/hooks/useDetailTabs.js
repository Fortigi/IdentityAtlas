// The dynamic detail tabs of the app shell (#user:id, #group:id, …) and the
// per-tab data cache the detail pages fill.
//
// Extracted from App.jsx so the open / close / replace rules — which page a
// closed tab returns to, what happens to tabs that pointed back at it — can be
// tested on their own instead of through a full app mount.
//
// Each tab: { type, id, displayName, returnPage?, category? }.

import { useEffect, useReducer, useCallback, useRef } from 'react';
import { currentHashPage } from './useHashPage';
import { parseDetailRoute, relabelDetailTabs, replaceTabId, closeFallbackPage } from '@ui/App.helpers';

// useState-equivalent backed by useReducer (value + functional updates):
// dispatch isn't flagged by react-hooks/set-state-in-effect, so the effect
// below can dispatch instead of setState.
const setStateReducer = (s, a) => (typeof a === 'function' ? a(s) : a);

const keyOf = (type, id) => `${type}:${id}`;

// `page` and `navigate` are the pair useHashPage returns.
export function useDetailTabs(page, navigate) {
  const [detailTabs, setDetailTabs] = useReducer(setStateReducer, undefined, () => {
    // Restore detail tab from URL on load (e.g., bookmarked #user:abc)
    const route = parseDetailRoute(currentHashPage());
    return route ? [{ type: route.type, id: route.id, displayName: route.id }] : [];
  });

  // Keyed by "type:id", stores { core, memberships, accessPackages, history }
  const detailCacheRef = useRef({});

  const onCacheData = useCallback((id, type, partialData) => {
    const key = keyOf(type, id);
    detailCacheRef.current[key] = { ...detailCacheRef.current[key], ...partialData };
    // When a detail page loads its entity data, update the tab from the payload:
    // its display name (a tab opened by URL only had the id) and, for a
    // context, its template (the tab's icon). See relabelDetailTabs.
    setDetailTabs(prev => relabelDetailTabs(prev, id, partialData));
  }, []);

  const openDetailTab = useCallback((type, id, displayName) => {
    const tabKey = keyOf(type, id);
    setDetailTabs(prev => {
      if (prev.some(t => keyOf(t.type, t.id) === tabKey)) return prev;
      // Store the current page so closing this tab can return to where we came from
      return [...prev, { type, id, displayName: displayName || id, returnPage: page }];
    });
    navigate(tabKey);
  }, [navigate, page]);

  const closeDetailTab = useCallback((type, id) => {
    const tabKey = keyOf(type, id);
    const isActive = window.location.hash.replace('#', '') === tabKey;
    setDetailTabs(prev => {
      const closing = prev.find(t => keyOf(t.type, t.id) === tabKey);
      // Any tab that pointed back to this one inherits this tab's returnPage,
      // so closing an intermediate tab doesn't resurrect it later.
      const remaining = prev
        .filter(t => keyOf(t.type, t.id) !== tabKey)
        .map(t => t.returnPage === tabKey ? { ...t, returnPage: closing?.returnPage } : t);
      // Only navigate when closing the active tab
      if (isActive) {
        navigate(closing?.returnPage ?? closeFallbackPage(type));
      }
      return remaining;
    });
    delete detailCacheRef.current[tabKey];
  }, [navigate]);

  // Give an open tab a new id in place (the Compare tab when its users change).
  const replaceDetailTab = useCallback((type, oldId, newId) => {
    if (!newId || newId === oldId) return;
    setDetailTabs(prev => replaceTabId(prev, type, oldId, newId));
    delete detailCacheRef.current[keyOf(type, oldId)];
    navigate(keyOf(type, newId));
  }, [navigate]);

  // When navigating to a detail tab via URL that isn't tracked yet, add it
  useEffect(() => {
    const route = parseDetailRoute(page);
    if (!route) return;
    setDetailTabs(prev => {
      if (prev.some(t => t.type === route.type && t.id === route.id)) return prev;
      return [...prev, { type: route.type, id: route.id, displayName: route.id }];
    });
  }, [page]);

  return { detailTabs, detailCacheRef, onCacheData, openDetailTab, closeDetailTab, replaceDetailTab };
}
