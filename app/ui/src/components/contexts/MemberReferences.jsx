// One member's direct references, as plain text (a context owner's page).
//
// GET /api/contexts/:id/members/:memberId/references answers names only — no
// ids — so there is nothing here to open: the owner sees that a member of their
// unit holds "Finance-Admins", not the group itself. Each group lists at most 50
// names and says how many more there are.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { REFERENCE_LABELS, referenceDetail, formatCount, moreText } from './memberReferences.helpers';

export default function MemberReferences({ contextId, memberId }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/contexts/${contextId}/members/${memberId}/references`, { authFetch });

  if (loading) return <p className="text-xs text-gray-600 dark:text-gray-400">Loading references…</p>;
  if (error) return <p role="alert" className="text-xs text-red-700 dark:text-red-400">References could not be loaded ({error.message}).</p>;
  const groups = data?.groups || [];
  if (groups.length === 0) return <p className="text-xs text-gray-600 dark:text-gray-400">No references.</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {groups.map(g => <ReferenceGroup key={g.key} group={g} />)}
    </div>
  );
}

function ReferenceGroup({ group }) {
  const label = REFERENCE_LABELS[group.key] || group.key;
  const more = moreText(group);
  return (
    <section aria-label={label} className="min-w-0">
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-1">
        {label} <span className="font-normal text-gray-600 dark:text-gray-400">({formatCount(group.total)})</span>
      </h4>
      {group.items.length === 0
        ? <p className="text-xs text-gray-600 dark:text-gray-400">None</p>
        : (
          <ul className="space-y-0.5">
            {group.items.map((item, i) => (
              // Names only: an item has no id, and the list never reorders.
              <li key={`${i}:${item.displayName}`}className="text-xs text-gray-900 dark:text-gray-100 truncate">
                {item.displayName}
                {referenceDetail(group.key, item) && (
                  <span className="ml-1.5 text-gray-600 dark:text-gray-400">{referenceDetail(group.key, item)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      {more && <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{more}</p>}
    </section>
  );
}
