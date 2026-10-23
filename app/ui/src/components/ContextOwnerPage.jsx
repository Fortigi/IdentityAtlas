// A context owner's view of Identity Atlas.
//
// Somebody who is Accountable or Responsible for a context — a department's
// manager, an application's owner — signs in with their normal Microsoft
// account and, with no Identity Atlas role of their own, lands here instead of
// the app (AppRoot routes them; the Admin → Authentication switch lets them in).
// See docs/architecture/context-owner-access.md.
//
// The API only answers this user for their own contexts and those contexts'
// variants (`contextOwner.contextIds` from /api/auth-me), so the page shows
// exactly that: one context directly, or with several a slim list of them on the
// left. The context itself is the ordinary context page, wrapped in
// SharedViewContext so it renders read-only — no edits, no links into pages the
// owner may not open, and the workflows (the report download) kept.

import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useTheme } from '@ui/hooks/useTheme';
import { ThemeContext } from '@ui/contexts/ThemeContext';
import { SharedViewContext } from '@ui/contexts/SharedViewContext';
import ErrorBoundary from './ErrorBoundary';
import Brand from './app/Brand';
import ContextDetailPage from './ContextDetailPage';

const ROLE_BADGE = {
  Accountable: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700',
  Responsible: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',
};

function RoleBadge({ role }) {
  return (
    <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${ROLE_BADGE[role] || ROLE_BADGE.Responsible}`}>
      {role}
    </span>
  );
}

function OwnerHeader({ isDark, userName, onSignOut }) {
  return (
    <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      <div className="px-6 py-3 flex items-center gap-4">
        <Brand isDark={isDark} />
        <div className="flex-1" />
        {userName && <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{userName}</span>}
        {onSignOut && (
          <button type="button" onClick={onSignOut}
            className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700">
            Sign out
          </button>
        )}
      </div>
    </header>
  );
}

function ContextList({ contexts, selectedId, onSelect }) {
  return (
    <nav aria-label="Your contexts" className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-y-auto">
      <h2 className="px-2 mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Your contexts</h2>
      <ul className="space-y-1">
        {contexts.map(c => (
          <li key={c.id}>
            <button type="button" onClick={() => onSelect(c.id)} aria-current={c.id === selectedId ? 'true' : undefined}
              className={`w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm ${c.id === selectedId
                ? 'bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
              <span className="truncate">{c.displayName}</span>
              <RoleBadge role={c.role} />
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function ContextOwnerPage() {
  const { contextOwner, account, logout } = useAuth();
  const { isDark, mode } = useTheme();
  const contexts = useMemo(() => contextOwner?.contexts || [], [contextOwner]);
  // The scope the API enforces: the held contexts plus their variants.
  const scope = useMemo(
    () => new Set([...(contextOwner?.contextIds || []), ...contexts.map(c => c.id)].map(id => String(id).toLowerCase())),
    [contextOwner, contexts],
  );
  const [selectedId, setSelectedId] = useState(contexts[0]?.id ?? null);

  // The context page asks to open things; only another context in scope (a
  // variant of this unit) opens, in place. Anything else would be a 403.
  const openDetail = useCallback((type, id) => {
    if (type === 'context' && scope.has(String(id).toLowerCase())) setSelectedId(id);
  }, [scope]);

  return (
    <ThemeContext.Provider value={{ isDark, mode }}>
      <SharedViewContext.Provider value={true}>
        <ErrorBoundary>
          <div className="flex-1 min-h-0 flex flex-col bg-gray-50 dark:bg-gray-900">
            <OwnerHeader isDark={isDark} userName={account?.name || account?.username} onSignOut={logout} />
            <div className="flex-1 min-h-0 flex">
              {contexts.length > 1 && <ContextList contexts={contexts} selectedId={selectedId} onSelect={setSelectedId} />}
              <main className="flex-1 min-w-0 overflow-y-auto p-6">
                {selectedId && (
                  <ContextDetailPage key={selectedId} contextId={selectedId} embedded onOpenDetail={openDetail} />
                )}
              </main>
            </div>
          </div>
        </ErrorBoundary>
      </SharedViewContext.Provider>
    </ThemeContext.Provider>
  );
}
