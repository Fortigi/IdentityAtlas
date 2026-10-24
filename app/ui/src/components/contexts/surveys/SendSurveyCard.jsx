import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import { formatDateOnly } from '@ui/utils/formatters';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { surveyHash } from '@ui/components/surveys/surveyRoute';
import SendSurveyModal from './SendSurveyModal';
import { sentSummary } from './send.helpers';

// Action card: send a survey about this unit or application, and see the ones
// sent — waiting, answered (its claims are under What we know), withdrawn. An
// analyst opens one to fill it in on the recipient's behalf (Surveys page).
// docs/architecture/survey-templates.md.

const STATUS = {
  sent: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  submitted: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};
const STATUS_LABEL = { sent: 'waiting', submitted: 'answered', cancelled: 'withdrawn' };
export const LISTED = 5;

export default function SendSurveyCard({ attrs }) {
  const ctx = useContextClaims();
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [open, setOpen] = useState(false);
  const canWrite = !!ctx?.canWrite;
  const { data: requests, reload } = useFetch(`/api/contexts/${attrs.id}/surveys`, {
    authFetch, enabled: canWrite, initialData: [], transform: b => b.data || [],
  });
  if (!canWrite) return null;

  function sent(result) {
    reload();
    dialog.toast(sentSummary(result), { variant: result.sent?.length ? 'success' : 'warning' });
  }

  async function withdraw(r) {
    if (!(await dialog.confirm({ message: `Withdraw the survey sent to ${r.recipientName}?`, confirmLabel: 'Withdraw', danger: true }))) return;
    const res = await authFetch(`/api/surveys/requests/${r.id}`, { method: 'DELETE' });
    if (!res.ok) dialog.alert('The survey could not be withdrawn.');
    reload();
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-send-survey">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Send survey</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        Ask the owner or a manager set questions about this. Their answers become claims to review.
      </p>
      <button type="button" onClick={() => setOpen(true)}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600">
        Send survey
      </button>
      {requests.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Surveys sent">
          {requests.slice(0, LISTED).map(r => (
            <li key={r.id} className="flex items-center gap-2">
              <span className={`shrink-0 rounded px-1.5 py-0.5 ${STATUS[r.status] ?? ''}`}>{STATUS_LABEL[r.status] ?? r.status}</span>
              <a href={`#${surveyHash(r.id)}`} className="min-w-0 truncate text-blue-700 hover:underline dark:text-blue-300" title={`${r.templateName} — ${r.recipientName}`}>
                {r.recipientName}
              </a>
              <span className="shrink-0 text-gray-600 dark:text-gray-400">{formatDateOnly(r.sentAt)}</span>
              {r.status === 'sent' && (
                <button type="button" onClick={() => withdraw(r)} aria-label={`Withdraw the survey sent to ${r.recipientName}`}
                  className="ml-auto shrink-0 text-gray-600 hover:text-red-700 dark:text-gray-400 dark:hover:text-red-300">✕</button>
              )}
            </li>
          ))}
          {requests.length > LISTED && <li className="text-gray-600 dark:text-gray-400">and {requests.length - LISTED} more</li>}
        </ul>
      )}
      {open && <SendSurveyModal contextId={attrs.id} onSent={sent} onClose={() => setOpen(false)} />}
    </div>
  );
}
