import { Suspense, createElement } from 'react';
import DetailRoute from './DetailRoute';
import MatrixArea from './MatrixArea';

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
export default function AppMain({ isDetail, detailRouteProps, staticRoute, pageCtx, loading, matrixProps }) {
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
    body = <MatrixArea {...matrixProps} />;
  }

  return (
    <main id="main-content" className="p-6">
      <Suspense fallback={<LoadingPane label="Loading..." />}>
        {body}
      </Suspense>
    </main>
  );
}
