// Organisation → Review → "Activity references": every distinct value an
// activity list names (who: "Ann Example"; on what: "Contoso"), with the
// object it was resolved to, decided ONCE for every row that carries it.
//
// GET /api/org-truth/activity-keys (shape in activityKeys.js). Per value: what
// it is (who / on what), the raw value, how many rows carry it, the current
// candidate with its confidence, and Accept / Reject / "Pick another" (a
// select of the other candidates, accepting the one picked). A decision is
// PUT /activity-keys/:id, then a toast and a reload. Readers (no
// useCanImportOrgTruth()) see the list without controls. A server without
// the route (404/501) shows nothing: there is no activity to review there.
//
// Props: { onOpenDetail }
import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useCanImportOrgTruth } from '@ui/hooks/useCanImportOrgTruth';
import { useDialog } from '@ui/components/dialogContext';
import { Section } from '@ui/components/DetailSection';
import Pagination from '@ui/components/Pagination';
import ConfidenceBar from '@ui/components/ConfidenceBar';
import { buildQuery, fetchBlocked, readErrorDetail, isMissingRoute, pageParam, rowsOf, totalOf } from './orgFormat';
import { rowsText, totalPages, DEFAULT_PAGE_SIZE } from './reviewGroups';
import { refDetailKind } from './activity';
import {
  KEYS_URL, KEY_STATUSES, KEY_ROLES, keyUrl, roleLabel, currentCandidate, otherCandidates,
  keyDecisionBody, keyToast, keyError, keyActions,
} from './activityKeys';
import { FetchState, InlineError, INPUT, LINK_BUTTON, SMALL_BUTTON } from './orgUi';

function useKeyDecision({ authFetch, onDone }) {
  const dialog = useDialog();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  async function decide(key, action, candidate) {
    setBusy(key.id);
    setError(null);
    try {
      const res = await authFetch(keyUrl(key.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(keyDecisionBody(action, candidate)),
      });
      if (!res.ok) { setError(keyError(res.status, await readErrorDetail(res))); return; }
      dialog.toast(keyToast(action, key, candidate), { variant: 'success' });
      onDone?.();
    } catch (err) {
      setError(keyError(0, err.message));
    } finally {
      setBusy(null);
    }
  }
  return { busy, error, decide };
}

function Candidate({ candidate, onOpenDetail }) {
  if (!candidate) return <span className="text-sm text-gray-600 dark:text-gray-400">No candidate</span>;
  const kind = refDetailKind(candidate.targetType);
  return (
    <span className="flex items-center gap-2">
      {kind ? (
        <button type="button" className={LINK_BUTTON} onClick={() => onOpenDetail?.(kind, candidate.targetId, candidate.label)}>{candidate.label}</button>
      ) : <span className="text-sm">{candidate.label}</span>}
      {candidate.confidence != null && <ConfidenceBar confidence={candidate.confidence} />}
    </span>
  );
}

function KeyRow({ k, canEdit, busy, onDecide, onOpenDetail }) {
  const current = currentCandidate(k);
  const others = otherCandidates(k);
  const actions = keyActions(k, canEdit);
  const quoted = `“${k.rawValue}”`;
  return (
    <li className="flex flex-wrap items-center gap-3 px-1 py-2" aria-label={`${roleLabel(k.role)} ${quoted}`}>
      <span className="w-16 text-xs text-gray-600 dark:text-gray-400">{roleLabel(k.role)}</span>
      <span className="min-w-0 flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">{quoted}</span>
      <span className="w-16 text-right text-xs text-gray-600 dark:text-gray-400">{rowsText(k.rows)}</span>
      <Candidate candidate={current} onOpenDetail={onOpenDetail} />
      <span className="text-xs text-gray-600 dark:text-gray-400">{k.status}</span>
      <span className="flex gap-1">
        {actions.accept && <button type="button" className={SMALL_BUTTON} disabled={busy} aria-label={`Accept ${current.label} for ${quoted}`}
          onClick={() => onDecide(k, 'accepted', current)}>Accept</button>}
        {actions.reject && <button type="button" className={SMALL_BUTTON} disabled={busy} aria-label={`Reject ${quoted}`}
          onClick={() => onDecide(k, 'rejected')}>Reject</button>}
        {actions.pick && (
          <select className={INPUT} disabled={busy} aria-label={`Pick another candidate for ${quoted}`} value=""
            onChange={e => onDecide(k, 'accepted', others.find(c => c.targetId === e.target.value))}>
            <option value="">Pick another…</option>
            {others.map(c => <option key={c.targetId} value={c.targetId}>{c.label}{c.confidence != null ? ` (${c.confidence}%)` : ''}</option>)}
          </select>
        )}
      </span>
    </li>
  );
}

export default function ActivityKeysSection({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const canEdit = useCanImportOrgTruth();
  const [status, setStatus] = useState('proposed');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(0);
  const state = useFetch(`${KEYS_URL}${buildQuery({ status, role, page: pageParam(page) })}`, { authFetch });
  const { busy, error, decide } = useKeyDecision({ authFetch, onDone: state.reload });

  if (isMissingRoute(state.error)) return null;
  const keys = rowsOf(state.data);
  const total = totalOf(state.data);
  const pageSize = state.data?.pageSize || DEFAULT_PAGE_SIZE;

  return (
    <Section title="Activity references" count={fetchBlocked(state) ? null : total}>
      <p className="mb-3 text-xs text-gray-600 dark:text-gray-400">
        The people and subjects activity lists name, each decided once for every row that names it.
      </p>
      <div className="mb-3 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          Status
          <select className={INPUT} value={status} onChange={e => { setStatus(e.target.value); setPage(0); }}>
            {KEY_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          Show
          <select className={INPUT} value={role} onChange={e => { setRole(e.target.value); setPage(0); }}>
            {KEY_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>
      {fetchBlocked(state) ? <FetchState state={state} what="Activity references" /> : (
        <>
          <InlineError message={error} />
          {keys.length === 0
            ? <p className="text-sm text-gray-600 dark:text-gray-400">No {status} references.</p>
            : (
              <ul aria-label="Activity references" className="divide-y divide-gray-100 dark:divide-gray-700">
                {keys.map(k => <KeyRow key={k.id} k={k} canEdit={canEdit} busy={busy === k.id} onDecide={decide} onOpenDetail={onOpenDetail} />)}
              </ul>
            )}
          <Pagination page={page} setPage={setPage} totalPages={totalPages(total, pageSize)} total={total} pageSize={pageSize} />
        </>
      )}
    </Section>
  );
}
