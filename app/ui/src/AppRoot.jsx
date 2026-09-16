// Root route dispatcher.
//
// Almost every hash renders the normal app shell. The one exception is a share
// link ("#shared:<token>", #1166), which renders the recipient's bare
// shared-matrix shell instead — a different chrome entirely, so it branches
// here rather than inside App's nav/tab machinery.
//
// Both branches sit inside the AuthGate mounted in main.jsx, so a recipient on
// an auth-enabled install is signed in through the ordinary MSAL flow before
// this ever renders.

import { lazy, Suspense } from 'react';
import App from './App';
import { parseSharedRoute } from './App.helpers';
import { useHashPage } from './hooks/useHashPage';

const SharedMatrixPage = lazy(() => import('./components/SharedMatrixPage'));

export default function AppRoot() {
  const [page] = useHashPage();
  const shareToken = parseSharedRoute(page);
  if (!shareToken) return <App />;
  return (
    <Suspense fallback={
      <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">
        Loading shared matrix...
      </div>
    }>
      <SharedMatrixPage token={shareToken} />
    </Suspense>
  );
}
