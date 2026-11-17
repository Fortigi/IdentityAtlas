// The page for somebody signed in without an Identity Atlas role.
//
// The API refuses a signed-in caller who holds no permission and owns no
// context (security review Nov 2026, F-01), except for /api/auth-me. Without
// this page the app would open and every screen would answer 403. Instead the
// user learns why, and what to ask for. AppRoot routes them here.

import { useAuth } from '@ui/auth/AuthGate';
import { useTheme } from '@ui/hooks/useTheme';
import Brand from './app/Brand';

export default function NoRolePage() {
  const { account, logout } = useAuth();
  const { isDark } = useTheme();
  const who = account?.username || account?.name;

  return (
    <div className={isDark ? 'dark' : ''}>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center px-4">
        <div className="max-w-lg w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-8 shadow-sm">
          <Brand isDark={isDark} />
          <h2 className="mt-6 text-lg font-semibold text-gray-900 dark:text-white">
            You don&apos;t have access to Identity Atlas yet
          </h2>
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {who ? <>You&apos;re signed in as <strong>{who}</strong>, but</> : 'Your'}
            {who ? ' your' : ''} account has no role in Identity Atlas.
          </p>
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            Ask your Identity Atlas administrator to assign you a role, such as Admin, RoleMiner or
            Servicedesk, on the Identity Atlas application in Microsoft Entra ID. Sign out and in
            again once it is assigned.
          </p>
          <button
            type="button"
            onClick={logout}
            className="mt-6 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
