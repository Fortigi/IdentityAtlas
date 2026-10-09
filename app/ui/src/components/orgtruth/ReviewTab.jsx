// Organisation → Review (workstream T6).
//
// The queue of proposed links (GET /api/org-truth/review?status=proposed
// &entityType=&page=), grouped per org entity by reviewRows.js, lowest
// confidence first between groups, best candidate first within one. Per
// candidate: target with its type, ConfidenceBar, matched signals, and Confirm /
// Reject / Move (PUT /api/org-truth/links/:id/override, then refetch, toast on
// success, failures inline). The buttons need useCanImportOrgTruth(); readers
// see the queue read-only.
//
// Props: { onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import EmptyState from '@ui/components/EmptyState';
import Pagination from '@ui/components/Pagination';
import { buildQuery, fetchBlocked, pageParam, rowsOf, totalOf } from './orgFormat';
import { groupReviewRows } from './reviewRows';
import { useLinkOverride } from './useLinkOverride';
import OrgLinkTable from './OrgLinkTable';
import { FetchState, InlineError, TypePill, CARD, INPUT, LINK_BUTTON } from './orgUi';

const PAGE_SIZE = 50;

export default function ReviewTab({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const canEdit = useCanImportOrgTruth();
  const [entityType, setEntityType] = useState('');
  const [page, setPage] = useState(0);
  const model = useFetch('/api/org-truth/model?withSystemCounts=0', { authFetch });
  const state = useFetch(
    `/api/org-truth/review${buildQuery({ status: 'proposed', entityType, page: pageParam(page) })}`,
    { authFetch },
  );
  const { busy, error, override } = useLinkOverride({ authFetch, onDone: state.reload });

  const filter = (
    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
      Entity type
      <select className={INPUT} value={entityType} onChange={e => { setEntityType(e.target.value); setPage(0); }}>
        <option value="">All types</option>
        {(model.data?.entityTypes || []).map(t => <option key={t.type} value={t.type}>{t.type}</option>)}
      </select>
    </label>
  );

  if (fetchBlocked(state)) return <div className="space-y-4">{filter}<FetchState state={state} what="Review" /></div>;

  const groups = groupReviewRows(rowsOf(state.data));
  const total = totalOf(state.data);

  return (
    <div className="space-y-4">
      {filter}
      {!canEdit && groups.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">You can see the queue; deciding on a link needs permission to import organisation truth.</p>
      )}
      <InlineError message={error} />
      {groups.length === 0 ? (
        <EmptyState title="Nothing to review" hint="Every proposed link has been decided, or no link was proposed." />
      ) : (
        groups.map(g => (
          <section key={g.entity.id} className={`${CARD} overflow-x-auto`} aria-label={g.entity.displayName}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
              <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.('org-entity', g.entity.id, g.entity.displayName)}>
                {g.entity.displayName}
              </button>
              <TypePill type={g.entity.entityType} />
            </div>
            <OrgLinkTable candidates={g.candidates} canEdit={canEdit} busy={busy}
              onOverride={override} onOpenDetail={onOpenDetail} />
          </section>
        ))
      )}
      <Pagination page={page} setPage={setPage} totalPages={Math.ceil(total / PAGE_SIZE)} total={total} pageSize={PAGE_SIZE} />
    </div>
  );
}
