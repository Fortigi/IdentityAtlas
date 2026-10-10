// Organisation → Entities (workstream T6).
//
// Searchable, paged list of org entities
// (GET /api/org-truth/entities?type=&status=&q=&includeClosed=&page=&pageSize=50): type filter
// (options from GET /model entityTypes), status filter, a search box debounced
// 300 ms, and include closed (the API lists open entities only by default). A row's name opens the entity detail tab
// (onOpenDetail('org-entity', id, name)). The empty state tells "nothing
// imported yet" apart from "no entity matches these filters".
//
// Props: { onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDebouncedValue } from '@ui/hooks/useDebouncedValue';
import EmptyState from '@ui/components/EmptyState';
import Pagination from '@ui/components/Pagination';
import { formatDate } from '@ui/utils/formatters';
import { buildQuery, fetchBlocked, pageParam, rowsOf, totalOf } from './orgFormat';
import { FetchState, StatusPill, TypePill, TH, TD, CARD, INPUT, LINK_BUTTON } from './orgUi';

const PAGE_SIZE = 50;
const STATUSES = ['accepted', 'proposed', 'rejected'];

function Filters({ types, type, setType, status, setStatus, search, setSearch, includeClosed, setIncludeClosed }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Type
        <select className={INPUT} value={type} onChange={e => setType(e.target.value)}>
          <option value="">All types</option>
          {types.map(t => <option key={t.type} value={t.type}>{t.type}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Status
        <select className={INPUT} value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <input
        type="search"
        aria-label="Search entities by name"
        placeholder="Search by name…"
        className={`${INPUT} min-w-[16rem]`}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} />
        Include closed
      </label>
    </div>
  );
}

function EntityRow({ e, onOpenDetail }) {
  return (
    <tr>
      <td className={TD}>
        <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.('org-entity', e.id, e.displayName)}>
          {e.displayName}
        </button>
      </td>
      <td className={TD}><TypePill type={e.entityType} /></td>
      <td className={TD}><StatusPill status={e.status} /></td>
      <td className={TD}>{e.linkCount ?? 0}</td>
      <td className={TD}>{e.relationCount ?? 0}</td>
      <td className={TD}>{e.sourceName || '—'}</td>
      <td className={TD}>{formatDate(e.observedAt)}</td>
      <td className={TD}>
        {e.validTo ? <span title={formatDate(e.validTo)}><StatusPill status="closed" /></span> : ''}
      </td>
    </tr>
  );
}

export default function EntitiesTab({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const [type, setTypeRaw] = useState('');
  const [status, setStatusRaw] = useState('');
  const [search, setSearchRaw] = useState('');
  const [includeClosed, setIncludeClosedRaw] = useState(false);
  const [page, setPage] = useState(0);
  const q = useDebouncedValue(search.trim(), 300);
  // A filter change always starts again at the first page.
  const setType = (v) => { setTypeRaw(v); setPage(0); };
  const setStatus = (v) => { setStatusRaw(v); setPage(0); };
  const setSearch = (v) => { setSearchRaw(v); setPage(0); };
  const setIncludeClosed = (v) => { setIncludeClosedRaw(v); setPage(0); };

  const model = useFetch('/api/org-truth/model?withSystemCounts=0', { authFetch });
  const url = `/api/org-truth/entities${buildQuery({ type, status, q, includeClosed, page: pageParam(page), pageSize: PAGE_SIZE })}`;
  const state = useFetch(url, { authFetch });
  const filtered = Boolean(type || status || q || includeClosed);

  const filters = (
    <Filters types={model.data?.entityTypes || []} type={type} setType={setType}
      status={status} setStatus={setStatus} search={search} setSearch={setSearch}
      includeClosed={includeClosed} setIncludeClosed={setIncludeClosed} />
  );

  if (fetchBlocked(state)) return <div className="space-y-4">{filters}<FetchState state={state} what="Entities" /></div>;

  const rows = rowsOf(state.data);
  const total = totalOf(state.data);
  let body;
  if (rows.length === 0) {
    body = filtered
      ? <EmptyState title="No entity matches" hint="No entity matches these filters. Clear the search or pick another type or status." />
      : <EmptyState title="Nothing imported yet" hint="Entities appear here after an organisation list has been imported." />;
  } else {
    body = (
      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th scope="col" className={TH}>Name</th>
              <th scope="col" className={TH}>Type</th>
              <th scope="col" className={TH}>Status</th>
              <th scope="col" className={TH}>Links</th>
              <th scope="col" className={TH}>Relations</th>
              <th scope="col" className={TH}>Source</th>
              <th scope="col" className={TH}>Observed</th>
              <th scope="col" className={TH}>Valid to</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {rows.map(e => <EntityRow key={e.id} e={e} onOpenDetail={onOpenDetail} />)}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {filters}
      {body}
      <Pagination page={page} setPage={setPage} totalPages={Math.ceil(total / PAGE_SIZE)} total={total} pageSize={PAGE_SIZE} />
    </div>
  );
}
