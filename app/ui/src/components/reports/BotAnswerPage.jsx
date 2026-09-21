// One answer the Teams bot gave, in its own tab (#bot-answer:<id>).
//
// Where the "Open the full report" link on a bot's card lands. The card shows at
// most ten rows and four columns because that is what fits in a chat; this is
// the whole answer.
//
// It re-RUNS the stored definition rather than showing stored rows, so the page
// reflects the data as it is now — the same promise a saved report makes. The
// API serves it only to the person who asked the question, so a forwarded chat
// message does not carry the data with it; a link that is not yours is a 404
// here, indistinguishable from one that never existed.
//
// Deliberately read-only and without the report tab's parameter form, refresh
// and download: this is one answer to one question someone asked in a chat, not
// a report anybody saved. If it turns out to be worth keeping, it should be
// saved as a report — which is a different thing with a different lifetime.

import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import EmptyState from '@ui/components/EmptyState';
import ReportError from './ReportError';
import ListReportRenderer from './ListReportRenderer';

export default function BotAnswerPage({ answerId, onClose, onOpenDetail }) {
  const { authFetch } = useAuth();
  const { data, loading, error } = useFetch(
    `/api/bot-answers/${encodeURIComponent(answerId)}`, { authFetch },
  );

  if (loading) return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Running the report…</div>;

  // 404 here is the ordinary case, not a fault: the conversation has passed its
  // retention window, or the link was forwarded to someone it is not for.
  if (error) {
    return (
      <div className="space-y-3 p-6">
        <ReportError title="This answer is not available" message={error.message} onClose={onClose} />
        <p className="text-sm text-gray-500 dark:text-gray-400">
          A bot answer is kept for a limited time, and only the person who asked can open it.
        </p>
      </div>
    );
  }

  if (!data) return <EmptyState title="No answer" hint="This answer is no longer available." />;

  return (
    <div className="space-y-4 p-6">
      <header>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Asked in Teams</h2>
        {/* The question first, then what the bot made of it — the same order the
            card uses, and for the same reason: a wrong name match is only
            visible when the two sit next to each other. */}
        <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">“{data.question}”</p>
        {data.explanation && (
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            <span className="font-medium">Understood as:</span> {data.explanation}
          </p>
        )}
      </header>
      <ListReportRenderer
        // A neutral table name, NOT the question: the renderer puts displayName
        // in the table caption and in its empty state, so using the question
        // there would print it three times on one page.
        report={{ ...data, displayName: 'Bot answer' }}
        onOpenDetail={onOpenDetail}
      />
    </div>
  );
}
