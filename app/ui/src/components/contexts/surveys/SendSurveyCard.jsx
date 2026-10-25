import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useDialog } from '@ui/components/dialogContext';
import { formatDateOnly } from '@ui/utils/formatters';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import { surveyHash } from '@ui/components/surveys/surveyRoute';
import SendSurveyModal from './SendSurveyModal';
import DoSurveyModal from './DoSurveyModal';
import { DO_SURVEY_BUTTON } from './DoSurveyCard';
import { sentSummary, requestStatus } from './send.helpers';

// Action card: do a survey about this unit or application in place (Do survey:
// nothing is sent, the form opens at once), send one, and see the ones sent —
// waiting, answered (its claims are under What we know), withdrawn — and the
// ones done in place. An analyst opens one to fill it in on the recipient's
// behalf (Surveys page). docs/architecture/survey-templates.md.

const STATUS = {
  sent: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300',
  submitted: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
};
export const LISTED = 5;

const how = (r) => (r.inPlace ? 'started for' : 'sent to');

function RequestRow({ r, onWithdraw }) {
  const status = requestStatus(r);
  const byWhom = r.inPlace && r.status === 'submitted' ? `answered in place by ${r.recipientName}` : r.recipientName;
  return (
    <li className="flex items-center gap-2">
      <span className={`shrink-0 rounded px-1.5 py-0.5 ${STATUS[status.key] ?? ''}`}>{status.label}</span>
      <a href={`#${surveyHash(r.id)}`} className="min-w-0 truncate text-blue-700 hover:underline dark:text-blue-300" title={`${r.templateName} — ${byWhom}`}>
        {r.recipientName}
      </a>
      <span className="shrink-0 text-gray-600 dark:text-gray-400">{formatDateOnly(r.sentAt)}</span>
      {r.status === 'sent' && (
        <button type="button" onClick={() => onWithdraw(r)} aria-label={`Withdraw the survey ${how(r)} ${r.recipientName}`}
          className="ml-auto shrink-0 text-gray-600 hover:text-red-700 dark:text-gray-400 dark:hover:text-red-300">✕</button>
      )}
    </li>
  );
}

export default function SendSurveyCard({ attrs }) {
  const ctx = useContextClaims();
  const { authFetch } = useAuth();
  const dialog = useDialog();
  const [open, setOpen] = useState(null);
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
    if (!(await dialog.confirm({ message: `Withdraw the survey ${how(r)} ${r.recipientName}?`, confirmLabel: 'Withdraw', danger: true }))) return;
    const res = await authFetch(`/api/surveys/requests/${r.id}`, { method: 'DELETE' });
    if (!res.ok) dialog.alert('The survey could not be withdrawn.');
    reload();
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-send-survey">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Survey</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        Answer set questions about this here and now, or send them to the owner or a manager. The answers become claims to review.
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => setOpen('do')} className={DO_SURVEY_BUTTON}>Do survey</button>
        <button type="button" onClick={() => setOpen('send')}
          className="rounded border border-blue-600 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-900/20">
          Send survey
        </button>
      </div>
      {requests.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Surveys">
          {requests.slice(0, LISTED).map(r => <RequestRow key={r.id} r={r} onWithdraw={withdraw} />)}
          {requests.length > LISTED && <li className="text-gray-600 dark:text-gray-400">and {requests.length - LISTED} more</li>}
        </ul>
      )}
      {open === 'send' && <SendSurveyModal contextId={attrs.id} onSent={sent} onClose={() => setOpen(null)} />}
      {open === 'do' && <DoSurveyModal contextId={attrs.id} onClose={() => setOpen(null)} />}
    </div>
  );
}
