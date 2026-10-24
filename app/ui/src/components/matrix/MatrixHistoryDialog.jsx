// "Who changed this matrix?" — the trail behind a saved matrix.
//
// Saved matrices are org-wide documents that anybody with the Matrix tab can
// rename, re-cut or re-point at different contexts, and until now the row only
// remembered its last writer. This is the answer to "this matrix used to work":
// every change since, newest first, with the person who made it.
//
// History is forward-only (migration 069), so a matrix saved before it shows
// its creator and an explicit note rather than an empty list that would read as
// "nobody ever changed it".

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { Modal, SecondaryButton } from '@ui/components/contexts/ModalPrimitives';
import { formatDate, formatRelativeTime } from '@ui/utils/formatters';
import { provenanceLine, eventSummary, changeLine } from './matrixHistoryText';

function HistoryEvent({ event }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-gray-900 dark:text-gray-100">{eventSummary(event)}</span>
        <span className="text-[11px] text-gray-600 dark:text-gray-400" title={formatDate(event.at)}>
          {formatRelativeTime(event.at)}
        </span>
      </div>
      {event.changes?.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {event.changes.map(c => (
            <li key={c.field} className="break-words text-[11px] text-gray-700 dark:text-gray-300">
              {changeLine(c)}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function HistoryBody({ data, loading }) {
  if (loading && !data) return <p className="text-xs text-gray-600 dark:text-gray-400">Loading history…</p>;
  const events = data?.events || [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-700 dark:text-gray-300">{provenanceLine(data || {})}</p>
      {events.length === 0 ? (
        <p className="text-xs text-gray-600 dark:text-gray-400">
          No changes recorded yet. Changes are only tracked from the moment this Identity Atlas was
          updated, so a matrix that has not been touched since shows nothing here.
        </p>
      ) : (
        <ul aria-label="Matrix history" className="divide-y divide-gray-100 dark:divide-gray-700">
          {events.map((e, i) => <HistoryEvent key={`${e.at}-${i}`} event={e} />)}
        </ul>
      )}
    </div>
  );
}

export default function MatrixHistoryDialog({ savedFilterId, savedName, onClose }) {
  const { authFetch } = useAuth();
  const { data, loading } = useFetch(`/api/matrix/saved-filters/${savedFilterId}/history`, { authFetch });

  return (
    <Modal title={`History of “${savedName}”`} onClose={onClose} width={560}>
      <div className="space-y-4">
        <HistoryBody data={data} loading={loading} />
        <div className="flex justify-end">
          <SecondaryButton onClick={onClose}>Done</SecondaryButton>
        </div>
      </div>
    </Modal>
  );
}
