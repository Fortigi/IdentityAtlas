import { Suspense, createElement, lazy, useState } from 'react';
import DetailRoute from './DetailRoute';
import MatrixArea from './MatrixArea';

const ShareMatrixDialog = lazy(() => import('@ui/components/matrix/ShareMatrixDialog'));

function LoadingPane({ label }) {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="text-gray-500 dark:text-gray-400">{label}</div>
    </div>
  );
}

// The app shell's <main> region. Picks the body — a detail page, a static page
// (from the instrumented pageRegistry map), a loading pane, or the matrix — and
// renders it inside the shared Suspense boundary.
//
// The share dialog (#1166) is owned HERE, deliberately outside that switch. It
// is opened from a button in the matrix toolbar, but everything between that
// button and this level is torn down and rebuilt as the app works: a matrix
// refetch swaps the whole body for the loading pane, and MatrixArea picks a
// different view component once it knows whether the payload is a roll-up. With
// the dialog anywhere below, an analyst who hit "Share view…" on a slow tenant
// watched it vanish, half-filled, the moment the matrix caught up. This is the
// shallowest level that survives all of it.
export default function AppMain({ isDetail, detailRouteProps, staticRoute, pageCtx, loading, matrixProps }) {
  const [shareOpen, setShareOpen] = useState(false);

  let body;
  if (isDetail) {
    body = <DetailRoute {...detailRouteProps} />;
  } else if (staticRoute) {
    // createElement (not staticRoute(...)) keeps the user-controlled hash key
    // out of callee position — see #669.
    body = createElement(staticRoute, pageCtx);
  } else if (loading) {
    body = <LoadingPane label="Loading permission data..." />;
  } else {
    body = <MatrixArea {...matrixProps} onShareView={() => setShareOpen(true)} />;
  }

  return (
    <main id="main-content" className="p-6">
      <Suspense fallback={<LoadingPane label="Loading..." />}>
        {body}
      </Suspense>
      {/* Its own boundary, and outside the one above: the dialog is a lazy chunk,
          and sharing the body's boundary would replace the matrix with "Loading…"
          while that chunk arrives. */}
      <Suspense fallback={null}>
        {shareOpen && (
          <ShareMatrixDialog
            filter={matrixProps?.matrixFilter}
            managed={matrixProps?.managedFilter}
            onClose={() => setShareOpen(false)}
          />
        )}
      </Suspense>
    </main>
  );
}
