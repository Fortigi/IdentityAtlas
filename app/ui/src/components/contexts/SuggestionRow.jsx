// ─── One suggested holder for a role ─────────────────────────────────────
// The dashed row under a role in the People block: "Suggested: <name>", why,
// and for someone who can edit contexts Confirm / Not this person / Choose
// someone else. Shared by the best guess (ContextBestGuess: a manager or owner
// of most members) and the interview suggestions (interviews/
// InterviewSuggestions: what an interviewee said), so both read the same.
// `note` is an extra line of context (the quote); `flag` a warning (a match to
// check). A reader sees the suggestion without the buttons.

const BTN = 'px-2 py-0.5 rounded text-xs disabled:opacity-50';

export default function SuggestionRow({ testId, name, reason, note, flag, canWrite, busy, onConfirm, onReject, onChooseOther, error }) {
  return (
    <div data-testid={testId} className="flex flex-wrap items-center gap-1.5 rounded border border-dashed border-gray-300 bg-gray-50 px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900/40 dark:text-gray-200">
      <span><span className="font-semibold">Suggested:</span> {name}</span>
      {reason && <span className="text-gray-600 dark:text-gray-400">· {reason}</span>}
      {note && <span className="italic text-gray-700 dark:text-gray-300">· {note}</span>}
      {flag && <span className="rounded bg-amber-50 px-1 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300">{flag}</span>}
      {canWrite && (
        <>
          <button type="button" onClick={onConfirm} disabled={busy} className={`${BTN} bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600`}>Confirm</button>
          <button type="button" onClick={onReject} disabled={busy} className={`${BTN} bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600`}>Not this person</button>
          <button type="button" onClick={onChooseOther} className={`${BTN} text-blue-700 underline hover:text-blue-800 dark:text-blue-300 dark:hover:text-blue-200`}>Choose someone else</button>
        </>
      )}
      {error && <span role="alert" className="text-red-700 dark:text-red-400">{error}</span>}
    </div>
  );
}
