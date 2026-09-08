// The recipient's view of a shared matrix (#1166).
//
// A business user follows a "#shared:<token>" link, signs in with their normal
// Microsoft account (the surrounding AuthGate handles that, and needs no
// Identity Atlas role), and lands here: a bare shell with the matrix and
// nothing else — no top nav, no dashboard, no Adjust matrix, no export.
//
// The matrix itself is the ordinary one. We resolve the share's SNAPSHOT
// (filter + managed toggle + display mode, frozen at share time) and feed it
// through the same useMatrix/MatrixArea path the analyst view uses, wrapped in
// SharedViewContext so the analyst-only affordances inside those components
// opt out. Drill-down opens the existing detail pages inside this shell rather
// than routing out to the app.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMatrix } from '@ui/hooks/useMatrix';
import { useAuth } from '@ui/auth/AuthGate';
import { useTheme } from '@ui/hooks/useTheme';
import { ThemeContext } from '@ui/contexts/ThemeContext';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import ErrorBoundary from './ErrorBoundary';
import AppMain from './app/AppMain';
import SharedMatrixHeader from './shared/SharedMatrixHeader';
import SharedMatrixUnavailable from './shared/SharedMatrixUnavailable';
import { applyDisplayMode } from './shared/sharedSnapshot';

// Resolve state: 'loading' | 'ready' | 'revoked' | 'missing' | 'error'
const STATUS_BY_HTTP = { 404: 'missing', 410: 'revoked' };

export default function SharedMatrixPage({ token }) {
  const { authFetch } = useAuth();
  const { isDark, mode } = useTheme();
  const [share, setShare] = useState(null);
  // Value-only state flipped synchronously inside the resolve effect; a reducer
  // dispatch keeps that clear of react-hooks/set-state-in-effect.
  const [status, setStatus] = useReducer((_, v) => v, 'loading');

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    authFetch('/api/matrix/shares/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setStatus(STATUS_BY_HTTP[res.status] || 'error'); return; }
        setShare(await res.json());
        setStatus('ready');
      })
      .catch(() => { if (!cancelled) setStatus('error'); });
    return () => { cancelled = true; };
  }, [authFetch, token]);

  // The snapshot's filter, with its display mode applied. Frozen at share time:
  // editing the originating saved filter afterwards can't change it.
  const filter = useMemo(
    () => (share ? applyDisplayMode(share.filter, share.displayMode) : null),
    [share],
  );
  // Seeded from the snapshot once it resolves, then owned by the recipient's
  // own toggle. A reducer dispatch (not a setState) keeps the seeding effect
  // clear of react-hooks/set-state-in-effect.
  const [managedFilter, setManagedFilter] = useReducer((_, v) => v, 'all');
  const snapshotManaged = share?.managed;
  useEffect(() => { if (snapshotManaged) setManagedFilter(snapshotManaged); }, [snapshotManaged]);

  const matrix = useMatrix(filter);

  // Drill-down lives inside this shell: one open detail entity at a time, held
  // in local state rather than the URL hash (which carries the share token).
  const [detail, setDetail] = useState(null);
  const detailCacheRef = useRef({});
  const openDetailTab = useCallback((type, id, displayName) => {
    setDetail({ type, id, displayName: displayName || id });
  }, []);
  const closeDetailTab = useCallback(() => setDetail(null), []);
  const noop = useCallback(() => {}, []);

  const body = useMemo(() => {
    if (detail) {
      return {
        isDetail: true,
        detailRouteProps: {
          page: `${detail.type}:${detail.id}`,
          detailCacheRef,
          onCacheData: noop,
          openDetailTab,
          closeDetailTab,
        },
      };
    }
    return {
      isDetail: false,
      matrixProps: {
        rollup: matrix.rollup,
        data: matrix.data,
        matrixFilter: filter,
        counts: matrix.counts,
        managedFilter,
        setManagedFilter,
        refreshing: matrix.refreshing,
        onOpenDetail: openDetailTab,
        setMatrixFilter: noop,
        accessPackageGroups: matrix.accessPackageGroups,
        managedByPackages: matrix.managedByPackages,
        resourceContexts: matrix.resourceContexts,
        groupTagMap: matrix.groupTagMap,
        hasData: matrix.hasData,
        wizardOpen: false,
        onAdjustFilter: noop,
        onWizardApply: noop,
        onWizardClose: noop,
      },
    };
  }, [detail, matrix, filter, managedFilter, openDetailTab, closeDetailTab, noop]);

  const unavailable = status !== 'loading' && status !== 'ready';

  return (
    <ThemeContext.Provider value={{ isDark, mode }}>
      <SharedViewContext.Provider value={true}>
        <ErrorBoundary>
          <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-gray-900">
            <SharedMatrixHeader
              isDark={isDark}
              shareName={status === 'ready' ? share?.name : null}
              onBackToMatrix={detail ? closeDetailTab : null}
            />
            {unavailable
              ? <SharedMatrixUnavailable status={status} />
              : <AppMain {...body} loading={status === 'loading' || matrix.loading} />}
          </div>
        </ErrorBoundary>
      </SharedViewContext.Provider>
    </ThemeContext.Provider>
  );
}
