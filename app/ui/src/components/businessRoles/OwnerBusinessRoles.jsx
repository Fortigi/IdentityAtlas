// A context owner's Business roles view (ContextOwnerPage): the business roles
// they answer for themselves — Accountable or Responsible — and, beside the list,
// the one they picked, as its ordinary page. The page is read-only (the owner's
// shell is a shared view) except its Composition review, where they may sign off
// (OwnedBusinessRolesContext). The list is /api/auth-me contextOwner.businessRoles;
// the API opens only these roles.

import { Suspense, useCallback, useRef, useState } from 'react';
import DetailRoute from '@ui/components/app/DetailRoute';

const BADGE = {
  Accountable: 'bg-blue-50 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-200 dark:border-blue-700',
  Responsible: 'bg-gray-100 text-gray-700 border-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600',
};

function RoleList({ roles, selectedId, onSelect }) {
  return (
    <nav aria-label="Your business roles" className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-3 overflow-y-auto">
      <h2 className="px-2 mb-2 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-400">Your business roles</h2>
      <ul className="space-y-1">
        {roles.map(r => (
          <li key={r.id}>
            <button type="button" onClick={() => onSelect(r.id)} aria-current={r.id === selectedId ? 'true' : undefined}
              className={`w-full text-left flex items-center justify-between gap-2 rounded px-2 py-1.5 text-sm ${r.id === selectedId
                ? 'bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100'
                : 'text-gray-800 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-700'}`}>
              <span className="truncate">{r.displayName || r.id}</span>
              <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${BADGE[r.role] || BADGE.Responsible}`}>{r.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export default function OwnerBusinessRoles({ roles, onOpenDetail }) {
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? null);
  const detailCacheRef = useRef({});
  const noop = useCallback(() => {}, []);
  return (
    <div className="flex-1 min-h-0 flex" data-testid="owner-business-roles">
      <RoleList roles={roles} selectedId={selectedId} onSelect={setSelectedId} />
      <main className="flex-1 min-w-0 overflow-y-auto p-6">
        {selectedId && (
          <Suspense fallback={<p className="py-10 text-center text-sm text-gray-600 dark:text-gray-400">Loading…</p>}>
            <DetailRoute key={selectedId} page={`access-package:${selectedId}`} detailCacheRef={detailCacheRef} onCacheData={noop}
              openDetailTab={onOpenDetail} closeDetailTab={noop} />
          </Suspense>
        )}
      </main>
    </div>
  );
}
