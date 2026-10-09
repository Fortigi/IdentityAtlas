// Organisation → Review (workstream T6): the queue as DISTINCT decisions.
//
// GET /api/org-truth/review/groups groups the proposed links on (entity type,
// attribute, value, target type): 42 timesheet rows naming one customer are one
// card, decided once. Per candidate: label, ConfidenceBar, how many rows it
// covers, and Confirm / Reject; per group: Reject all. A decision is
// PUT /api/org-truth/review/groups/decision (bodies built in reviewGroups.js),
// then a toast and a reload; failures show inline. Accepted / rejected groups and
// readers (no useCanImportOrgTruth()) see the cards read-only.
//
// Props: { onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import { useDialog } from '@ui/components/dialogContext';
import EmptyState from '@ui/components/EmptyState';
import Pagination from '@ui/components/Pagination';
import ConfidenceBar from '@ui/components/ConfidenceBar';
import { buildQuery, fetchBlocked, pageParam, rowsOf, totalOf } from './orgFormat';
import {
  GROUPS_URL, DECISION_URL, REVIEW_STATUSES, DEFAULT_PAGE_SIZE,
  groupTitle, groupSubline, groupKey, candidateName, orderCandidates, candidateDetailKind,
  entityTypeOptions, canDecide, decisionBody, decisionToast, decisionError, rowsText, totalPages,
} from './reviewGroups';
import { FetchState, InlineError, CARD, INPUT, LINK_BUTTON, SMALL_BUTTON } from './orgUi';

async function readError(res) {
  try {
    return (await res.json())?.error || '';
  } catch {
    return '';
  }
}

function useGroupDecision({ authFetch, onDone }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function decide(group, action, candidate) {
    setBusy(groupKey(group));
    setError(null);
    try {
      const res = await authFetch(DECISION_URL, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decisionBody(group, action, candidate?.targetId)),
      });
      if (!res.ok) {
        setError(decisionError(res.status, await readError(res)));
        return;
      }
      dialog.toast(decisionToast(action, await res.json(), candidate ? candidateName(candidate) : ''), { variant: 'success' });
      onDone?.();
    } catch (err) {
      setError(decisionError(0, err.message));
    } finally {
      setBusy(null);
    }
  }

  return { busy, error, decide };
}

function CandidateRow({ group, candidate, editable, busy, onDecide, onOpenDetail }) {
  const name = candidateName(candidate);
  const kind = candidateDetailKind(group.targetType);
  const quoted = `“${group.value}”`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <span className="min-w-0 flex-1 text-sm text-gray-900 dark:text-gray-100">
        {kind && candidate.targetId ? (
          <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(kind, candidate.targetId, name)}>{name}</button>
        ) : name}
      </span>
      <ConfidenceBar confidence={candidate.confidence} />
      <span className="w-16 text-right text-xs text-gray-600 dark:text-gray-400">{rowsText(candidate.entities)}</span>
      {editable && (
        <span className="flex gap-1">
          <button type="button" className={SMALL_BUTTON} disabled={busy} aria-label={`Confirm ${name} for ${quoted}`}
            onClick={() => onDecide(group, 'confirmed', candidate)}>Confirm</button>
          <button type="button" className={SMALL_BUTTON} disabled={busy} aria-label={`Reject ${name} for ${quoted}`}
            onClick={() => onDecide(group, 'rejected', candidate)}>Reject</button>
        </span>
      )}
    </li>
  );
}

function GroupCard({ group, editable, busy, onDecide, onOpenDetail }) {
  const title = groupTitle(group);
  return (
    <section className={CARD} aria-label={title}>
      <div className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{title}</h3>
          <p className="text-xs text-gray-600 dark:text-gray-400">{groupSubline(group)}</p>
        </div>
        {editable && (
          <button type="button" className={SMALL_BUTTON} disabled={busy} aria-label={`Reject all for “${group.value}”`}
            onClick={() => onDecide(group, 'rejected')}>Reject all</button>
        )}
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        {orderCandidates(group.candidates).map(c => (
          <CandidateRow key={c.targetId ?? candidateName(c)} group={group} candidate={c} editable={editable}
            busy={busy} onDecide={onDecide} onOpenDetail={onOpenDetail} />
        ))}
      </ul>
    </section>
  );
}

function Filters({ types, entityType, status, onEntityType, onStatus }) {
  return (
    <div className="flex flex-wrap gap-4">
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Entity type
        <select className={INPUT} value={entityType} onChange={e => onEntityType(e.target.value)}>
          <option value="">All types</option>
          {types.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        Status
        <select className={INPUT} value={status} onChange={e => onStatus(e.target.value)}>
          {REVIEW_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
    </div>
  );
}

export default function ReviewTab({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const canEdit = useCanImportOrgTruth();
  const [entityType, setEntityType] = useState('');
  const [status, setStatus] = useState('proposed');
  const [page, setPage] = useState(0);
  const model = useFetch('/api/org-truth/model?withSystemCounts=0', { authFetch });
  const state = useFetch(`${GROUPS_URL}${buildQuery({ status, entityType, page: pageParam(page) })}`, { authFetch });
  const { busy, error, decide } = useGroupDecision({ authFetch, onDone: state.reload });

  const groups = rowsOf(state.data);
  const filters = (
    <Filters
      types={entityTypeOptions(model.data?.entityTypes, groups, entityType)}
      entityType={entityType}
      status={status}
      onEntityType={v => { setEntityType(v); setPage(0); }}
      onStatus={v => { setStatus(v); setPage(0); }}
    />
  );

  if (fetchBlocked(state)) return <div className="space-y-4">{filters}<FetchState state={state} what="Review" /></div>;

  const editable = canDecide(status, canEdit);
  const total = totalOf(state.data);
  const pageSize = state.data?.pageSize || DEFAULT_PAGE_SIZE;

  return (
    <div className="space-y-4">
      {filters}
      {!canEdit && groups.length > 0 && (
        <p className="text-sm text-gray-600 dark:text-gray-400">You can see the queue; deciding on a link needs permission to import organisation truth.</p>
      )}
      <InlineError message={error} />
      {groups.length === 0 ? (
        <EmptyState title="Nothing to review" hint="Every proposed link has been decided, or no link was proposed." />
      ) : (
        groups.map(g => (
          <GroupCard key={groupKey(g)} group={g} editable={editable} busy={busy === groupKey(g)}
            onDecide={decide} onOpenDetail={onOpenDetail} />
        ))
      )}
      <Pagination page={page} setPage={setPage} totalPages={totalPages(total, pageSize)} total={total} pageSize={pageSize} />
    </div>
  );
}
