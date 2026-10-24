import { useState } from 'react';

// The frame every unit action shares: a short hint, the action's own fields,
// the optional Reason (shown in the adjustments log) and the submit button.
// `onSubmit(reason)` does the work; the button stays disabled while it runs
// and while `canSubmit` is false.

export const INPUT_CLASS = 'min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200 dark:placeholder-gray-500';
const SUBMIT_CLASS = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 dark:bg-blue-700 dark:hover:bg-blue-600';

export default function ActionForm({ id, hint, submitLabel, canSubmit = true, onSubmit, children }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (!canSubmit || busy) return;
    setBusy(true);
    try { await onSubmit(reason.trim()); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} aria-label={submitLabel} className="space-y-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-900/40">
      {hint && <p className="text-xs text-gray-600 dark:text-gray-400">{hint}</p>}
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-reason`} className="sr-only">Reason</label>
        <input id={`${id}-reason`} value={reason} onChange={e => setReason(e.target.value)}
          placeholder="Reason (optional, shown in the log)" className={INPUT_CLASS} />
        <button type="submit" disabled={!canSubmit || busy} className={SUBMIT_CLASS}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </form>
  );
}

// A labelled text field of a form (the label is visible: a placeholder is not a label).
export function TextField({ id, label, value, onChange, placeholder }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-gray-700 dark:text-gray-300">{label}</label>
      <input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className={INPUT_CLASS} />
    </div>
  );
}
