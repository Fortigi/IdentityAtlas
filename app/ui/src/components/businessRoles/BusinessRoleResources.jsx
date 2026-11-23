import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EntityLink from '@ui/components/EntityLink';
import DeletedBadge from '@ui/components/DeletedBadge';

// What holding this role gives you: the resources it contains and with which
// role on each.
export default function BusinessRoleResources({ roleId, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/resource-roles`, { authFetch, initialData: [] });
  const rows = Array.isArray(data) ? data : [];

  if (loading) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading resources…</p>;
  if (error) return <p role="alert" className="py-6 text-center text-sm text-red-700 dark:text-red-400">Could not load the resources.</p>;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">This role contains no resources.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-left text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">Resource</th>
            <th scope="col" className="px-4 py-2 font-medium">Type</th>
            <th scope="col" className="px-4 py-2 font-medium">Role in the resource</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
          {rows.map(r => (
            <tr key={`${r.childResourceId}|${r.roleName}`}>
              <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
                <EntityLink kind="resource" id={r.childResourceId} label={r.resourceDisplayName || r.roleName || r.childResourceId}
                  accessible={r.accessible} onOpenDetail={onOpenDetail} />
                {r.deleted && <DeletedBadge at={r.deletedAt} label="Deleted in source" className="ml-2" />}
              </td>
              <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.resourceType || '—'}</td>
              <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{r.roleName || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
