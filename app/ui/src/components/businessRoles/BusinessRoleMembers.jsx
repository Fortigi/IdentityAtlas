import { useMemo, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDateOnly } from '@ui/utils/formatters';
import EntityLink from '@ui/components/EntityLink';
import DeletedBadge from '@ui/components/DeletedBadge';
import Pagination from '@ui/components/Pagination';
import WayChips from './WayChips';
import { WAYS, MEMBER_PAGE_SIZE, countByWay, filterMembers } from './accessModel';

// Who holds this role and how each of them got it. The list is complete: it is
// paged in the browser, never cut off.

function WayFilter({ counts, way, onChange }) {
  const options = Object.keys(WAYS.in).filter(w => counts[w] > 0);
  if (options.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by how the role was gained">
      {[null, ...options].map((w) => {
        const active = way === w;
        return (
          <button key={w ?? 'all'} type="button" aria-pressed={active} onClick={() => onChange(w)}
            className={`rounded border px-2 py-0.5 text-xs ${active
              ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-300'
              : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700/50'}`}>
            {w ? `${WAYS.in[w].label} (${counts[w]})` : 'All'}
          </button>
        );
      })}
    </div>
  );
}

function MemberRow({ row, onOpenDetail }) {
  const policies = (row.via ?? []).map(p => p.displayName).filter(Boolean);
  return (
    <tr>
      <td className="px-4 py-2 text-gray-900 dark:text-gray-100">
        <EntityLink kind="user" id={row.principalId} label={row.targetDisplayName || row.principalId} accessible={row.accessible} onOpenDetail={onOpenDetail} />
        {row.deleted && <DeletedBadge at={row.deletedAt} label="Deleted in source" className="ml-2" />}
      </td>
      <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{row.targetUPN || '—'}</td>
      <td className="px-4 py-2"><WayChips ways={row.howHeld} direction="in" /></td>
      <td className="px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{policies.length > 0 ? policies.join(', ') : (row.originDetail || '—')}</td>
      <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-700 dark:text-gray-300">{row.expirationDateTime ? formatDateOnly(row.expirationDateTime) : '—'}</td>
    </tr>
  );
}

export default function BusinessRoleMembers({ roleId, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(`/api/access-package/${encodeURIComponent(roleId)}/assignments`, { authFetch, initialData: [] });
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const [search, setSearch] = useState('');
  const [way, setWay] = useState(null);
  const [page, setPage] = useState(0);
  const counts = useMemo(() => countByWay(rows), [rows]);
  const shown = useMemo(() => filterMembers(rows, search, way), [rows, search, way]);

  if (loading) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Loading people…</p>;
  if (error) return <p role="alert" className="py-6 text-center text-sm text-red-700 dark:text-red-400">Could not load the people.</p>;
  if (rows.length === 0) return <p className="py-6 text-center text-sm text-gray-600 dark:text-gray-400">Nobody holds this role.</p>;

  const lastPage = Math.max(0, Math.ceil(shown.length / MEMBER_PAGE_SIZE) - 1);
  const current = Math.min(page, lastPage);
  const pageRows = shown.slice(current * MEMBER_PAGE_SIZE, (current + 1) * MEMBER_PAGE_SIZE);
  const change = (setter) => (value) => { setter(value); setPage(0); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input type="search" value={search} onChange={e => change(setSearch)(e.target.value)} aria-label="Search people in this role" placeholder="Search by name or e-mail…"
          className="w-56 rounded border border-gray-300 px-2 py-1 text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500" />
        <WayFilter counts={counts} way={way} onChange={change(setWay)} />
        <span className="text-xs text-gray-600 dark:text-gray-400">{shown.length} of {rows.length}</span>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs text-gray-700 dark:bg-gray-900/40 dark:text-gray-300">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Name</th>
              <th scope="col" className="px-4 py-2 font-medium">E-mail</th>
              <th scope="col" className="px-4 py-2 font-medium">How they got it</th>
              <th scope="col" className="px-4 py-2 font-medium">Through</th>
              <th scope="col" className="px-4 py-2 font-medium">Ends</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
            {pageRows.map(r => <MemberRow key={r.principalId} row={r} onOpenDetail={onOpenDetail} />)}
          </tbody>
        </table>
      </div>
      {shown.length > MEMBER_PAGE_SIZE && (
        <Pagination page={current} setPage={setPage} totalPages={lastPage + 1} total={shown.length} pageSize={MEMBER_PAGE_SIZE} />
      )}
    </div>
  );
}
