import { useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import { useContextClaims } from '@ui/components/contexts/interviews/claimsContext';
import DoSurveyModal from './DoSurveyModal';

// Action card for someone who is not an analyst but holds a role here (the
// Accountable or a Responsible, on a context owner's page too): "Do survey",
// answered for themselves, nothing sent. An analyst does it from the Send
// survey card instead, so this card stays empty for them; anyone the API does
// not allow (GET …/surveys/start → allowed: false) gets no card.

export const DO_SURVEY_BUTTON = 'rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600';

export default function DoSurveyCard({ attrs }) {
  const ctx = useContextClaims();
  const { authFetch } = useAuth();
  const [open, setOpen] = useState(false);
  const analyst = !!ctx?.canWrite;
  const { data: options } = useFetch(`/api/contexts/${attrs.id}/surveys/start`, { authFetch, enabled: !analyst });
  if (analyst || !options?.allowed) return null;

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800" data-testid="action-do-survey">
      <h4 className="text-sm font-semibold text-gray-900 dark:text-white">Do survey</h4>
      <p className="mt-0.5 mb-2 text-xs text-gray-600 dark:text-gray-400">
        Answer set questions about this yourself. Your answers become claims an analyst reviews.
      </p>
      <button type="button" onClick={() => setOpen(true)} className={DO_SURVEY_BUTTON}>Do survey</button>
      {open && <DoSurveyModal contextId={attrs.id} onClose={() => setOpen(false)} />}
    </div>
  );
}
