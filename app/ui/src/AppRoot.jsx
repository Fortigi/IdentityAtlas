// Root route dispatcher.
//
// Almost every hash renders the normal app shell. Two exceptions render a
// different chrome entirely, so they branch here rather than inside App's
// nav/tab machinery:
//
//   - a context owner (signed in without an Identity Atlas role, Accountable or
//     Responsible for a context — see docs/architecture/context-owner-access.md)
//     always gets their bare owner page: the API answers 403 for everything
//     else, so the app would be a screen of errors. This wins over a share link
//     for the same reason.
//   - a share link ("#shared:<token>", #1166) renders the recipient's bare
//     shared-matrix shell.
//
// Both sit inside the AuthGate mounted in main.jsx, so a visitor on an
// auth-enabled install is signed in through the ordinary MSAL flow before this
// ever renders. While auth-me has not answered yet on such an install, nothing
// renders: who the user is decides which shell they get.

import { lazy, Suspense } from 'react';
import App from './App';
import { parseSharedRoute } from './App.helpers';
import { useHashPage } from './hooks/useHashPage';
import { useAuth } from './auth/AuthGate';
import { isContextOwnerSession } from './auth/authMeState';

const SharedMatrixPage = lazy(() => import('./components/SharedMatrixPage'));
const ContextOwnerPage = lazy(() => import('./components/ContextOwnerPage'));

function Waiting({ label }) {
  return (
    <div className="flex h-64 items-center justify-center text-gray-500 dark:text-gray-400">
      {label}
    </div>
  );
}

export default function AppRoot() {
  const [page] = useHashPage();
  const auth = useAuth();

  if (auth.authEnabled && !auth.permissionsLoaded) return <Waiting label="Signing in..." />;

  if (isContextOwnerSession(auth)) {
    return (
      <Suspense fallback={<Waiting label="Loading your contexts..." />}>
        <ContextOwnerPage />
      </Suspense>
    );
  }

  const shareToken = parseSharedRoute(page);
  if (!shareToken) return <App />;
  return (
    <Suspense fallback={<Waiting label="Loading shared matrix..." />}>
      <SharedMatrixPage token={shareToken} />
    </Suspense>
  );
}
