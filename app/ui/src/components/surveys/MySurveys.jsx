import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { formatDateOnly } from '@ui/utils/formatters';
import { isOverdue } from './surveyText';

// The surveys sent to the signed-in person (GET /api/surveys/mine), open ones
// first. Choosing one opens it (onOpen(requestId)).

const STATUS = {
  sent: { label: 'To answer', className: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300' },
  submitted: { label: 'Answered', className: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300' },
};

export default function MySurveys({ onOpen }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch('/api/surveys/mine', { authFetch });
  if (loading) return <p className="text-sm text-gray-600 dark:text-gray-400">Loading your surveys…</p>;
  if (error) return <p role="alert" className="text-sm text-red-700 dark:text-red-300">Your surveys could not be loaded ({error.message}).</p>;
  if (!data?.me) {
    return (
      <p className="text-sm text-gray-700 dark:text-gray-300" data-testid="no-me">
        Surveys are sent to people by their account. You are not signed in as an account Identity Atlas knows, so there are none to show here.
      </p>
    );
  }
  const surveys = data.data || [];
  if (surveys.length === 0) return <p className="text-sm text-gray-700 dark:text-gray-300">No surveys have been sent to you.</p>;
  return (
    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
      {surveys.map(s => (
        <li key={s.id}>
          <button type="button" onClick={() => onOpen(s.id)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-gray-900 dark:text-white">{s.templateName}: {s.contextName}</span>
              <span className="block text-xs text-gray-600 dark:text-gray-400">
                Sent {formatDateOnly(s.sentAt)}{s.dueAt ? ` · due ${formatDateOnly(s.dueAt)}` : ''}
                {isOverdue(s) && <span className="ml-1 font-medium text-red-700 dark:text-red-300">· overdue</span>}
              </span>
            </span>
            <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${STATUS[s.status]?.className ?? ''}`}>{STATUS[s.status]?.label ?? s.status}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
