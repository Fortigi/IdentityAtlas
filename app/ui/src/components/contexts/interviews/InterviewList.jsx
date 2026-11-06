import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useDialog } from '@ui/components/dialogContext';
import ManualClaimForm from './ManualClaimForm';
import { extractionLabel } from './claims.helpers';

// ─── The interviews of this context (analysts only) ──────────────────────
// Each with who and when, how far the model got (the message says what it left
// out or why it failed), its claim counts, and: View transcript (with what was
// taken from it highlighted — TranscriptPanel), Read again (retry the model),
// Add claim (by hand — always there, with or without a model), Delete (its
// claims go; what confirmed claims changed stays).

const BTN = 'rounded px-2 py-0.5 text-xs text-blue-700 underline hover:text-blue-800 disabled:opacity-50 dark:text-blue-300 dark:hover:text-blue-200';
const CAN_RETRY = new Set(['done', 'failed', 'pending']);

// The status line; while a run goes on it ticks, so a long one says how long.
function ExtractionStatus({ interview }) {
  const [now, setNow] = useState(() => Date.now());
  const running = interview.extractionStatus === 'running';
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [running]);
  return <span className="text-xs text-gray-700 dark:text-gray-300" data-testid="extraction-status">{extractionLabel(interview, now)}</span>;
}

export default function InterviewList({ contextId, interviews, onChanged, onViewTranscript }) {
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [adding, setAdding] = useState(null);
  const [error, setError] = useState(null);

  async function call(url, init, okStatuses) {
    setError(null);
    const r = await authFetch(url, init);
    if (!okStatuses.includes(r.status)) {
      const body = await r.json().catch(() => ({}));
      setError(body.error || `HTTP ${r.status}`);
      return;
    }
    onChanged();
  }

  const retry = (iv) => call(`/api/contexts/${contextId}/interviews/${iv.id}/extract`, { method: 'POST' }, [202]);

  async function remove(iv) {
    const ok = await dialog.confirm({
      title: 'Delete interview',
      message: `Delete the interview with ${iv.intervieweeName} and the claims it made? What confirmed claims already changed stays.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await call(`/api/contexts/${contextId}/interviews/${iv.id}`, { method: 'DELETE' }, [204]);
  }

  if (interviews.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300">Interviews</h4>
      <ul aria-label="Interviews" className="divide-y divide-gray-100 dark:divide-gray-700">
        {interviews.map(iv => (
          <li key={iv.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm text-gray-900 dark:text-gray-200">
            <span className="font-medium">{iv.intervieweeName}</span>
            <span className="text-xs text-gray-600 dark:text-gray-400">{iv.interviewedAt} · {iv.fileName}</span>
            <ExtractionStatus interview={iv} />
            <span className="text-xs text-gray-600 dark:text-gray-400">{iv.proposed ?? 0} to review · {iv.confirmed ?? 0} confirmed</span>
            {onViewTranscript && (
              <button type="button" className={BTN} onClick={() => onViewTranscript(iv.id)}
                aria-label={`View the transcript of the interview with ${iv.intervieweeName}, ${iv.interviewedAt}`}>View transcript</button>
            )}
            {CAN_RETRY.has(iv.extractionStatus) && <button type="button" className={BTN} onClick={() => retry(iv)}>Read again</button>}
            <button type="button" className={BTN} onClick={() => setAdding(iv)}>Add claim</button>
            <button type="button" className={BTN} onClick={() => remove(iv)}>Delete</button>
            {iv.extractionMessage && <p className="w-full text-xs text-gray-600 dark:text-gray-400">{iv.extractionMessage}</p>}
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-xs text-red-700 dark:text-red-400">{error}</p>}
      {adding && <ManualClaimForm contextId={contextId} interview={adding} onAdded={onChanged} onClose={() => setAdding(null)} />}
    </div>
  );
}
