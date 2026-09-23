// The Ask tab's history: this person's earlier conversations, and a way to
// start a fresh one.
//
// Presentational on purpose. Which conversations exist, which one is open and
// what opening one does are decided by AskPage and useAskConversation; this
// draws the list and reports clicks. Nothing here knows the API.
//
// The list is per person: the store serves only the conversations of the
// signed-in caller (nlreports/conversations.js), and a deployment without
// sign-in has nobody to list them for, so it shows an empty history rather than
// everyone's questions.

const ROW = 'w-full rounded px-2 py-1.5 text-left text-sm hover:bg-gray-100 dark:hover:bg-gray-700/60';
const ACTIVE = 'bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100';

/** A stored question, short enough for one line. */
function title(conversation) {
  const q = String(conversation.firstQuestion ?? '').trim();
  return q.length > 64 ? `${q.slice(0, 61)}…` : q || '(no question)';
}

function when(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
}

/**
 * @param {object}   props
 * @param {object[]} props.conversations  { conversationId, firstQuestion, lastAt, turns }
 * @param {string}   [props.activeId]      the conversation currently on screen
 * @param {boolean}  [props.loading]
 * @param {boolean}  [props.busy]          a question is being answered: switching now would lose it
 * @param {string}   [props.error]
 * @param {Function} props.onNew
 * @param {Function} props.onOpen          (conversationId) => void
 */
export default function AskHistory({ conversations = [], activeId, loading, busy, error, onNew, onOpen }) {
  return (
    <nav aria-label="Earlier conversations" className="space-y-2">
      <button type="button" onClick={onNew} disabled={busy}
        className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-800 hover:border-blue-400 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100">
        + New conversation
      </button>

      {loading && conversations.length === 0 && <p className="px-2 text-xs text-gray-500 dark:text-gray-400">Loading…</p>}
      {error && <p className="px-2 text-xs text-red-700 dark:text-red-300" role="alert">Earlier conversations could not be loaded.</p>}
      {!loading && !error && conversations.length === 0 && (
        <p className="px-2 text-xs text-gray-500 dark:text-gray-400">No earlier conversations yet.</p>
      )}

      {conversations.length > 0 && (
        <ul className="space-y-0.5">
          {conversations.map(c => {
            const active = c.conversationId === activeId;
            return (
              <li key={c.conversationId}>
                <button type="button" onClick={() => onOpen(c.conversationId)} disabled={busy}
                  aria-current={active ? 'true' : undefined}
                  className={`${ROW} ${active ? ACTIVE : 'text-gray-800 dark:text-gray-200'} disabled:opacity-50`}>
                  <span className="block truncate">{title(c)}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400">
                    {when(c.lastAt)}{c.turns ? ` · ${c.turns} ${c.turns === 1 ? 'question' : 'questions'}` : ''}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
