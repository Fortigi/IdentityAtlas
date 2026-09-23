// Ask — the chat, as a page of its own.
//
// The same conversation the report builder has always had, with the builder
// taken away. That is the entire design: no definition editor, no save
// controls, no spec JSON. Someone who wants to know who has access to what
// types a question and reads an answer, and everything else on screen is in
// the way.
//
// It is NOT a second implementation. `useAskConversation` (turns, history,
// clarifications), `useReportPreview` (running a definition) and
// `ListReportRenderer` (the table) are the same units the builder uses, so a
// fix to the pipeline lands in both. What this file owns is the arrangement:
// question at the top, answer below it, nothing else.
//
// WHO SEES IT. `data.read.reports` — "Ask questions in plain language", the
// permission written for the Teams bot, which says in as many words that it
// covers the bot "or anywhere else that only asks". Deliberately NOT
// `data.write.reports`: asking a question and managing the saved reports every
// analyst sees are different rights, and this page is for people who should
// only have the first.

import { useEffect, useState } from 'react';
import { useAuth } from '@ui/auth/AuthGate';
import { useFetch } from '@ui/hooks/useFetch';
import AskAssistant from '@ui/components/reports/ask/AskAssistant';
import AskHistory from '@ui/components/AskHistory';
import { useAskConversation } from '@ui/components/reports/ask/useAskConversation';
import ListReportRenderer from '@ui/components/reports/ListReportRenderer';
import { useReportPreview } from '@ui/components/reports/ask/useReportPreview';
import ReportNotices from '@ui/components/reports/ReportNotices';
import ConfirmChoices from '@ui/components/reports/ask/ConfirmChoices';

/** What the bot understood, above the rows — the line that catches a wrong answer. */
function Understood({ explanation }) {
  if (!explanation) return null;
  const { title, lines } = typeof explanation === 'string'
    ? { title: explanation, lines: [] }
    : explanation;
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/60">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">Understood as</p>
      <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {(lines ?? []).map((line, i) => (
          <li key={i} className="text-sm text-gray-700 dark:text-gray-300"
              style={{ paddingLeft: `${(line.depth ?? 0) * 1.25}rem` }}>
            • {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function AskPage({ onOpenDetail }) {
  const { authFetch } = useAuth();
  const preview = useReportPreview(authFetch);
  const [question, setQuestion] = useState('');
  const [openError, setOpenError] = useState(null);

  // A definition came back from the model: run it straight away. The builder
  // waits for the analyst to press Run because they may want to edit it first;
  // here there is nothing to edit, so waiting would only be a second click.
  // A resumed conversation reports its last answer the same way, so its rows
  // come back with it — a query, never a model call.
  const onReport = (reply, asked) => {
    setQuestion(asked);
    preview.run(reply.spec, reply.logId);
  };

  // The page owns the conversation, so the history can load one into it.
  const convo = useAskConversation({ authFetch, currentSpec: null, onReport });

  // This person's earlier conversations. Re-read whenever a turn lands, so the
  // one in progress appears in the list as soon as it has been recorded.
  const history = useFetch('/api/nl-reports/conversations', { authFetch, transform: d => d.conversations ?? [] });
  const turnCount = convo.turns.length;
  const reloadHistory = history.reload;
  useEffect(() => { if (turnCount) reloadHistory(); }, [turnCount, reloadHistory]);

  const openConversation = async (id) => {
    setOpenError(null);
    try {
      const res = await authFetch(`/api/nl-reports/conversations/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { turns } = await res.json();
      preview.reset();
      convo.load(id, turns);
    } catch (e) {
      setOpenError(e.message);
    }
  };

  const startNew = () => {
    convo.newConversation();
    setQuestion('');
    preview.reset();
  };

  const { result, running, runError, confirm } = preview;

  return (
    <div className="mx-auto max-w-6xl p-4 md:grid md:grid-cols-[15rem_1fr] md:gap-8">
      <aside className="mb-6 md:mb-0">
        <AskHistory conversations={history.data ?? []} activeId={convo.conversationId}
                    loading={history.loading} error={history.error?.message ?? openError}
                    busy={convo.busy || running} onNew={startNew} onOpen={openConversation} />
      </aside>

      <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Ask</h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          Ask about access in plain language — English or Dutch. The model runs on your own
          hardware and your question never leaves it.
        </p>
      </header>

      <AskAssistant onReport={onReport} conversation={convo} />

      {running && (
        <p className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
          Running the report…
        </p>
      )}

      {runError && (
        <p className="text-sm text-red-700 dark:text-red-300" role="alert">{runError}</p>
      )}

      {confirm && (
        <ConfirmChoices confirm={confirm.confirm} onChoose={preview.confirmChoice} busy={running} />
      )}

      {result && !running && (
        <section className="space-y-3">
          {question && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              <span className="font-medium text-gray-700 dark:text-gray-300">You asked:</span> {question}
            </p>
          )}
          <Understood explanation={result.explanation} />
          <ReportNotices notices={result.notices} />
          <ListReportRenderer report={{ ...result, displayName: question || 'This question' }}
                              onOpenDetail={onOpenDetail} />
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {result.total} {result.total === 1 ? 'record' : 'records'}
            {result.truncated ? ' (the report hit its row limit, there may be more)' : ''}
          </p>
        </section>
      )}
      </div>
    </div>
  );
}
